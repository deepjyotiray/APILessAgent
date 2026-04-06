import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const INSTRUCTION_FILENAMES = [
  "AGENT.md",
  "AGENT.local.md",
  ".agent/AGENT.md",
  ".agent/instructions.md",
];

const MAX_INSTRUCTION_FILE_CHARS = 4_000;
const MAX_TOTAL_INSTRUCTION_CHARS = 12_000;

export interface InstructionFile {
  filePath: string;
  content: string;
}

/**
 * Walk from `root` up to the filesystem root, collecting instruction files
 * at each ancestor. Deduplicates by content hash. Enforces per-file and
 * total char budgets. Matches Claude Code's discover_instruction_files behaviour.
 */
export async function loadProjectContext(root: string): Promise<string> {
  const files = await discoverInstructionFiles(root);
  if (files.length === 0) return "";
  return renderInstructionFiles(files);
}

async function discoverInstructionFiles(cwd: string): Promise<InstructionFile[]> {
  const ancestors: string[] = [];
  let cursor: string | null = path.resolve(cwd);
  while (cursor) {
    ancestors.push(cursor);
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  ancestors.reverse(); // root-first, like Claude Code

  const files: InstructionFile[] = [];
  for (const dir of ancestors) {
    for (const name of INSTRUCTION_FILENAMES) {
      const filePath = path.join(dir, name);
      try {
        const content = await fs.readFile(filePath, "utf8");
        if (content.trim().length > 0) {
          files.push({ filePath, content });
        }
      } catch { /* not found, skip */ }
    }
  }

  return dedupeByContent(files);
}

function dedupeByContent(files: InstructionFile[]): InstructionFile[] {
  const seen = new Set<string>();
  return files.filter((f) => {
    const hash = createHash("sha256").update(normalise(f.content)).digest("hex");
    if (seen.has(hash)) return false;
    seen.add(hash);
    return true;
  });
}

function normalise(content: string): string {
  return content.replace(/\n{3,}/g, "\n\n").trim();
}

function truncate(content: string, limit: number): string {
  const trimmed = content.trim();
  if (trimmed.length <= limit) return trimmed;
  return trimmed.slice(0, limit) + "\n\n[truncated]";
}

function renderInstructionFiles(files: InstructionFile[]): string {
  const sections: string[] = ["# Agent instructions"];
  let remaining = MAX_TOTAL_INSTRUCTION_CHARS;

  for (const file of files) {
    if (remaining <= 0) {
      sections.push("_Additional instruction content omitted after reaching the prompt budget._");
      break;
    }
    const budget = Math.min(MAX_INSTRUCTION_FILE_CHARS, remaining);
    const rendered = truncate(file.content, budget);
    remaining -= rendered.length;
    sections.push(`## ${path.basename(file.filePath)} (${path.dirname(file.filePath)})`);
    sections.push(rendered);
  }

  return sections.join("\n\n");
}

export async function initProjectContext(root: string): Promise<string> {
  const target = path.join(root, "AGENT.md");
  try {
    await fs.access(target);
    return target;
  } catch {
    await fs.writeFile(target, [
      "# Project Instructions",
      "",
      "This file is automatically loaded by the agent at the start of every session.",
      "Use it to describe your project, coding conventions, and preferences.",
      "",
      "## Project Overview",
      "",
      "(Describe what this project does.)",
      "",
      "## Coding Conventions",
      "",
      "- (List your preferred patterns, naming conventions, etc.)",
      "",
      "## Important Notes",
      "",
      "- (Anything the agent should always keep in mind.)",
      ""
    ].join("\n"), "utf8");
    return target;
  }
}
