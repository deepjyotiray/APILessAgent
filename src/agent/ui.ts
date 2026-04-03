import readline from "node:readline";

import type { RuntimeObserver, StepRecord, TaskState } from "./types.js";

export class TerminalDashboard implements RuntimeObserver {
  private activeTool = "";
  private recentEvents: string[] = [];
  private lastStep = 0;
  private phase = "idle";
  private plannerReason = "";
  private spinnerIndex = 0;
  private spinnerTimer?: NodeJS.Timeout;
  private readonly spinnerFrames = ["|", "/", "-", "\\"];

  constructor(private readonly enabled: boolean) {}

  onTaskStarted(task: TaskState): void {
    this.pushEvent(`task started: ${task.id}`);
    this.render(task);
  }

  onStepStarted(task: TaskState, step: StepRecord): void {
    this.lastStep = step.index;
    this.pushEvent(`step ${step.index} started`);
    this.render(task);
  }

  onPlannerStarted(task: TaskState): void {
    this.phase = "planning";
    this.startSpinner(task);
    this.pushEvent("planner thinking");
    this.render(task);
  }

  onPlannerReply(task: TaskState, step: StepRecord): void {
    this.stopSpinner();
    this.phase = "planner_replied";
    if (step.plannerReply?.type === "tool") {
      this.activeTool = step.plannerReply.tool;
      this.plannerReason = step.plannerReply.reason ?? "";
      this.pushEvent(`planner chose ${step.plannerReply.tool}`);
    } else if (step.plannerReply?.type === "done") {
      this.plannerReason = step.plannerReply.summary ?? step.plannerReply.message;
      this.pushEvent("planner requested completion");
    } else if (step.plannerReply?.type === "error") {
      this.plannerReason = step.plannerReply.message;
      this.pushEvent(`planner error: ${step.plannerReply.message}`);
    }
    this.render(task);
  }

  onToolStarted(task: TaskState, step: StepRecord): void {
    this.phase = "executing";
    if (step.toolName) {
      this.activeTool = step.toolName;
      this.pushEvent(`tool started: ${step.toolName}`);
    }
    this.render(task);
  }

  onToolFinished(task: TaskState, step: StepRecord): void {
    this.phase = "idle";
    if (step.toolResult) {
      this.pushEvent(
        `${step.toolName ?? "tool"} ${step.toolResult.ok ? "ok" : "failed"}${step.toolResult.errorCode ? ` (${step.toolResult.errorCode})` : ""}`
      );
    }
    this.render(task);
  }

  onTaskFinished(task: TaskState): void {
    this.stopSpinner();
    this.phase = "finished";
    this.pushEvent(`task finished: ${task.status}`);
    this.render(task);
    if (this.enabled) {
      process.stdout.write("\n");
    }
  }

  private pushEvent(event: string) {
    this.recentEvents.push(`${new Date().toLocaleTimeString()}  ${event}`);
    this.recentEvents = this.recentEvents.slice(-8);
  }

  private render(task: TaskState) {
    if (!this.enabled) {
      return;
    }

    const lines = [
      "ChatGPT Agent Dashboard",
      `Task: ${task.id}`,
      `Status: ${task.status}`,
      `Step: ${this.lastStep}`,
      `Phase: ${this.phase}${this.phase === "planning" ? ` ${this.spinnerFrames[this.spinnerIndex]}` : ""}`,
      `Active tool: ${this.activeTool || "(idle)"}`,
      `Planner reason: ${this.plannerReason || "(none)"}`,
      `Changed files: ${task.changedFiles.length ? task.changedFiles.join(", ") : "(none)"}`,
      `Verification: git_diff=${task.verification.sawGitDiff} checks=${task.verification.sawVerification}`,
      task.lastError ? `Last error: ${task.lastError}` : "Last error: (none)",
      "",
      "Recent events:",
      ...(this.recentEvents.length ? this.recentEvents : ["(none)"])
    ];

    readline.cursorTo(process.stdout, 0, 0);
    readline.clearScreenDown(process.stdout);
    process.stdout.write(`${lines.join("\n")}\n`);
  }

  private startSpinner(task: TaskState) {
    if (!this.enabled || this.spinnerTimer) {
      return;
    }

    this.spinnerTimer = setInterval(() => {
      this.spinnerIndex = (this.spinnerIndex + 1) % this.spinnerFrames.length;
      this.render(task);
    }, 120);
  }

  private stopSpinner() {
    if (!this.spinnerTimer) {
      return;
    }
    clearInterval(this.spinnerTimer);
    this.spinnerTimer = undefined;
  }
}
