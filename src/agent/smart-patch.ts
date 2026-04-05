/**
 * Smart patch builder: applies edits described in various formats.
 * Handles:
 *   1. Standard PATCH blocks (BEFORE/AFTER)
 *   2. Line-range edits ("replace lines 15-20 with...")
 *   3. Function-level edits ("replace function login() with...")
 *   4. Chunked editing for large files
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { fuzzyReplace } from "./fuzzy-match.js";

export interface EditResult {
  path: string;
  ok: boolean;
  message: string;
  method: string;
}

/**
 * Apply a PATCH block using fuzzy matching.
 */
export async function applyPatch(
  filePath: string,
  before: string,
  after: string,
  root: string
): Promise<EditResult> {
  const result = await fuzzyReplace(filePath, before, after, root);
  return { path: filePath, ok: result.ok, message: result.message, method: "patch" };
}

/**
 * Apply a line-range edit: replace lines startLine-endLine with newContent.
 */
export async function applyLineEdit(
  filePath: string,
  startLine: number,
  endLine: number,
  newContent: string,
  root: string
): Promise<EditResult> {
  const fullPath = path.resolve(root, filePath);
  try {
    const content = await fs.readFile(fullPath, "utf8");
    const lines = content.split("\n");
    if (startLine < 1 || endLine > lines.length || startLine > endLine) {
      return { path: filePath, ok: false, message: `Invalid line range ${startLine}-${endLine} (file has ${lines.length} lines)`, method: "line-edit" };
    }
    const newLines = [
      ...lines.slice(0, startLine - 1),
      ...newContent.split("\n"),
      ...lines.slice(endLine)
    ];
    await fs.writeFile(fullPath, newLines.join("\n"), "utf8");
    return { path: filePath, ok: true, message: `Replaced lines ${startLine}-${endLine}`, method: "line-edit" };
  } catch (err: any) {
    return { path: filePath, ok: false, message: err.message, method: "line-edit" };
  }
}

/**
 * Apply a function-level edit: find a function by name and replace its body.
 */
export async function applyFunctionEdit(
  filePath: string,
  functionName: string,
  newBody: string,
  root: string
): Promise<EditResult> {
  const fullPath = path.resolve(root, filePath);
  try {
    const content = await fs.readFile(fullPath, "utf8");
    const lines = content.split("\n");

    // Find the function start
    const funcPatterns = [
      new RegExp(`^(\\s*(?:export\\s+)?(?:async\\s+)?function\\s+${escapeRegex(functionName)}\\s*\\()`),
      new RegExp(`^(\\s*(?:export\\s+)?(?:const|let|var)\\s+${escapeRegex(functionName)}\\s*=\\s*(?:async\\s+)?(?:\\([^)]*\\)|\\w+)\\s*=>)`),
      new RegExp(`^(\\s*(?:async\\s+)?${escapeRegex(functionName)}\\s*\\([^)]*\\)\\s*\\{)`),
    ];

    let startIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      for (const pattern of funcPatterns) {
        if (pattern.test(lines[i])) {
          startIdx = i;
          break;
        }
      }
      if (startIdx >= 0) break;
    }

    if (startIdx < 0) {
      return { path: filePath, ok: false, message: `Function "${functionName}" not found`, method: "function-edit" };
    }

    // Find the function end (matching braces)
    let braceCount = 0;
    let endIdx = startIdx;
    let foundOpen = false;
    for (let i = startIdx; i < lines.length; i++) {
      for (const ch of lines[i]) {
        if (ch === "{") { braceCount++; foundOpen = true; }
        if (ch === "}") braceCount--;
      }
      if (foundOpen && braceCount === 0) {
        endIdx = i;
        break;
      }
    }

    const newLines = [
      ...lines.slice(0, startIdx),
      ...newBody.split("\n"),
      ...lines.slice(endIdx + 1)
    ];
    await fs.writeFile(fullPath, newLines.join("\n"), "utf8");
    return { path: filePath, ok: true, message: `Replaced function "${functionName}" (lines ${startIdx + 1}-${endIdx + 1})`, method: "function-edit" };
  } catch (err: any) {
    return { path: filePath, ok: false, message: err.message, method: "function-edit" };
  }
}

/**
 * Chunk a large file into sections for editing.
 * Returns sections with line ranges and content.
 */
export function chunkFile(content: string, maxChunkLines = 50): Array<{ startLine: number; endLine: number; content: string }> {
  const lines = content.split("\n");
  const chunks: Array<{ startLine: number; endLine: number; content: string }> = [];

  let i = 0;
  while (i < lines.length) {
    // Try to find a natural break point (empty line, function boundary)
    let end = Math.min(i + maxChunkLines, lines.length);

    // Look for a natural break near the end
    for (let j = end; j > i + maxChunkLines / 2; j--) {
      if (lines[j]?.trim() === "" || lines[j]?.match(/^(?:export\s+)?(?:function|class|const|let|var|interface|type)\s/)) {
        end = j;
        break;
      }
    }

    chunks.push({
      startLine: i + 1,
      endLine: end,
      content: lines.slice(i, end).join("\n")
    });
    i = end;
  }

  return chunks;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
