import { randomUUID } from "node:crypto";
import type { PlannerAdapter, PlannerSession, PlannerStatus, PlannerTurnResult } from "./types.js";

/**
 * Pool-based planner: uses the Electron session pool for parallel sub-agent work.
 * Each session is identified by a role (planner, explorer, editor, etc.)
 * Talks to the pool via the bridge relay HTTP endpoint.
 */
export class PoolPlanner implements PlannerAdapter {
  readonly name = "pool_chatgpt";
  private currentRole = "default";

  constructor(
    private readonly relayUrl: string,
    private readonly timeoutMs: number
  ) {}

  setRole(role: string): void {
    this.currentRole = role;
  }

  async getPlannerStatus(): Promise<PlannerStatus> {
    try {
      const res = await fetch(`${this.relayUrl}/bridge/pool/status`);
      const body = await res.json() as any;
      return {
        ok: body.ok && body.total > 0,
        message: body.ok ? `Pool: ${body.available} available, ${body.inUse?.length ?? 0} in use` : "Pool not ready"
      };
    } catch (err: any) {
      return { ok: false, errorCode: "pool_unavailable", message: err.message };
    }
  }

  async startSession(skipReset?: boolean): Promise<PlannerSession> {
    if (!skipReset) {
      try {
        await fetch(`${this.relayUrl}/bridge/pool/new-chat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ role: this.currentRole })
        });
      } catch {}
    }
    return { id: `${this.currentRole}-${randomUUID().slice(0, 8)}` };
  }

  async resetSession(_session: PlannerSession): Promise<void> {
    try {
      await fetch(`${this.relayUrl}/bridge/pool/new-chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role: this.currentRole })
      });
    } catch {}
  }

  async sendTurn(_session: PlannerSession, prompt: string): Promise<PlannerTurnResult> {
    try {
      const res = await fetch(`${this.relayUrl}/bridge/pool/send`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          role: this.currentRole,
          prompt,
          timeoutMs: this.timeoutMs
        })
      });

      const body = await res.json() as any;
      if (!body.ok) {
        return { ok: false, errorCode: "pool_error", message: body.error ?? "Pool send failed" };
      }

      const raw = body.response?.trim();
      if (!raw) {
        return { ok: false, errorCode: "empty_response", message: "Empty response from pool" };
      }

      return { ok: true, raw, message: "Pool turn succeeded." };
    } catch (err: any) {
      return { ok: false, errorCode: "pool_error", message: err.message };
    }
  }
}
