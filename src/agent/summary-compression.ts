/**
 * Summary compression.
 * Ported from Claude Code's rust/crates/runtime/src/summary_compression.rs
 *
 * Compresses a compaction summary to fit within a character/line budget
 * while preserving the most important information (scope, current work,
 * pending work, key files) and dropping lower-priority timeline entries.
 */

export interface SummaryCompressionBudget {
  maxChars: number;
  maxLines: number;
  maxLineChars: number;
}

export const DEFAULT_BUDGET: SummaryCompressionBudget = {
  maxChars: 1_200,
  maxLines: 24,
  maxLineChars: 160,
};

export interface SummaryCompressionResult {
  summary: string;
  originalChars: number;
  compressedChars: number;
  originalLines: number;
  compressedLines: number;
  removedDuplicateLines: number;
  omittedLines: number;
  truncated: boolean;
}

export function compressSummary(
  summary: string,
  budget: SummaryCompressionBudget = DEFAULT_BUDGET
): SummaryCompressionResult {
  const originalChars = summary.length;
  const originalLines = summary.split("\n").length;

  const normalized = normalizeLines(summary, budget.maxLineChars);
  if (!normalized.lines.length || budget.maxChars === 0 || budget.maxLines === 0) {
    return {
      summary: "",
      originalChars,
      compressedChars: 0,
      originalLines,
      compressedLines: 0,
      removedDuplicateLines: normalized.removedDuplicateLines,
      omittedLines: normalized.lines.length,
      truncated: originalChars > 0,
    };
  }

  const selected = selectLineIndexes(normalized.lines, budget);
  let compressed = selected.map((i) => normalized.lines[i]);
  if (!compressed.length) compressed = [truncateLine(normalized.lines[0], budget.maxChars)];

  const omittedLines = normalized.lines.length - compressed.length;
  if (omittedLines > 0) {
    const notice = `- … ${omittedLines} additional line(s) omitted.`;
    const candidate = [...compressed, notice];
    if (candidate.length <= budget.maxLines && joinedCharCount(candidate) <= budget.maxChars) {
      compressed.push(notice);
    }
  }

  const result = compressed.join("\n");
  return {
    summary: result,
    originalChars,
    compressedChars: result.length,
    originalLines,
    compressedLines: compressed.length,
    removedDuplicateLines: normalized.removedDuplicateLines,
    omittedLines,
    truncated: result !== summary.trim(),
  };
}

export function compressSummaryText(summary: string): string {
  return compressSummary(summary).summary;
}

// --- Internal ---

interface NormalizedSummary {
  lines: string[];
  removedDuplicateLines: number;
}

function normalizeLines(summary: string, maxLineChars: number): NormalizedSummary {
  const seen = new Set<string>();
  const lines: string[] = [];
  let removedDuplicateLines = 0;

  for (const raw of summary.split("\n")) {
    const normalized = collapseInlineWhitespace(raw);
    if (!normalized) continue;
    const truncated = truncateLine(normalized, maxLineChars);
    const key = truncated.toLowerCase();
    if (seen.has(key)) { removedDuplicateLines++; continue; }
    seen.add(key);
    lines.push(truncated);
  }

  return { lines, removedDuplicateLines };
}

function selectLineIndexes(lines: string[], budget: SummaryCompressionBudget): number[] {
  const selected = new Set<number>();

  for (let priority = 0; priority <= 3; priority++) {
    for (let i = 0; i < lines.length; i++) {
      if (selected.has(i) || linePriority(lines[i]) !== priority) continue;
      const candidate = [...selected].map((idx) => lines[idx]);
      candidate.push(lines[i]);
      if (candidate.length > budget.maxLines) continue;
      if (joinedCharCount(candidate) > budget.maxChars) continue;
      selected.add(i);
    }
  }

  return [...selected].sort((a, b) => a - b);
}

function linePriority(line: string): number {
  if (line === "Summary:" || line === "Conversation summary:" || isCoreDetail(line)) return 0;
  if (isSectionHeader(line)) return 1;
  if (line.startsWith("- ") || line.startsWith("  - ")) return 2;
  return 3;
}

const CORE_PREFIXES = [
  "- Scope:", "- Current work:", "- Pending work:", "- Key files referenced:",
  "- Tools mentioned:", "- Recent user requests:", "- Previously compacted context:",
  "- Newly compacted context:",
];

function isCoreDetail(line: string): boolean {
  return CORE_PREFIXES.some((p) => line.startsWith(p));
}

function isSectionHeader(line: string): boolean {
  return line.endsWith(":");
}

function joinedCharCount(lines: string[]): number {
  return lines.reduce((sum, l) => sum + l.length, 0) + Math.max(0, lines.length - 1);
}

function collapseInlineWhitespace(line: string): string {
  return line.split(/\s+/).filter(Boolean).join(" ");
}

function truncateLine(line: string, maxChars: number): string {
  if (maxChars === 0 || line.length <= maxChars) return line;
  if (maxChars === 1) return "…";
  return line.slice(0, maxChars - 1) + "…";
}
