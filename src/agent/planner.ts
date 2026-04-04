import { randomUUID } from "node:crypto";

import type {
  PlannerAdapter,
  PlannerSession,
  PlannerStatus,
  PlannerTurnResult
} from "./types.js";

export class ChatGPTWebPlanner implements PlannerAdapter {
  readonly name = "chatgpt_web_planner";

  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs: number
  ) {}

  async getPlannerStatus(): Promise<PlannerStatus> {
    try {
      const response = await fetch(`${this.baseUrl}/health`);
      if (!response.ok) {
        return {
          ok: false,
          errorCode: "planner_unavailable",
          message: `Bridge health check failed with status ${response.status}`
        };
      }

      const body = await response.json() as { clients?: unknown[] };
      if (!body.clients?.length) {
        return {
          ok: false,
          errorCode: "stale_session",
          message: "No active ChatGPT tab is connected to the bridge."
        };
      }

      return {
        ok: true,
        message: "Planner is available.",
        data: body
      };
    } catch (error) {
      return {
        ok: false,
        errorCode: "planner_unavailable",
        message: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async startSession(skipReset = false): Promise<PlannerSession> {
    const session = { id: randomUUID() };
    if (!skipReset) {
      await this.resetSession(session);
    }
    return session;
  }

  async resetSession(_session: PlannerSession): Promise<void> {
    const response = await fetch(`${this.baseUrl}/new-chat`, { method: "POST" });
    const body = await response.json() as { ok?: boolean; error?: string };
    if (!response.ok || !body.ok) {
      throw new Error(body.error ?? "Failed to reset ChatGPT planner session.");
    }
  }

  async sendTurn(_session: PlannerSession, prompt: string): Promise<PlannerTurnResult> {
    try {
      const response = await fetch(`${this.baseUrl}/send`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          prompt,
          timeoutMs: this.timeoutMs
        })
      });

      const body = await response.json() as {
        ok?: boolean;
        error?: string;
        data?: { response?: string };
      };

      if (!response.ok || !body.ok) {
        return {
          ok: false,
          errorCode: classifyBridgeError(body.error),
          message: body.error ?? `Bridge send failed with status ${response.status}`
        };
      }

      const raw = body.data?.response?.trim();
      if (!raw) {
        return {
          ok: false,
          errorCode: "invalid_output",
          message: "ChatGPT returned an empty response."
        };
      }

      return {
        ok: true,
        raw,
        message: "Planner turn succeeded."
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        errorCode: classifyBridgeError(message),
        message
      };
    }
  }
}

function classifyBridgeError(message: string | undefined): string {
  if (!message) {
    return "planner_unavailable";
  }
  if (message.includes("Timed out")) {
    return "planner_timeout";
  }
  if (message.includes("No active ChatGPT tab")) {
    return "stale_session";
  }
  if (message.includes("Could not parse")) {
    return "invalid_output";
  }
  return "chat_send_failure";
}
