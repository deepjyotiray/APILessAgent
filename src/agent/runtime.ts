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

const execAsync = promisify(exec);
const DIFF_LIMIT = Number(process.env.AGENT_OUTPUT_LIMIT ?? "12000");

export class AgentRuntime {
  private projectContext = "";
  private memoryContext = "";

  constructor(
    private readonly root: string,
    private readonly planner: PlannerAdapter,
    private readonly tools: ToolRegistry,
    private readonly store: TaskStateStore,
    private readonly config: AgentConfig,
    private readonly observer?: RuntimeObserver,
    private readonly maxSteps = Number(process.env.AGENT_MAX_STEPS ?? "24")
  ) {}

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

    return [
      "You are a coding agent planner using structured local tools.",
      "Reply with exactly one JSON object and nothing else.",
      "Allowed response forms:",
      '{"type":"tool","tool":"<tool_name>","args":{},"reason":"short reason"}',
      '{"type":"done","message":"summary","summary":"optional concise recap"}',
      '{"type":"error","message":"reason","retryable":false}',
      "Rules:",
      "- Never claim the workspace is inaccessible.",
      "- Use one tool per reply.",
      "- Prefer read/search tools before editing tools.",
      "- Prefer apply_patch for targeted edits.",
      "- For any tool argument containing many quotes, code, or newlines, prefer a Base64 form such as patchBase64, contentBase64, oldTextBase64, newTextBase64, textBase64, beforeBase64, or afterBase64.",
      "- When using apply_patch, prefer patchBase64 instead of patch.",
      "- After edits, usually run git_diff and a verification command before done.",
      "- Use only the tools listed below.",
      "TOOLS:",
      toolDescriptions,
      "",
      `GOAL:\n${task.goal}`,
      `WORKSPACE ROOT:\n${task.root}`,
      `PROJECT INSTRUCTIONS:\n${this.projectContext || "(none)"}`,
      `MEMORY:\n${this.memoryContext || "(none)"}`,
      `INITIAL CONTEXT:\n${task.initialContext || "(none)"}`,
      `SAFETY MODE:\n${task.safetyMode}`,
      `SUMMARY:\n${task.summary || "(none yet)"}`,
      `CHANGED FILES:\n${task.changedFiles.join(", ") || "(none)"}`,
      `VERIFICATION:\n${JSON.stringify(task.verification, null, 2)}`,
      `CURRENT DIFF:\n${task.currentDiff || "(none)"}`,
      `RECENT STEPS:\n${recentSteps || "(none yet)"}`
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
        "Your last reply did not follow the required JSON tool protocol.",
        "Return exactly one JSON object and nothing else.",
        `LAST REPLY:\n${first.raw}`
      ].join("\n\n")
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
        prompt,
        "",
        "PLANNER FAILURE:",
        "Your prior two replies were invalid. Re-read the tool protocol and return exactly one valid JSON object."
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
    return task.steps.some((step) =>
      step.toolName !== undefined &&
      step.toolResult?.ok === true &&
      !["task_checkpoint_save", "task_checkpoint_load"].includes(step.toolName)
    );
  }

  private compactTaskState(task: TaskState): void {
    const keepRecentSteps = Math.max(1, this.config.compaction.keepRecentSteps);
    if (task.steps.length <= keepRecentSteps) {
      return;
    }

    const candidatePrompt = this.buildPrompt(task);
    if (candidatePrompt.length <= this.config.compaction.maxPromptChars) {
      return;
    }

    const olderSteps = task.steps.slice(0, -keepRecentSteps);
    const summaryLines = olderSteps.map((step) => {
      const tool = step.toolName ? `tool=${step.toolName}` : "tool=(none)";
      const result = step.toolResult ? `ok=${step.toolResult.ok}${step.toolResult.errorCode ? ` error=${step.toolResult.errorCode}` : ""}` : "ok=(none)";
      return `step ${step.index}: ${tool}; ${result}`;
    });

    task.summary = limitOutput(
      [
        task.summary,
        "Compacted prior steps:",
        ...summaryLines
      ].filter(Boolean).join("\n")
    );
    task.steps = task.steps.slice(-keepRecentSteps);
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

    return limitOutput(
      [
        "Workspace file summary:",
        JSON.stringify(listFiles, null, 2),
        "",
        "Git status:",
        JSON.stringify(gitStatus, null, 2)
      ].join("\n")
    );
  }
}

function parsePlannerReply(raw: string): PlannerReply | null {
  const trimmed = stripCodeFence(raw);
  try {
    const parsed = JSON.parse(trimmed) as Partial<PlannerReply>;
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
