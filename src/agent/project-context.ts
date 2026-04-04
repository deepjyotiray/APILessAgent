import { promises as fs } from "node:fs";
import path from "node:path";

const CONTEXT_FILES = ["AGENT.md", "CHATGPT-AGENT.md", "CLAUDE.md", ".agent-rules.md"];

export async function loadProjectContext(root: string): Promise<string> {
  for (const name of CONTEXT_FILES) {
    try {
      const content = await fs.readFile(path.join(root, name), "utf8");
      return `## Project Instructions (from ${name})\n${content}`;
    } catch { continue; }
  }
  return "";
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
