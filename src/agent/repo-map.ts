import path from "node:path";
import type { SymbolEntry } from "./context-pipeline.js";
import type { ImportGraph } from "./import-graph.js";

/**
 * Build a compact repo map: a structural summary of the entire codebase
 * that fits in ~2-5k chars. Gives the LLM full orientation without
 * reading any file contents.
 *
 * Format:
 *   src/agent/orchestrator.ts
 *     class ChatGPTAgent
 *       run(userMessage, conversationId)
 *       gatherSubtaskContext(subtask, pipelineContext, log)
 *     classifyIntent(msg) → QueryIntent
 *     imports: ./tools, ./sub-agents, ./context-pipeline
 *
 * This replaces the flat file tree for planner/explorer orientation.
 */
export function buildRepoMap(
  allFiles: string[],
  symbols: SymbolEntry[],
  importGraph: ImportGraph | null
): string {
  // Group symbols by file
  const symbolsByFile = new Map<string, SymbolEntry[]>();
  for (const s of symbols) {
    const list = symbolsByFile.get(s.file) ?? [];
    list.push(s);
    symbolsByFile.set(s.file, list);
  }

  const lines: string[] = [];

  for (const filePath of allFiles) {
    const fileSymbols = symbolsByFile.get(filePath);
    const imports = importGraph?.imports[filePath];

    // Skip files with no symbols and no imports (binary, config, etc.)
    // But always include key files
    const isKeyFile = isImportantFile(filePath);
    if (!fileSymbols?.length && !imports?.length && !isKeyFile) continue;

    lines.push(filePath);

    // Show top-level symbols (classes, functions, interfaces, types)
    if (fileSymbols?.length) {
      // Group: classes first with their methods indented, then standalone functions
      const classes = fileSymbols.filter(s => s.kind === "class");
      const methods = fileSymbols.filter(s => s.kind === "method");
      const functions = fileSymbols.filter(s => s.kind === "function");
      const interfaces = fileSymbols.filter(s => s.kind === "interface");
      const types = fileSymbols.filter(s => s.kind === "type");

      for (const cls of classes) {
        lines.push(`  class ${cls.name}`);
        // Find methods that belong to this class (between this class and next class/end)
        const classLine = cls.line;
        const nextClassLine = classes.find(c => c.line > classLine)?.line ?? Infinity;
        const classMethods = methods.filter(m => m.line > classLine && m.line < nextClassLine);
        for (const m of classMethods.slice(0, 10)) {
          lines.push(`    ${m.name}()`);
        }
        if (classMethods.length > 10) {
          lines.push(`    ... +${classMethods.length - 10} methods`);
        }
      }

      for (const fn of functions.slice(0, 8)) {
        lines.push(`  fn ${fn.name}()`);
      }
      if (functions.length > 8) {
        lines.push(`  ... +${functions.length - 8} functions`);
      }

      for (const iface of interfaces.slice(0, 5)) {
        lines.push(`  interface ${iface.name}`);
      }
      if (interfaces.length > 5) {
        lines.push(`  ... +${interfaces.length - 5} interfaces`);
      }

      for (const t of types.slice(0, 5)) {
        lines.push(`  type ${t.name}`);
      }
    }

    // Show imports (compressed)
    if (imports?.length) {
      const shortImports = imports.map(i => {
        const base = path.basename(i, path.extname(i));
        return base;
      });
      lines.push(`  → imports: ${shortImports.join(", ")}`);
    }
  }

  return lines.join("\n");
}

function isImportantFile(filePath: string): boolean {
  const name = path.basename(filePath).toLowerCase();
  return [
    "package.json", "tsconfig.json", "readme.md", "agent.md",
    "index.ts", "index.js", "main.ts", "main.js", "main.cjs",
  ].includes(name);
}
