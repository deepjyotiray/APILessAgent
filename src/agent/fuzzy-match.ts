import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Fuzzy replace: finds the closest match for `oldText` in the file,
 * even if whitespace/indentation differs slightly.
 * 
 * Strategy:
 * 1. Try exact match first (fastest)
 * 2. Try trimmed match (ignore leading/trailing whitespace per line)
 * 3. Try normalized match (collapse all whitespace)
 * 4. Try line-by-line fuzzy match (find the best overlapping region)
 */
export async function fuzzyReplace(
  filePath: string,
  oldText: string,
  newText: string,
  root: string
): Promise<{ ok: boolean; message: string }> {
  const fullPath = path.resolve(root, filePath);
  let content: string;
  try {
    content = await fs.readFile(fullPath, "utf8");
  } catch {
    return { ok: false, message: `File not found: ${filePath}` };
  }

  // Strategy 1: Exact match
  if (content.includes(oldText)) {
    const updated = content.replace(oldText, newText);
    await fs.writeFile(fullPath, updated, "utf8");
    return { ok: true, message: "Exact match replaced." };
  }

  // Strategy 2: Trimmed line match
  const trimmedResult = tryTrimmedMatch(content, oldText, newText);
  if (trimmedResult) {
    await fs.writeFile(fullPath, trimmedResult, "utf8");
    return { ok: true, message: "Trimmed match replaced." };
  }

  // Strategy 3: Normalized whitespace match
  const normalizedResult = tryNormalizedMatch(content, oldText, newText);
  if (normalizedResult) {
    await fs.writeFile(fullPath, normalizedResult, "utf8");
    return { ok: true, message: "Normalized match replaced." };
  }

  // Strategy 4: Line-by-line fuzzy match
  const fuzzyResult = tryFuzzyLineMatch(content, oldText, newText);
  if (fuzzyResult) {
    await fs.writeFile(fullPath, fuzzyResult, "utf8");
    return { ok: true, message: "Fuzzy line match replaced." };
  }

  // Strategy 5: First/last line anchor match
  const anchorResult = tryAnchorMatch(content, oldText, newText);
  if (anchorResult) {
    await fs.writeFile(fullPath, anchorResult, "utf8");
    return { ok: true, message: "Anchor match replaced." };
  }

  return { ok: false, message: `Could not find matching text in ${filePath}. The BEFORE text doesn't match any section of the file.` };
}

/**
 * Try matching after trimming each line.
 */
function tryTrimmedMatch(content: string, oldText: string, newText: string): string | null {
  const contentLines = content.split("\n");
  const oldLines = oldText.split("\n").map(l => l.trim());

  for (let i = 0; i <= contentLines.length - oldLines.length; i++) {
    let match = true;
    for (let j = 0; j < oldLines.length; j++) {
      if (contentLines[i + j].trim() !== oldLines[j]) {
        match = false;
        break;
      }
    }
    if (match) {
      // Found it — replace preserving original indentation of first line
      const indent = contentLines[i].match(/^(\s*)/)?.[1] ?? "";
      const newLines = newText.split("\n").map((line, idx) => {
        if (idx === 0) return indent + line.trim();
        return line; // Keep newText indentation as-is for subsequent lines
      });
      const result = [
        ...contentLines.slice(0, i),
        ...newLines,
        ...contentLines.slice(i + oldLines.length)
      ];
      return result.join("\n");
    }
  }
  return null;
}

/**
 * Try matching after collapsing all whitespace.
 */
function tryNormalizedMatch(content: string, oldText: string, newText: string): string | null {
  const normalize = (s: string) => s.replace(/\s+/g, " ").trim();
  const normalizedContent = normalize(content);
  const normalizedOld = normalize(oldText);

  const idx = normalizedContent.indexOf(normalizedOld);
  if (idx === -1) return null;

  // Find the actual position in the original content
  // Map normalized index back to original
  let origStart = -1;
  let origEnd = -1;
  let normIdx = 0;
  let origIdx = 0;

  // Skip leading whitespace in content
  while (origIdx < content.length && normIdx < idx) {
    if (/\s/.test(content[origIdx])) {
      // In normalized, consecutive whitespace = single space
      if (origIdx === 0 || /\s/.test(content[origIdx - 1])) {
        origIdx++;
        continue;
      }
      normIdx++;
    } else {
      normIdx++;
    }
    origIdx++;
  }
  origStart = origIdx;

  // Now find the end
  let matchLen = 0;
  while (origIdx < content.length && matchLen < normalizedOld.length) {
    if (/\s/.test(content[origIdx])) {
      if (origIdx === origStart || /\s/.test(content[origIdx - 1])) {
        origIdx++;
        continue;
      }
      matchLen++;
    } else {
      matchLen++;
    }
    origIdx++;
  }
  origEnd = origIdx;

  if (origStart >= 0 && origEnd > origStart) {
    return content.slice(0, origStart) + newText + content.slice(origEnd);
  }
  return null;
}

/**
 * Try finding the best matching region by comparing lines with similarity scoring.
 */
function tryFuzzyLineMatch(content: string, oldText: string, newText: string): string | null {
  const contentLines = content.split("\n");
  const oldLines = oldText.split("\n").filter(l => l.trim().length > 0);

  if (oldLines.length === 0) return null;

  let bestScore = 0;
  let bestStart = -1;

  for (let i = 0; i <= contentLines.length - oldLines.length; i++) {
    let score = 0;
    for (let j = 0; j < oldLines.length; j++) {
      const similarity = lineSimilarity(contentLines[i + j], oldLines[j]);
      score += similarity;
    }
    const avgScore = score / oldLines.length;
    if (avgScore > bestScore && avgScore > 0.7) {
      bestScore = avgScore;
      bestStart = i;
    }
  }

  if (bestStart >= 0) {
    const result = [
      ...contentLines.slice(0, bestStart),
      ...newText.split("\n"),
      ...contentLines.slice(bestStart + oldLines.length)
    ];
    return result.join("\n");
  }
  return null;
}

/**
 * Try matching using first and last lines as anchors.
 */
function tryAnchorMatch(content: string, oldText: string, newText: string): string | null {
  const oldLines = oldText.split("\n").filter(l => l.trim().length > 0);
  if (oldLines.length < 2) return null;

  const firstLine = oldLines[0].trim();
  const lastLine = oldLines[oldLines.length - 1].trim();
  const contentLines = content.split("\n");

  for (let i = 0; i < contentLines.length; i++) {
    if (contentLines[i].trim() !== firstLine) continue;

    // Found first line — look for last line within reasonable range
    const maxEnd = Math.min(i + oldLines.length + 5, contentLines.length);
    for (let j = i + 1; j < maxEnd; j++) {
      if (contentLines[j].trim() === lastLine) {
        // Found both anchors — replace the range
        const result = [
          ...contentLines.slice(0, i),
          ...newText.split("\n"),
          ...contentLines.slice(j + 1)
        ];
        return result.join("\n");
      }
    }
  }
  return null;
}

/**
 * Simple line similarity score (0-1).
 */
function lineSimilarity(a: string, b: string): number {
  const ta = a.trim();
  const tb = b.trim();
  if (ta === tb) return 1;
  if (ta.length === 0 && tb.length === 0) return 1;
  if (ta.length === 0 || tb.length === 0) return 0;

  // Check if one contains the other
  if (ta.includes(tb) || tb.includes(ta)) return 0.9;

  // Character-level similarity
  const longer = ta.length > tb.length ? ta : tb;
  const shorter = ta.length > tb.length ? tb : ta;
  let matches = 0;
  for (let i = 0; i < shorter.length; i++) {
    if (shorter[i] === longer[i]) matches++;
  }
  return matches / longer.length;
}
