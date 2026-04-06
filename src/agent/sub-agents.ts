import type { PlannerAdapter, PlannerSession } from "./types.js";
import type { AgentEventCallback } from "./orchestrator.js";

/**
 * Sub-agent: a focused ChatGPT call with a specific role.
 * Each call gets a fresh ChatGPT chat — no drift, no context pollution.
 */
export interface SubAgentResult {
  role: string;
  output: string;
  success: boolean;
}

export interface SubTask {
  description: string;
  files: string[];       // files to read for this subtask
  role: "explore" | "edit" | "write" | "review" | "run";
}

export interface Plan {
  complexity: "simple" | "medium" | "complex";
  subtasks: SubTask[];
  summary: string;
}

// --- System prompts for each role ---

const PLANNER_PROMPT = `You are a task planner. Break the task into subtasks. Be minimal.

Output ONLY subtask lines, nothing else:
SUBTASK: [explore|edit|write|review|run] | files: file1.ts, file2.ts | description

Rules:
- 1-3 subtasks max. Do NOT over-plan.
- For analysis tasks: 1 explore subtask is enough.
- For simple edits: 1 edit subtask.
- Use review ONLY after edits, never for analysis.
- Files marked ★ are pre-fetched. The pipeline auto-includes relevant files.
- Output ONLY the SUBTASK lines. No explanation, no preamble.`;

const EXPLORER_PROMPT = `Answer about the codebase. HARD LIMIT: 150 words max. Bullet points only. No intro, no summary, no filler. Start with the answer. If you need more files, end with NEED_FILE: path/to/file.ts`;

const EDITOR_PROMPT = `Produce ONLY patch blocks. No explanation before or after.

Format:
PATCH: path/to/file.ext
<<<<<<< BEFORE
exact lines from file
=======
replacement lines
>>>>>>> AFTER

For new files: CREATE: path\ncontent\nEND_CREATE

Rules: copy BEFORE exactly, minimal context lines, no full files.`;

const WRITER_PROMPT = `Produce ONLY file content blocks. No commentary.

New files: CREATE: path/to/file.md\ncontent\nEND_CREATE
Edits: PATCH: path\n<<<<<<< BEFORE\nold\n=======\nnew\n>>>>>>> AFTER

Be concise. No filler.`;

const REVIEWER_PROMPT = `Review the diff. Output ONLY:
- PASS or FAIL on first line
- If FAIL: max 3 bullet points listing issues + PATCH fix blocks
- If PASS: one sentence why

No preamble. No summary paragraph.`;

export class SubAgentRunner {
  // Persistent session per role — each role reuses its own ChatGPT chat
  private sessions = new Map<string, PlannerSession>();

  constructor(
    private readonly chatgpt: PlannerAdapter,
    private readonly emit?: AgentEventCallback
  ) {}

  /** Reset a specific role session or all */
  resetSession(role?: string): void {
    if (role) this.sessions.delete(role);
    else this.sessions.clear();
  }

  /**
   * Plan: break a task into subtasks.
   */
  async plan(task: string, fileTree: string): Promise<Plan> {
    this.emit?.({ type: "step", data: { step: "📋 Planning subtasks…" } });

    const prompt = `${PLANNER_PROMPT}\n\nFILE TREE:\n${fileTree}\n\nTASK: ${task}`;
    const response = await this.callRole("planner", prompt);

    if (!response) {
      return { complexity: "simple", subtasks: [{ description: task, files: [], role: "edit" }], summary: "Single step" };
    }

    const subtasks = this.parsePlan(response);

    if (subtasks.length === 0) {
      return { complexity: "simple", subtasks: [{ description: task, files: [], role: "edit" }], summary: "Single step" };
    }

    const complexity = subtasks.length <= 1 ? "simple" : subtasks.length <= 3 ? "medium" : "complex";
    return { complexity, subtasks, summary: response.slice(0, 200) };
  }

  /**
   * Explore: analyze files and produce a summary.
   */
  async explore(task: string, fileContents: string): Promise<SubAgentResult> {
    this.emit?.({ type: "step", data: { step: "🔍 Exploring codebase…" } });

    const prompt = `${EXPLORER_PROMPT}\n\n${fileContents}\n\nTASK: ${task}`;
    const output = await this.callRole("explorer", prompt);

    return { role: "explorer", output: output ?? "No analysis produced.", success: !!output };
  }

  /**
   * Edit: produce PATCH blocks for file modifications.
   */
  async edit(task: string, fileContents: string, explorerSummary?: string): Promise<SubAgentResult> {
    this.emit?.({ type: "step", data: { step: "✏️ Editing code…" } });

    const parts = [EDITOR_PROMPT, "", fileContents];
    if (explorerSummary) parts.push("", "ANALYSIS:", explorerSummary);
    parts.push("", `TASK: ${task}`);

    const output = await this.callRole("editor", parts.join("\n"));
    return { role: "editor", output: output ?? "No edits produced.", success: !!output };
  }

  /**
   * Write: produce documentation or new files.
   */
  async write(task: string, fileContents: string, explorerSummary?: string): Promise<SubAgentResult> {
    this.emit?.({ type: "step", data: { step: "📝 Writing documentation…" } });

    const parts = [WRITER_PROMPT, "", fileContents];
    if (explorerSummary) parts.push("", "ANALYSIS:", explorerSummary);
    parts.push("", `TASK: ${task}`);

    const output = await this.callRole("writer", parts.join("\n"));
    return { role: "writer", output: output ?? "No content produced.", success: !!output };
  }

  /**
   * Review: check diffs and test output.
   */
  async review(diff: string, testOutput?: string): Promise<SubAgentResult> {
    this.emit?.({ type: "step", data: { step: "🔎 Reviewing changes…" } });

    const parts = [REVIEWER_PROMPT, "", "DIFF:", diff];
    if (testOutput) parts.push("", "TEST OUTPUT:", testOutput);

    const output = await this.callRole("reviewer", parts.join("\n"));
    const passed = output?.toUpperCase().includes("PASS") ?? false;
    return { role: "reviewer", output: output ?? "No review produced.", success: passed };
  }

  /**
   * Call a sub-agent by role. Reuses the same ChatGPT chat per role.
   * Prompt size is capped per role to avoid sending unnecessary context.
   */
  private async callRole(role: string, prompt: string): Promise<string | null> {
    // Role-based prompt caps: explore needs more, edit/review need less
    const promptCaps: Record<string, number> = {
      planner: 8000,
      explorer: 15000,
      editor: 20000,
      writer: 15000,
      reviewer: 10000,
    };
    const cap = promptCaps[role] ?? 25000;

    try {
      let session = this.sessions.get(role);
      if (!session) {
        session = await this.chatgpt.startSession();
        this.sessions.set(role, session);
        console.log(`[${role}] New chat session`);
      } else {
        console.log(`[${role}] Reusing existing chat`);
      }

      const result = await this.chatgpt.sendTurn(session, prompt.slice(0, cap));
      if (result.ok && result.raw) {
        console.log(`[${role}] Response (${result.raw.length} chars):`, result.raw.slice(0, 100));
        return result.raw;
      }

      // Session might be dead — reset and retry
      console.log(`[${role}] Failed, retrying with fresh session:`, result.message);
      session = await this.chatgpt.startSession();
      this.sessions.set(role, session);
      const retry = await this.chatgpt.sendTurn(session, prompt.slice(0, cap));
      if (retry.ok && retry.raw) {
        console.log(`[${role}] Retry succeeded (${retry.raw.length} chars)`);
        return retry.raw;
      }

      console.log(`[${role}] Retry also failed:`, retry.message);
      return null;
    } catch (err: any) {
      console.log(`[${role}] Error:`, err.message);
      return null;
    }
  }

  private parsePlan(text: string): SubTask[] {
    const subtasks: SubTask[] = [];
    const regex = /SUBTASK:\s*(explore|edit|write|review|run)\s*\|\s*files:\s*(.*?)\s*\|\s*(.+)/gi;
    let m;
    while ((m = regex.exec(text)) !== null) {
      const role = m[1].toLowerCase() as SubTask["role"];
      const files = m[2].split(",").map(f => f.trim()).filter(f => f.length > 0);
      const description = m[3].trim();
      subtasks.push({ role, files, description });
    }
    return subtasks;
  }
}
