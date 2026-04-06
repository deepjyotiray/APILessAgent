import { randomUUID } from "node:crypto";
import type { PlannerAdapter, PlannerSession, PlannerStatus, PlannerTurnResult } from "./types.js";

/**
 * Planner that talks to the Merlin chat webview embedded in the Electron app.
 * Communication: API server → HTTP → Electron main process → webContents.executeJavaScript → Merlin DOM
 */
export class MerlinBridgePlanner implements PlannerAdapter {
  readonly name = "merlin";

  constructor(
    private readonly bridgeUrl: string,
    private readonly timeoutMs: number
  ) {}

  async getPlannerStatus(): Promise<PlannerStatus> {
    try {
      const res = await fetch(`${this.bridgeUrl}/bridge/merlin/status`);
      const body = await res.json() as { ok: boolean; message: string };
      return body.ok
        ? { ok: true, message: body.message }
        : { ok: false, errorCode: "webview_not_ready", message: body.message };
    } catch (error) {
      return { ok: false, errorCode: "bridge_unavailable", message: error instanceof Error ? error.message : String(error) };
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
    const res = await fetch(`${this.bridgeUrl}/bridge/merlin/new-chat`, { method: "POST" });
    const body = await res.json() as { ok?: boolean; error?: string };
    if (!body.ok) {
      throw new Error(body.error ?? "Failed to open new Merlin chat in webview.");
    }
  }

  async sendTurn(_session: PlannerSession, prompt: string): Promise<PlannerTurnResult> {
    try {
      const res = await fetch(`${this.bridgeUrl}/bridge/merlin/send`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt, timeoutMs: this.timeoutMs })
      });
      const body = await res.json() as { ok?: boolean; error?: string; response?: string };
      if (!body.ok) {
        return { ok: false, errorCode: "bridge_error", message: body.error ?? "Merlin bridge send failed." };
      }
      let raw = body.response?.trim();

      // If response is empty, Merlin may still be rendering — retry
      if (!raw) {
        await new Promise(r => setTimeout(r, 2000));
        try {
          const retryRes = await fetch(`${this.bridgeUrl}/bridge/merlin/messages`);
          const retryBody = await retryRes.json() as { ok?: boolean; messages?: Array<{ role: string; text: string }> };
          if (retryBody.ok && retryBody.messages?.length) {
            const lastAssistant = [...retryBody.messages].reverse().find(m => m.role === "assistant");
            if (lastAssistant?.text?.trim()) raw = lastAssistant.text.trim();
          }
        } catch { /* ignore retry failure */ }
      }

      if (!raw) {
        return { ok: false, errorCode: "empty_response", message: "Merlin returned empty response." };
      }
      return { ok: true, raw, message: "Turn succeeded." };
    } catch (error) {
      return { ok: false, errorCode: "bridge_error", message: error instanceof Error ? error.message : String(error) };
    }
  }
}
