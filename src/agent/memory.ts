import { promises as fs } from "node:fs";
import path from "node:path";

const MEMORY_DIR = ".agent-memory";

export interface MemoryEntry {
  key: string;
  content: string;
  updatedAt: string;
}

export class MemoryStore {
  constructor(private readonly root: string) {}

  private dir(): string {
    return path.join(this.root, MEMORY_DIR);
  }

  private filePath(key: string): string {
    return path.join(this.dir(), `${sanitize(key)}.md`);
  }

  async ensure(): Promise<void> {
    await fs.mkdir(this.dir(), { recursive: true });
  }

  async read(key: string): Promise<string | null> {
    try {
      return await fs.readFile(this.filePath(key), "utf8");
    } catch {
      return null;
    }
  }

  async write(key: string, content: string): Promise<void> {
    await this.ensure();
    await fs.writeFile(this.filePath(key), content, "utf8");
  }

  async append(key: string, content: string): Promise<void> {
    await this.ensure();
    const existing = (await this.read(key)) ?? "";
    const separator = existing && !existing.endsWith("\n") ? "\n" : "";
    await fs.writeFile(this.filePath(key), `${existing}${separator}${content}\n`, "utf8");
  }

  async list(): Promise<MemoryEntry[]> {
    await this.ensure();
    const entries = await fs.readdir(this.dir());
    const results: MemoryEntry[] = [];
    for (const entry of entries.filter((e) => e.endsWith(".md"))) {
      const key = entry.replace(/\.md$/, "");
      const content = await fs.readFile(path.join(this.dir(), entry), "utf8");
      const stat = await fs.stat(path.join(this.dir(), entry));
      results.push({ key, content, updatedAt: stat.mtime.toISOString() });
    }
    return results.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async delete(key: string): Promise<boolean> {
    try {
      await fs.unlink(this.filePath(key));
      return true;
    } catch {
      return false;
    }
  }

  async buildContextBlock(): Promise<string> {
    const entries = await this.list();
    if (!entries.length) return "";
    return entries
      .map((e) => `## Memory: ${e.key}\n${e.content}`)
      .join("\n\n");
  }

  async initDefaults(): Promise<void> {
    await this.ensure();
    const defaults: Record<string, string> = {
      "project-summary": "# Project Summary\n\n(Describe what this project does, its main purpose, and key technologies.)\n",
      "architecture": "# Architecture\n\n(Document the project structure, key modules, data flow, and design decisions.)\n",
      "patterns": "# Coding Patterns\n\n(Record recurring patterns, conventions, and style preferences used in this codebase.)\n",
      "active-context": "# Active Context\n\n(Track what you're currently working on, recent decisions, and next steps.)\n",
      "learnings": "# Learnings\n\n(Capture things learned during development — gotchas, workarounds, important discoveries.)\n"
    };
    for (const [key, content] of Object.entries(defaults)) {
      if (!(await this.read(key))) {
        await this.write(key, content);
      }
    }
  }
}

function sanitize(key: string): string {
  return key.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100);
}
