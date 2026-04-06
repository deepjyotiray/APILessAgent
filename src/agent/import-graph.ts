import { promises as fs } from "node:fs";
import path from "node:path";

const GRAPH_CACHE_PATH = ".agent-memory/import-graph.json";

export interface ImportGraph {
  /** file → files it imports */
  imports: Record<string, string[]>;
  /** file → files that import it */
  importedBy: Record<string, string[]>;
  /** timestamp of last build */
  builtAt: string;
}

/**
 * Build an import graph from file contents already in memory.
 * No AST parser needed — uses regex on the content we already read.
 */
export function buildImportGraph(
  files: Array<{ path: string; content: string }>,
  allFilePaths: string[]
): ImportGraph {
  const imports: Record<string, string[]> = {};
  const importedBy: Record<string, string[]> = {};

  for (const file of files) {
    const resolved = resolveFileImports(file.path, file.content, allFilePaths);
    imports[file.path] = resolved;
    for (const dep of resolved) {
      (importedBy[dep] ??= []).push(file.path);
    }
  }

  return { imports, importedBy, builtAt: new Date().toISOString() };
}

/**
 * Get files within N hops of the given files in the import graph.
 */
export function getConnectedFiles(
  graph: ImportGraph,
  seedFiles: string[],
  maxHops: number
): string[] {
  const visited = new Set(seedFiles);
  let frontier = [...seedFiles];

  for (let hop = 0; hop < maxHops && frontier.length > 0; hop++) {
    const next: string[] = [];
    for (const file of frontier) {
      for (const dep of graph.imports[file] ?? []) {
        if (!visited.has(dep)) { visited.add(dep); next.push(dep); }
      }
      for (const dep of graph.importedBy[file] ?? []) {
        if (!visited.has(dep)) { visited.add(dep); next.push(dep); }
      }
    }
    frontier = next;
  }

  // Return only the newly discovered files (not the seeds)
  return [...visited].filter(f => !seedFiles.includes(f));
}

/**
 * Find the test file for a given source file, if it exists.
 */
export function findTestFile(filePath: string, allFiles: string[]): string | undefined {
  const base = path.basename(filePath, path.extname(filePath));
  const dir = path.dirname(filePath);
  const ext = path.extname(filePath);

  const candidates = [
    path.join(dir, `${base}.test${ext}`),
    path.join(dir, `${base}.spec${ext}`),
    path.join(dir, "__tests__", `${base}${ext}`),
    path.join(dir, "__tests__", `${base}.test${ext}`),
    // Common test directory patterns
    filePath.replace(/^src\//, "test/").replace(ext, `.test${ext}`),
    filePath.replace(/^src\//, "tests/").replace(ext, `.test${ext}`),
  ];

  return allFiles.find(f => candidates.some(c => path.normalize(c) === path.normalize(f)));
}

/** Save graph to disk cache. */
export async function saveImportGraph(root: string, graph: ImportGraph): Promise<void> {
  try {
    const target = path.join(root, GRAPH_CACHE_PATH);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, JSON.stringify(graph), "utf8");
  } catch { /* non-critical */ }
}

/** Load graph from disk cache. Returns null if stale or missing. */
export async function loadImportGraph(root: string, maxAgeMs = 300_000): Promise<ImportGraph | null> {
  try {
    const raw = await fs.readFile(path.join(root, GRAPH_CACHE_PATH), "utf8");
    const graph = JSON.parse(raw) as ImportGraph;
    if (Date.now() - new Date(graph.builtAt).getTime() > maxAgeMs) return null;
    return graph;
  } catch {
    return null;
  }
}

// --- Internal ---

function resolveFileImports(filePath: string, content: string, allFiles: string[]): string[] {
  const rawPaths: string[] = [];

  // ES imports
  for (const m of content.matchAll(/from\s+["']([^"']+)["']/g)) {
    if (m[1].startsWith(".")) rawPaths.push(m[1]);
  }
  // require()
  for (const m of content.matchAll(/require\s*\(\s*["']([^"']+)["']\s*\)/g)) {
    if (m[1].startsWith(".")) rawPaths.push(m[1]);
  }

  const dir = path.dirname(filePath);
  const resolved: string[] = [];

  for (const raw of rawPaths) {
    const base = path.normalize(path.join(dir, raw));
    // Try exact, then with extensions, then as directory index
    const candidates = [
      base,
      base + ".ts", base + ".tsx", base + ".js", base + ".jsx",
      base + ".mjs", base + ".cjs",
      path.join(base, "index.ts"), path.join(base, "index.js"),
    ];
    const match = allFiles.find(f => candidates.some(c => path.normalize(c) === path.normalize(f)));
    if (match && !resolved.includes(match)) resolved.push(match);
  }

  return resolved;
}
