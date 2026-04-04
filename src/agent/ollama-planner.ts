import { randomUUID } from "node:crypto";

import type {
  PlannerAdapter,
  PlannerSession,
  PlannerStatus,
  PlannerTurnResult
} from "./types.js";

interface OllamaMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export class OllamaPlanner implements PlannerAdapter {
  readonly name: string;
  private conversations = new Map<string, OllamaMessage[]>();

  constructor(
    private readonly baseUrl: string,
    private readonly model: string,
    private readonly timeoutMs: number
  ) {
    this.name = `ollama:${model}`;
  }

  async getPlannerStatus(): Promise<PlannerStatus> {
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) {
        return { ok: false, errorCode: "planner_unavailable", message: `Ollama returned ${res.status}` };
      }
      const body = await res.json() as { models?: Array<{ name: string }> };
      const available = body.models?.map((m) => m.name) ?? [];
      const found = available.some((n) => n === this.model || n.startsWith(`${this.model}:`));
      if (!found) {
        return {
          ok: false,
          errorCode: "model_not_found",
          message: `Model "${this.model}" not found. Available: ${available.join(", ") || "(none)"}. Run: ollama pull ${this.model}`
        };
      }
      return { ok: true, message: "Ollama is available.", data: { model: this.model, available } };
    } catch (error) {
      return {
        ok: false,
        errorCode: "planner_unavailable",
        message: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async startSession(_skipReset?: boolean): Promise<PlannerSession> {
    const id = randomUUID();
    this.conversations.set(id, []);
    return { id };
  }

  async resetSession(session: PlannerSession): Promise<void> {
    this.conversations.set(session.id, []);
  }

  async sendTurn(session: PlannerSession, prompt: string): Promise<PlannerTurnResult> {
    const messages = this.conversations.get(session.id) ?? [];
    messages.push({ role: "user", content: prompt });

    try {
      const res = await fetch(`${this.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          messages,
          stream: false,
          options: { temperature: 0.1, num_predict: 4096 }
        }),
        signal: AbortSignal.timeout(this.timeoutMs)
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        return { ok: false, errorCode: "ollama_error", message: `Ollama ${res.status}: ${text}` };
      }

      const body = await res.json() as { message?: { content?: string } };
      const raw = body.message?.content?.trim();
      if (!raw) {
        return { ok: false, errorCode: "invalid_output", message: "Ollama returned empty response." };
      }

      messages.push({ role: "assistant", content: raw });
      this.conversations.set(session.id, messages.slice(-40));

      return { ok: true, raw, message: "Ollama turn succeeded." };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        errorCode: msg.includes("abort") || msg.includes("timeout") ? "planner_timeout" : "ollama_error",
        message: msg
      };
    }
  }
}
