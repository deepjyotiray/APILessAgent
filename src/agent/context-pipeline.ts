import { promises as fs } from "node:fs";
import path from "node:path";
import type { ToolRegistry, ToolExecutionContext, TaskState } from "./types.js";
import { buildImportGraph, getConnectedFiles, findTestFile, saveImportGraph, loadImportGraph, type ImportGraph } from "./import-graph.js";
import { RankingFeedbackStore } from "./ranking-feedback.js";
import { buildRepoMap } from "./repo-map.js";
import { VectorStore } from "./vector-index.js";

// --- Types ---

export interface ContextBudget {
  maxTotalChars: number;    // total chars for code context in prompt
  maxFileChars: number;     // max chars per single file
  maxFiles: number;         // max files to include
  reserveForOutput: number; // chars reserved for LLM output
}

export interface ScoredFile {
  path: string;
  score: number;
  keywordHits: number;
  nameMatch: boolean;
  recencyBoost: number;
  size: number;
}

export interface SymbolEntry {
  name: string;
  kind: "function" | "class" | "method" | "interface" | "type" | "export";
  file: string;
  line: number;
}

export interface ContextResult {
  files: Array<{ path: string; content: string; score: number }>;
  symbolIndex: SymbolEntry[];
  totalChars: number;
  searchHits: string[];
  keywords: string[];
  semanticChunks?: Array<{ file: string; startLine: number; endLine: number; text: string; score: number }>;
}

const DEFAULT_BUDGET: ContextBudget = {
  maxTotalChars: 25000,
  maxFileChars: 8000,
  maxFiles: 6,
  reserveForOutput: 10000,
};

const SKIP_PATTERNS = [
  "node_modules", ".git/", ".git\\", ".DS_Store", ".agent-state",
  ".agent-memory", ".agent-conversations", ".auth/", ".auth\\",
  "package-lock.json", ".ico", ".png", ".jpg", ".jpeg", ".gif",
  ".svg", ".woff", ".ttf", ".eot", ".mp3", ".mp4", ".zip",
  "dist/", "dist\\", "build/", "build\\", "out/", "out\\",
];

const CODE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".go", ".rs", ".rb", ".java", ".kt",
  ".c", ".cpp", ".h", ".hpp", ".cs", ".swift",
  ".sh", ".bash", ".zsh", ".sql", ".graphql",
  ".json", ".yaml", ".yml", ".toml",
  ".html", ".css", ".scss",
  ".md", ".txt", ".rst",
]);

const SYMBOL_INDEX_PATH = ".agent-memory/symbol-index.json";

export class ContextPipeline {
  private symbolCache: SymbolEntry[] | null = null;
  private importGraph: ImportGraph | null = null;
  private feedbackStore: RankingFeedbackStore;
  private vectorStore: VectorStore;

  constructor(
    private readonly tools: ToolRegistry,
    private readonly root: string,
    private readonly budget: ContextBudget = DEFAULT_BUDGET
  ) {
    this.feedbackStore = new RankingFeedbackStore(root);
    this.vectorStore = new VectorStore(root);
  }

  /**
   * Fast context: keyword filename matching + explicit files only.
   * No ripgrep, no embeddings, no import graph. Returns in <100ms.
   * Used to get initial files to the LLM immediately.
   */
  async gatherFastContext(
    goal: string,
    explicitFiles: string[] = [],
    onFileRead?: (path: string) => void
  ): Promise<ContextResult> {
    const keywords = extractKeywords(goal);
    const allFiles = await this.listAllFiles();

    // Score by filename/path keyword match only (no ripgrep)
    const lowerKeywords = keywords.map(k => k.toLowerCase());
    let scored: ScoredFile[] = allFiles.map(filePath => {
      let score = 0;
      const fileName = path.basename(filePath).toLowerCase();
      const dirName = path.dirname(filePath).toLowerCase();
      let keywordHits = 0;
      let nameMatch = false;
      for (const kw of lowerKeywords) {
        if (fileName.includes(kw)) { score += 15; nameMatch = true; keywordHits++; }
        else if (dirName.includes(kw)) { score += 8; keywordHits++; }
      }
      if (fileName === "index.ts" || fileName === "index.js") score += 3;
      if (fileName === "package.json") score += 5;
      if (fileName.includes("type") || fileName.includes("interface")) score += 4;
      const depth = filePath.split("/").length - 1;
      score -= depth * 0.5;
      return { path: filePath, score, keywordHits, nameMatch, recencyBoost: 0, size: 0 };
    }).filter(f => f.score > 0);

    // Resolve explicit files
    const resolvedExplicit = this.resolveExplicitFiles(explicitFiles, allFiles);
    for (const f of resolvedExplicit) {
      if (!scored.find(s => s.path === f)) {
        scored.unshift({ path: f, score: 100, keywordHits: 0, nameMatch: true, recencyBoost: 0, size: 0 });
      } else {
        scored.find(s => s.path === f)!.score = Math.max(scored.find(s => s.path === f)!.score, 100);
      }
    }

    scored.sort((a, b) => b.score - a.score);
    const selected = scored.slice(0, this.budget.maxFiles);

    // Read files, emitting events as each is read
    const files = await this.readWithBudget(selected, onFileRead);
    const symbolIndex = await this.getSymbolIndex(files);

    return { files, symbolIndex, totalChars: files.reduce((s, f) => s + f.content.length, 0), searchHits: [], keywords };
  }

  /**
   * Expand existing context with heavier signals: ripgrep, embeddings, import graph.
   * Called after the first LLM call is already in flight.
   */
  async expandContextDeep(
    goal: string,
    existing: ContextResult,
    onFileRead?: (path: string) => void
  ): Promise<ContextResult> {
    const keywords = existing.keywords;
    const allFiles = await this.listAllFiles();
    const existingPaths = new Set(existing.files.map(f => f.path));
    const files = [...existing.files];

    // Ripgrep search
    const searchResult = keywords.length ? await this.searchFilesWithCounts(keywords) : { hits: [], counts: new Map<string, number>() };
    const feedbackBoosts = await this.feedbackStore.getBoosts(allFiles);

    // Find new files from ripgrep that aren't already loaded
    const newCandidates: ScoredFile[] = [];
    for (const [filePath, hitCount] of searchResult.counts) {
      if (existingPaths.has(filePath)) continue;
      const maxHits = Math.max(1, ...searchResult.counts.values());
      const score = 10 + Math.round((hitCount / maxHits) * 20) + (feedbackBoosts.get(filePath) ?? 0);
      newCandidates.push({ path: filePath, score, keywordHits: hitCount, nameMatch: false, recencyBoost: 0, size: 0 });
    }
    newCandidates.sort((a, b) => b.score - a.score);

    // Read top new files within budget
    let totalChars = files.reduce((s, f) => s + f.content.length, 0);
    for (const candidate of newCandidates.slice(0, 4)) {
      if (totalChars >= this.budget.maxTotalChars) break;
      const ctx = this.makeContext();
      onFileRead?.(candidate.path);
      const r = await this.tools.execute("read_file", { path: candidate.path }, ctx);
      if (!r.ok) continue;
      let content = (r.data as any)?.content ?? "";
      if (content.length > this.budget.maxFileChars) content = this.smartTruncate(content, this.budget.maxFileChars, candidate);
      files.push({ path: candidate.path, content, score: candidate.score });
      existingPaths.add(candidate.path);
      totalChars += content.length;
    }

    // Import graph expansion
    this.importGraph = await this.getImportGraph(files, allFiles);
    const connected = getConnectedFiles(this.importGraph, [...existingPaths], 1);
    for (const connPath of connected.slice(0, 2)) {
      if (totalChars >= this.budget.maxTotalChars || existingPaths.has(connPath)) continue;
      const ctx = this.makeContext();
      onFileRead?.(connPath);
      const r = await this.tools.execute("read_file", { path: connPath }, ctx);
      if (!r.ok) continue;
      let content = (r.data as any)?.content ?? "";
      if (content.length > 4000) content = content.slice(0, 4000) + "\n...[truncated]";
      files.push({ path: connPath, content, score: 5 });
      existingPaths.add(connPath);
      totalChars += content.length;
    }

    // Embeddings (non-blocking — if Ollama is slow, skip)
    let semanticChunks: ContextResult["semanticChunks"] = [];
    try {
      const vectorAvailable = await this.vectorStore.isAvailable();
      if (vectorAvailable) {
        await this.vectorStore.indexFiles(files);
        semanticChunks = await this.vectorStore.getRelevantChunks(goal, 8);
        for (const chunk of semanticChunks) {
          if (existingPaths.has(chunk.file) || totalChars >= this.budget.maxTotalChars) continue;
          if (chunk.score < 0.4) continue;
          const ctx = this.makeContext();
          onFileRead?.(chunk.file);
          const r = await this.tools.execute("read_file", { path: chunk.file }, ctx);
          if (!r.ok) continue;
          const content = ((r.data as any)?.content ?? "").slice(0, this.budget.maxFileChars);
          files.push({ path: chunk.file, content, score: Math.round(chunk.score * 25) });
          existingPaths.add(chunk.file);
          totalChars += content.length;
        }
      }
    } catch { /* embeddings are optional */ }

    files.sort((a, b) => b.score - a.score);
    const symbolIndex = await this.getSymbolIndex(files);
    return { files, symbolIndex, totalChars, searchHits: searchResult.hits, keywords, semanticChunks };
  }

  /**
   * Full context gather (original behavior, used as fallback).
   */
  async gatherContext(
    goal: string,
    explicitFiles: string[] = [],
    existingContext = ""
  ): Promise<ContextResult> {
    const fast = await this.gatherFastContext(goal, explicitFiles);
    return this.expandContextDeep(goal, fast);
  }

  /**
   * Expand context: use import graph (1-2 hops), siblings, and test file linking.
   */
  async expandContext(
    currentFiles: string[],
    allContent: string
  ): Promise<string[]> {
    const allFiles = await this.listAllFiles();
    const expanded: string[] = [];

    // 1. Import graph traversal (2 hops) — if graph available
    if (this.importGraph) {
      const graphExpanded = getConnectedFiles(this.importGraph, currentFiles, 2);
      expanded.push(...graphExpanded.filter(f => !currentFiles.includes(f)));
    } else {
      // Fallback: regex-based import resolution
      const imports = extractImportPaths(allContent);
      for (const imp of imports) {
        for (const current of currentFiles) {
          const resolved = resolveImport(imp, current);
          const match = allFiles.find(f =>
            f === resolved || f === resolved + ".ts" || f === resolved + ".js" ||
            f === resolved + "/index.ts" || f === resolved + "/index.js"
          );
          if (match && !currentFiles.includes(match) && !expanded.includes(match)) {
            expanded.push(match);
          }
        }
      }
    }

    // 2. Test file linking
    for (const f of currentFiles) {
      const testFile = findTestFile(f, allFiles);
      if (testFile && !currentFiles.includes(testFile) && !expanded.includes(testFile)) {
        expanded.push(testFile);
      }
    }

    // 3. Same-directory siblings for small directories
    const currentDirs = new Set(currentFiles.map(f => path.dirname(f)));
    for (const dir of currentDirs) {
      const siblings = allFiles.filter(f =>
        path.dirname(f) === dir && !currentFiles.includes(f) && !expanded.includes(f)
      );
      if (siblings.length <= 5) expanded.push(...siblings);
    }

    return expanded.slice(0, 15);
  }

  /** Record which files were useful after a task completes. */
  async recordFeedback(usedFiles: string[], editedFiles: string[]): Promise<void> {
    await this.feedbackStore.recordTaskCompletion(usedFiles, editedFiles);
  }

  /**
   * Build a compact repo map (~2-5k chars) showing file structure,
   * classes, functions, and import relationships.
   * Replaces the flat file tree for LLM orientation.
   */
  async getRepoMap(): Promise<string> {
    const allFiles = await this.listAllFiles();

    // Read a sample of files to extract symbols (don't read everything)
    const ctx = this.makeContext();
    const filesToScan = allFiles.filter(f => {
      const ext = path.extname(f).toLowerCase();
      return [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py"].includes(ext);
    }).slice(0, 30);

    const scannedFiles: Array<{ path: string; content: string }> = [];
    for (const f of filesToScan) {
      const r = await this.tools.execute("read_file", { path: f }, ctx);
      if (r.ok) {
        scannedFiles.push({ path: f, content: (r.data as any)?.content ?? "" });
      }
    }

    const symbols = await this.getSymbolIndex(scannedFiles);
    const graph = await this.getImportGraph(scannedFiles, allFiles);

    // Warm the vector index while we have files in memory
    if (await this.vectorStore.isAvailable()) {
      await this.vectorStore.indexFiles(scannedFiles);
    }

    return buildRepoMap(allFiles, symbols, graph);
  }

  /**
   * Build a formatted context string for prompt injection.
   * Includes file contents, symbol index, and usage context from import graph.
   */
  formatForPrompt(result: ContextResult): string {
    const parts: string[] = [];

    if (result.symbolIndex.length > 0) {
      const symbolMap = new Map<string, string[]>();
      for (const s of result.symbolIndex) {
        const list = symbolMap.get(s.file) ?? [];
        list.push(`  ${s.kind}: ${s.name} (L${s.line})`);
        symbolMap.set(s.file, list);
      }
      parts.push("SYMBOL INDEX:");
      for (const [file, symbols] of symbolMap) {
        parts.push(`${file}:`);
        parts.push(...symbols);
      }
      parts.push("");
    }

    // Add usage context: who imports/is imported by the top files
    if (this.importGraph) {
      const topPaths = result.files.slice(0, 6).map(f => f.path);
      const usageLines: string[] = [];
      for (const fp of topPaths) {
        const importedBy = this.importGraph.importedBy[fp];
        const imports = this.importGraph.imports[fp];
        if (importedBy?.length || imports?.length) {
          const parts: string[] = [];
          if (imports?.length) parts.push(`imports: ${imports.join(", ")}`);
          if (importedBy?.length) parts.push(`used by: ${importedBy.join(", ")}`);
          usageLines.push(`  ${fp} → ${parts.join(" | ")}`);
        }
      }
      if (usageLines.length > 0) {
        parts.push("USAGE GRAPH (imports & callers):");
        parts.push(...usageLines);
        parts.push("");
      }
    }

    for (const f of result.files) {
      parts.push(`--- ${f.path} (relevance: ${f.score.toFixed(1)}) ---`);
      parts.push(f.content);
      parts.push("");
    }

    // Append top semantic chunks that aren't already in file contents
    if (result.semanticChunks?.length) {
      const includedPaths = new Set(result.files.map(f => f.path));
      const extraChunks = result.semanticChunks
        .filter(c => !includedPaths.has(c.file) && c.score > 0.4)
        .slice(0, 4);
      if (extraChunks.length > 0) {
        parts.push("SEMANTIC MATCHES (embedding-ranked relevant code):");
        for (const c of extraChunks) {
          parts.push(`--- ${c.file}:${c.startLine}-${c.endLine} (similarity: ${c.score.toFixed(2)}) ---`);
          parts.push(c.text);
          parts.push("");
        }
      }
    }

    return parts.join("\n");
  }

  // --- Internal methods ---

  private async listAllFiles(): Promise<string[]> {
    const ctx = this.makeContext();
    const r = await this.tools.execute("list_files", { path: ".", maxDepth: 4 }, ctx);
    if (!r.ok || !r.data) return [];
    const files = ((r.data as any).files as string[]) ?? [];
    return files.filter(f => {
      if (SKIP_PATTERNS.some(p => f.includes(p))) return false;
      if (f.endsWith("/")) return false;
      const ext = path.extname(f).toLowerCase();
      return CODE_EXTENSIONS.has(ext) || ext === "";
    });
  }

  /**
   * Search files and return both hit list and per-file hit counts (TF-IDF proxy).
   */
  private async searchFilesWithCounts(keywords: string[]): Promise<{ hits: string[]; counts: Map<string, number> }> {
    const ctx = this.makeContext();
    const pattern = keywords.slice(0, 8).join("|");
    const r = await this.tools.execute("search", { pattern, path: "." }, ctx);
    if (!r.ok || !r.data) return { hits: [], counts: new Map() };
    const stdout = (r.data as any)?.stdout ?? "";
    const counts = new Map<string, number>();
    for (const line of stdout.split("\n")) {
      const match = line.match(/^([^:]+):\d+:/);
      if (match) {
        const rel = path.relative(this.root, match[1]) || match[1];
        counts.set(rel, (counts.get(rel) ?? 0) + 1);
      }
    }
    return { hits: [...counts.keys()], counts };
  }

  private scoreFiles(
    allFiles: string[],
    keywords: string[],
    searchHits: string[],
    hitCounts: Map<string, number>,
    feedbackBoosts: Map<string, number>
  ): ScoredFile[] {
    const hitSet = new Set(searchHits);
    const lowerKeywords = keywords.map(k => k.toLowerCase());
    // Normalize hit counts for TF-IDF-like scoring
    const maxHits = Math.max(1, ...hitCounts.values());

    return allFiles.map(filePath => {
      let score = 0;
      const fileName = path.basename(filePath).toLowerCase();
      const dirName = path.dirname(filePath).toLowerCase();

      // Keyword match in filename/path
      let keywordHits = 0;
      let nameMatch = false;
      for (const kw of lowerKeywords) {
        if (fileName.includes(kw)) { score += 15; nameMatch = true; keywordHits++; }
        else if (dirName.includes(kw)) { score += 8; keywordHits++; }
      }

      // TF-IDF-like ripgrep scoring: more hits = higher score, normalized
      const fileHitCount = hitCounts.get(filePath) ?? 0;
      if (fileHitCount > 0) {
        const normalizedTf = fileHitCount / maxHits; // 0..1
        score += 10 + Math.round(normalizedTf * 20); // 10..30 range
        keywordHits += fileHitCount;
      }

      // Structural weight: entry points, configs, types
      if (fileName === "index.ts" || fileName === "index.js") score += 3;
      if (fileName === "package.json") score += 5;
      if (fileName.includes("type") || fileName.includes("interface")) score += 4;


      // Depth penalty
      const depth = filePath.split("/").length - 1;
      score -= depth * 0.5;

      // Ranking feedback boost (learned from past tasks)
      const feedbackScore = feedbackBoosts.get(filePath) ?? 0;
      if (feedbackScore > 0) score += Math.min(feedbackScore, 15);

      const recencyBoost = 0;

      return { path: filePath, score, keywordHits, nameMatch, recencyBoost, size: 0 };
    }).filter(f => f.score > 0);
  }

  private async readWithBudget(
    files: ScoredFile[],
    onFileRead?: (path: string) => void
  ): Promise<Array<{ path: string; content: string; score: number }>> {
    const ctx = this.makeContext();
    const result: Array<{ path: string; content: string; score: number }> = [];
    let totalChars = 0;

    for (const file of files) {
      if (totalChars >= this.budget.maxTotalChars) break;

      const remaining = this.budget.maxTotalChars - totalChars;
      const maxForThis = Math.min(remaining, this.budget.maxFileChars);

      const r = await this.tools.execute("read_file", { path: file.path }, ctx);
      if (!r.ok) continue;
      onFileRead?.(file.path);

      let content = (r.data as any)?.content ?? "";

      // Smart truncation: if file is too large, extract relevant chunks
      if (content.length > maxForThis) {
        content = this.smartTruncate(content, maxForThis, file);
      }

      result.push({ path: file.path, content, score: file.score });
      totalChars += content.length;
    }

    return result;
  }

  /**
   * Smart truncation: instead of cutting at arbitrary char limit,
   * try to keep complete functions/classes and prioritize top of file + keyword regions.
   */
  private smartTruncate(content: string, maxChars: number, file: ScoredFile): string {
    const lines = content.split("\n");

    // Always keep first 30 lines (imports, class declaration, etc.)
    const header = lines.slice(0, 30).join("\n");
    if (header.length >= maxChars) return header.slice(0, maxChars);

    // Find function/class boundaries
    const chunks = chunkBySymbols(lines);
    if (chunks.length <= 1) return content.slice(0, maxChars);

    // Always include header chunk, then fill with remaining budget
    const parts: string[] = [header];
    let used = header.length;

    for (const chunk of chunks) {
      if (chunk.startLine < 30) continue; // already in header
      const text = chunk.text;
      if (used + text.length + 20 > maxChars) {
        // Add a truncation marker
        parts.push(`\n... [${lines.length - chunk.startLine} more lines truncated] ...`);
        break;
      }
      parts.push(text);
      used += text.length;
    }

    return parts.join("\n");
  }

  private async getSymbolIndex(
    files: Array<{ path: string; content: string }>
  ): Promise<SymbolEntry[]> {
    // Try loading cached index
    if (this.symbolCache) return this.symbolCache;

    try {
      const cached = await fs.readFile(path.join(this.root, SYMBOL_INDEX_PATH), "utf8");
      this.symbolCache = JSON.parse(cached) as SymbolEntry[];
      return this.symbolCache;
    } catch { /* no cache, build fresh */ }

    // Build from the files we already have in memory
    const symbols: SymbolEntry[] = [];
    for (const file of files) {
      symbols.push(...extractSymbols(file.path, file.content));
    }

    // Cache to disk
    this.symbolCache = symbols;
    try {
      await fs.mkdir(path.dirname(path.join(this.root, SYMBOL_INDEX_PATH)), { recursive: true });
      await fs.writeFile(
        path.join(this.root, SYMBOL_INDEX_PATH),
        JSON.stringify(symbols, null, 2),
        "utf8"
      );
    } catch { /* non-critical */ }

    return symbols;
  }

  /** Invalidate all caches (call after edits). */
  clearSymbolCache(): void {
    this.symbolCache = null;
    this.importGraph = null;
    this.vectorStore.clear();
  }

  /**
   * Fast vector search: returns top-K files ranked by semantic similarity.
   * If the vector index isn't available or empty, falls back to keyword filename matching.
   * Does NOT read file contents — just returns paths + scores.
   */
  async searchRelevantFiles(
    query: string,
    topK = 6,
    minScore = 0.3
  ): Promise<Array<{ path: string; score: number }>> {
    // Try vector search first
    const vectorAvailable = await this.vectorStore.isAvailable();
    if (vectorAvailable) {
      // Ensure index is warm (getRepoMap indexes files as a side effect)
      const index = await this.vectorStore.search(query, topK);
      if (index.length > 0) {
        return index
          .filter(r => r.score >= minScore)
          .map(r => ({ path: r.file, score: r.score }));
      }
    }

    // Fallback: keyword filename matching
    const keywords = extractKeywords(query);
    if (keywords.length === 0) return [];
    const allFiles = await this.listAllFiles();
    const lowerKeywords = keywords.map(k => k.toLowerCase());
    const scored: Array<{ path: string; score: number }> = [];
    for (const f of allFiles) {
      const name = path.basename(f).toLowerCase();
      const dir = path.dirname(f).toLowerCase();
      let score = 0;
      for (const kw of lowerKeywords) {
        if (name.includes(kw)) score += 0.6;
        else if (dir.includes(kw)) score += 0.3;
      }
      if (score >= minScore) scored.push({ path: f, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }

  private async getImportGraph(
    files: Array<{ path: string; content: string }>,
    allFilePaths: string[]
  ): Promise<ImportGraph> {
    // Try cached
    const cached = await loadImportGraph(this.root);
    if (cached) return cached;

    const graph = buildImportGraph(files, allFilePaths);
    await saveImportGraph(this.root, graph);
    return graph;
  }

  /**
   * Resolve user-provided file names against the actual file list.
   * Handles case-insensitive matching and partial paths (e.g. "README.MD" → "README.md").
   */
  private resolveExplicitFiles(requested: string[], allFiles: string[]): string[] {
    const resolved: string[] = [];
    for (const req of requested) {
      // Exact match first
      if (allFiles.includes(req)) { resolved.push(req); continue; }
      // Case-insensitive basename match
      const reqLower = req.toLowerCase();
      const match = allFiles.find(f => f.toLowerCase() === reqLower)
        ?? allFiles.find(f => path.basename(f).toLowerCase() === reqLower)
        ?? allFiles.find(f => f.toLowerCase().endsWith("/" + reqLower));
      if (match) resolved.push(match);
      else resolved.push(req); // keep as-is, readWithBudget will handle missing
    }
    return [...new Set(resolved)];
  }

  private makeContext(): ToolExecutionContext {
    return {
      root: this.root,
      safetyMode: "auto",
      task: {
        id: "context-pipeline", goal: "", root: this.root,
        plannerBackend: "chatgpt", safetyMode: "auto", status: "running",
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        steps: [], changedFiles: [],
        verification: { sawGitDiff: false, sawVerification: false }
      } as TaskState,
      saveCheckpoint: async () => "",
      loadCheckpoint: async () => ({} as any)
    };
  }
}

// --- Pure functions ---

/** Extract meaningful keywords from a goal/query string. */
export function extractKeywords(text: string): string[] {
  const stopWords = new Set([
    "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
    "have", "has", "had", "do", "does", "did", "will", "would", "could",
    "should", "may", "might", "shall", "can", "need", "must", "ought",
    "i", "me", "my", "we", "our", "you", "your", "he", "she", "it",
    "they", "them", "this", "that", "these", "those", "what", "which",
    "who", "whom", "how", "where", "when", "why", "all", "each", "every",
    "both", "few", "more", "most", "other", "some", "such", "no", "not",
    "only", "same", "so", "than", "too", "very", "just", "about", "above",
    "after", "again", "also", "and", "any", "because", "before", "between",
    "but", "by", "for", "from", "if", "in", "into", "of", "on", "or",
    "out", "over", "then", "to", "up", "with", "make", "use", "add",
    "get", "set", "put", "let", "new", "like", "want", "look", "find",
    "give", "tell", "think", "know", "see", "come", "take", "show",
    "try", "ask", "work", "call", "keep", "help", "start", "run",
    "file", "code", "implement", "create", "update", "change", "fix",
    "please", "ensure", "check",
  ]);

  // Extract quoted phrases first
  const phrases: string[] = [];
  const quoted = text.match(/"([^"]+)"|'([^']+)'/g);
  if (quoted) {
    for (const q of quoted) phrases.push(q.replace(/['"]/g, "").trim());
  }

  // Extract camelCase/PascalCase identifiers
  const identifiers = text.match(/[A-Z][a-z]+(?:[A-Z][a-z]+)+|[a-z]+(?:[A-Z][a-z]+)+/g) ?? [];
  phrases.push(...identifiers);

  // Extract snake_case/kebab-case identifiers
  const snakeKebab = text.match(/[a-z]+[-_][a-z]+(?:[-_][a-z]+)*/g) ?? [];
  phrases.push(...snakeKebab);

  // Extract remaining words
  const words = text
    .replace(/[^a-zA-Z0-9_.-]/g, " ")
    .split(/\s+/)
    .filter(w => w.length > 2 && !stopWords.has(w.toLowerCase()))
    .map(w => w.toLowerCase());

  // Split camelCase identifiers into component words too
  for (const id of identifiers) {
    const parts = id.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().split(" ");
    words.push(...parts.filter(p => p.length > 2 && !stopWords.has(p)));
  }

  // Deduplicate, preserve order
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of [...phrases, ...words]) {
    const lower = item.toLowerCase();
    if (!seen.has(lower) && lower.length > 1) {
      seen.add(lower);
      result.push(item);
    }
  }

  return result.slice(0, 20);
}

/** Extract import/require paths from source code. */
function extractImportPaths(content: string): string[] {
  const paths: string[] = [];
  // ES imports: import ... from "path"
  const esImports = content.matchAll(/from\s+["']([^"']+)["']/g);
  for (const m of esImports) {
    if (m[1].startsWith(".")) paths.push(m[1]);
  }
  // require: require("path")
  const requires = content.matchAll(/require\s*\(\s*["']([^"']+)["']\s*\)/g);
  for (const m of requires) {
    if (m[1].startsWith(".")) paths.push(m[1]);
  }
  return [...new Set(paths)];
}

/** Resolve a relative import path against a source file. */
function resolveImport(importPath: string, fromFile: string): string {
  const dir = path.dirname(fromFile);
  return path.normalize(path.join(dir, importPath));
}

/** Extract top-level symbols from source code using regex (lightweight, no AST). */
export function extractSymbols(filePath: string, content: string): SymbolEntry[] {
  const symbols: SymbolEntry[] = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    // Functions: function name(, async function name(, const name = (
    let m = line.match(/^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)/);
    if (m) { symbols.push({ name: m[1], kind: "function", file: filePath, line: lineNum }); continue; }

    m = line.match(/^\s*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?\(/);
    if (m) { symbols.push({ name: m[1], kind: "function", file: filePath, line: lineNum }); continue; }

    // Classes
    m = line.match(/^\s*(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/);
    if (m) { symbols.push({ name: m[1], kind: "class", file: filePath, line: lineNum }); continue; }

    // Interfaces
    m = line.match(/^\s*(?:export\s+)?interface\s+(\w+)/);
    if (m) { symbols.push({ name: m[1], kind: "interface", file: filePath, line: lineNum }); continue; }

    // Type aliases
    m = line.match(/^\s*(?:export\s+)?type\s+(\w+)\s*=/);
    if (m) { symbols.push({ name: m[1], kind: "type", file: filePath, line: lineNum }); continue; }

    // Methods inside classes (indented)
    m = line.match(/^\s+(?:async\s+)?(\w+)\s*\([^)]*\)\s*(?::\s*\S+)?\s*\{/);
    if (m && m[1] !== "if" && m[1] !== "for" && m[1] !== "while" && m[1] !== "switch") {
      symbols.push({ name: m[1], kind: "method", file: filePath, line: lineNum });
    }

    // Python: def name(
    m = line.match(/^\s*(?:async\s+)?def\s+(\w+)/);
    if (m) { symbols.push({ name: m[1], kind: "function", file: filePath, line: lineNum }); continue; }

    // Python: class Name
    m = line.match(/^\s*class\s+(\w+)/);
    if (m && !symbols.find(s => s.name === m![1] && s.line === lineNum)) {
      symbols.push({ name: m[1], kind: "class", file: filePath, line: lineNum });
    }
  }

  return symbols;
}

/** Chunk file content by function/class boundaries. */
function chunkBySymbols(lines: string[]): Array<{ startLine: number; text: string }> {
  const chunks: Array<{ startLine: number; lines: string[] }> = [];
  let current: { startLine: number; lines: string[] } = { startLine: 0, lines: [] };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Detect function/class/method boundaries
    const isBoundary =
      /^\s*(?:export\s+)?(?:async\s+)?function\s+\w+/.test(line) ||
      /^\s*(?:export\s+)?(?:abstract\s+)?class\s+\w+/.test(line) ||
      /^\s*(?:export\s+)?interface\s+\w+/.test(line) ||
      /^\s*(?:async\s+)?def\s+\w+/.test(line);

    if (isBoundary && current.lines.length > 0) {
      chunks.push(current);
      current = { startLine: i, lines: [] };
    }
    current.lines.push(line);
  }

  if (current.lines.length > 0) chunks.push(current);

  return chunks.map(c => ({ startLine: c.startLine, text: c.lines.join("\n") }));
}
