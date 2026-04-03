import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import type { SafetyMode, TaskState, TaskStatus } from "./types.js";

const STATE_DIR = ".agent-state";

export class TaskStateStore {
  constructor(private readonly root: string) {}

  async ensure(): Promise<void> {
    await fs.mkdir(this.baseDir(), { recursive: true });
  }

  createTask(goal: string, plannerBackend: string, safetyMode: SafetyMode): TaskState {
    const now = new Date().toISOString();
    return {
      id: randomUUID(),
      goal,
      root: this.root,
      plannerBackend,
      safetyMode,
      status: "pending",
      createdAt: now,
      updatedAt: now,
      steps: [],
      changedFiles: [],
      verification: {
        sawGitDiff: false,
        sawVerification: false
      }
    };
  }

  async save(task: TaskState): Promise<void> {
    await this.ensure();
    task.updatedAt = new Date().toISOString();
    await fs.mkdir(this.taskDir(task.id), { recursive: true });
    await fs.writeFile(this.taskFile(task.id), JSON.stringify(task, null, 2), "utf8");
  }

  async load(taskId: string): Promise<TaskState> {
    const raw = await fs.readFile(this.taskFile(taskId), "utf8");
    return JSON.parse(raw) as TaskState;
  }

  async list(): Promise<Array<Pick<TaskState, "id" | "goal" | "status" | "updatedAt" | "createdAt">>> {
    await this.ensure();
    const entries = await fs.readdir(this.baseDir(), { withFileTypes: true });
    const tasks: Array<Pick<TaskState, "id" | "goal" | "status" | "updatedAt" | "createdAt">> = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      try {
        const task = await this.load(entry.name);
        tasks.push({
          id: task.id,
          goal: task.goal,
          status: task.status,
          updatedAt: task.updatedAt,
          createdAt: task.createdAt
        });
      } catch {
        continue;
      }
    }

    return tasks.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async setStatus(taskId: string, status: TaskStatus, lastError?: string): Promise<TaskState> {
    const task = await this.load(taskId);
    task.status = status;
    task.lastError = lastError;
    await this.save(task);
    return task;
  }

  async saveCheckpoint(task: TaskState, name?: string): Promise<string> {
    const checkpointName = sanitizeCheckpointName(name ?? new Date().toISOString());
    const dir = this.checkpointDir(task.id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `${checkpointName}.json`), JSON.stringify(task, null, 2), "utf8");
    return checkpointName;
  }

  async loadCheckpoint(taskId: string, name: string): Promise<TaskState> {
    const raw = await fs.readFile(path.join(this.checkpointDir(taskId), `${sanitizeCheckpointName(name)}.json`), "utf8");
    return JSON.parse(raw) as TaskState;
  }

  private baseDir(): string {
    return path.join(this.root, STATE_DIR);
  }

  private taskDir(taskId: string): string {
    return path.join(this.baseDir(), taskId);
  }

  private taskFile(taskId: string): string {
    return path.join(this.taskDir(taskId), "task.json");
  }

  private checkpointDir(taskId: string): string {
    return path.join(this.taskDir(taskId), "checkpoints");
  }
}

function sanitizeCheckpointName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}
