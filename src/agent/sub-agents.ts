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

const PLANNER_PROMPT = `You are a task planner. Given a coding task and a file tree, break it into ordered subtasks.

Output format (plain text, one subtask per line):
SUBTASK: [explore|edit|write|review|run] | files: file1.ts, file2.ts | description of what to do

Rules:
- Start with explore if you need to understand the code first
- Use edit for modifying existing files (produces PATCH blocks)
- Use write for creating new files (produces CREATE blocks)
- Use review after edits to check for issues
- Use run for commands (tests, build, lint)
- Keep it to 2-5 subtasks. Don't over-plan.
- For simple tasks (single file edit), just output one edit subtask.

Example for "add error handling to the API":
SUBTASK: explore | files: src/api-server.ts | understand current error handling
SUBTASK: edit | files: src/api-server.ts | add try-catch and error responses
SUBTASK: run | files: | npm run build
SUBTASK: review | files: | check the diff for issues`;

const EXPLORER_PROMPT = `You are a code explorer. Analyze the provided files and produce a concise summary.

Output:
- What the code does (1-2 sentences)
- Key functions/classes and their purpose
- Relevant patterns or conventions
- Anything important for the task at hand

Be concise. No code output. Just analysis.`;

const EDITOR_PROMPT = `You are a code editor. Given file contents and a task, produce surgical edits.

Use this EXACT format for each edit:

PATCH: path/to/file.ext
<<<<<<< BEFORE
exact lines to replace (copy from the file)
=======
new replacement lines
>>>>>>> AFTER

Rules:
- Copy the BEFORE text EXACTLY from the file (including whitespace)
- Keep patches small — only the lines that change plus 1-2 lines of context
- You can output multiple PATCH blocks for different files
- Do NOT output entire files. Only the changed sections.
- If creating a new file, use CREATE: path\\ncontent\\nEND_CREATE`;

const WRITER_PROMPT = `You are a technical writer. Given project context, produce documentation.

For new files, use:
CREATE: path/to/file.md
content here
END_CREATE

For updating existing files, use:
PATCH: path/to/file.md
<<<<<<< BEFORE
exact text to replace
=======
new text
>>>>>>> AFTER

Rules:
- Be concise and practical
- Use markdown formatting
- Include code examples where helpful
- Keep patches focused — don't rewrite entire files`;

const REVIEWER_PROMPT = `You are a code reviewer. Given a git diff and optionally test output, review the changes.

Output:
- PASS or FAIL
- If FAIL: list specific issues and suggest fixes using PATCH blocks
- If PASS: brief summary of what looks good

Be concise. Focus on bugs, logic errors, and missing edge cases.`;

export class SubAgentRunner {
  constructor(
    private readonly chatgpt: PlannerAdapter,
    private readonly emit?: AgentEventCallback
  ) {}

  /**
   * Plan: break a task into subtasks.
   */
  async plan(task: string, fileTree: string): Promise<Plan> {
    this.emit?.({ type: "step", data: { step: "📋 Planning subtasks…" } });

    const prompt = `${PLANNER_PROMPT}\n\nFILE TREE:\n${fileTree}\n\nTASK: ${task}`;
    const response = await this.callFresh(prompt);

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
    const output = await this.callFresh(prompt);

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

    const output = await this.callFresh(parts.join("\n"));
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

    const output = await this.callFresh(parts.join("\n"));
    return { role: "writer", output: output ?? "No content produced.", success: !!output };
  }

  /**
   * Review: check diffs and test output.
   */
  async review(diff: string, testOutput?: string): Promise<SubAgentResult> {
    this.emit?.({ type: "step", data: { step: "🔎 Reviewing changes…" } });

    const parts = [REVIEWER_PROMPT, "", "DIFF:", diff];
    if (testOutput) parts.push("", "TEST OUTPUT:", testOutput);

    const output = await this.callFresh(parts.join("\n"));
    const passed = output?.toUpperCase().includes("PASS") ?? false;
    return { role: "reviewer", output: output ?? "No review produced.", success: passed };
  }

  /**
   * Each sub-agent call gets a FRESH ChatGPT chat.
   */
  private async callFresh(prompt: string): Promise<string | null> {
    try {
      const session = await this.chatgpt.startSession();
      const result = await this.chatgpt.sendTurn(session, prompt.slice(0, 35000));
      if (result.ok && result.raw) {
        console.log(`[sub-agent] Response (${result.raw.length} chars):`, result.raw.slice(0, 100));
        return result.raw;
      }
      console.log("[sub-agent] Failed:", result.message);
      return null;
    } catch (err: any) {
      console.log("[sub-agent] Error:", err.message);
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
