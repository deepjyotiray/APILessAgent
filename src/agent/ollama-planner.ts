/**
 * Ollama Planner: uses a local Ollama model as the planning brain
 * instead of ChatGPT. Implements the same PlannerAdapter interface.
 */

import { randomUUID } from "node:crypto";
import type { PlannerAdapter, PlannerSession, PlannerStatus, PlannerTurnResult } from "./types.js";
import { compactOllamaHistory } from "./conversation-summarizer.js";

const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";
const DEFAULT_MODEL = "qwen2.5-coder:7b";
const TIMEOUT_MS = 120_000;

export class OllamaPlanner implements PlannerAdapter {
  readonly name = "ollama";
  private conversationHistory: Array<{ role: string; content: string }> = [];
  private pulling: Promise<boolean> | null = null;

  constructor(
    private model: string = DEFAULT_MODEL,
    private readonly ollamaUrl: string = OLLAMA_URL,
    private readonly onLog?: (msg: string) => void
  ) {}

  getModel(): string { return this.model; }
  setModel(model: string): void { this.model = model; }
  getHistory(): Array<{ role: string; content: string }> { return this.conversationHistory; }
  setHistory(h: Array<{ role: string; content: string }>): void { this.conversationHistory = h; }

  private log(msg: string): void {
    this.onLog?.(msg);
  }

  async getPlannerStatus(): Promise<PlannerStatus> {
    try {
      this.log(`Checking Ollama at ${this.ollamaUrl}…`);
      const res = await fetch(`${this.ollamaUrl}/api/tags`);
      if (!res.ok) {
        this.log(`Ollama unreachable (HTTP ${res.status})`);
        return { ok: false, errorCode: "ollama_unavailable", message: "Ollama is not running." };
      }
      const body = await res.json() as { models?: Array<{ name: string }> };
      const models = body.models?.map(m => m.name) ?? [];
      this.log(`Ollama up — ${models.length} models available`);
      const hasModel = models.some(m => m === this.model);
      if (!hasModel) {
        if (this.pulling) {
          this.log(`Already pulling "${this.model}"…`);
          return { ok: false, errorCode: "pulling", message: `Pulling "${this.model}"… check logs for progress.` };
        }
        this.log(`Model "${this.model}" not found locally. Pulling…`);
        this.pulling = this.pullModel(this.model);
        const pulled = await this.pulling;
        this.pulling = null;
        if (!pulled) {
          return { ok: false, errorCode: "pull_failed", message: `Failed to pull model "${this.model}".` };
        }
      }
      this.log(`Model "${this.model}" ready`);
      return { ok: true, message: `Ollama ready — model: ${this.model}` };
    } catch (error) {
      this.log(`Ollama connection failed: ${error instanceof Error ? error.message : String(error)}`);
      return { ok: false, errorCode: "ollama_unavailable", message: "Cannot connect to Ollama. Is it running?" };
    }
  }

  async startSession(_skipReset?: boolean): Promise<PlannerSession> {
    this.conversationHistory = [];
    this.log("New Ollama session started");
    return { id: randomUUID() };
  }

  async resetSession(_session: PlannerSession): Promise<void> {
    this.conversationHistory = [];
    this.log("Session reset");
  }

  private async pullModel(model: string): Promise<boolean> {
    try {
      const res = await fetch(`${this.ollamaUrl}/api/pull`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: model, stream: true }),
      });
      if (!res.ok || !res.body) {
        this.log(`Pull request failed (HTTP ${res.status})`);
        return false;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let lastPct = -1;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        for (const line of chunk.split("\n").filter(l => l.trim())) {
          try {
            const obj = JSON.parse(line) as { status?: string; total?: number; completed?: number; error?: string };
            if (obj.error) {
              this.log(`Pull error: ${obj.error}`);
              return false;
            }
            if (obj.total && obj.completed) {
              const pct = Math.floor((obj.completed / obj.total) * 100);
              if (pct !== lastPct && pct % 5 === 0) {
                this.log(`Pulling ${model}… ${pct}%`);
                lastPct = pct;
              }
            } else if (obj.status) {
              this.log(`Pull: ${obj.status}`);
            }
          } catch {}
        }
      }
      this.log(`Pull complete: ${model}`);
      return true;
    } catch (err) {
      this.log(`Pull failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  async sendTurn(_session: PlannerSession, prompt: string): Promise<PlannerTurnResult> {
    this.conversationHistory.push({ role: "user", content: prompt });
    this.log(`Sending prompt (${prompt.length} chars) to ${this.model}…`);
    const startTime = Date.now();

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

      const res = await fetch(`${this.ollamaUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          messages: this.conversationHistory,
          stream: false,
          format: "json",
          options: {
            temperature: 0.1,
            num_predict: 4096,
          },
        }),
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        this.log(`Ollama error (HTTP ${res.status}): ${errText.slice(0, 200)}`);
        return { ok: false, errorCode: "ollama_error", message: `Ollama returned HTTP ${res.status}` };
      }

      const body = await res.json() as {
        message?: { content: string };
        total_duration?: number;
        eval_count?: number;
        eval_duration?: number;
      };

      const raw = body.message?.content?.trim() ?? "";
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      const tokPerSec = body.eval_count && body.eval_duration
        ? (body.eval_count / (body.eval_duration / 1e9)).toFixed(1)
        : "?";

      this.log(`Response (${raw.length} chars) in ${elapsed}s — ${tokPerSec} tok/s`);

      if (!raw) {
        this.log("Empty response from Ollama");
        return { ok: false, errorCode: "empty_response", message: "Ollama returned empty response." };
      }

      this.conversationHistory.push({ role: "assistant", content: raw });

      // Compact history if it's getting large (>20 messages)
      if (this.conversationHistory.length > 20) {
        const totalChars = this.conversationHistory.reduce((s, m) => s + m.content.length, 0);
        if (totalChars > 30000) {
          this.log(`Compacting history (${this.conversationHistory.length} msgs, ${totalChars} chars)`);
          this.conversationHistory = compactOllamaHistory(this.conversationHistory, "", 6);
          this.log(`After compaction: ${this.conversationHistory.length} msgs`);
        }
      }

      return { ok: true, raw, message: "Turn succeeded." };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.log(`Ollama request failed: ${msg}`);
      return { ok: false, errorCode: "ollama_error", message: msg };
    }
  }
}
