/**
 * File Editor Worker: applies code changes using local Ollama.
 *
 * Flow:
 * 1. Read the full file
 * 2. Send file + change instructions to Ollama
 * 3. Ollama returns the complete updated file
 * 4. Write it back
 *
 * This avoids all ChatGPT bridge/HTML escaping/patch parsing issues.
 * Ollama runs locally — no network latency, no DOM extraction, clean output.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { parseChatGPTDiff } from "./diff-parser.js";
import { fuzzyReplace } from "./fuzzy-match.js";

const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";
const EDITOR_MODEL = process.env.EDITOR_MODEL ?? "qwen2.5-coder:7b";
const EDIT_TIMEOUT_MS = 60_000; // 60s for large files

export interface EditRequest {
  filePath: string;
  instructions: string;
  root: string;
}

export interface EditResult {
  ok: boolean;
  filePath: string;
  message: string;
  diff?: string;
}

/**
 * Apply changes to a single file using local Ollama.
 */
export async function applyFileEdit(request: EditRequest): Promise<EditResult> {
  const fullPath = path.resolve(request.root, request.filePath);

  // Read current file
  let currentContent: string;
  try {
    currentContent = await fs.readFile(fullPath, "utf8");
  } catch {
    return { ok: false, filePath: request.filePath, message: "File not found" };
  }

  // For files over 15k chars, truncation risk is too high — skip
  if (currentContent.length > 15000) {
    return { ok: false, filePath: request.filePath, message: `File too large for local LLM edit (${currentContent.length} chars). Apply changes manually.` };
  }

  // Send to Ollama: full file + instructions → get back complete updated file
  const prompt = `You are a code editor. Apply the requested changes to this file and output the COMPLETE updated file.

RULES:
- Output ONLY the file content. No explanation. No markdown fences. No "here is the updated file".
- Include EVERY line of the file, not just the changed parts.
- Make ONLY the requested changes. Do not modify anything else.
- Preserve all formatting, indentation, and whitespace.

CURRENT FILE (${request.filePath}):
${currentContent}

CHANGES TO APPLY:
${request.instructions}

OUTPUT THE COMPLETE UPDATED FILE:`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), EDIT_TIMEOUT_MS);
    const res = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: EDITOR_MODEL, prompt, stream: false }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) {
      return { ok: false, filePath: request.filePath, message: "Ollama request failed" };
    }

    const body = await res.json() as { response?: string };
    let newContent = (body.response ?? "").trim();

    // Strip markdown fences if Ollama wrapped the output
    newContent = newContent.replace(/^```[\w]*\n/, "").replace(/\n```$/, "").trim();

    // Sanity checks
    if (newContent.length < currentContent.length * 0.3) {
      return { ok: false, filePath: request.filePath, message: "Ollama output too short — likely truncated. Apply changes manually." };
    }

    if (newContent === currentContent) {
      return { ok: true, filePath: request.filePath, message: "No changes needed" };
    }

    // Write the updated file
    await fs.writeFile(fullPath, newContent, "utf8");

    return { ok: true, filePath: request.filePath, message: "File updated" };
  } catch (err) {
    return { ok: false, filePath: request.filePath, message: err instanceof Error ? err.message : "Edit failed" };
  }
}

/**
 * Apply changes to multiple files.
 * Fast path: parse ChatGPT's structured diff and apply via fuzzy-match.
 * Slow path: fall back to Ollama for files that couldn't be parsed.
 */
export async function applyAllEdits(
  instructions: string,
  root: string,
  onProgress?: (msg: string) => void
): Promise<EditResult[]> {
  const results: EditResult[] = [];

  // Fast path: try structured diff parsing first
  const parsedEdits = parseChatGPTDiff(instructions);
  if (parsedEdits.length > 0) {
    const handledFiles = new Set<string>();
    for (const edit of parsedEdits) {
      onProgress?.(`Applying parsed diff to ${edit.file}…`);
      const r = await fuzzyReplace(edit.file, edit.oldText, edit.newText, root);
      results.push({ ok: r.ok, filePath: edit.file, message: r.ok ? `Parsed diff applied (${r.message})` : r.message });
      if (r.ok) handledFiles.add(edit.file);
    }
    // If all parsed edits succeeded, we're done
    if (results.every(r => r.ok)) return results;
    // For files that failed parsed diff, try Ollama below
    const failedFiles = results.filter(r => !r.ok).map(r => r.filePath);
    const fileChanges = parseFileChanges(instructions).filter(c => failedFiles.includes(c.filePath));
    for (const change of fileChanges) {
      onProgress?.(`Falling back to LLM edit for ${change.filePath}…`);
      const result = await applyFileEdit({ filePath: change.filePath, instructions: change.instructions, root });
      // Replace the failed result
      const idx = results.findIndex(r => r.filePath === change.filePath && !r.ok);
      if (idx >= 0) results[idx] = result;
      else results.push(result);
    }
    return results;
  }

  // No structured diffs found — use original Ollama path
  const fileChanges = parseFileChanges(instructions);
  if (fileChanges.length === 0) {
    return [{ ok: false, filePath: "", message: "No file changes found in instructions" }];
  }
  for (const change of fileChanges) {
    onProgress?.(`Editing ${change.filePath}…`);
    const result = await applyFileEdit({ filePath: change.filePath, instructions: change.instructions, root });
    results.push(result);
  }
  return results;
}

/**
 * Parse change instructions to extract per-file changes.
 * Handles formats like:
 * - "File: path/to/file.ext" sections
 * - "CHANGE N — description\nFile: path" sections
 */
function parseFileChanges(text: string): Array<{ filePath: string; instructions: string }> {
  const changes: Array<{ filePath: string; instructions: string }> = [];
  const seen = new Map<string, string>();

  // Split by CHANGE N or File: markers
  const sections = text.split(/(?=^CHANGE \d|^File:\s|^FILE:\s)/mi).filter(s => s.trim());

  for (const section of sections) {
    // Extract file path
    const fileMatch = section.match(/(?:^|\n)\s*(?:File|FILE)[:\s]+([^\n]+)/i);
    if (!fileMatch) continue;

    const filePath = fileMatch[1].trim().replace(/[`*]/g, "");
    if (!filePath || filePath.length > 200) continue;

    // Accumulate instructions per file
    const existing = seen.get(filePath) ?? "";
    seen.set(filePath, existing + "\n" + section);
  }

  for (const [filePath, instructions] of seen) {
    changes.push({ filePath, instructions });
  }

  return changes;
}
