import { promises as fs } from "node:fs";
import path from "node:path";
import type { PlannerAdapter, PlannerSession } from "./types.js";
import { LocalToolRegistry } from "./tools.js";
import { MemoryStore } from "./memory.js";
import { loadProjectContext } from "./project-context.js";
import { SubAgentRunner } from "./sub-agents.js";
import type { SubTask } from "./sub-agents.js";

export interface AgentEvent {
  type: "init" | "thinking" | "tool_call" | "tool_result" | "answer" | "error" | "step";
  data: unknown;
}
export type AgentEventCallback = (event: AgentEvent) => void;

export class ChatGPTAgent {
  private sessions = new Map<string, PlannerSession>();
  private agents: SubAgentRunner;

  constructor(
    private readonly chatgpt: PlannerAdapter,
    private readonly tools: LocalToolRegistry,
    private root: string,
    private readonly onEvent?: AgentEventCallback
  ) {
    this.agents = new SubAgentRunner(chatgpt, onEvent);
  }

  setRoot(r: string): void { this.root = r; }
  resetSession(id?: string): void {
    if (id) this.sessions.delete(id); else this.sessions.clear();
    // Also reset sub-agent sessions so they start fresh
    this.agents.resetSession();
  }

  async run(userMessage: string, conversationId = "default"): Promise<string> {
    // Simple messages — no agents needed
    if (this.isSimpleMessage(userMessage)) {
      this.emit({ type: "init", data: "Processing…" });
      const session = await this.getSession(conversationId);
      const result = await this.chatgpt.sendTurn(session, userMessage);
      return result.raw ?? result.message;
    }

    const log: string[] = [];

    // Step 1: Get file tree
    this.emit({ type: "init", data: "Scanning project…" });
    const fileTree = await this.getFileTree();
    log.push(`📂 Scanned project`);

    // Step 2: Plan — break task into subtasks
    const plan = await this.agents.plan(userMessage, fileTree);
    log.push(`📋 Plan: ${plan.complexity} (${plan.subtasks.length} steps)`);
    for (const st of plan.subtasks) {
      log.push(`  → [${st.role}] ${st.description}`);
    }
    this.emit({ type: "step", data: { step: `📋 ${plan.complexity}: ${plan.subtasks.length} subtasks` } });

    // Step 3: Execute each subtask
    let explorerSummary = "";

    for (let i = 0; i < plan.subtasks.length; i++) {
      const subtask = plan.subtasks[i];
      this.emit({ type: "step", data: { step: `[${i + 1}/${plan.subtasks.length}] ${subtask.role}: ${subtask.description.slice(0, 80)}` } });

      switch (subtask.role) {
        case "explore": {
          const fileContents = await this.readFiles(subtask.files, log);
          const result = await this.agents.explore(subtask.description, fileContents);
          explorerSummary = result.output;
          log.push(`🔍 Explorer: ${result.output.slice(0, 200)}`);
          break;
        }

        case "edit": {
          const fileContents = await this.readFiles(subtask.files, log);
          const result = await this.agents.edit(subtask.description, fileContents, explorerSummary);
          const editLog = await this.executeActions(result.output, log);
          break;
        }

        case "write": {
          const fileContents = await this.readFiles(subtask.files, log);
          const result = await this.agents.write(subtask.description, fileContents, explorerSummary);
          await this.executeActions(result.output, log);
          break;
        }

        case "review": {
          const diff = await this.getDiff();
          let testOutput = "";
          // Run tests if available
          const testResult = await this.exec("run_build", {});
          if (testResult.ok) {
            testOutput = ((testResult.data as any)?.stdout ?? "") + ((testResult.data as any)?.stderr ?? "");
          }
          const result = await this.agents.review(diff, testOutput);
          log.push(`🔎 Review: ${result.success ? "PASS ✅" : "ISSUES FOUND ❌"}`);
          log.push(result.output.slice(0, 500));

          // If review found issues and produced patches, execute them
          if (!result.success) {
            await this.executeActions(result.output, log);
          }
          break;
        }

        case "run": {
          const cmd = subtask.description.match(/`([^`]+)`/)?.[1] ?? subtask.description;
          this.emit({ type: "tool_call", data: { tool: "run_command", reason: cmd } });
          const result = await this.exec("run_command", { command: cmd });
          const out = ((result.data as any)?.stdout ?? "") + ((result.data as any)?.stderr ?? "");
          log.push(`🔧 \`${cmd}\`\n\`\`\`\n${out.trim().slice(0, 2000)}\n\`\`\``);
          break;
        }
      }
    }

    return log.join("\n\n");
  }

  // --- Execute PATCH/CREATE/RUN/SEARCH actions from agent output ---

  private async executeActions(agentOutput: string, log: string[]): Promise<void> {
    // PATCH blocks
    const patchRegex = /PATCH:\s*([\w./\\-]+\.[\w]{1,10})\s*\n<<<<<<< BEFORE\n([\s\S]*?)\n=======\n([\s\S]*?)\n>>>>>>> AFTER/g;
    let m;
    while ((m = patchRegex.exec(agentOutput)) !== null) {
      const filePath = m[1].trim();
      const before = m[2];
      const after = m[3];
      this.emit({ type: "tool_call", data: { tool: "replace_text", reason: `Patching ${filePath}` } });
      const result = await this.exec("replace_text", { path: filePath, oldText: before, newText: after });
      if (result.ok) {
        log.push(`✅ Patched \`${filePath}\``);
        const diff = await this.exec("git_diff", { path: filePath });
        const d = (diff.data as any)?.stdout ?? "";
        if (d.trim()) log.push("```diff\n" + d.slice(0, 3000) + "\n```");
      } else {
        log.push(`❌ Patch failed on \`${filePath}\`: ${result.message}`);
      }
    }

    // CREATE blocks
    const createRegex = /CREATE:\s*([\w./\\-]+\.[\w]{1,10})\s*\n([\s\S]*?)\nEND_CREATE/g;
    while ((m = createRegex.exec(agentOutput)) !== null) {
      const filePath = m[1].trim();
      const content = m[2];
      this.emit({ type: "tool_call", data: { tool: "write_file", reason: `Creating ${filePath}` } });
      const result = await this.exec("write_file", { path: filePath, content });
      if (result.ok) {
        log.push(`✅ Created \`${filePath}\``);
      } else {
        log.push(`❌ Failed to create \`${filePath}\`: ${result.message}`);
      }
    }

    // RUN commands
    const runRegex = /^RUN:\s*`?([^`\n]+)`?\s*$/gm;
    while ((m = runRegex.exec(agentOutput)) !== null) {
      const cmd = m[1].trim();
      if (cmd.match(/^(npm|node|npx|git|cargo|python|pip|make|docker|curl|cat|ls|grep|rg|tsc|eslint|prettier|jest|vitest)/)) {
        this.emit({ type: "tool_call", data: { tool: "run_command", reason: cmd } });
        const result = await this.exec("run_command", { command: cmd });
        const out = ((result.data as any)?.stdout ?? "") + ((result.data as any)?.stderr ?? "");
        log.push(`🔧 \`${cmd}\`\n\`\`\`\n${out.trim().slice(0, 2000)}\n\`\`\``);
      }
    }
  }

  // --- Helpers ---

  private isSimpleMessage(msg: string): boolean {
    const lower = msg.trim().toLowerCase();
    const greetings = ["hi", "hello", "hey", "sup", "yo", "thanks", "thank you", "ok", "okay", "yes", "no", "sure", "cool", "great", "nice", "what can you do", "help"];
    if (greetings.includes(lower)) return true;
    if (lower.length < 10 && !lower.match(/\b(file|code|fix|add|update|create|delete|remove|change|refactor|build|test|run|read|write|patch|edit)\b/)) return true;
    return false;
  }

  private async readFiles(filePaths: string[], log: string[]): Promise<string> {
    const parts: string[] = [];
    const skipPatterns = [".DS_Store", ".idea/", "node_modules/", ".git/", ".agent-state/", ".agent-memory/", ".agent-conversations/", ".auth/"];

    for (const f of filePaths.slice(0, 6)) {
      if (skipPatterns.some(p => f.includes(p))) continue;
      this.emit({ type: "tool_call", data: { tool: "read_file", reason: `Reading ${f}` } });
      const result = await this.exec("read_file", { path: f });
      if (result.ok) {
        const content = (result.data as any)?.content ?? "";
        parts.push(`--- ${f} ---\n${content.slice(0, 6000)}`);
        log.push(`📖 Read \`${f}\``);
      }
    }

    // If no specific files, read the most relevant ones
    if (!filePaths.length) {
      const tree = await this.exec("list_files", { path: ".", maxDepth: 1 });
      const files = tree.ok ? ((tree.data as any)?.files as string[]) ?? [] : [];
      const defaults = files.filter(f => ["README.md", "package.json", "AGENT.md"].includes(f));
      for (const f of defaults) {
        const result = await this.exec("read_file", { path: f });
        if (result.ok) {
          parts.push(`--- ${f} ---\n${((result.data as any)?.content ?? "").slice(0, 3000)}`);
          log.push(`📖 Read \`${f}\``);
        }
      }
    }

    return parts.join("\n\n");
  }

  private async getFileTree(): Promise<string> {
    const r = await this.exec("list_files", { path: ".", maxDepth: 2 });
    if (r.ok && r.data) {
      const files = ((r.data as any).files as string[])
        .filter(f => !f.includes(".DS_Store") && !f.includes(".idea/") && !f.includes("node_modules/") && !f.includes(".git/") && !f.includes(".auth/"));
      return files.slice(0, 100).join("\n");
    }
    return "";
  }

  private async getDiff(): Promise<string> {
    const r = await this.exec("git_diff", {});
    return (r.data as any)?.stdout ?? "";
  }

  private async getSession(conversationId: string): Promise<PlannerSession> {
    let s = this.sessions.get(conversationId);
    if (!s) { s = await this.chatgpt.startSession(); this.sessions.set(conversationId, s); }
    return s;
  }

  private async exec(tool: string, args: Record<string, unknown>) {
    return this.tools.execute(tool as any, args, {
      root: this.root, safetyMode: "auto", task: this.makeDummyTask(),
      saveCheckpoint: async () => "", loadCheckpoint: async () => ({} as any)
    });
  }

  private makeDummyTask(): any {
    return {
      id: "agent", goal: "", root: this.root, plannerBackend: "chatgpt",
      safetyMode: "auto", status: "running", createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(), steps: [], changedFiles: [],
      verification: { sawGitDiff: false, sawVerification: false }
    };
  }

  private emit(event: AgentEvent): void { this.onEvent?.(event); }
}
