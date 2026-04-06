/**
 * Patch Repair: uses local Ollama to reformat LLM edit output
 * into the exact PATCH:/CREATE: format that executeActions expects.
 */

const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";
const REPAIR_MODEL = process.env.REPAIR_MODEL ?? "qwen2.5-coder:32b";
const REPAIR_TIMEOUT_MS = 15_000;

const REPAIR_PROMPT = `You are a patch formatter. Convert the input into EXACT patch format.
Output ONLY patches. No explanation. No commentary.

EXACT format for edits:
PATCH: path/to/file.ext
<<<<<<< BEFORE
exact old lines from the file
=======
exact new replacement lines
>>>>>>> AFTER

EXACT format for new files:
CREATE: path/to/file.ext
file content
END_CREATE

RULES:
- BEFORE block must contain the EXACT current code to find in the file
- AFTER block must contain the replacement code
- Both blocks must be non-empty
- Do NOT use HTML entities like &lt; &gt; &amp; — use raw < > &
- If input has no file changes, output the word NONE

Input:
`;

/**
 * Check if output has VALID patches (non-empty BEFORE and AFTER content).
 */
export function hasValidPatches(output: string): boolean {
  // Check for patches with actual content in both BEFORE and AFTER
  const patchRegex = /PATCH:\s*[\w./\\-]+\.[\w]{1,10}\s*\n<<<<<<< BEFORE\n([\s\S]*?)\n=======\n([\s\S]*?)\n>>>>>>> AFTER/g;
  let m;
  while ((m = patchRegex.exec(output)) !== null) {
    const before = m[1].trim();
    const after = m[2].trim();
    // Both must have real content, not HTML-escaped garbage
    if (before.length > 0 && after.length > 0 && !before.includes("&lt;") && !before.includes("&gt;")) {
      return true;
    }
  }
  // Check for CREATE blocks with content
  const createRegex = /CREATE:\s*[\w./\\-]+\.[\w]{1,10}\s*\n([\s\S]*?)\nEND_CREATE/g;
  while ((m = createRegex.exec(output)) !== null) {
    if (m[1].trim().length > 10) return true;
  }
  return false;
}

/**
 * Attempt to repair LLM output into valid PATCH/CREATE format.
 * Always runs repair if output looks like edits but doesn't have valid patches.
 */
export async function repairPatches(rawOutput: string): Promise<string> {
  // Already has valid, non-empty, non-escaped patches — pass through
  if (hasValidPatches(rawOutput)) return rawOutput;

  // Nothing that looks like an edit — don't bother
  if (!looksLikeEdit(rawOutput)) return rawOutput;

  // Unescape HTML entities before sending to repair (ChatGPT sometimes escapes)
  const unescaped = rawOutput
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");

  // Check if unescaping alone fixed it
  if (hasValidPatches(unescaped)) return unescaped;

  // Send to local LLM for repair
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REPAIR_TIMEOUT_MS);
    const res = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: REPAIR_MODEL,
        prompt: REPAIR_PROMPT + unescaped.slice(0, 8000),
        stream: false,
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) return rawOutput;

    const body = await res.json() as { response?: string };
    const repaired = (body.response ?? "").trim();

    if (repaired === "NONE" || repaired.length < 20) return rawOutput;
    if (hasValidPatches(repaired)) return repaired;

    return rawOutput;
  } catch {
    return rawOutput;
  }
}

/**
 * Heuristic: does this output look like it contains edit suggestions?
 */
function looksLikeEdit(output: string): boolean {
  return (
    /```[\w]*\n/.test(output) ||
    /\bbefore\b.*\bafter\b/is.test(output) ||
    /\bupdate\s+file\b/i.test(output) ||
    /\breplace\b.*\bwith\b/i.test(output) ||
    /^[-+]\s/m.test(output) ||
    /\bchange\b.*\bto\b/i.test(output) ||
    /PATCH:/i.test(output) ||
    /<<<<<</.test(output) ||
    /&lt;.*&gt;/.test(output)  // HTML-escaped content = likely broken patches
  );
}
