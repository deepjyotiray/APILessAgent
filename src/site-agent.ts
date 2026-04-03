import { ChatGPTWebPlanner } from "./agent/planner.js";
import { loadAgentConfig } from "./agent/config.js";
import { AgentRuntime } from "./agent/runtime.js";
import { TaskStateStore } from "./agent/state.js";
import { LocalToolRegistry } from "./agent/tools.js";
import { TerminalDashboard } from "./agent/ui.js";
import type { SafetyMode, TaskState } from "./agent/types.js";

const ROOT = process.cwd();
const BRIDGE_BASE_URL = process.env.BRIDGE_BASE_URL ?? "http://127.0.0.1:3847";
const CHAT_TIMEOUT_MS = Number(process.env.AGENT_CHAT_TIMEOUT_MS ?? "120000");

async function main() {
  const [command, ...rest] = process.argv.slice(2);

  const config = await loadAgentConfig(ROOT);
  const planner = new ChatGPTWebPlanner(BRIDGE_BASE_URL, CHAT_TIMEOUT_MS);
  const store = new TaskStateStore(ROOT);
  const tools = new LocalToolRegistry();
  const showTui = shouldUseTui(rest);
  const runtime = new AgentRuntime(ROOT, planner, tools, store, config, new TerminalDashboard(showTui));

  switch (command) {
    case "start":
      await handleStart(runtime, rest);
      return;
    case "resume":
      await handleResume(runtime, store, rest[0]);
      return;
    case "status":
      await handleStatus(store, rest[0]);
      return;
    case "list":
      await handleList(store);
      return;
    case "abort":
      await handleAbort(store, rest[0]);
      return;
    default:
      await handleLegacyStart(runtime, [command, ...rest].filter(Boolean));
  }
}

async function handleStart(runtime: AgentRuntime, args: string[]) {
  const { goal, safetyMode } = parseStartArgs(args);
  if (!goal) {
    throw new Error('Usage: npm run agent -- start "Your task here" [--mode auto|guarded|read_only]');
  }

  const task = await runtime.createTask(goal, safetyMode);
  process.stdout.write(`[agent] task ${task.id}\n`);
  const completed = await runtime.run(task);
  printTaskSummary(completed);
}

async function handleLegacyStart(runtime: AgentRuntime, args: string[]) {
  const goal = args.join(" ").trim();
  if (!goal) {
    throw new Error('Usage: npm run agent -- start "Your task here"');
  }
  const task = await runtime.createTask(goal, "auto");
  process.stdout.write(`[agent] task ${task.id}\n`);
  const completed = await runtime.run(task);
  printTaskSummary(completed);
}

async function handleResume(runtime: AgentRuntime, store: TaskStateStore, taskId: string | undefined) {
  if (!taskId) {
    throw new Error("Usage: npm run agent -- resume <task-id>");
  }
  const task = await store.load(taskId);
  if (["completed", "aborted"].includes(task.status)) {
    printTaskSummary(task);
    return;
  }

  process.stdout.write(`[agent] resuming ${task.id}\n`);
  const completed = await runtime.run(task);
  printTaskSummary(completed);
}

async function handleStatus(store: TaskStateStore, taskId: string | undefined) {
  if (!taskId) {
    throw new Error("Usage: npm run agent -- status <task-id>");
  }
  const task = await store.load(taskId);
  printTaskSummary(task);
}

async function handleList(store: TaskStateStore) {
  const tasks = await store.list();
  if (!tasks.length) {
    process.stdout.write("No agent tasks found.\n");
    return;
  }

  for (const task of tasks) {
    process.stdout.write(`${task.id}  ${task.status}  ${task.updatedAt}  ${task.goal}\n`);
  }
}

async function handleAbort(store: TaskStateStore, taskId: string | undefined) {
  if (!taskId) {
    throw new Error("Usage: npm run agent -- abort <task-id>");
  }
  const task = await store.setStatus(taskId, "aborted", "Aborted by user.");
  printTaskSummary(task);
}

function parseStartArgs(args: string[]): { goal: string; safetyMode: SafetyMode } {
  let safetyMode: SafetyMode = "auto";
  const goalParts: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--mode") {
      const next = args[index + 1];
      if (next === "auto" || next === "guarded" || next === "read_only") {
        safetyMode = next;
        index += 1;
        continue;
      }
      throw new Error("Invalid --mode value. Use auto, guarded, or read_only.");
    }
    if (value === "--tui" || value === "--no-tui") {
      continue;
    }
    goalParts.push(value);
  }

  return {
    goal: goalParts.join(" ").trim(),
    safetyMode
  };
}

function shouldUseTui(args: string[]): boolean {
  if (args.includes("--no-tui")) {
    return false;
  }
  if (args.includes("--tui")) {
    return true;
  }
  return Boolean(process.stdout.isTTY);
}

function printTaskSummary(task: TaskState) {
  process.stdout.write(
    [
      `status: ${task.status}`,
      `task: ${task.id}`,
      `steps: ${task.steps.length}`,
      `changed files: ${task.changedFiles.join(", ") || "(none)"}`,
      task.lastError ? `last error: ${task.lastError}` : null,
      task.verification.lastCommand ? `verification: ${task.verification.lastCommand} (exit ${task.verification.lastExitCode ?? "?"})` : null
    ]
      .filter(Boolean)
      .join("\n") + "\n"
  );
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
