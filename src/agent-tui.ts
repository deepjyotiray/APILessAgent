import blessed from "blessed";

import { loadAgentConfig } from "./agent/config.js";
import { ChatGPTWebPlanner } from "./agent/planner.js";
import { AgentRuntime } from "./agent/runtime.js";
import { TaskStateStore } from "./agent/state.js";
import { LocalToolRegistry } from "./agent/tools.js";
import type { RuntimeObserver, SafetyMode, StepRecord, TaskState } from "./agent/types.js";

const ROOT = process.cwd();
const BRIDGE_BASE_URL = process.env.BRIDGE_BASE_URL ?? "http://127.0.0.1:3847";
const CHAT_TIMEOUT_MS = Number(process.env.AGENT_CHAT_TIMEOUT_MS ?? "120000");

class TaskEventFeed implements RuntimeObserver {
  readonly events = new Map<string, string[]>();
  readonly snapshots = new Map<string, TaskState>();

  constructor(private readonly onUpdate: () => void) {}

  onTaskStarted(task: TaskState): void {
    this.capture(task, `task started`);
  }

  onStepStarted(task: TaskState, step: StepRecord): void {
    this.capture(task, `step ${step.index} started`);
  }

  onPlannerStarted(task: TaskState, step: StepRecord): void {
    this.capture(task, `planner thinking for step ${step.index}`);
  }

  onPlannerReply(task: TaskState, step: StepRecord): void {
    const reply = step.plannerReply;
    if (!reply) {
      return;
    }

    if (reply.type === "tool") {
      this.capture(task, `planner chose ${reply.tool}${reply.reason ? `: ${reply.reason}` : ""}`);
    } else if (reply.type === "done") {
      this.capture(task, `planner done: ${reply.summary ?? reply.message}`);
    } else {
      this.capture(task, `planner error: ${reply.message}`);
    }
  }

  onToolStarted(task: TaskState, step: StepRecord): void {
    this.capture(task, `tool started: ${step.toolName ?? "(unknown)"}`);
  }

  onToolFinished(task: TaskState, step: StepRecord): void {
    const result = step.toolResult;
    this.capture(
      task,
      `${step.toolName ?? "tool"} ${result?.ok ? "ok" : "failed"}${result?.errorCode ? ` (${result.errorCode})` : ""}${result?.message ? ` - ${result.message}` : ""}`
    );
  }

  onTaskFinished(task: TaskState): void {
    this.capture(task, `task finished: ${task.status}`);
  }

  private capture(task: TaskState, event: string) {
    this.snapshots.set(task.id, cloneTask(task));
    const list = this.events.get(task.id) ?? [];
    list.push(`${new Date().toLocaleTimeString()}  ${event}`);
    this.events.set(task.id, list.slice(-100));
    this.onUpdate();
  }
}

class AgentTuiApp {
  private readonly screen = blessed.screen({
    smartCSR: true,
    title: "ChatGPT Agent TUI",
    fullUnicode: true
  });

  private readonly taskList = blessed.list({
    parent: this.screen,
    label: " Sessions ",
    top: 0,
    left: 0,
    width: "28%",
    height: "100%-3",
    border: "line",
    keys: true,
    vi: true,
    mouse: true,
    style: {
      selected: {
        bg: "blue"
      }
    },
    scrollbar: {
      ch: " "
    }
  });

  private readonly summaryBox = blessed.box({
    parent: this.screen,
    label: " Summary ",
    top: 0,
    left: "28%",
    width: "72%",
    height: 9,
    border: "line",
    tags: true,
    scrollable: true
  });

  private readonly historyBox = blessed.box({
    parent: this.screen,
    label: " Planner + Tool History ",
    top: 9,
    left: "28%",
    width: "45%",
    height: "100%-12",
    border: "line",
    tags: true,
    scrollable: true,
    keys: true,
    mouse: true,
    scrollbar: {
      ch: " "
    }
  });

  private readonly filesBox = blessed.box({
    parent: this.screen,
    label: " Files + Diff ",
    top: 9,
    left: "73%",
    width: "27%",
    height: "100%-12",
    border: "line",
    tags: true,
    scrollable: true,
    keys: true,
    mouse: true,
    scrollbar: {
      ch: " "
    }
  });

  private readonly commandBar = blessed.box({
    parent: this.screen,
    bottom: 0,
    left: 0,
    width: "100%",
    height: 3,
    border: "line",
    label: " Command ",
    content:
      "Press : to enter a command. Commands: start <goal>, resume <task-id>, abort <task-id>, refresh, quit",
    tags: true
  });

  private readonly prompt = blessed.textbox({
    parent: this.screen,
    bottom: 1,
    left: 2,
    width: "96%",
    height: 1,
    inputOnFocus: true,
    mouse: true,
    keys: true,
    vi: true,
    style: {
      fg: "white",
      bg: "black"
    }
  });

  private readonly feed = new TaskEventFeed(() => this.render());
  private readonly running = new Map<string, Promise<void>>();
  private taskSummaries: Array<{ id: string; goal: string; status: string; updatedAt: string; createdAt: string }> = [];
  private readonly taskCache = new Map<string, TaskState>();
  private selectedTaskId?: string;
  private selectedListIndex = -1;
  private refreshTimer?: NodeJS.Timeout;
  private isRendering = false;
  private renderQueued = false;

  private runtime!: AgentRuntime;
  private store!: TaskStateStore;

  async start() {
    const config = await loadAgentConfig(ROOT);
    const planner = new ChatGPTWebPlanner(BRIDGE_BASE_URL, CHAT_TIMEOUT_MS);
    this.store = new TaskStateStore(ROOT);
    const tools = new LocalToolRegistry();
    this.runtime = new AgentRuntime(ROOT, planner, tools, this.store, config, this.feed);

    this.bindKeys();
    await this.refresh();
    this.taskList.focus();
    this.requestRender();

    this.refreshTimer = setInterval(() => {
      void this.refresh();
    }, 1000);
  }

  private bindKeys() {
    this.screen.key(["q", "C-c"], () => {
      if (this.refreshTimer) {
        clearInterval(this.refreshTimer);
      }
      this.screen.destroy();
      process.exit(0);
    });

    this.screen.key([":"], () => {
      this.openCommandPrompt();
    });

    this.screen.key(["r"], () => {
      void this.refresh();
    });

    this.taskList.on("select item", (_, index) => {
      const task = this.taskSummaries[index];
      if (task) {
        this.selectedListIndex = index;
        this.selectedTaskId = task.id;
        this.requestRender();
      }
    });

    this.prompt.hide();
    this.prompt.on("submit", (value) => {
      this.closeCommandPrompt();
      if (value?.trim()) {
        void this.handleCommand(value.trim());
      }
    });
    this.prompt.on("cancel", () => {
      this.closeCommandPrompt();
    });
  }

  private async handleCommand(command: string) {
    if (command === "refresh") {
      await this.refresh();
      return;
    }

    if (command === "quit" || command === "exit") {
      this.screen.destroy();
      process.exit(0);
    }

    if (command.startsWith("start ")) {
      const goal = command.slice("start ".length).trim();
      if (!goal) {
        this.pushSystemEvent("Missing goal for start.");
        return;
      }
      const task = await this.runtime.createTask(goal, "auto");
      this.selectedTaskId = task.id;
       this.taskCache.set(task.id, cloneTask(task));
      this.pushSystemEvent(`started task ${task.id}`);
      this.running.set(task.id, this.trackRun(task.id, this.runtime.run(task)));
      await this.refresh();
      return;
    }

    if (command.startsWith("resume ")) {
      const taskId = command.slice("resume ".length).trim();
      if (!taskId) {
        this.pushSystemEvent("Missing task id for resume.");
        return;
      }
      const task = await this.store.load(taskId);
      this.selectedTaskId = task.id;
      this.taskCache.set(task.id, cloneTask(task));
      this.pushSystemEvent(`resuming task ${task.id}`);
      this.running.set(task.id, this.trackRun(task.id, this.runtime.run(task)));
      await this.refresh();
      return;
    }

    if (command.startsWith("abort ")) {
      const taskId = command.slice("abort ".length).trim();
      if (!taskId) {
        this.pushSystemEvent("Missing task id for abort.");
        return;
      }
      await this.store.setStatus(taskId, "aborted", "Aborted from TUI.");
      this.pushSystemEvent(`aborted task ${taskId}`);
      await this.refresh();
      return;
    }

    this.pushSystemEvent(`unknown command: ${command}`);
  }

  private openCommandPrompt() {
    this.prompt.clearValue();
    this.prompt.show();
    this.prompt.focus();
    this.requestRender();
  }

  private closeCommandPrompt() {
    this.prompt.hide();
    this.taskList.focus();
    this.requestRender();
  }

  private async refresh() {
    this.taskSummaries = await this.store.list();
    for (const summary of this.taskSummaries) {
      try {
        const task = await this.store.load(summary.id);
        this.taskCache.set(summary.id, task);
      } catch {
        continue;
      }
    }
    if (!this.selectedTaskId && this.taskSummaries[0]) {
      this.selectedTaskId = this.taskSummaries[0].id;
    }
    if (this.selectedTaskId && !this.taskSummaries.some((task) => task.id === this.selectedTaskId)) {
      this.selectedTaskId = this.taskSummaries[0]?.id;
    }
    this.requestRender();
  }

  private requestRender() {
    if (this.isRendering) {
      this.renderQueued = true;
      return;
    }
    setImmediate(() => this.render());
  }

  private render() {
    if (this.isRendering) {
      this.renderQueued = true;
      return;
    }
    this.isRendering = true;

    this.taskList.setItems(
      this.taskSummaries.map((task) => `${task.status.padEnd(9)} ${task.id.slice(0, 8)} ${truncate(task.goal, 36)}`)
    );
    const selectedIndex = this.taskSummaries.findIndex((task) => task.id === this.selectedTaskId);
    if (selectedIndex >= 0 && this.selectedListIndex !== selectedIndex) {
      this.selectedListIndex = selectedIndex;
      this.taskList.select(selectedIndex);
    }

    const task = this.getSelectedTask();
    if (!task) {
      this.summaryBox.setContent("No task selected.");
      this.historyBox.setContent("");
      this.filesBox.setContent("");
      this.finishRender();
      return;
    }

    const lastStep = task.steps.at(-1);
    this.summaryBox.setContent(
      [
        `{bold}Goal{/bold}: ${task.goal}`,
        `{bold}Task{/bold}: ${task.id}`,
        `{bold}Status{/bold}: ${task.status}`,
        `{bold}Planner{/bold}: ${task.plannerBackend}`,
        `{bold}Created{/bold}: ${task.createdAt}`,
        `{bold}Updated{/bold}: ${task.updatedAt}`,
        `{bold}Steps{/bold}: ${task.steps.length}`,
        `{bold}Current Tool{/bold}: ${lastStep?.toolName ?? (lastStep?.plannerReply?.type === "tool" ? lastStep.plannerReply.tool : "(idle)")}`,
        `{bold}Planner Reason{/bold}: ${
          lastStep?.plannerReply?.type === "tool"
            ? lastStep.plannerReply.reason ?? "(none)"
            : lastStep?.plannerReply?.type === "done"
              ? lastStep.plannerReply.summary ?? lastStep.plannerReply.message
              : lastStep?.plannerReply?.type === "error"
                ? lastStep.plannerReply.message
                : "(none)"
        }`
        , `{bold}Latest Output{/bold}: ${task.lastOutput ? truncate(task.lastOutput.replace(/\r?\n/g, " "), 64) : "(none)"}`,
        task.lastOutputPath ? `{bold}Output File{/bold}: ${task.lastOutputPath}` : ""
      ].join("\n")
    );

    const historyLines = [
      "{bold}Task summary{/bold}",
      task.summary || "(none yet)",
      "",
      ...buildOutputPreview(task),
      "",
      ...buildStepHistory(task),
      "",
      "{bold}Live events{/bold}",
      ...(this.feed.events.get(task.id) ?? [])
    ];
    this.historyBox.setContent(historyLines.join("\n"));
    this.historyBox.setScrollPerc(100);

    this.filesBox.setContent(
      [
        "{bold}Changed files{/bold}",
        ...(task.changedFiles.length ? task.changedFiles : ["(none)"]),
        "",
        "{bold}Verification{/bold}",
        `git_diff: ${task.verification.sawGitDiff}`,
        `checks: ${task.verification.sawVerification}`,
        task.verification.lastCommand ? `last command: ${task.verification.lastCommand}` : "last command: (none)",
        "",
        "{bold}Diff preview{/bold}",
        task.currentDiff || "(none)"
      ].join("\n")
    );
    this.filesBox.setScroll(0);

    this.finishRender();
  }

  private finishRender() {
    try {
      this.screen.render();
    } finally {
      this.isRendering = false;
      if (this.renderQueued) {
        this.renderQueued = false;
        this.requestRender();
      }
    }
  }

  private getSelectedTask(): TaskState | undefined {
    if (!this.selectedTaskId) {
      return undefined;
    }
    return this.feed.snapshots.get(this.selectedTaskId) ?? this.taskCache.get(this.selectedTaskId) ?? undefined;
  }

  private pushSystemEvent(message: string) {
    const pseudoTaskId = this.selectedTaskId;
    if (!pseudoTaskId) {
      return;
    }
    const list = this.feed.events.get(pseudoTaskId) ?? [];
    list.push(`${new Date().toLocaleTimeString()}  ${message}`);
    this.feed.events.set(pseudoTaskId, list.slice(-100));
    this.requestRender();
  }

  private trackRun(taskId: string, run: Promise<TaskState>): Promise<void> {
    return run
      .then((task) => {
        this.taskCache.set(taskId, cloneTask(task));
      })
      .catch((error) => {
        this.pushSystemEvent(`runtime failure: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => {
        this.running.delete(taskId);
        void this.refresh();
      });
  }
}

function buildStepHistory(task: TaskState): string[] {
  return task.steps.slice(-20).flatMap((step) => {
    const lines = [`step ${step.index}`];
    if (step.plannerReply?.type === "tool") {
      lines.push(`  planner -> tool ${step.plannerReply.tool}${step.plannerReply.reason ? `: ${step.plannerReply.reason}` : ""}`);
      if (step.toolArgs && Object.keys(step.toolArgs).length > 0) {
        lines.push(`  args -> ${truncate(JSON.stringify(step.toolArgs), 180)}`);
      }
    } else if (step.plannerReply?.type === "done") {
      lines.push(`  planner -> done: ${step.plannerReply.message}`);
    } else if (step.plannerReply?.type === "error") {
      lines.push(`  planner -> error: ${step.plannerReply.message}`);
    }
    if (step.toolResult) {
      lines.push(`  tool result -> ${step.toolResult.ok ? "ok" : "failed"}${step.toolResult.errorCode ? ` (${step.toolResult.errorCode})` : ""}: ${step.toolResult.message}`);
    }
    if (step.plannerError) {
      lines.push(`  planner failure -> ${step.plannerError}`);
    }
    return lines;
  });
}

function buildOutputPreview(task: TaskState): string[] {
  if (!task.lastOutput) {
    return ["{bold}Latest Output Preview{/bold}", "(none yet)"];
  }
  const lines = task.lastOutput
    .split("\n")
    .map((line) => truncate(line, 120))
    .slice(-6);
  const preview = ["{bold}Latest Output Preview{/bold}", ...lines];
  if (task.lastOutputPath) {
    preview.push(`Saved to: ${task.lastOutputPath}`);
  }
  return preview;
}

function truncate(value: string, length: number): string {
  return value.length <= length ? value : `${value.slice(0, length - 1)}…`;
}

function cloneTask(task: TaskState): TaskState {
  return JSON.parse(JSON.stringify(task)) as TaskState;
}

async function main() {
  const app = new AgentTuiApp();
  await app.start();
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
