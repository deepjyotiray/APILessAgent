import { createHash } from "node:crypto";
import { exec } from "node:child_process";
import { promisify } from "node:util";

import type {
  AgentConfig,
  PlannerAdapter,
  PlannerReply,
  PlannerSession,
  RuntimeObserver,
  SafetyMode,
  StepRecord,
  TaskState,
  ToolName,
  ToolRegistry
} from "./types.js";
import { TaskStateStore } from "./state.js";
import { HookRunner } from "./hooks.js";
import { MemoryStore } from "./memory.js";
import { loadProjectContext } from "./project-context.js";
import { ContextPipeline } from "./context-pipeline.js";
import {
  compactSteps,
  getCompactContinuationMessage,
} from "./compact.js";
import { compressSummaryText } from "./summary-compression.js";

const execAsync = promisify(exec);
const DIFF_LIMIT = Number(process.env.AGENT_OUTPUT_LIMIT ?? "12000");

export class AgentRuntime {
  private projectContext = "";
  private memoryContext = "";
  private pipeline: ContextPipeline;

  constructor(
    private readonly root: string,
    private readonly planner: PlannerAdapter,
    private readonly tools: ToolRegistry,
    private readonly store: TaskStateStore,
    private readonly config: AgentConfig,
    private readonly observer?: RuntimeObserver,
    private readonly maxSteps = Number(process.env.AGENT_MAX_STEPS ?? "24")
  ) {
    this.pipeline = new ContextPipeline(tools, root, {
      maxTotalChars: Math.floor(config.compaction.maxPromptChars * 0.6),
      maxFileChars: 15000,
      maxFiles: 15,
      reserveForOutput: 20000,
    });
  }

  async createTask(goal: string, safetyMode: SafetyMode): Promise<TaskState> {
    const status = await this.planner.getPlannerStatus();
    if (!status.ok) {
      throw new Error(status.message);
    }

    const task = this.store.createTask(goal, this.planner.name, safetyMode);
    const session = await this.planner.startSession();
    task.plannerSessionId = session.id;
    task.initialContext = await this.buildInitialContext(task, safetyMode);
    const memory = new MemoryStore(this.root);
    await memory.initDefaults();
    await this.store.save(task);
    await new HookRunner(this.root, this.config.hooks).onTaskStart(task);
    this.observer?.onTaskStarted?.(task);
    return task;
  }

  async run(task: TaskState): Promise<TaskState> {
    task.status = "running";
    await this.store.save(task);
    this.projectContext = await loadProjectContext(this.root);
    this.memoryContext = await new MemoryStore(this.root).buildContextBlock();
    let session: PlannerSession = { id: task.plannerSessionId ?? "missing-session" };
    const hooks = new HookRunner(this.root, this.config.hooks);

    for (let stepIndex = task.steps.length + 1; stepIndex <= this.maxSteps; stepIndex += 1) {
      this.compactTaskState(task);
      const prompt = this.buildPrompt(task);
      const step: StepRecord = {
        index: stepIndex,
        startedAt: new Date().toISOString(),
        promptDigest: digest(prompt)
      };
      task.steps.push(step);
      await this.store.save(task);
      this.observer?.onStepStarted?.(task, step);
      this.observer?.onPlannerStarted?.(task, step);

      const plannerOutcome = await this.getPlannerReply(session, prompt);
      if (!plannerOutcome.ok) {
        step.plannerError = plannerOutcome.message;
        step.finishedAt = new Date().toISOString();
        task.lastError = plannerOutcome.message;
        task.status = "failed";
        await this.captureDiff(task);
        await this.store.save(task);
        return task;
      }

      step.plannerRaw = plannerOutcome.raw;
      step.plannerReply = plannerOutcome.reply;
      this.observer?.onPlannerReply?.(task, step);

      if (plannerOutcome.reply.type === "error") {
        step.finishedAt = new Date().toISOString();
        task.lastError = plannerOutcome.reply.message;
        task.status = plannerOutcome.reply.retryable ? "running" : "failed";
        await this.store.save(task);
        if (plannerOutcome.reply.retryable) {
          continue;
        }
        return task;
      }

      if (plannerOutcome.reply.type === "done") {
        if (!this.hasMeaningfulProgress(task)) {
          step.toolResult = {
            ok: false,
            errorCode: "progress_required",
            message: "Completion blocked because the agent has not yet made meaningful progress. It must inspect files or perform relevant tool actions before done."
          };
          step.finishedAt = new Date().toISOString();
          await this.store.save(task);
          continue;
        }

        if (this.requiresVerification(task)) {
          step.toolResult = {
            ok: false,
            errorCode: "verification_required",
            message: "Completion blocked until git_diff and verification commands have run after edits."
          };
          step.finishedAt = new Date().toISOString();
          await this.store.save(task);
          continue;
        }

        step.finishedAt = new Date().toISOString();
        task.status = "completed";
        task.lastError = undefined;
        await this.captureDiff(task);
        await this.store.save(task);
        await this.runCompletionHooks(hooks, task);
        this.observer?.onTaskFinished?.(task);
        return task;
      }

      step.toolName = plannerOutcome.reply.tool;
      step.toolArgs = plannerOutcome.reply.args ?? {};
      this.observer?.onToolStarted?.(task, step);
      try {
        await hooks.beforeTool(task, plannerOutcome.reply.tool, plannerOutcome.reply.args ?? {});
      } catch (error) {
        step.toolResult = {
          ok: false,
          errorCode: "before_tool_hook_failed",
          message: error instanceof Error ? error.message : String(error)
        };
        step.finishedAt = new Date().toISOString();
        await this.store.save(task);
        continue;
      }
      step.toolResult = await this.tools.execute(plannerOutcome.reply.tool, plannerOutcome.reply.args ?? {}, {
        root: this.root,
        safetyMode: task.safetyMode,
        task,
        saveCheckpoint: (name?: string) => this.store.saveCheckpoint(task, name),
        loadCheckpoint: (name: string) => this.store.loadCheckpoint(task.id, name)
      });
      try {
        await hooks.afterTool(task, plannerOutcome.reply.tool, step.toolResult);
      } catch (error) {
        task.lastError = `afterTool hook failed: ${error instanceof Error ? error.message : String(error)}`;
      }
      step.finishedAt = new Date().toISOString();
      this.updateTaskStateFromTool(task, plannerOutcome.reply.tool, step.toolResult);
      this.applyReplanningHints(task, plannerOutcome.reply.tool, step.toolResult);
      await this.captureDiff(task);
      await this.store.save(task);
      this.observer?.onToolFinished?.(task, step);
    }

    task.status = "failed";
    task.lastError = `Agent hit the step limit (${this.maxSteps}) without returning done.`;
    await this.captureDiff(task);
    await this.store.save(task);
    await this.runCompletionHooks(hooks, task);
    this.observer?.onTaskFinished?.(task);
    return task;
  }

  private buildPrompt(task: TaskState): string {
    const toolDescriptions = this.tools.list().map((tool) => `- ${tool.name}: ${tool.description}`).join("\n");
    const recentSteps = task.steps.slice(-6).map((step) => JSON.stringify({
      index: step.index,
      plannerReply: step.plannerReply,
      toolResult: step.toolResult
    })).join("\n");

    // Token budgeting: calculate available space for context
    const maxChars = this.config.compaction.maxPromptChars;
    const fixedParts = [
      "You are a coding agent planner using structured local tools.",
      "",
      "OUTPUT FORMAT (MANDATORY):",
      "You MUST reply with ONLY a single JSON object. No markdown, no explanation, no preamble, no commentary.",
      "Do NOT wrap the JSON in ```json``` code fences.",
      "Do NOT write anything before or after the JSON object.",
      "Your entire response must be parseable by JSON.parse().",
      "",
      "RESPONSE SCHEMA — use exactly one of these three forms:",
      '1. Tool call:  {"type":"tool","tool":"<tool_name>","args":{...},"reason":"short reason"}',
      '2. Task done:  {"type":"done","message":"summary","summary":"optional concise recap"}',
      '3. Error:      {"type":"error","message":"reason","retryable":false}',
      "",
      "EXAMPLE of a CORRECT response (your entire output should look exactly like this):",
      '{"type":"tool","tool":"read_file","args":{"path":"src/index.ts"},"reason":"Need to understand entry point"}',
      "",
      "EXAMPLE of WRONG responses (NEVER do these):",
      '- "Sure, let me read the file: {\"type\":\"tool\"...}"  ← has text before JSON',
      '- "```json\n{...}\n```"  ← has code fences',
      '- "I\'ll help you with that. Here\'s my plan..."  ← no JSON at all',
      "",
      "Rules:",
      "- Never claim the workspace is inaccessible.",
      "- Use one tool per reply.",
      "- Prefer read/search tools before editing tools.",
      "- Prefer apply_patch for targeted edits.",
      "- For any tool argument containing many quotes, code, or newlines, prefer a Base64 form such as patchBase64, contentBase64, oldTextBase64, newTextBase64, textBase64, beforeBase64, or afterBase64.",
      "- When using apply_patch, prefer patchBase64 instead of patch.",
      "- After edits, usually run git_diff and a verification command before done.",
      "- Use only the tools listed below.",
      "- UNCERTAINTY RULE: If you are unsure about the codebase structure, file locations, or how something works, DO NOT guess. Use search or read_file to gather more context before proceeding.",
      "- EXPLORATION RULE: Before editing any file, you should have read it first (or it should appear in INITIAL CONTEXT). Never edit blind.",
      "TOOLS:",
      toolDescriptions,
      "",
      `GOAL:\n${task.goal}`,
      `WORKSPACE ROOT:\n${task.root}`,
      `SAFETY MODE:\n${task.safetyMode}`,
      `CHANGED FILES:\n${task.changedFiles.join(", ") || "(none)"}`,
      `VERIFICATION:\n${JSON.stringify(task.verification, null, 2)}`,
    ].join("\n");

    const fixedLen = fixedLen_calc(fixedParts);
    const remaining = maxChars - fixedLen;

    // Allocate remaining budget proportionally
    const contextBudget = Math.floor(remaining * 0.45);
    const memoryBudget = Math.floor(remaining * 0.15);
    const diffBudget = Math.floor(remaining * 0.15);
    const stepsBudget = Math.floor(remaining * 0.20);
    const summaryBudget = Math.floor(remaining * 0.05);

    return [
      fixedParts,
      `PROJECT INSTRUCTIONS:\n${truncateToBudget(this.projectContext || "(none)", memoryBudget)}`,
      `MEMORY:\n${truncateToBudget(this.memoryContext || "(none)", memoryBudget)}`,
      `INITIAL CONTEXT:\n${truncateToBudget(task.initialContext || "(none)", contextBudget)}`,
      `SUMMARY:\n${truncateToBudget(task.summary || "(none yet)", summaryBudget)}`,
      `CURRENT DIFF:\n${truncateToBudget(task.currentDiff || "(none)", diffBudget)}`,
      `RECENT STEPS:\n${truncateToBudget(recentSteps || "(none yet)", stepsBudget)}`
    ].join("\n");
  }

  private async getPlannerReply(
    session: PlannerSession,
    prompt: string
  ): Promise<{ ok: true; raw: string; reply: PlannerReply } | { ok: false; message: string }> {
    const first = await this.planner.sendTurn(session, prompt);
    if (!first.ok || !first.raw) {
      return {
        ok: false,
        message: first.message
      };
    }

    const parsed = parsePlannerReply(first.raw);
    if (parsed && !isHallucinatedAccessError(parsed)) {
      return {
        ok: true,
        raw: first.raw,
        reply: parsed
      };
    }

    const repair = await this.planner.sendTurn(
      session,
      [
        "PROTOCOL VIOLATION: Your last reply was not valid JSON.",
        "You MUST respond with ONLY a raw JSON object. No text before or after it.",
        "Do NOT use markdown code fences. Do NOT add any explanation.",
        "Your ENTIRE response must be exactly one JSON object like:",
        '{"type":"tool","tool":"list_files","args":{"path":"."},"reason":"explore workspace"}',
        "",
        `YOUR INVALID REPLY WAS:\n${first.raw.slice(0, 500)}`
      ].join("\n")
    );

    if (!repair.ok || !repair.raw) {
      return {
        ok: false,
        message: repair.message
      };
    }

    const repaired = parsePlannerReply(repair.raw);
    if (repaired && !isHallucinatedAccessError(repaired)) {
      return {
        ok: true,
        raw: repair.raw,
        reply: repaired
      };
    }

    const retry = await this.planner.sendTurn(
      session,
      [
        "FINAL ATTEMPT. You have failed twice to return valid JSON.",
        "Respond with ONLY this JSON and absolutely nothing else:",
        '{"type":"tool","tool":"list_files","args":{"path":".","maxDepth":2},"reason":"Starting by exploring the workspace"}',
        "",
        "Copy the above JSON exactly, or replace it with your own valid tool call JSON.",
        "DO NOT add any other text."
      ].join("\n")
    );

    if (!retry.ok || !retry.raw) {
      return {
        ok: false,
        message: retry.message
      };
    }

    const retried = parsePlannerReply(retry.raw);
    if (!retried || isHallucinatedAccessError(retried)) {
      return {
        ok: false,
        message: `Planner returned invalid JSON after repair and retry.\nRaw reply:\n${retry.raw}`
      };
    }

    return {
      ok: true,
      raw: retry.raw,
      reply: retried
    };
  }

  private updateTaskStateFromTool(task: TaskState, toolName: ToolName, toolResult: { ok: boolean; data?: unknown }) {
    const data = toolResult.data as Record<string, unknown> | undefined;
    const touched = extractChangedFiles(toolName, data);
    for (const file of touched) {
      if (!task.changedFiles.includes(file)) {
        task.changedFiles.push(file);
      }
    }

    if (toolName === "git_diff" && toolResult.ok) {
      task.verification.sawGitDiff = true;
    }

    if (["run_tests", "run_build", "run_lint", "run_format_check"].includes(toolName) && toolResult.ok) {
      task.verification.sawVerification = true;
      task.verification.lastRunAt = new Date().toISOString();
      if (data && typeof data.exitCode === "number") {
        task.verification.lastExitCode = data.exitCode;
      }
      if (data && typeof data.command === "string") {
        task.verification.lastCommand = data.command;
      }
    }
  }

  private applyReplanningHints(task: TaskState, toolName: ToolName, result: { ok: boolean; errorCode?: string }) {
    if (result.ok) {
      return;
    }
    const recentFailures = task.steps
      .slice(-4)
      .filter((step) => step.toolName === toolName && step.toolResult?.ok === false);

    if (recentFailures.length >= 3) {
      task.lastError = `Repeated failures on ${toolName}. The planner should re-read files and choose a different approach.`;
    }
  }

  private requiresVerification(task: TaskState): boolean {
    return task.changedFiles.length > 0 &&
      (!task.verification.sawGitDiff || !task.verification.sawVerification);
  }

  private hasMeaningfulProgress(task: TaskState): boolean {
    const hasSuccessfulTool = task.steps.some((step) =>
      step.toolName !== undefined &&
      step.toolResult?.ok === true &&
      !["task_checkpoint_save", "task_checkpoint_load"].includes(step.toolName)
    );
    // Require at least one file read or search before allowing completion
    const hasReadContext = task.steps.some((step) =>
      step.toolResult?.ok === true &&
      ["read_file", "read_file_range", "read_multiple_files", "search", "list_files"].includes(step.toolName ?? "")
    );
    return hasSuccessfulTool && hasReadContext;
  }

  private compactTaskState(task: TaskState): void {
    const keepRecentSteps = Math.max(1, this.config.compaction.keepRecentSteps);
    if (task.steps.length <= keepRecentSteps) return;

    const candidatePrompt = this.buildPrompt(task);
    if (candidatePrompt.length <= this.config.compaction.maxPromptChars) return;

    // Use Claude Code-style compaction
    const result = compactSteps(task.steps, {
      preserveRecentSteps: keepRecentSteps,
      maxEstimatedTokens: Math.floor(this.config.compaction.maxPromptChars / 4),
    }, task.summary);

    if (result.removedStepCount === 0) return;

    // Compress the summary to fit budget
    const compressed = compressSummaryText(result.summary);
    task.summary = compressed
      ? getCompactContinuationMessage(compressed, true, result.compactedSteps.length > 0)
      : result.formattedSummary;
    task.steps = result.compactedSteps;
  }

  private async captureDiff(task: TaskState): Promise<void> {
    try {
      const { stdout } = await execAsync("git diff", {
        cwd: this.root,
        timeout: 15000,
        maxBuffer: 1024 * 1024,
        shell: "/bin/zsh"
      });
      task.currentDiff = limitOutput(stdout);
    } catch {
      task.currentDiff = "";
    }
  }

  private async runCompletionHooks(hooks: HookRunner, task: TaskState): Promise<void> {
    try {
      await hooks.onTaskComplete(task);
    } catch (error) {
      task.lastError = `completion hook failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  private async buildInitialContext(task: TaskState, safetyMode: SafetyMode): Promise<string> {
    // Use context pipeline to gather goal-relevant files
    const contextResult = await this.pipeline.gatherContext(task.goal);

    const listFiles = await this.tools.execute("list_files", { path: ".", maxDepth: 2 }, {
      root: this.root,
      safetyMode,
      task,
      saveCheckpoint: (name?: string) => this.store.saveCheckpoint(task, name),
      loadCheckpoint: (name: string) => this.store.loadCheckpoint(task.id, name)
    });

    const gitStatus = await this.tools.execute("git_status", {}, {
      root: this.root,
      safetyMode,
      task,
      saveCheckpoint: (name?: string) => this.store.saveCheckpoint(task, name),
      loadCheckpoint: (name: string) => this.store.loadCheckpoint(task.id, name)
    });

    const parts = [
      "Workspace file summary:",
      JSON.stringify(listFiles, null, 2),
      "",
      "Git status:",
      JSON.stringify(gitStatus, null, 2),
    ];

    // Add goal-relevant context from pipeline (embedding-ranked with usages)
    if (contextResult.files.length > 0) {
      parts.push("", "GOAL-RELEVANT CODE (embedding-ranked with usages):");
      parts.push(this.pipeline.formatForPrompt(contextResult));
      parts.push(`\nContext stats: ${contextResult.files.length} files, ${contextResult.totalChars} chars, ${contextResult.semanticChunks?.length ?? 0} semantic chunks, keywords: [${contextResult.keywords.join(", ")}]`);
    }

    return limitOutput(parts.join("\n"));
  }
}

function parsePlannerReply(raw: string): PlannerReply | null {
  // Try multiple extraction strategies in order of preference
  const candidates = [
    stripCodeFence(raw),           // Direct or code-fenced JSON
    extractJsonFromProse(raw),     // JSON embedded in surrounding text
  ];

  for (const candidate of candidates) {
    if (!candidate) continue;
    const result = tryParseReply(candidate);
    if (result) return result;
  }
  return null;
}

function tryParseReply(text: string): PlannerReply | null {
  try {
    const parsed = JSON.parse(text) as Partial<PlannerReply>;
    if (parsed.type === "tool" && typeof parsed.tool === "string") {
      return {
        type: "tool",
        tool: parsed.tool as ToolName,
        args: isRecord(parsed.args) ? parsed.args : {},
        reason: typeof parsed.reason === "string" ? parsed.reason : undefined
      };
    }
    if (parsed.type === "done" && typeof parsed.message === "string") {
      return {
        type: "done",
        message: parsed.message,
        summary: typeof parsed.summary === "string" ? parsed.summary : undefined
      };
    }
    if (parsed.type === "error" && typeof parsed.message === "string") {
      return {
        type: "error",
        message: parsed.message,
        retryable: typeof parsed.retryable === "boolean" ? parsed.retryable : false
      };
    }
  } catch {
    return null;
  }
  return null;
}

/** Extract a JSON object from prose text — finds the first { ... } that parses */
function extractJsonFromProse(raw: string): string | null {
  // Find all potential JSON object boundaries
  const firstBrace = raw.indexOf("{");
  if (firstBrace === -1) return null;

  // Try from each { to find a valid JSON object
  for (let start = firstBrace; start < raw.length; start++) {
    if (raw[start] !== "{") continue;
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = start; i < raw.length; i++) {
      const ch = raw[i];
      if (escape) { escape = false; continue; }
      if (ch === "\\" && inString) { escape = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          const candidate = raw.slice(start, i + 1);
          // Quick sanity check: must contain "type"
          if (candidate.includes('"type"')) return candidate;
          break;
        }
      }
    }
  }
  return null;
}

function isHallucinatedAccessError(reply: PlannerReply): boolean {
  if (reply.type !== "error") {
    return false;
  }

  return /workspace|environment|project files/i.test(reply.message) &&
    /not found|cannot locate|inaccessible|not accessible/i.test(reply.message);
}

function extractChangedFiles(toolName: ToolName, data: Record<string, unknown> | undefined): string[] {
  if (!data) {
    return [];
  }
  if (["write_file", "replace_text", "insert_text"].includes(toolName) && typeof data.path === "string") {
    return [data.path];
  }
  if (toolName === "apply_patch" && Array.isArray(data.files)) {
    return data.files.filter((value): value is string => typeof value === "string");
  }
  return [];
}

function digest(value: string): string {
  return createHash("sha1").update(value).digest("hex").slice(0, 12);
}

function stripCodeFence(input: string): string {
  const trimmed = input.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1].trim() : trimmed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function limitOutput(text: string): string {
  if (text.length <= DIFF_LIMIT) {
    return text;
  }
  return `${text.slice(0, DIFF_LIMIT)}\n...[truncated]`;
}

function truncateToBudget(text: string, budget: number): string {
  if (budget <= 0) return "(omitted — budget exceeded)";
  if (text.length <= budget) return text;
  return `${text.slice(0, budget)}\n...[truncated to fit budget]`;
}

function fixedLen_calc(text: string): number {
  return text.length;
}
