import type { PlannerAdapter, PlannerSession } from "./types.js";
import { LocalToolRegistry } from "./tools.js";
import { MemoryStore } from "./memory.js";
import { loadProjectContext } from "./project-context.js";

const MAX_ITERATIONS = 6;
const MAX_CONTEXT_CHARS = 40000;

export interface AgentAction { action: string; [key: string]: unknown; }
export interface AgentEvent { type: "init" | "thinking" | "tool_call" | "tool_result" | "answer" | "error" | "step"; data: unknown; }
export type AgentEventCallback = (event: AgentEvent) => void;

export class ChatGPTAgent {
  private sessions = new Map<string, PlannerSession>();

  constructor(
    private readonly planner: PlannerAdapter,
    private readonly tools: LocalToolRegistry,
    private root: string,
    private readonly onEvent?: AgentEventCallback
  ) {}

  setRoot(newRoot: string): void { this.root = newRoot; }

  resetSession(conversationId?: string): void {
    if (conversationId) this.sessions.delete(conversationId);
    else this.sessions.clear();
  }

  async run(userMessage: string, conversationId: string = "default"): Promise<string> {
    let session = this.sessions.get(conversationId);
    const isFirst = !session;

    if (!session) {
      this.emit({ type: "init", data: "Starting new agent session…" });
      session = await this.planner.startSession();
      this.sessions.set(conversationId, session);
    }

    // Build prompt
    const prompt = await this.buildPrompt(userMessage, isFirst);
    this.emit({ type: "thinking", data: { message: userMessage } });

    let result = await this.planner.sendTurn(session, prompt);
    if (!result.ok || !result.raw) {
      // Retry with fresh session
      this.sessions.delete(conversationId);
      session = await this.planner.startSession();
      this.sessions.set(conversationId, session);
      result = await this.planner.sendTurn(session, prompt);
      if (!result.ok || !result.raw) return `⚠️ ${result.message}`;
    }

    let response = result.raw;
    const actionLog: string[] = [];

    // Multi-turn loop: detect actions in response, execute, send back
    for (let round = 0; round < MAX_ITERATIONS; round++) {
      const actions = this.parseActions(response);

      if (!actions.length) break; // Pure text answer, no actions needed

      let needsFollowUp = false;
      const followUpParts: string[] = [];

      for (const action of actions) {
        if (action.type === "read") {
          this.emit({ type: "tool_call", data: { tool: "read_file", reason: `Reading ${action.path}` } });
          const r = await this.execTool("read_file", { path: action.path });
          if (r.ok) {
            const content = (r.data as any)?.content ?? "";
            followUpParts.push(`Contents of ${action.path}:\n\`\`\`\n${content.slice(0, 6000)}\n\`\`\``);
            actionLog.push(`📖 Read \`${action.path}\``);
          } else {
            followUpParts.push(`Could not read ${action.path}: ${r.message}`);
            actionLog.push(`❌ Failed to read \`${action.path}\``);
          }
          needsFollowUp = true;

        } else if (action.type === "write" && action.path && action.content) {
          this.emit({ type: "tool_call", data: { tool: "write_file", reason: `Writing ${action.path}` } });
          const r = await this.execTool("write_file", { path: action.path, content: action.content });
          if (r.ok) {
            actionLog.push(`✅ Wrote \`${action.path}\``);
            // Get diff
            const diff = await this.execTool("git_diff", { path: action.path });
            const diffText = (diff.data as any)?.stdout ?? "";
            if (diffText.trim()) actionLog.push(`\`\`\`diff\n${diffText.slice(0, 3000)}\n\`\`\``);
          } else {
            actionLog.push(`❌ Failed to write \`${action.path}\`: ${r.message}`);
          }

        } else if (action.type === "run" && action.command) {
          this.emit({ type: "tool_call", data: { tool: "run_command", reason: action.command } });
          const r = await this.execTool("run_command", { command: action.command });
          const output = ((r.data as any)?.stdout ?? "") + ((r.data as any)?.stderr ?? "");
          actionLog.push(`🔧 \`${action.command}\`\n\`\`\`\n${output.trim().slice(0, 2000)}\n\`\`\``);
          if (!r.ok) needsFollowUp = true;
          followUpParts.push(`Command \`${action.command}\` output:\n\`\`\`\n${output.trim().slice(0, 3000)}\n\`\`\``);

        } else if (action.type === "search" && action.query) {
          this.emit({ type: "tool_call", data: { tool: "search", reason: action.query } });
          const r = await this.execTool("search", { pattern: action.query });
          const output = (r.data as any)?.stdout ?? "";
          followUpParts.push(`Search results for "${action.query}":\n\`\`\`\n${output.slice(0, 3000)}\n\`\`\``);
          actionLog.push(`🔍 Searched \`${action.query}\``);
          needsFollowUp = true;
        }
      }

      // If ChatGPT needs more info, send it back in the same chat
      if (needsFollowUp && followUpParts.length) {
        const followUp = followUpParts.join("\n\n") + "\n\nNow continue with the task. If you need to write/update files, output the full file content in a code block with the file path as the language tag.";
        result = await this.planner.sendTurn(session, followUp);
        if (!result.ok || !result.raw) break;
        response = result.raw;
        continue;
      }

      break; // All actions were writes/runs, no follow-up needed
    }

    // Combine action log + ChatGPT's response
    if (actionLog.length) {
      return actionLog.join("\n\n") + "\n\n" + response;
    }
    return response;
  }

  private async buildPrompt(userMessage: string, isFirst: boolean): Promise<string> {
    const parts: string[] = [];

    if (isFirst) {
      const projectCtx = await loadProjectContext(this.root);
      const memoryCtx = await new MemoryStore(this.root).buildContextBlock();
      const fileTree = await this.getFileTree();

      parts.push("You are a coding assistant with full access to the user's project.");
      parts.push("I will execute any file operations or commands for you.");
      parts.push("");
      parts.push("CONVENTIONS:");
      parts.push("- When you need to see a file, say: \"Let me read path/to/file\" or \"I need to check path/to/file\"");
      parts.push("- When you want to write/update a file, output the COMPLETE file in a code block with the path as the language tag:");
      parts.push("  ```path/to/file.ts");
      parts.push("  // full file content");
      parts.push("  ```");
      parts.push("- When you want to run a command, say: \"Let me run: `command here`\"");
      parts.push("- When you want to search, say: \"Let me search for: pattern\"");
      parts.push("- Be direct. Don't ask permission. Just do it.");
      parts.push("");
      parts.push(`WORKSPACE: ${this.root}`);
      if (fileTree) parts.push(`\nFILE TREE:\n${fileTree}`);
      if (projectCtx) parts.push(`\n${projectCtx.slice(0, 2000)}`);
      if (memoryCtx) parts.push(`\n${memoryCtx.slice(0, 2000)}`);
    }

    // Pre-read files that seem relevant to the task
    const relevantFiles = this.guessRelevantFiles(userMessage);
    if (relevantFiles.length) {
      this.emit({ type: "step", data: { step: `📖 Pre-reading: ${relevantFiles.join(", ")}` } });
      for (const f of relevantFiles) {
        const r = await this.execTool("read_file", { path: f });
        if (r.ok) {
          const content = (r.data as any)?.content ?? "";
          parts.push(`\n--- ${f} ---\n${content.slice(0, 5000)}`);
        }
      }
    }

    parts.push(`\nUSER: ${userMessage}`);

    let prompt = parts.join("\n");
    if (prompt.length > MAX_CONTEXT_CHARS) {
      prompt = prompt.slice(0, MAX_CONTEXT_CHARS) + "\n...[truncated]";
    }
    return prompt;
  }

  private guessRelevantFiles(message: string): string[] {
    const lower = message.toLowerCase();
    const files: string[] = [];
    if (lower.includes("readme")) files.push("README.md");
    if (lower.includes("package") || lower.includes("dependencies")) files.push("package.json");
    if (lower.includes("config") || lower.includes("tsconfig")) files.push("tsconfig.json");
    if (lower.includes("coupon")) files.push("public/coupons.json");
    if (lower.includes("agent.md") || lower.includes("project context")) files.push("AGENT.md");
    // Extract explicit file paths from the message
    const pathMatches = message.match(/[\w./\-]+\.\w{1,10}/g) ?? [];
    for (const p of pathMatches) {
      if (!files.includes(p) && p.includes(".")) files.push(p);
    }
    return files.slice(0, 5);
  }

  private parseActions(text: string): Array<{type: string; path?: string; content?: string; command?: string; query?: string}> {
    const actions: Array<{type: string; path?: string; content?: string; command?: string; query?: string}> = [];

    // Detect file writes: ```path/to/file.ext\n...\n```
    const writeRegex = /```([\w./\-]+\.\w{1,10})\n([\s\S]*?)```/g;
    let m;
    while ((m = writeRegex.exec(text)) !== null) {
      const path = m[1];
      const content = m[2];
      // Skip common language tags that aren't file paths
      if (["json", "bash", "sh", "diff", "text", "txt", "md", "markdown", "javascript", "typescript", "ts", "js", "html", "css", "python", "py", "yaml", "yml", "xml", "sql", "plaintext"].includes(path.toLowerCase())) continue;
      if (content.trim().length > 0) {
        actions.push({ type: "write", path, content });
      }
    }

    // Detect file read requests: "let me read X", "I need to check X", "inspect X"
    const readRegex = /(?:let me (?:read|check|inspect|look at|examine|open)|I need to (?:read|check|inspect|see|look at)|reading|checking)\s+[`"]?([\w./\-]+\.\w{1,10})[`"]?/gi;
    while ((m = readRegex.exec(text)) !== null) {
      actions.push({ type: "read", path: m[1] });
    }

    // Detect commands: "let me run: `cmd`" or "run `cmd`" or "execute `cmd`"
    const cmdRegex = /(?:let me run|run|execute|running)[:\s]+`([^`]+)`/gi;
    while ((m = cmdRegex.exec(text)) !== null) {
      actions.push({ type: "run", command: m[1].trim() });
    }

    // Detect search: "let me search for: pattern" or "search for pattern"
    const searchRegex = /(?:let me search|search|searching|grep)\s+(?:for[:\s]+)?[`"]?([^`"\n]+)[`"]?/gi;
    while ((m = searchRegex.exec(text)) !== null) {
      const query = m[1].trim();
      if (query.length > 2 && query.length < 100) {
        actions.push({ type: "search", query });
      }
    }

    return actions;
  }

  private async execTool(name: string, args: Record<string, unknown>) {
    return this.tools.execute(name as any, args, {
      root: this.root, safetyMode: "auto", task: this.makeDummyTask(),
      saveCheckpoint: async () => "", loadCheckpoint: async () => ({} as any)
    });
  }

  private async getFileTree(): Promise<string> {
    try {
      const r = await this.execTool("list_files", { path: ".", maxDepth: 2 });
      if (r.ok && r.data) return ((r.data as any).files as string[]).slice(0, 80).join("\n");
    } catch {}
    return "";
  }

  private makeDummyTask(): any {
    return {
      id: "agent", goal: "", root: this.root, plannerBackend: this.planner.name,
      safetyMode: "auto", status: "running", createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(), steps: [], changedFiles: [],
      verification: { sawGitDiff: false, sawVerification: false }
    };
  }

  private emit(event: AgentEvent): void { this.onEvent?.(event); }
}
