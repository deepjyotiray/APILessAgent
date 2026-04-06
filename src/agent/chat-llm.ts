/**
 * ChatLLM — lightweight Ollama worker that normalizes planner responses
 * into structured JSON tool calls.
 *
 * When the main planner (ChatGPT/Merlin) returns natural language instead
 * of the expected JSON protocol, this worker translates the intent into
 * a valid tool-call JSON object the orchestrator can execute.
 */

const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";
const NORMALIZE_MODEL = process.env.CLASSIFY_MODEL ?? "qwen2.5-coder:7b";
const TIMEOUT_MS = 15_000;

const NORMALIZE_PROMPT = `You are a JSON translator. Convert the assistant's natural-language response into exactly one JSON tool call.

IMPORTANT: The "type" field must ALWAYS be either "tool" or "done". The tool name goes in the "tool" field.

Available tool call formats:
{"type":"tool","tool":"read_file","args":{"path":"<file>"},"reason":"<why>"}
{"type":"tool","tool":"replace_text","args":{"path":"<file>","oldText":"<old>","newText":"<new>"},"reason":"<why>"}
{"type":"tool","tool":"write_file","args":{"path":"<file>","content":"<content>"},"reason":"<why>"}
{"type":"tool","tool":"insert_text","args":{"path":"<file>","after":"<marker>","text":"<code>"},"reason":"<why>"}
{"type":"tool","tool":"run_command","args":{"command":"<cmd>"},"reason":"<why>"}
{"type":"tool","tool":"search","args":{"pattern":"<pattern>"},"reason":"<why>"}
{"type":"done","message":"<summary>"}

Rules:
- If the response says NEED_FILE or asks to read/see a file → read_file tool call
- If the response describes an edit → replace_text or write_file
- If the response says it's finished or summarises changes → done
- If the response asks to run a command → run_command
- NEVER use a tool name as the "type" value. Always use "type":"tool" with the tool name in "tool".
- Output ONLY the JSON object. No markdown, no explanation.

Assistant's response:
`;

export interface NormalizeResult {
  ok: boolean;
  json?: Record<string, unknown>;
  raw?: string;
  error?: string;
}

/**
 * Attempt to normalize a planner's natural-language response into a JSON tool call
 * using a local Ollama model.
 */
export async function normalizePlannerResponse(
  plannerResponse: string,
  userMessage?: string,
  availableFiles?: string[]
): Promise<NormalizeResult> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    let prompt = NORMALIZE_PROMPT + plannerResponse;
    if (userMessage) {
      prompt += `\n\nUser's original question: ${userMessage.slice(0, 500)}`;
    }
    if (availableFiles?.length) {
      prompt += `\n\nFiles in the project that could be read: ${availableFiles.slice(0, 20).join(", ")}`;
      prompt += `\n\nIMPORTANT: If the assistant gave a generic answer without actually reading the relevant files, emit a read_file tool call for the most relevant file instead of "done".`;
    }

    const res = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: NORMALIZE_MODEL,
        prompt,
        stream: false,
        format: "json",
        options: { temperature: 0, num_predict: 1024 },
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) return { ok: false, error: `Ollama HTTP ${res.status}` };

    const body = await res.json() as { response?: string };
    const raw = (body.response ?? "").trim();
    if (!raw) return { ok: false, error: "Empty response from normalizer" };

    const obj = JSON.parse(raw);
    if (obj.type) return { ok: true, json: obj, raw };
    return { ok: false, error: "Normalized JSON missing 'type' field", raw };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Quick check: does the response contain a NEED_FILE request?
 * Returns the file paths if found, null otherwise.
 * This is a fast regex check — no LLM call needed.
 */
export function extractNeedFiles(response: string): string[] | null {
  const files: string[] = [];
  for (const m of response.matchAll(/NEED_FILE:\s*(\S+)/g)) {
    files.push(m[1]);
  }
  return files.length > 0 ? files : null;
}

/**
 * Convert a NEED_FILE response directly into a read_file tool call JSON.
 * No LLM needed — pure deterministic conversion.
 */
export function needFileToToolCall(filePath: string): Record<string, unknown> {
  return {
    type: "tool",
    tool: "read_file",
    args: { path: filePath },
    reason: `Planner requested file: ${filePath}`,
  };
}
