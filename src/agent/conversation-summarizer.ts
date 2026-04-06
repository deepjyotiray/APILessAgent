/**
 * Intelligent conversation summarizer.
 *
 * Summarizes conversation history via Ollama when token pressure builds,
 * preserving key decisions, file changes, and user intent across turns.
 * The orchestrator injects the running summary into each prompt so the
 * planner has cross-turn memory without unbounded context growth.
 */

const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";
const SUMMARIZE_MODEL = process.env.KB_MODEL ?? "qwen2.5-coder:7b";
const TIMEOUT_MS = 20_000;

/** A single turn in the conversation. */
export interface ConversationTurn {
  role: "user" | "assistant" | "tool";
  content: string;
  /** Tool name if role === "tool" */
  tool?: string;
  /** Whether this turn resulted in a file change */
  hadEdit?: boolean;
  timestamp?: number;
}

/** Persistent summary state for one conversation. */
export interface ConversationSummaryState {
  /** The running summary text */
  summary: string;
  /** Turns accumulated since last summarization */
  pendingTurns: ConversationTurn[];
  /** Total turns ever summarized */
  totalSummarized: number;
  /** Files modified across the conversation */
  filesModified: string[];
  /** Last summarization timestamp */
  lastSummarizedAt: number;
}

/** Thresholds that control when summarization triggers. */
export interface SummarizationPolicy {
  /** Summarize when pending turns exceed this char count */
  maxPendingChars: number;
  /** Summarize when pending turn count exceeds this */
  maxPendingTurns: number;
  /** Max chars for the running summary itself */
  maxSummaryChars: number;
}

const DEFAULT_POLICY: SummarizationPolicy = {
  maxPendingChars: 8000,
  maxPendingTurns: 10,
  maxSummaryChars: 2000,
};

export function createSummaryState(): ConversationSummaryState {
  return {
    summary: "",
    pendingTurns: [],
    totalSummarized: 0,
    filesModified: [],
    lastSummarizedAt: Date.now(),
  };
}

/** Record a turn. Returns true if summarization should be triggered. */
export function addTurn(
  state: ConversationSummaryState,
  turn: ConversationTurn,
  policy: SummarizationPolicy = DEFAULT_POLICY
): boolean {
  state.pendingTurns.push({ ...turn, timestamp: turn.timestamp ?? Date.now() });

  if (turn.hadEdit && turn.tool) {
    // Extract file path from content if present
    const pathMatch = turn.content.match(/(?:✅|⚠️)\s+([^\s:]+)/);
    if (pathMatch) {
      const file = pathMatch[1];
      if (!state.filesModified.includes(file)) state.filesModified.push(file);
    }
  }

  return shouldSummarize(state, policy);
}

/** Check if summarization should trigger based on token pressure. */
export function shouldSummarize(
  state: ConversationSummaryState,
  policy: SummarizationPolicy = DEFAULT_POLICY
): boolean {
  if (state.pendingTurns.length === 0) return false;
  const pendingChars = state.pendingTurns.reduce((s, t) => s + t.content.length, 0);
  return (
    pendingChars >= policy.maxPendingChars ||
    state.pendingTurns.length >= policy.maxPendingTurns
  );
}

/**
 * Summarize pending turns into the running summary via Ollama.
 * Falls back to a deterministic extraction if Ollama is unavailable.
 */
export async function summarize(
  state: ConversationSummaryState,
  policy: SummarizationPolicy = DEFAULT_POLICY
): Promise<string> {
  if (state.pendingTurns.length === 0) return state.summary;

  const newContent = formatTurnsForSummary(state.pendingTurns);
  const existingSummary = state.summary;

  let merged: string;
  try {
    merged = await ollamaSummarize(existingSummary, newContent, state.filesModified, policy);
  } catch {
    // Fallback: deterministic compression
    merged = deterministicSummarize(existingSummary, state.pendingTurns, state.filesModified, policy);
  }

  state.summary = merged.slice(0, policy.maxSummaryChars);
  state.totalSummarized += state.pendingTurns.length;
  state.pendingTurns = [];
  state.lastSummarizedAt = Date.now();

  return state.summary;
}

/** Get the summary to inject into a prompt. Includes pending turns if not yet summarized. */
export function getSummaryForPrompt(state: ConversationSummaryState): string {
  if (!state.summary && state.pendingTurns.length === 0) return "";

  const parts: string[] = [];
  if (state.summary) parts.push(state.summary);

  // Include a brief note about unsummarized recent turns
  if (state.pendingTurns.length > 0) {
    const recent = state.pendingTurns
      .filter(t => t.role === "user" || t.hadEdit)
      .slice(-3)
      .map(t => {
        if (t.role === "user") return `User: ${t.content.slice(0, 100)}`;
        return t.content.slice(0, 100);
      });
    if (recent.length) {
      parts.push("Recent (not yet summarized): " + recent.join(" | "));
    }
  }

  return parts.join("\n");
}

// --- Ollama-based summarization ---

const SUMMARIZE_PROMPT = `You are a conversation summarizer for a coding agent. Merge the existing summary with new conversation turns into a single concise summary.

Rules:
- Keep it under 300 words
- Preserve: user goals, key decisions, files modified, errors encountered, current state
- Drop: verbose tool outputs, repeated attempts, intermediate thinking
- Use bullet points
- If the existing summary is empty, create a fresh one
- End with "Current state:" describing what was last done/discussed

Existing summary:
{EXISTING}

New conversation turns:
{NEW_TURNS}

Files modified so far: {FILES}

Write the merged summary:`;

async function ollamaSummarize(
  existing: string,
  newTurns: string,
  files: string[],
  policy: SummarizationPolicy
): Promise<string> {
  const prompt = SUMMARIZE_PROMPT
    .replace("{EXISTING}", existing || "(none)")
    .replace("{NEW_TURNS}", newTurns.slice(0, 6000))
    .replace("{FILES}", files.length ? files.join(", ") : "(none)");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  const res = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: SUMMARIZE_MODEL,
      prompt,
      stream: false,
      options: { temperature: 0, num_predict: 512 },
    }),
    signal: controller.signal,
  });
  clearTimeout(timer);

  if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);
  const body = await res.json() as { response?: string };
  const result = (body.response ?? "").trim();
  if (!result) throw new Error("Empty summarization response");
  return result.slice(0, policy.maxSummaryChars);
}

// --- Deterministic fallback ---

function deterministicSummarize(
  existing: string,
  turns: ConversationTurn[],
  files: string[],
  policy: SummarizationPolicy
): string {
  const lines: string[] = [];

  // Keep the core of the existing summary
  if (existing) {
    const existingLines = existing.split("\n").filter(l => l.trim());
    // Keep last N lines to stay within budget
    const keepLines = existingLines.slice(-8);
    lines.push("Previous context:", ...keepLines, "");
  }

  // Extract key events from new turns
  const userGoals = turns
    .filter(t => t.role === "user")
    .map(t => `- User: ${t.content.slice(0, 120)}`);
  const edits = turns
    .filter(t => t.hadEdit)
    .map(t => `- ${t.content.slice(0, 120)}`);
  const errors = turns
    .filter(t => t.content.includes("⚠️") || t.content.includes("ERROR"))
    .map(t => `- ${t.content.slice(0, 120)}`);

  if (userGoals.length) lines.push("User requests:", ...userGoals.slice(-3));
  if (edits.length) lines.push("Changes made:", ...edits.slice(-5));
  if (errors.length) lines.push("Issues:", ...errors.slice(-2));
  if (files.length) lines.push(`Files modified: ${files.slice(-10).join(", ")}`);

  // Current state from last meaningful turn
  const lastUser = [...turns].reverse().find(t => t.role === "user");
  const lastAssistant = [...turns].reverse().find(t => t.role === "assistant");
  if (lastUser) lines.push(`Current state: User asked "${lastUser.content.slice(0, 100)}"`);
  else if (lastAssistant) lines.push(`Current state: ${lastAssistant.content.slice(0, 100)}`);

  return lines.join("\n").slice(0, policy.maxSummaryChars);
}

// --- Helpers ---

function formatTurnsForSummary(turns: ConversationTurn[]): string {
  return turns.map(t => {
    const prefix = t.role === "tool" ? `[tool:${t.tool}]` : `[${t.role}]`;
    return `${prefix} ${t.content.slice(0, 500)}`;
  }).join("\n");
}

/**
 * Compact an Ollama planner's conversation history using the summary.
 * Replaces old messages with a single summary message, keeping recent ones.
 */
export function compactOllamaHistory(
  history: Array<{ role: string; content: string }>,
  summary: string,
  keepRecent = 4
): Array<{ role: string; content: string }> {
  if (history.length <= keepRecent + 1) return history;

  const recent = history.slice(-keepRecent);
  const compacted: Array<{ role: string; content: string }> = [];

  if (summary) {
    compacted.push({
      role: "system",
      content: `Conversation summary (earlier turns compacted):\n${summary}`,
    });
  }

  compacted.push(...recent);
  return compacted;
}
