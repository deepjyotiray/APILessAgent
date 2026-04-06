/**
 * Project Knowledge Base: auto-generates structured maps of the codebase
 * using local Ollama. Cached per project in .agent-memory/.
 *
 * Maps generated:
 * - project-summary.md    — what the project does, tech stack, entry points
 * - architecture.md       — module responsibilities, layers, data flow
 * - file-roles.md         — every file's purpose in one line
 * - api-surface.md        — routes, endpoints, exported functions
 * - patterns.md           — coding patterns, conventions, idioms
 * - dependency-map.md     — import graph in human-readable form
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import type { SymbolEntry } from "./context-pipeline.js";
import type { ImportGraph } from "./import-graph.js";

const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";
const KB_MODEL = process.env.KB_MODEL ?? "qwen2.5-coder:7b";
const KB_TIMEOUT_MS = 30_000;
const MEMORY_DIR = ".agent-memory";

interface KBInput {
  repoMap: string;
  fileContents: Array<{ path: string; content: string }>;
  symbols: SymbolEntry[];
  importGraph: ImportGraph | null;
  packageJson: string | null;
  readme: string | null;
}

/**
 * Check if knowledge base needs building (templates still empty).
 */
export async function needsKnowledgeBase(root: string): Promise<boolean> {
  try {
    const summary = await fs.readFile(path.join(root, MEMORY_DIR, "project-summary.md"), "utf8");
    return summary.includes("(Describe what this project does");
  } catch {
    return true;
  }
}

/**
 * Build all knowledge base maps from project data.
 * Runs multiple Ollama calls in sequence (~15-20s total).
 */
export async function buildKnowledgeBase(
  root: string,
  input: KBInput,
  onProgress?: (step: string) => void
): Promise<void> {
  const available = await isOllamaAvailable();
  if (!available) return;

  // 1. File roles — one line per file
  onProgress?.("Mapping file roles…");
  const fileRoles = await generateFileRoles(input);

  // 2. Project summary
  onProgress?.("Generating project summary…");
  const summary = await generateSummary(input, fileRoles);

  // 3. Architecture
  onProgress?.("Mapping architecture…");
  const architecture = await generateArchitecture(input, fileRoles);

  // 4. API surface
  onProgress?.("Mapping API surface…");
  const apiSurface = await generateApiSurface(input);

  // 5. Dependency map
  onProgress?.("Building dependency map…");
  const depMap = buildDependencyMap(input.importGraph);

  // 6. Patterns
  onProgress?.("Detecting patterns…");
  const patterns = await generatePatterns(input);

  // Write all maps
  const dir = path.join(root, MEMORY_DIR);
  await fs.mkdir(dir, { recursive: true });

  if (fileRoles) await fs.writeFile(path.join(dir, "file-roles.md"), fileRoles, "utf8");
  if (summary) await fs.writeFile(path.join(dir, "project-summary.md"), summary, "utf8");
  if (architecture) await fs.writeFile(path.join(dir, "architecture.md"), architecture, "utf8");
  if (apiSurface) await fs.writeFile(path.join(dir, "api-surface.md"), apiSurface, "utf8");
  if (depMap) await fs.writeFile(path.join(dir, "dependency-map.md"), depMap, "utf8");
  if (patterns) await fs.writeFile(path.join(dir, "patterns.md"), patterns, "utf8");

  onProgress?.("Knowledge base ready");
}

/**
 * Enrich knowledge base with ChatGPT's deeper analysis.
 * Called after a successful ChatGPT analysis response.
 */
export async function enrichFromChatGPT(
  root: string,
  chatgptAnalysis: string
): Promise<void> {
  if (!chatgptAnalysis || chatgptAnalysis.length < 100) return;

  const dir = path.join(root, MEMORY_DIR);
  await fs.mkdir(dir, { recursive: true });

  // Save ChatGPT's analysis as active context
  await fs.writeFile(
    path.join(dir, "active-context.md"),
    `# Active Context\n\nLast analysis (${new Date().toISOString()}):\n\n${chatgptAnalysis}\n`,
    "utf8"
  );

  // If project summary is still a template, use ChatGPT's analysis
  try {
    const existing = await fs.readFile(path.join(dir, "project-summary.md"), "utf8");
    if (existing.includes("(Describe what this project does")) {
      await fs.writeFile(
        path.join(dir, "project-summary.md"),
        `# Project Summary\n\n${chatgptAnalysis.slice(0, 3000)}\n`,
        "utf8"
      );
    }
  } catch { /* file doesn't exist, skip */ }
}

/**
 * Load all knowledge base content as a single context string.
 */
export async function loadKnowledgeBase(root: string): Promise<string> {
  const dir = path.join(root, MEMORY_DIR);
  const files = [
    "project-summary.md",
    "architecture.md",
    "file-roles.md",
    "api-surface.md",
    "dependency-map.md",
    "patterns.md",
  ];

  const parts: string[] = [];
  for (const f of files) {
    try {
      const content = await fs.readFile(path.join(dir, f), "utf8");
      // Skip empty templates
      if (content.includes("(Describe what") || content.includes("(Document the") || content.includes("(Record recurring") || content.length < 50) continue;
      parts.push(content.trim());
    } catch { continue; }
  }

  return parts.join("\n\n---\n\n");
}

// --- Generators ---

async function generateFileRoles(input: KBInput): Promise<string | null> {
  const prompt = `Given this repo map, write ONE line per file describing its role. Format: "path — role". Be specific, not generic. Max 60 words per line.

${input.repoMap.slice(0, 6000)}`;

  const result = await ollamaGenerate(prompt);
  return result ? `# File Roles\n\n${result}` : null;
}

async function generateSummary(input: KBInput, fileRoles: string | null): Promise<string | null> {
  const context = [
    input.packageJson ? `package.json:\n${input.packageJson.slice(0, 1500)}` : "",
    input.readme ? `README (first 1000 chars):\n${input.readme.slice(0, 1000)}` : "",
    fileRoles ? `File roles:\n${fileRoles.slice(0, 2000)}` : "",
  ].filter(Boolean).join("\n\n");

  const prompt = `Write a concise project summary (200 words max). Cover: what it does, tech stack, main entry points, how to run it.

${context}`;

  const result = await ollamaGenerate(prompt);
  return result ? `# Project Summary\n\n${result}` : null;
}

async function generateArchitecture(input: KBInput, fileRoles: string | null): Promise<string | null> {
  const symbolSummary = summarizeSymbols(input.symbols);
  const context = [
    fileRoles ? fileRoles.slice(0, 2000) : "",
    symbolSummary ? `Key symbols:\n${symbolSummary}` : "",
    input.repoMap.slice(0, 3000),
  ].filter(Boolean).join("\n\n");

  const prompt = `Describe the architecture in 200 words max. Cover: layers/modules, data flow, key classes, how components connect.

${context}`;

  const result = await ollamaGenerate(prompt);
  return result ? `# Architecture\n\n${result}` : null;
}

async function generateApiSurface(input: KBInput): Promise<string | null> {
  // Extract routes, exports, handlers from file contents
  const apiHints: string[] = [];
  for (const f of input.fileContents) {
    // HTTP routes
    const routes = f.content.match(/\b(get|post|put|delete|patch)\s*\(\s*["'`][^"'`]+["'`]/gi) ?? [];
    const pathMatches = f.content.match(/["'`]\/(api|webhook|auth|health|events)[^"'`]*["'`]/g) ?? [];
    if (routes.length > 0 || pathMatches.length > 0) {
      apiHints.push(`${f.path}: ${[...routes, ...pathMatches].slice(0, 10).join(", ")}`);
    }
    // Exports
    const exports = f.content.match(/export\s+(async\s+)?function\s+\w+|export\s+class\s+\w+|module\.exports/g) ?? [];
    if (exports.length > 0) {
      apiHints.push(`${f.path} exports: ${exports.slice(0, 8).join(", ")}`);
    }
  }

  if (apiHints.length === 0) return null;

  const prompt = `List the API surface of this project. Include: HTTP routes, exported functions/classes, webhook endpoints. Bullet points, max 150 words.

${apiHints.join("\n")}`;

  const result = await ollamaGenerate(prompt);
  return result ? `# API Surface\n\n${result}` : null;
}

function buildDependencyMap(graph: ImportGraph | null): string | null {
  if (!graph) return null;

  const lines: string[] = ["# Dependency Map\n"];

  // Find entry points (files imported by many, importing few)
  const importCounts = new Map<string, number>();
  for (const deps of Object.values(graph.importedBy)) {
    for (const d of deps) {
      importCounts.set(d, (importCounts.get(d) ?? 0) + 1);
    }
  }

  // Most-imported files
  const sorted = [...importCounts.entries()].sort((a, b) => b[1] - a[1]);
  if (sorted.length > 0) {
    lines.push("## Most-imported files");
    for (const [file, count] of sorted.slice(0, 10)) {
      const importedBy = graph.importedBy[file] ?? [];
      lines.push(`- **${file}** (imported by ${count}): ${importedBy.slice(0, 5).join(", ")}`);
    }
  }

  // Dependency chains
  lines.push("\n## Import chains");
  for (const [file, deps] of Object.entries(graph.imports)) {
    if (deps.length > 0) {
      lines.push(`- ${file} → ${deps.join(", ")}`);
    }
  }

  return lines.join("\n");
}

async function generatePatterns(input: KBInput): Promise<string | null> {
  // Sample code snippets for pattern detection
  const samples: string[] = [];
  for (const f of input.fileContents.slice(0, 5)) {
    samples.push(`--- ${f.path} (first 500 chars) ---\n${f.content.slice(0, 500)}`);
  }

  const prompt = `Identify coding patterns and conventions in this project. Cover: naming conventions, error handling style, async patterns, module structure, testing approach. Bullet points, max 150 words.

${samples.join("\n\n")}`;

  const result = await ollamaGenerate(prompt);
  return result ? `# Coding Patterns\n\n${result}` : null;
}

// --- Helpers ---

function summarizeSymbols(symbols: SymbolEntry[]): string {
  const byKind = new Map<string, string[]>();
  for (const s of symbols) {
    const list = byKind.get(s.kind) ?? [];
    list.push(`${s.name} (${s.file})`);
    byKind.set(s.kind, list);
  }
  const lines: string[] = [];
  for (const [kind, names] of byKind) {
    lines.push(`${kind}: ${names.slice(0, 10).join(", ")}${names.length > 10 ? ` +${names.length - 10} more` : ""}`);
  }
  return lines.join("\n");
}

async function ollamaGenerate(prompt: string): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), KB_TIMEOUT_MS);
    const res = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: KB_MODEL, prompt, stream: false }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const body = await res.json() as { response?: string };
    return (body.response ?? "").trim() || null;
  } catch {
    return null;
  }
}

async function isOllamaAvailable(): Promise<boolean> {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}
