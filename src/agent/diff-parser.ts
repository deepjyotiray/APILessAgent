/**
 * Diff Parser: extracts structured file edits from ChatGPT's
 * natural-language diff responses.
 *
 * Handles formats like:
 *   - "File: README.md / Current code: ... / Replace with: ..."
 *   - "### File\nREADME.md\n### Current code\n```...\n### Replace with\n```..."
 *   - Numbered change sections ("1) Fix the ...\nFile\nREADME.md\n...")
 */

export interface ParsedEdit {
  file: string;
  oldText: string;
  newText: string;
  reason?: string;
}

/**
 * Parse ChatGPT's verbose diff output into structured edits.
 * Returns empty array if no edits could be extracted.
 */
export function parseChatGPTDiff(text: string): ParsedEdit[] {
  const edits: ParsedEdit[] = [];

  // Split into numbered sections or "CHANGE N" blocks
  const sections = splitIntoSections(text);

  for (const section of sections) {
    const edit = extractEdit(section);
    if (edit) edits.push(edit);
  }

  // Deduplicate by file+oldText
  const seen = new Set<string>();
  return edits.filter(e => {
    const key = `${e.file}::${e.oldText.slice(0, 100)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Split response into per-change sections.
 */
function splitIntoSections(text: string): string[] {
  // Try numbered sections: "1) ...", "2) ...", "# 1) ...", "## 1) ..."
  const numbered = text.split(/(?=^#{0,3}\s*\d+[.)]\s)/m).filter(s => s.trim());
  if (numbered.length > 1) return numbered;

  // Try "CHANGE N" sections
  const changeBlocks = text.split(/(?=^CHANGE\s+\d+)/mi).filter(s => s.trim());
  if (changeBlocks.length > 1) return changeBlocks;

  // Try "---" separators
  const dashed = text.split(/^-{3,}$/m).filter(s => s.trim());
  if (dashed.length > 1) return dashed;

  // Treat entire text as one section
  return [text];
}

/**
 * Extract a single edit from a section of text.
 */
function extractEdit(section: string): ParsedEdit | null {
  const file = extractFilePath(section);
  if (!file) return null;

  const oldText = extractBlock(section, [
    /(?:current\s+code|existing\s+code|old\s+code|before)[:\s]*\n/i,
    /#{1,4}\s*(?:current\s+code|existing\s+code|before)\s*\n/i,
  ]);

  const newText = extractBlock(section, [
    /(?:replace\s+with|new\s+code|updated\s+code|after|replacement)[:\s]*\n/i,
    /#{1,4}\s*(?:replace\s+with|new\s+code|after|replacement)\s*\n/i,
  ]);

  if (!oldText || !newText) return null;
  if (oldText.trim() === newText.trim()) return null;

  const reasonMatch = section.match(/(?:reason|why|explanation)[:\s]*\n?\s*(.+?)(?:\n\n|\n#{1,4}|$)/is);

  return {
    file,
    oldText: cleanCodeBlock(oldText),
    newText: cleanCodeBlock(newText),
    reason: reasonMatch?.[1]?.trim(),
  };
}

/**
 * Extract file path from a section.
 */
function extractFilePath(section: string): string | null {
  // "File\nREADME.md" or "File: README.md" or "### File\nREADME.md"
  const patterns = [
    /#{1,4}\s*File\s*\n\s*([^\n]+)/i,
    /(?:^|\n)\s*File[:\s]+([^\n]+)/i,
    /(?:^|\n)\s*(?:File|Filename|Path)\s*[:]\s*`?([^`\n]+)`?/i,
  ];

  for (const pattern of patterns) {
    const m = section.match(pattern);
    if (m) {
      const candidate = m[1].trim().replace(/[`*]/g, "").replace(/\s*$/, "");
      if (isPlausiblePath(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Extract a code block following one of the given header patterns.
 */
function extractBlock(section: string, headerPatterns: RegExp[]): string | null {
  for (const pattern of headerPatterns) {
    const m = section.match(pattern);
    if (!m) continue;

    const afterHeader = section.slice(m.index! + m[0].length);

    // Try fenced code block first
    const fenced = afterHeader.match(/^```[\w]*\n([\s\S]*?)```/m);
    if (fenced) return fenced[1];

    // Try indented block or raw text until next section header
    const rawBlock = afterHeader.match(/^([\s\S]*?)(?=\n(?:#{1,4}\s|(?:Replace|Current|File|Reason|New|After|Before)\s*[:\n]|\d+[.)]\s))/i);
    if (rawBlock && rawBlock[1].trim()) return rawBlock[1];

    // Take everything remaining
    const remaining = afterHeader.trim();
    if (remaining) return remaining;
  }
  return null;
}

/**
 * Strip markdown code fences and language tags.
 */
function cleanCodeBlock(text: string): string {
  let cleaned = text;
  // Remove leading/trailing fences
  cleaned = cleaned.replace(/^```[\w]*\n?/, "").replace(/\n?```\s*$/, "");
  // Trim trailing whitespace but preserve internal structure
  return cleaned.replace(/\s+$/, "");
}

function isPlausiblePath(s: string): boolean {
  if (!s || s.length > 200) return false;
  if (s.includes(" ") && !s.includes("/")) return false;
  return /\.\w{1,10}$/.test(s) || s.includes("/");
}
