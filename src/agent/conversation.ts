import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

const CONVERSATIONS_DIR = ".agent-conversations";

export interface ConversationMessage {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolResult?: { ok: boolean; message: string };
  timestamp: string;
}

export interface Conversation {
  id: string;
  title: string;
  workspaceRoot: string;
  plannerBackend: string;
  createdAt: string;
  updatedAt: string;
  messages: ConversationMessage[];
}

export class ConversationStore {
  constructor(private readonly root: string) {}

  private dir(): string {
    return path.join(this.root, CONVERSATIONS_DIR);
  }

  private filePath(id: string): string {
    return path.join(this.dir(), `${id}.json`);
  }

  async ensure(): Promise<void> {
    await fs.mkdir(this.dir(), { recursive: true });
  }

  create(title: string, plannerBackend: string): Conversation {
    const now = new Date().toISOString();
    return {
      id: randomUUID(),
      title,
      workspaceRoot: this.root,
      plannerBackend,
      createdAt: now,
      updatedAt: now,
      messages: []
    };
  }

  async save(conv: Conversation): Promise<void> {
    await this.ensure();
    conv.updatedAt = new Date().toISOString();
    await fs.writeFile(this.filePath(conv.id), JSON.stringify(conv, null, 2), "utf8");
  }

  async load(id: string): Promise<Conversation> {
    const raw = await fs.readFile(this.filePath(id), "utf8");
    return JSON.parse(raw) as Conversation;
  }

  async list(): Promise<Array<Pick<Conversation, "id" | "title" | "plannerBackend" | "createdAt" | "updatedAt"> & { messageCount: number }>> {
    await this.ensure();
    const entries = await fs.readdir(this.dir());
    const results = [];
    for (const entry of entries.filter((e) => e.endsWith(".json"))) {
      try {
        const conv = await this.load(entry.replace(/\.json$/, ""));
        results.push({
          id: conv.id,
          title: conv.title,
          plannerBackend: conv.plannerBackend,
          createdAt: conv.createdAt,
          updatedAt: conv.updatedAt,
          messageCount: conv.messages.length
        });
      } catch { continue; }
    }
    return results.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async delete(id: string): Promise<boolean> {
    try {
      await fs.unlink(this.filePath(id));
      return true;
    } catch {
      return false;
    }
  }

  addMessage(conv: Conversation, msg: Omit<ConversationMessage, "id" | "timestamp">): ConversationMessage {
    const full: ConversationMessage = {
      ...msg,
      id: randomUUID(),
      timestamp: new Date().toISOString()
    };
    conv.messages.push(full);
    return full;
  }

  getRecentMessages(conv: Conversation, count: number): ConversationMessage[] {
    return conv.messages.slice(-count);
  }

  buildConversationContext(conv: Conversation, maxChars: number): string {
    const msgs = conv.messages;
    const lines: string[] = [];
    let chars = 0;
    for (let i = msgs.length - 1; i >= 0 && chars < maxChars; i--) {
      const m = msgs[i];
      const line = m.role === "tool"
        ? `[tool:${m.toolName}] ${m.toolResult?.ok ? "ok" : "failed"}: ${m.content.slice(0, 200)}`
        : `[${m.role}] ${m.content}`;
      chars += line.length;
      lines.unshift(line);
    }
    return lines.join("\n");
  }
}
