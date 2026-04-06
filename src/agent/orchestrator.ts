import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { PlannerAdapter, PlannerSession } from "./types.js";
import { LocalToolRegistry } from "./tools.js";
import { ContextPipeline } from "./context-pipeline.js";
import type { ContextResult } from "./context-pipeline.js";
import type { SubTask } from "./sub-agents.js";
import { needsKnowledgeBase, buildKnowledgeBase, enrichFromChatGPT, loadKnowledgeBase } from "./knowledge-base.js";
import type { Conversation, ConversationStore } from "./conversation.js";
import { extractNeedFiles, normalizePlannerResponse } from "./chat-llm.js";

export interface AgentEvent {
  type: "init" | "thinking" | "tool_call" | "tool_result" | "answer" | "error" | "step";
  data: unknown;
}
export type AgentEventCallback = (event: AgentEvent) => void;

// Kept for backward compat but no longer used for routing
export type QueryIntent = "SIMPLE_QA" | "CODEBASE_QA" | "IMPLEMENTATION" | "DEBUGGING" | "ARCHITECTURE" | "SHELL";

const SYSTEM_PROMPT = `You are a coding agent with access to tools. You help the user by answering questions, running commands, reading files, and editing code.

You have these tools available. To use one, respond with EXACTLY ONE raw JSON object (no markdown fences, no prose):

TOOLS:
{TOOL_LIST}

Response formats:
{"type":"tool","tool":"run_command","args":{"command":"..."},"reason":"why"}
{"type":"tool","tool":"read_file","args":{"path":"..."},"reason":"why"}
{"type":"tool","tool":"write_file","args":{"path":"...","content":"..."},"reason":"why"}
{"type":"tool","tool":"delete_file","args":{"path":"..."},"reason":"why"}
{"type":"tool","tool":"replace_text","args":{"path":"...","oldText":"...","newText":"..."},"reason":"why"}
{"type":"tool","tool":"search","args":{"pattern":"..."},"reason":"why"}
{"type":"done","message":"your final answer to the user"}

Rules:
- For questions (code questions, general knowledge, greetings): respond with {"type":"done","message":"your answer"}.
- For shell/system tasks (check RAM, disk, processes, run commands): use run_command.
- For file edits: use replace_text (preferred), write_file, or delete_file.
- One tool call per reply. I will execute it and show you the result.
- After edits, use git_diff to verify, then done.
- Your ENTIRE response must be parseable by JSON.parse(). No text outside the JSON.`;

export class ChatGPTAgent {
  private sessions = new Map<string, PlannerSession>();
  private pipeline: ContextPipeline;
  private taskStart = 0;
  private sysInfoCache = "";

  constructor(
    private readonly chatgpt: PlannerAdapter,
    private readonly tools: LocalToolRegistry,
    private root: string,
    private readonly onEvent?: AgentEventCallback,
    private conversationStore?: ConversationStore
  ) {
    this.pipeline = new ContextPipeline(tools, root);
  }

  private formatFileBlocks(
    ctx: ContextResult,
    maxFiles = 10,
    maxTotalChars = 120000
  ): string {
    const blocks: string[] = [];
    let totalChars = 0;
    for (const f of ctx.files.slice(0, maxFiles)) {
      if (totalChars + f.content.length > maxTotalChars) break;
      // Use plain-text delimiters instead of XML tags to avoid HTML entity encoding
      // when the prompt passes through a contenteditable DOM (ChatGPT/Merlin webview)
      blocks.push(`--- FILE: ${f.path} ---\n${f.content}\n--- END FILE ---`);
      totalChars += f.content.length;
    }
    return blocks.join("\n\n");
  }

  setRoot(r: string): void {
    this.root = r;
    this.pipeline = new ContextPipeline(this.tools, r);
  }

  setConversationStore(store: ConversationStore): void {
    this.conversationStore = store;
  }

  resetSession(id?: string): void {
    if (id) this.sessions.delete(id); else this.sessions.clear();
  }

  private buildSystemPrompt(): string {
    const toolDefs = this.tools.list()
      .filter(t => ["replace_text", "write_file", "delete_file", "insert_text", "apply_patch",
        "read_file", "read_file_range", "search", "run_command", "run_tests", "run_build", "git_diff"].includes(t.name))
      .map(t => `- ${t.name}: ${t.description}`).join("\n");
    return SYSTEM_PROMPT.replace("{TOOL_LIST}", toolDefs);
  }

  async run(userMessage: string, conversationId = "default", conversation?: Conversation, signal?: AbortSignal): Promise<string> {
    this.taskStart = Date.now();
    const thinking: string[] = [];
    const output: string[] = [];
    const conv = conversation;
    const cs = this.conversationStore;

    const checkAbort = () => { if (signal?.aborted) throw new DOMException("Aborted", "AbortError"); };

    this.emit({ type: "init", data: `${this.wallClock()} Thinking…` });
    checkAbort();

    const status = await this.chatgpt.getPlannerStatus();
    if (!status.ok) return `❌ ${status.message}\n\nStart the Electron app first.`;

    // Vector search: find top-K relevant files for this prompt.
    // "check ram usage" → 0 files → lean prompt.
    // "fix the orchestrator" → relevant files → rich prompt.
    const explicitFiles = this.extractExplicitFiles(userMessage);
    const onFileRead = (p: string) => this.emit({ type: "step", data: { step: `${this.wallClock()} 📄 ${p}` } });

    // Warm vector index (cached after first call)
    await this.pipeline.getRepoMap();

    const [relevantFiles, kbNeeded] = await Promise.all([
      this.pipeline.searchRelevantFiles(userMessage, 6, 0.35),
      needsKnowledgeBase(this.root),
    ]);

    const filesToRead = [...new Set([...explicitFiles, ...relevantFiles.map(f => f.path)])];
    thinking.push(`${this.ts()} Relevant: ${filesToRead.length} files (vector: ${relevantFiles.length}, explicit: ${explicitFiles.length})`);

    // Read relevant files (if any)
    let fastContext: ContextResult | null = null;
    if (filesToRead.length > 0) {
      fastContext = await this.pipeline.gatherFastContext(userMessage, filesToRead, onFileRead);
      thinking.push(`${this.ts()} Loaded ${fastContext.files.length} files (${fastContext.totalChars} chars)`);
    }

    // Build KB on first use
    let knowledgeBase = "";
    if (kbNeeded) {
      this.emit({ type: "step", data: { step: `${this.wallClock()} Building project knowledge base…` } });
      const allFiles = await this.pipeline.gatherContext(userMessage, explicitFiles);
      const repoMap = await this.pipeline.getRepoMap();
      await buildKnowledgeBase(this.root, {
        repoMap, fileContents: allFiles.files, symbols: allFiles.symbolIndex, importGraph: null,
        packageJson: allFiles.files.find(f => f.path === "package.json")?.content ?? null,
        readme: allFiles.files.find(f => f.path.toLowerCase().includes("readme"))?.content ?? null,
      }, (step) => this.emit({ type: "step", data: { step: `${this.wallClock()} ${step}` } }));
    }
    knowledgeBase = await loadKnowledgeBase(this.root);

    // Deep expand in background only if we have files to expand from
    const deepExpandPromise = fastContext
      ? this.pipeline.expandContextDeep(userMessage, fastContext, onFileRead)
      : Promise.resolve({ files: [], symbolIndex: [], totalChars: 0, searchHits: [], keywords: [] } as ContextResult);

    checkAbort();

    // Build prompt — lean when 0 relevant files, rich when there are
    const session = await this.getSession(conversationId);
    const sysInfo = await this.getSystemInfo();
    const promptParts: string[] = [
      this.buildSystemPrompt(),
      "",
      `System: ${sysInfo}`,
      `Working directory: ${this.root}`,
    ];

    if (fastContext && fastContext.files.length > 0) {
      const repoMap = await this.pipeline.getRepoMap();
      const fileBlocks = this.formatFileBlocks(fastContext, 8, 100000);
      if (knowledgeBase) promptParts.push("", "PROJECT KNOWLEDGE:", knowledgeBase.slice(0, 2000));
      promptParts.push("", "REPO MAP:", repoMap.slice(0, 5000));
      if (fileBlocks) promptParts.push("", "SOURCE FILES:", fileBlocks);
    }

    promptParts.push("", `USER: ${userMessage}`);
    const initialPrompt = promptParts.filter(Boolean).join("\n");

    // === Single unified tool-call loop ===
    const taskId = randomUUID();
    if (conv && cs) cs.startTask(conv, taskId, userMessage);

    this.emit({ type: "step", data: { step: `${this.wallClock()} Sending to planner…` } });
    let reply = await this.chatgpt.sendTurn(session, initialPrompt);
    let raw = this.unescape(reply.raw ?? reply.message ?? "");
    thinking.push(`${this.ts()} First response (${raw.length} chars)`);

    // Await deep context (available for NEED_FILE and subsequent reads)
    const contextResult = await deepExpandPromise;
    thinking.push(`${this.ts()} Deep context: ${contextResult.files.length} files`);

    const MAX_STEPS = 20;
    for (let step = 0; step < MAX_STEPS; step++) {
      checkAbort();

      // Try to parse as JSON tool call
      let parsed = this.parseToolCall(raw);

      // If not JSON, try normalizer
      if (!parsed) {
        const normalized = await normalizePlannerResponse(raw);
        if (normalized.ok && normalized.json) {
          parsed = normalized.json as any;
          thinking.push(`${this.ts()} Step ${step + 1}: normalizer extracted: ${(parsed as any).type}`);
        }
      }

      // If still not JSON, check if it's a prose answer (no JSON at all = the LLM just answered)
      if (!parsed) {
        // If the response has no JSON-like content, treat it as a direct answer
        if (!raw.includes('"type"')) {
          output.push(raw.trim());
          thinking.push(`${this.ts()} Step ${step + 1}: prose answer (${raw.length} chars)`);
          break;
        }
        // Otherwise ask for retry
        thinking.push(`${this.ts()} Step ${step + 1}: invalid JSON, asking retry`);
        const retry = await this.chatgpt.sendTurn(session,
          "Your last reply was not valid JSON. Respond with ONLY a raw JSON object. " +
          'If you want to answer the user, use: {"type":"done","message":"your answer"}. ' +
          'If you need to run a command: {"type":"tool","tool":"run_command","args":{"command":"..."},"reason":"why"}'
        );
        raw = this.unescape(retry.raw ?? retry.message ?? "");
        continue;
      }

      // Handle "done" — the LLM's final answer
      if (parsed.type === "done") {
        output.push(parsed.message ?? "Done.");
        thinking.push(`${this.ts()} Step ${step + 1}: done`);
        if (conv && cs) cs.addTaskStep(conv, taskId, "step", `Done: ${(parsed.message ?? "").slice(0, 200)}`);
        break;
      }

      // Handle tool call
      if (parsed.type === "tool" && parsed.tool) {
        this.emit({ type: "step", data: { step: `${this.wallClock()} ${parsed.tool}(${parsed.args?.path ?? parsed.args?.command ?? ""})` } });
        thinking.push(`${this.ts()} Step ${step + 1}: ${parsed.tool} ${parsed.args?.path ?? ""}`);
        if (conv && cs) cs.addTaskStep(conv, taskId, "tool_call", `${parsed.tool}: ${parsed.reason ?? ""}`);

        // Handle large file reads in parts
        if (parsed.tool === "read_file" && parsed.args?.path) {
          const content = await this.readFullFile(parsed.args.path as string, contextResult);
          if (content && content.length > 12000) {
            await this.sendFileInParts(session, parsed.args.path as string, content, 12000, thinking);
            const nextReply = await this.chatgpt.sendTurn(session, "File delivered. Continue with your next action as JSON.");
            raw = this.unescape(nextReply.raw ?? nextReply.message ?? "");
            continue;
          }
        }

        const result = await this.exec(parsed.tool, parsed.args ?? {});
        const resultSummary = result.ok
          ? JSON.stringify(result.data ?? { ok: true }, null, 2).slice(0, 3000)
          : `ERROR: ${(result as any).errorCode ?? "failed"} — ${(result as any).message ?? ""}`;

        if (result.ok) {
          const label = (parsed.args?.path as string) ?? (parsed.args?.command as string)?.slice(0, 60) ?? parsed.tool;
          output.push(`✅ ${label}: ${parsed.reason ?? "done"}`);
          if (conv && cs) cs.addTaskStep(conv, taskId, "tool_result", `✅ ${label}`, { toolName: parsed.tool as any, toolResult: { ok: true, message: parsed.reason ?? "" } });
        } else {
          const label = (parsed.args?.path as string) ?? parsed.tool;
          output.push(`⚠️ ${label}: ${resultSummary.slice(0, 200)}`);
          if (conv && cs) cs.addTaskStep(conv, taskId, "tool_result", `⚠️ ${label}: ${resultSummary.slice(0, 200)}`, { toolName: parsed.tool as any, toolResult: { ok: false, message: resultSummary.slice(0, 200) } });
        }

        // Feed result back for next step
        const nextReply = await this.chatgpt.sendTurn(session,
          `Tool result:\n${resultSummary}\n\nContinue with the next action as JSON, or {"type":"done","message":"summary"} if finished.`
        );
        raw = this.unescape(nextReply.raw ?? nextReply.message ?? "");
      }
    }

    // Fallback if loop exhausted
    if (output.length === 0) {
      output.push(raw.trim() || "Task completed.");
    }

    if (conv && cs) {
      const edits = output.filter(l => l.startsWith("✅")).length;
      cs.finishTask(conv, taskId, edits > 0 ? "completed" : "completed", `${edits} action(s)`);
      await cs.save(conv);
    }

    thinking.push(`${this.ts()} Done (${this.elapsed()}s)`);
    await this.pipeline.recordFeedback(contextResult.files.map(f => f.path), []).catch(() => {});
    return this.formatOutput(output, thinking);
  }

  // --- Output ---

  private formatOutput(answers: string[], thinking: string[]): string {
    const parts: string[] = [];
    if (answers.length > 0) parts.push(answers.join("\n\n"));
    if (thinking.length > 0) {
      parts.push("");
      parts.push("<details><summary>🔍 Thinking</summary>\n");
      parts.push(thinking.join("\n"));
      parts.push(`\n⏱️ ${this.elapsed()}s total`);
      parts.push("\n</details>");
    }
    return parts.join("\n");
  }

  private ts(): string {
    const s = Math.floor((Date.now() - this.taskStart) / 1000);
    return `[${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}]`;
  }

  private wallClock(): string {
    return new Date().toLocaleTimeString("en-GB", { hour12: false });
  }

  private elapsed(): number {
    return Math.floor((Date.now() - this.taskStart) / 1000);
  }

  private unescape(text: string): string {
    let t = text
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");
    // Strip outer wrapping quotes that some bridges add: "{ ... }" → { ... }
    const trimmed = t.trim();
    if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
      const inner = trimmed.slice(1, -1);
      if (inner.includes('"type"')) t = inner;
    }
    return t;
  }

  // --- Context ---

  private async readFullFile(filePath: string, ctx: ContextResult): Promise<string> {
    const cached = ctx.files.find(cf => cf.path === filePath);
    if (cached) return cached.content;
    this.emit({ type: "tool_call", data: { tool: "read_file", reason: `Reading ${filePath}` } });
    const r = await this.exec("read_file", { path: filePath });
    return r.ok ? ((r.data as any)?.content ?? "") : "";
  }

  private async sendFileInParts(
    session: PlannerSession, filePath: string, content: string, partLimit: number, log: string[]
  ): Promise<number> {
    if (content.length <= partLimit) return 0;
    const totalParts = Math.ceil(content.length / partLimit);
    for (let i = 0; i < totalParts; i++) {
      const chunk = content.slice(i * partLimit, (i + 1) * partLimit);
      const isLast = i === totalParts - 1;
      const instruction = isLast ? "Last part. You have the complete file." : "More parts follow. Say OK.";
      this.emit({ type: "step", data: { step: `${this.wallClock()} Sending ${filePath} part ${i + 1}/${totalParts}` } });
      log.push(`${this.ts()} ${filePath} part ${i + 1}/${totalParts} (${chunk.length} chars)`);
      await this.chatgpt.sendTurn(session, `--- ${filePath} (part ${i + 1}/${totalParts}) ---\n${chunk}\n\n${instruction}`);
    }
    return totalParts;
  }

  // --- Helpers ---

  private parseToolCall(raw: string): { type: string; tool?: string; args?: Record<string, unknown>; reason?: string; message?: string } | null {
    const trimmed = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
    const start = trimmed.indexOf("{");
    if (start === -1) return null;
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < trimmed.length; i++) {
      const ch = trimmed[i];
      if (esc) { esc = false; continue; }
      if (ch === "\\" && inStr) { esc = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          const candidate = trimmed.slice(start, i + 1);
          try { const obj = JSON.parse(candidate); if (obj.type) return obj; } catch {}
          const sanitized = this.sanitizeJsonNewlines(candidate);
          try { const obj = JSON.parse(sanitized); if (obj.type) return obj; } catch {}
          // Last resort: extract type+message via regex for "done" responses
          const extracted = this.extractDoneFromBroken(candidate);
          if (extracted) return extracted;
          break;
        }
      }
    }
    // Fallback: if the whole raw string looks like a done response with broken JSON
    const extracted = this.extractDoneFromBroken(trimmed);
    if (extracted) return extracted;
    return null;
  }

  /**
   * Last-resort extraction for {"type":"done","message":"..."} when the message
   * field contains unescaped quotes that break JSON.parse.
   */
  private extractDoneFromBroken(text: string): { type: string; message: string } | null {
    // Match the opening: {"type":"done","message":" then grab everything until the closing "}
    const m = text.match(/\{\s*"type"\s*:\s*"done"\s*,\s*"message"\s*:\s*"/);
    if (!m || m.index == null) return null;
    const msgStart = m.index + m[0].length;
    // Find the closing "} — the last occurrence of "} in the string
    const closingIdx = text.lastIndexOf('"}');
    if (closingIdx <= msgStart) return null;
    const message = text.slice(msgStart, closingIdx)
      .replace(/\\n/g, "\n")
      .replace(/\\t/g, "\t")
      .replace(/\\"/g, '"');
    return { type: "done", message };
  }

  private sanitizeJsonNewlines(json: string): string {
    const out: string[] = [];
    let inStr = false, esc = false;
    for (let i = 0; i < json.length; i++) {
      const ch = json[i];
      if (esc) { esc = false; out.push(ch); continue; }
      if (ch === "\\" && inStr) { esc = true; out.push(ch); continue; }
      if (ch === '"') { inStr = !inStr; out.push(ch); continue; }
      if (inStr) {
        if (ch === "\n") { out.push("\\n"); continue; }
        if (ch === "\r") { out.push("\\r"); continue; }
        if (ch === "\t") { out.push("\\t"); continue; }
      }
      out.push(ch);
    }
    return out.join("");
  }

  private extractExplicitFiles(msg: string): string[] {
    const files: string[] = [];
    // Match filenames with extensions
    for (const m of msg.matchAll(/(?:^|\s|[`"'\/])([a-zA-Z0-9_.\/-]*[a-zA-Z0-9_-]+\.[a-zA-Z]{1,10})(?:\s|$|[`"',;.!?])/gi)) {
      const candidate = m[1].replace(/^\.[\\/]/, "");
      if (/^\d+\.\d+/.test(candidate)) continue;
      files.push(candidate);
    }
    // Also match well-known filenames without extensions (README, Makefile, Dockerfile, etc.)
    const wellKnown = ["readme", "makefile", "dockerfile", "agent", "changelog", "license", "contributing"];
    const lowerMsg = msg.toLowerCase();
    for (const name of wellKnown) {
      if (lowerMsg.includes(name)) {
        // Add common variants — resolveExplicitFiles will case-insensitive match
        files.push(name.toUpperCase() + ".md", name + ".md");
      }
    }
    return [...new Set(files)];
  }

  private async getSystemInfo(): Promise<string> {
    if (this.sysInfoCache) return this.sysInfoCache;
    try {
      const r = await this.exec("run_command", { command: "echo \"OS: $(uname -s) $(uname -r) $(uname -m), Shell: $SHELL, Node: $(node -v 2>/dev/null)\"" });
      this.sysInfoCache = ((r.data as any)?.stdout ?? "").trim() || "macOS, zsh";
    } catch { this.sysInfoCache = "macOS, zsh"; }
    return this.sysInfoCache;
  }

  private async getSession(id: string): Promise<PlannerSession> {
    let s = this.sessions.get(id);
    if (!s) { s = await this.chatgpt.startSession(); this.sessions.set(id, s); }
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
