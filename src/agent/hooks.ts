import { exec } from "node:child_process";
import { promisify } from "node:util";

import type { AgentHooksConfig, TaskState, ToolResult } from "./types.js";

const execAsync = promisify(exec);

export class HookRunner {
  constructor(
    private readonly root: string,
    private readonly hooks: AgentHooksConfig
  ) {}

  async onTaskStart(task: TaskState): Promise<void> {
    await this.runMany(this.hooks.onTaskStart, {
      AGENT_TASK_ID: task.id,
      AGENT_TASK_GOAL: task.goal,
      AGENT_TASK_STATUS: task.status
    });
  }

  async onTaskComplete(task: TaskState): Promise<void> {
    await this.runMany(this.hooks.onTaskComplete, {
      AGENT_TASK_ID: task.id,
      AGENT_TASK_GOAL: task.goal,
      AGENT_TASK_STATUS: task.status,
      AGENT_CHANGED_FILES: task.changedFiles.join(",")
    });
  }

  async beforeTool(task: TaskState, toolName: string, args: Record<string, unknown>): Promise<void> {
    await this.runMany(this.hooks.beforeTool, {
      AGENT_TASK_ID: task.id,
      AGENT_TOOL_NAME: toolName,
      AGENT_TOOL_ARGS: JSON.stringify(args)
    });
  }

  async afterTool(task: TaskState, toolName: string, result: ToolResult): Promise<void> {
    await this.runMany(this.hooks.afterTool, {
      AGENT_TASK_ID: task.id,
      AGENT_TOOL_NAME: toolName,
      AGENT_TOOL_OK: String(result.ok),
      AGENT_TOOL_ERROR_CODE: result.errorCode ?? "",
      AGENT_TOOL_MESSAGE: result.message
    });
  }

  private async runMany(commands: string[] | undefined, env: Record<string, string>): Promise<void> {
    for (const command of commands ?? []) {
      await execAsync(command, {
        cwd: this.root,
        shell: "/bin/zsh",
        env: {
          ...process.env,
          ...env
        },
        timeout: 15000,
        maxBuffer: 1024 * 1024
      });
    }
  }
}
