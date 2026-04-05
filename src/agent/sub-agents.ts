import type { PlannerAdapter, PlannerSession } from "./types.js";
import { PoolPlanner } from "./pool-planner.js";
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
- Use review ONLY after edits/writes to check for issues. Do NOT use review for analysis-only tasks.
- Use run for commands (tests, build, lint)
- Keep it to 2-5 subtasks. Don't over-plan.
- For simple tasks (single file edit), just output one edit subtask.
- For analysis/explanation tasks, use only explore subtasks. No review needed.
- For the LAST explore subtask, ask for a comprehensive summary that combines all findings.

Example for "analyse the repo":
SUBTASK: explore | files: README.md, package.json, AGENT.md | understand purpose, setup, and high-level architecture
SUBTASK: explore | files: src/agent/orchestrator.ts, src/agent/tools.ts, src/agent/types.ts | trace core agent workflow and tool system
SUBTASK: explore | files: app/main.cjs, src/api-server.ts, src/bridge-server.ts | inspect platform surfaces and integration points

Example for "add error handling to the API":
SUBTASK: explore | files: src/api-server.ts | understand current error handling
SUBTASK: edit | files: src/api-server.ts | add try-catch and error responses
SUBTASK: run | files: | npm run build
SUBTASK: review | files: | check the diff for issues`;

const EXPLORER_PROMPT = `You are a code explorer. Analyze the provided files and produce a detailed summary.

Output a thorough analysis covering:
- What the code does (clear explanation)
- Key functions/classes and their purpose
- How components connect to each other
- Relevant patterns, conventions, or design decisions
- Data flow and control flow
- Dependencies and external integrations
- Anything notable, unusual, or important

Be thorough but organized. Use markdown headers and bullet points.`;

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
   * First call for a role opens a new chat. Subsequent calls continue in it.
   */
  private async callRole(role: string, prompt: string): Promise<string | null> {
    try {
      let session = this.sessions.get(role);
      if (!session) {
        session = await this.chatgpt.startSession();
        this.sessions.set(role, session);
        console.log(`[${role}] New chat session`);
      } else {
        console.log(`[${role}] Reusing existing chat`);
      }

      const result = await this.chatgpt.sendTurn(session, prompt.slice(0, 35000));
      if (result.ok && result.raw) {
        console.log(`[${role}] Response (${result.raw.length} chars):`, result.raw.slice(0, 100));
        return result.raw;
      }

      // Session might be dead — reset and retry
      console.log(`[${role}] Failed, retrying with fresh session:`, result.message);
      session = await this.chatgpt.startSession();
      this.sessions.set(role, session);
      const retry = await this.chatgpt.sendTurn(session, prompt.slice(0, 35000));
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
