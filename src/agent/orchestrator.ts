import type { PlannerAdapter, PlannerSession } from "./types.js";
import { LocalToolRegistry } from "./tools.js";
import { MemoryStore } from "./memory.js";
import { loadProjectContext } from "./project-context.js";

const MAX_ITERATIONS = 20;
const MAX_CONTEXT_CHARS = 30000;
const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://127.0.0.1:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? "qwen2.5-coder:7b";

export interface AgentEvent {
  type: "init" | "thinking" | "tool_call" | "tool_result" | "answer" | "error" | "step";
  data: unknown;
}
export type AgentEventCallback = (event: AgentEvent) => void;

interface OllamaMessage { role: "system" | "user" | "assistant"; content: string; }

/**
 * Two-brain orchestrator:
 *   Brain 1 (Ollama) = planner/router — runs the agent loop, outputs JSON tool calls
 *   Brain 2 (ChatGPT) = expert coder — called only for heavy coding/writing tasks
 */
export class ChatGPTAgent {
  private chatgptSessions = new Map<string, PlannerSession>();

  constructor(
    private readonly chatgpt: PlannerAdapter,
    private readonly tools: LocalToolRegistry,
    private root: string,
    private readonly onEvent?: AgentEventCallback
  ) {}

  setRoot(newRoot: string): void { this.root = newRoot; }
  resetSession(conversationId?: string): void {
    if (conversationId) this.chatgptSessions.delete(conversationId);
    else this.chatgptSessions.clear();
  }

  async run(userMessage: string, conversationId: string = "default"): Promise<string> {
    this.emit({ type: "init", data: "Planning with local LLM…" });

    // Build context
    const projectCtx = await loadProjectContext(this.root);
    const memoryCtx = await new MemoryStore(this.root).buildContextBlock();
    const fileTree = await this.getFileTree();

    const systemPrompt = [
      "You are a coding agent planner. You control tools to accomplish tasks.",
      "Reply with EXACTLY ONE JSON object per message. No other text.",
      "",
      "Available actions:",
      '  {"action":"read_file","args":{"path":"..."},"reason":"why"}',
      '  {"action":"read_multiple_files","args":{"paths":["...","..."]},"reason":"why"}',
      '  {"action":"search","args":{"pattern":"..."},"reason":"why"}',
      '  {"action":"list_files","args":{"path":".","maxDepth":2},"reason":"why"}',
      '  {"action":"write_file","args":{"path":"...","content":"..."},"reason":"why"}',
      '  {"action":"run_command","args":{"command":"..."},"reason":"why"}',
      '  {"action":"ask_expert","args":{"task":"what you need","context":"relevant file contents"},"reason":"why"}',
      '  {"action":"done","result":"final answer in markdown"}',
      "",
      "RULES:",
      "- ALWAYS read files before modifying them.",
      "- Use ask_expert when you need to generate complex code, rewrite large files, or need creative/architectural thinking.",
      "- For ask_expert, include ALL relevant file contents in the context field so the expert has everything needed.",
      "- After ask_expert returns, use write_file to save the result.",
      "- Break tasks into steps: discover → read → plan → ask_expert (if needed) → write → verify.",
      "- For simple tasks (rename, small edits), do them directly without ask_expert.",
      "- The reason field should explain your thinking at each step.",
      "",
      `WORKSPACE: ${this.root}`,
      fileTree ? `\nFILES:\n${fileTree}` : "",
      projectCtx ? `\n${projectCtx.slice(0, 1500)}` : "",
      memoryCtx ? `\n${memoryCtx.slice(0, 1500)}` : "",
    ].filter(Boolean).join("\n");

    // Ollama conversation history for this run
    const messages: OllamaMessage[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: `TASK: ${userMessage}` }
    ];

    const toolLog: string[] = [];

    for (let i = 0; i < MAX_ITERATIONS; i++) {
      // Call Ollama (Brain 1)
      this.emit({ type: "thinking", data: { step: i + 1 } });
      const ollamaResponse = await this.callOllama(messages);

      if (!ollamaResponse) {
        if (toolLog.length) return toolLog.join("\n\n") + "\n\n⚠️ Planner returned empty response.";
        return "⚠️ Local planner returned empty response. Is Ollama running?";
      }

      messages.push({ role: "assistant", content: ollamaResponse });

      // Parse the action
      const action = this.parseAction(ollamaResponse);
      if (!action) {
        // Plain text — might be the answer itself
        if (toolLog.length) return toolLog.join("\n\n") + "\n\n" + ollamaResponse;
        return ollamaResponse;
      }

      // Done
      if (action.action === "done") {
        const answer = (action.result as string) ?? (action.message as string) ?? "";
        this.emit({ type: "answer", data: answer });
        return toolLog.length ? toolLog.join("\n\n") + "\n\n" + answer : answer;
      }

      // Ask expert (Brain 2 — ChatGPT)
      if (action.action === "ask_expert") {
        const task = (action.args as any)?.task ?? userMessage;
        const context = (action.args as any)?.context ?? "";
        const reason = (action.reason as string) ?? "Consulting expert";

        this.emit({ type: "step", data: { step: `🧠 Asking ChatGPT: ${reason}` } });
        this.emit({ type: "tool_call", data: { tool: "ask_expert", reason } });

        const expertResponse = await this.askChatGPT(task, context, conversationId);
        toolLog.push(`🧠 **Expert consulted** — ${reason}`);

        messages.push({ role: "user", content: `EXPERT_RESULT: ${expertResponse.slice(0, 10000)}` });
        continue;
      }

      // Regular tool call
      const toolName = action.action;
      const toolArgs = (action.args as Record<string, unknown>) ?? {};
      const reason = (action.reason as string) ?? "";

      this.emit({ type: "step", data: { step: `💡 ${reason || toolName}` } });
      this.emit({ type: "tool_call", data: { tool: toolName, args: toolArgs, reason } });

      const toolResult = await this.tools.execute(toolName as any, toolArgs, {
        root: this.root, safetyMode: "auto", task: this.makeDummyTask(),
        saveCheckpoint: async () => "", loadCheckpoint: async () => ({} as any)
      });

      this.emit({ type: "tool_result", data: { tool: toolName, ok: toolResult.ok, message: toolResult.message } });

      // Build display log
      let detail = `${toolResult.ok ? "✅" : "❌"} **${toolName}**${reason ? ` — ${reason}` : ""}: ${toolResult.message}`;

      // Show diff for writes
      if (toolResult.ok && ["write_file", "apply_patch", "replace_text", "insert_text"].includes(toolName)) {
        const filePath = (toolArgs.path as string) ?? "";
        if (filePath) {
          const diff = await this.tools.execute("git_diff" as any, { path: filePath }, {
            root: this.root, safetyMode: "auto", task: this.makeDummyTask(),
            saveCheckpoint: async () => "", loadCheckpoint: async () => ({} as any)
          });
          const diffText = (diff.data as any)?.stdout ?? "";
          if (diffText.trim()) detail += `\n\n\`\`\`diff\n${diffText.slice(0, 3000)}\n\`\`\``;
        }
      }

      // Show command output
      if (toolResult.ok && ["run_command", "run_tests", "run_build"].includes(toolName)) {
        const output = ((toolResult.data as any)?.stdout ?? "") + ((toolResult.data as any)?.stderr ?? "");
        if (output.trim()) detail += `\n\n\`\`\`\n${output.trim().slice(0, 2000)}\n\`\`\``;
      }

      toolLog.push(detail);

      // Feed result back to Ollama
      const resultStr = safeStringify({ ok: toolResult.ok, message: toolResult.message, data: toolResult.data }, 6000);
      messages.push({ role: "user", content: `TOOL_RESULT: ${resultStr}` });

      // Trim conversation if too long
      if (JSON.stringify(messages).length > MAX_CONTEXT_CHARS) {
        // Keep system + last 6 messages
        const system = messages[0];
        messages.splice(0, messages.length);
        messages.push(system, ...messages.slice(-6));
      }
    }

    return toolLog.join("\n\n") + "\n\n⚠️ Reached max iterations.";
  }

  private async callOllama(messages: OllamaMessage[]): Promise<string | null> {
    try {
      const res = await fetch(`${OLLAMA_URL}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: OLLAMA_MODEL,
          messages,
          stream: false,
          options: { temperature: 0.1, num_predict: 4096 }
        }),
        signal: AbortSignal.timeout(60000)
      });
      if (!res.ok) return null;
      const body = await res.json() as { message?: { content?: string } };
      return body.message?.content?.trim() ?? null;
    } catch {
      return null;
    }
  }

  private async askChatGPT(task: string, context: string, conversationId: string): Promise<string> {
    // Get or create a ChatGPT session for this conversation
    let session = this.chatgptSessions.get(conversationId);
    if (!session) {
      session = await this.chatgpt.startSession();
      this.chatgptSessions.set(conversationId, session);
    }

    const prompt = [
      "You are an expert coder. Complete the following task.",
      "Output the complete result directly. No explanations unless asked.",
      "If writing a file, output the FULL file content.",
      "",
      context ? `CONTEXT:\n${context.slice(0, 15000)}` : "",
      "",
      `TASK: ${task}`
    ].filter(Boolean).join("\n");

    const result = await this.chatgpt.sendTurn(session, prompt);
    return result.raw ?? result.message ?? "Expert returned no response.";
  }

  private parseAction(raw: string): any {
    let text = raw.trim();
    // Strip code fences
    const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    if (fenced) text = fenced[1].trim();

    // Direct parse
    try {
      const p = JSON.parse(text);
      if (p && typeof p.action === "string") return p;
    } catch {}

    // Fix broken JSON (newlines in strings)
    try {
      const fixed = text.replace(/[\n\r\t]/g, (c) => c === "\n" ? "\\n" : c === "\r" ? "" : "\\t");
      const p = JSON.parse(fixed);
      if (p && typeof p.action === "string") return p;
    } catch {}

    // Extract from surrounding text
    const match = text.match(/\{[\s\S]*"action"\s*:\s*"[^"]+[\s\S]*\}/);
    if (match) {
      try {
        const p = JSON.parse(match[0]);
        if (p && typeof p.action === "string") return p;
      } catch {}
      try {
        const fixed = match[0].replace(/[\n\r\t]/g, (c) => c === "\n" ? "\\n" : c === "\r" ? "" : "\\t");
        const p = JSON.parse(fixed);
        if (p && typeof p.action === "string") return p;
      } catch {}
    }

    return null;
  }

  private async getFileTree(): Promise<string> {
    try {
      const r = await this.tools.execute("list_files", { path: ".", maxDepth: 2 }, {
        root: this.root, safetyMode: "auto", task: this.makeDummyTask(),
        saveCheckpoint: async () => "", loadCheckpoint: async () => ({} as any)
      });
      if (r.ok && r.data) return ((r.data as any).files as string[]).slice(0, 80).join("\n");
    } catch {}
    return "";
  }

  private makeDummyTask(): any {
    return {
      id: "agent", goal: "", root: this.root, plannerBackend: "dual",
      safetyMode: "auto", status: "running", createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(), steps: [], changedFiles: [],
      verification: { sawGitDiff: false, sawVerification: false }
    };
  }

  private emit(event: AgentEvent): void { this.onEvent?.(event); }
}

function safeStringify(data: unknown, maxLen: number): string {
  try { const s = JSON.stringify(data); return s.length > maxLen ? s.slice(0, maxLen) + "..." : s; }
  catch { return "{}"; }
}
