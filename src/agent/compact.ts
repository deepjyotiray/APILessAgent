/**
 * Session compaction.
 * Ported from Claude Code's rust/crates/runtime/src/compact.rs
 *
 * Compacts older conversation steps into a structured summary while
 * preserving recent messages verbatim. Supports re-compaction by
 * merging previous summaries into the new one.
 */

import type { StepRecord } from "./types.js";

const COMPACT_CONTINUATION_PREAMBLE =
  "This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\n";
const COMPACT_RECENT_MESSAGES_NOTE = "Recent messages are preserved verbatim.";
const COMPACT_DIRECT_RESUME_INSTRUCTION =
  "Continue the conversation from where it left off without asking the user any further questions. Resume directly — do not acknowledge the summary, do not recap what was happening, and do not preface with continuation text.";

export interface CompactionConfig {
  preserveRecentSteps: number;
  maxEstimatedTokens: number;
}

export const DEFAULT_COMPACTION_CONFIG: CompactionConfig = {
  preserveRecentSteps: 4,
  maxEstimatedTokens: 10_000,
};

export interface CompactionResult {
  summary: string;
  formattedSummary: string;
  compactedSteps: StepRecord[];
  removedStepCount: number;
}

/** Roughly estimate token footprint of steps. */
export function estimateStepTokens(steps: StepRecord[]): number {
  return steps.reduce((sum, step) => {
    let chars = 0;
    if (step.plannerRaw) chars += step.plannerRaw.length;
    if (step.toolResult?.message) chars += step.toolResult.message.length;
    const data = step.toolResult?.data;
    if (data) chars += JSON.stringify(data).length;
    return sum + Math.ceil(chars / 4) + 1;
  }, 0);
}

/** Returns true when steps exceed the configured compaction budget. */
export function shouldCompact(steps: StepRecord[], config: CompactionConfig, existingSummary?: string): boolean {
  const start = existingSummary ? 0 : 0; // no prefix to skip in step array
  const compactable = steps.slice(start);
  return (
    compactable.length > config.preserveRecentSteps &&
    estimateStepTokens(compactable) >= config.maxEstimatedTokens
  );
}

/** Compact older steps into a summary, preserving the recent tail. */
export function compactSteps(
  steps: StepRecord[],
  config: CompactionConfig,
  existingSummary?: string
): CompactionResult {
  if (!shouldCompact(steps, config, existingSummary)) {
    return { summary: "", formattedSummary: "", compactedSteps: steps, removedStepCount: 0 };
  }

  const keepFrom = Math.max(0, steps.length - config.preserveRecentSteps);
  const removed = steps.slice(0, keepFrom);
  const preserved = steps.slice(keepFrom);

  const newSummary = summarizeSteps(removed);
  const merged = mergeSummaries(existingSummary, newSummary);
  const formatted = formatCompactSummary(merged);

  return {
    summary: merged,
    formattedSummary: formatted,
    compactedSteps: preserved,
    removedStepCount: removed.length,
  };
}

/** Build the synthetic continuation message used after compaction. */
export function getCompactContinuationMessage(
  summary: string,
  suppressFollowUpQuestions: boolean,
  recentMessagesPreserved: boolean
): string {
  let base = `${COMPACT_CONTINUATION_PREAMBLE}${formatCompactSummary(summary)}`;
  if (recentMessagesPreserved) base += `\n\n${COMPACT_RECENT_MESSAGES_NOTE}`;
  if (suppressFollowUpQuestions) base += `\n${COMPACT_DIRECT_RESUME_INSTRUCTION}`;
  return base;
}

/** Normalize a compaction summary into user-facing continuation text. */
export function formatCompactSummary(summary: string): string {
  let result = stripTagBlock(summary, "analysis");
  const content = extractTagBlock(result, "summary");
  if (content !== null) {
    result = result.replace(`<summary>${content}</summary>`, `Summary:\n${content.trim()}`);
  }
  return collapseBlankLines(result).trim();
}

// --- Internal ---

function summarizeSteps(steps: StepRecord[]): string {
  const toolSteps = steps.filter((s) => s.toolName);
  const toolNames = [...new Set(toolSteps.map((s) => s.toolName!))];

  const keyFiles = collectKeyFiles(steps);
  const pendingWork = inferPendingWork(steps);
  const currentWork = inferCurrentWork(steps);

  const lines: string[] = [
    "<summary>",
    "Conversation summary:",
    `- Scope: ${steps.length} earlier steps compacted (tool_calls=${toolSteps.length}).`,
  ];

  if (toolNames.length) lines.push(`- Tools mentioned: ${toolNames.join(", ")}.`);

  // Recent user requests (from planner replies that triggered tools)
  const recentGoals = steps
    .filter((s) => s.plannerReply?.type === "tool" && s.plannerReply.reason)
    .slice(-3)
    .map((s) => truncate((s.plannerReply as any).reason, 160));
  if (recentGoals.length) {
    lines.push("- Recent planner reasoning:");
    recentGoals.forEach((r) => lines.push(`  - ${r}`));
  }

  if (pendingWork.length) {
    lines.push("- Pending work:");
    pendingWork.forEach((item) => lines.push(`  - ${item}`));
  }

  if (keyFiles.length) lines.push(`- Key files referenced: ${keyFiles.join(", ")}.`);
  if (currentWork) lines.push(`- Current work: ${currentWork}`);

  lines.push("- Key timeline:");
  for (const step of steps) {
    const tool = step.toolName ?? "(none)";
    const ok = step.toolResult ? `ok=${step.toolResult.ok}` : "";
    const err = step.toolResult?.errorCode ? ` error=${step.toolResult.errorCode}` : "";
    lines.push(`  - step ${step.index}: ${tool} ${ok}${err}`);
  }

  lines.push("</summary>");
  return lines.join("\n");
}

function mergeSummaries(existing: string | undefined, newSummary: string): string {
  if (!existing) return newSummary;

  const prevHighlights = extractSummaryHighlights(existing);
  const newFormatted = formatCompactSummary(newSummary);
  const newHighlights = extractSummaryHighlights(newFormatted);
  const newTimeline = extractSummaryTimeline(newFormatted);

  const lines: string[] = ["<summary>", "Conversation summary:"];
  if (prevHighlights.length) {
    lines.push("- Previously compacted context:");
    prevHighlights.forEach((l) => lines.push(`  ${l}`));
  }
  if (newHighlights.length) {
    lines.push("- Newly compacted context:");
    newHighlights.forEach((l) => lines.push(`  ${l}`));
  }
  if (newTimeline.length) {
    lines.push("- Key timeline:");
    newTimeline.forEach((l) => lines.push(`  ${l}`));
  }
  lines.push("</summary>");
  return lines.join("\n");
}

function collectKeyFiles(steps: StepRecord[]): string[] {
  const files = new Set<string>();
  for (const step of steps) {
    // From tool args
    const args = step.toolArgs;
    if (args) {
      if (typeof args.path === "string" && args.path.includes("/")) files.add(args.path);
      if (Array.isArray(args.paths)) {
        for (const p of args.paths) {
          if (typeof p === "string" && p.includes("/")) files.add(p);
        }
      }
    }
    // From tool result data
    const data = step.toolResult?.data as Record<string, unknown> | undefined;
    if (data) {
      if (typeof data.path === "string" && data.path.includes("/")) files.add(data.path);
      if (Array.isArray(data.files)) {
        for (const f of data.files) {
          if (typeof f === "string" && f.includes("/")) files.add(f);
        }
      }
    }
  }
  return [...files].sort().slice(0, 8);
}

function inferPendingWork(steps: StepRecord[]): string[] {
  return steps
    .filter((s) => s.toolResult?.ok === false)
    .slice(-3)
    .map((s) => truncate(`${s.toolName}: ${s.toolResult!.message}`, 160));
}

function inferCurrentWork(steps: StepRecord[]): string | null {
  for (let i = steps.length - 1; i >= 0; i--) {
    const reply = steps[i].plannerReply;
    if (reply?.type === "tool" && reply.reason) return truncate(reply.reason, 200);
  }
  return null;
}

function extractSummaryHighlights(summary: string): string[] {
  const lines: string[] = [];
  let inTimeline = false;
  for (const line of formatCompactSummary(summary).split("\n")) {
    const trimmed = line.trimEnd();
    if (!trimmed || trimmed === "Summary:" || trimmed === "Conversation summary:") continue;
    if (trimmed === "- Key timeline:") { inTimeline = true; continue; }
    if (inTimeline) continue;
    lines.push(trimmed);
  }
  return lines;
}

function extractSummaryTimeline(summary: string): string[] {
  const lines: string[] = [];
  let inTimeline = false;
  for (const line of formatCompactSummary(summary).split("\n")) {
    const trimmed = line.trimEnd();
    if (trimmed === "- Key timeline:") { inTimeline = true; continue; }
    if (!inTimeline) continue;
    if (!trimmed) break;
    lines.push(trimmed);
  }
  return lines;
}

function extractTagBlock(content: string, tag: string): string | null {
  const start = `<${tag}>`;
  const end = `</${tag}>`;
  const si = content.indexOf(start);
  if (si === -1) return null;
  const ei = content.indexOf(end, si + start.length);
  if (ei === -1) return null;
  return content.slice(si + start.length, ei);
}

function stripTagBlock(content: string, tag: string): string {
  const start = `<${tag}>`;
  const end = `</${tag}>`;
  const si = content.indexOf(start);
  const ei = content.indexOf(end);
  if (si === -1 || ei === -1) return content;
  return content.slice(0, si) + content.slice(ei + end.length);
}

function collapseBlankLines(content: string): string {
  const lines: string[] = [];
  let lastBlank = false;
  for (const line of content.split("\n")) {
    const blank = line.trim().length === 0;
    if (blank && lastBlank) continue;
    lines.push(line.trimEnd());
    lastBlank = blank;
  }
  return lines.join("\n");
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + "…";
}
