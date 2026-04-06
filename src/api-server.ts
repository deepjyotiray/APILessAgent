import http from "node:http";
import { URL } from "node:url";

import { TaskStateStore } from "./agent/state.js";
import { LocalToolRegistry } from "./agent/tools.js";
import { MemoryStore } from "./agent/memory.js";
import { ConversationStore } from "./agent/conversation.js";
import { loadProjectContext, initProjectContext } from "./agent/project-context.js";
import { ChatGPTAgent } from "./agent/orchestrator.js";
import { ElectronBridgePlanner } from "./agent/electron-planner.js";
import { OllamaPlanner } from "./agent/ollama-planner.js";
import { MerlinBridgePlanner } from "./agent/merlin-planner.js";
import type { PlannerAdapter } from "./agent/types.js";

const PORT = Number(process.env.APP_PORT ?? "3850");
let ROOT = process.env.AGENT_ROOT ?? process.cwd();
const BRIDGE_RELAY_URL = process.env.BRIDGE_RELAY_URL ?? "http://127.0.0.1:3851";

let planner: PlannerAdapter = new ElectronBridgePlanner(BRIDGE_RELAY_URL, 120_000);
let ollamaPlanner: OllamaPlanner | null = null;
let activePlannerName = "chatgpt";
let store = new TaskStateStore(ROOT);
let memory = new MemoryStore(ROOT);
let conversations = new ConversationStore(ROOT);
const tools = new LocalToolRegistry();
const sseClients = new Set<http.ServerResponse>();
let agent: ChatGPTAgent | null = null;
const activeAbortControllers = new Map<string, AbortController>();

function getOllamaPlanner(): OllamaPlanner {
  if (!ollamaPlanner) {
    ollamaPlanner = new OllamaPlanner(undefined, undefined, (msg) => {
      broadcast({ type: "ollama:log", message: msg, timestamp: new Date().toISOString() });
    });
  }
  return ollamaPlanner;
}

function getAgent(): ChatGPTAgent {
  if (!agent) {
    agent = new ChatGPTAgent(planner, tools, ROOT, (event) => {
      broadcast({ type: `agent:${event.type}`, data: event.data });
    }, conversations);
  }
  return agent;
}


function broadcast(data: unknown) {
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try { client.write(payload); } catch { sseClients.delete(client); }
  }
}

const server = http.createServer(async (req, res) => {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "GET,POST,PUT,DELETE,OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  try {
    await route(req, res);
  } catch (error) {
    json(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});

async function route(req: http.IncomingMessage, res: http.ServerResponse) {
  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
  const p = url.pathname;

  // SSE stream
  if (method === "GET" && p === "/events") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    sseClients.add(res);
    req.on("close", () => sseClients.delete(res));
    return;
  }

  // Health
  if (method === "GET" && p === "/health") {
    const status = await Promise.race([
      planner.getPlannerStatus(),
      new Promise<{ok: boolean; message: string}>(r => setTimeout(() => r({ ok: false, message: "Status check timed out" }), 5000))
    ]);
    return json(res, 200, { ok: true, planner: planner.name, activePlanner: activePlannerName, plannerStatus: status, root: ROOT });
  }

  // Planner switch
  if (method === "GET" && p === "/planner") {
    const ollamaModel = ollamaPlanner?.getModel() ?? "qwen2.5-coder:7b";
    return json(res, 200, { ok: true, active: activePlannerName, ollamaModel });
  }
  if (method === "POST" && p === "/planner") {
    const body = await readBody(req) as { planner?: string; model?: string };
    const target = body.planner ?? "chatgpt";
    if (target === "ollama") {
      const op = getOllamaPlanner();
      if (body.model) op.setModel(body.model);
      planner = op;
      activePlannerName = "ollama";
    } else if (target === "merlin") {
      planner = new MerlinBridgePlanner(BRIDGE_RELAY_URL, 120_000);
      activePlannerName = "merlin";
    } else {
      planner = new ElectronBridgePlanner(BRIDGE_RELAY_URL, 120_000);
      activePlannerName = "chatgpt";
    }
    if (agent) { agent.resetSession(); }
    agent = null; // Force re-create with new planner
    broadcast({ type: "planner:switched", planner: activePlannerName, model: ollamaPlanner?.getModel() });
    const status = await planner.getPlannerStatus();
    return json(res, 200, { ok: true, active: activePlannerName, plannerStatus: status });
  }

  // Switch workspace
  if (method === "POST" && p === "/workspace") {
    const body = await readBody(req) as { path?: string };
    if (!body.path?.trim()) return json(res, 400, { ok: false, error: "Missing path" });
    ROOT = body.path;
    store = new TaskStateStore(ROOT);
    memory = new MemoryStore(ROOT);
    conversations = new ConversationStore(ROOT);
    if (agent) { agent.resetSession(); agent.setRoot(ROOT); agent.setConversationStore(conversations); }
    broadcast({ type: "workspace:changed", root: ROOT });
    return json(res, 200, { ok: true, root: ROOT });
  }

  // Get workspace
  if (method === "GET" && p === "/workspace") {
    return json(res, 200, { ok: true, root: ROOT });
  }

  // Tasks (read-only — tasks now live inside conversations)
  if (method === "GET" && p === "/tasks") {
    return json(res, 200, { ok: true, tasks: await store.list() });
  }
  if (method === "GET" && p.startsWith("/tasks/") && p.split("/").length === 3) {
    const id = p.split("/")[2];
    return json(res, 200, { ok: true, task: await store.load(id) });
  }

  // Conversations
  if (method === "GET" && p === "/conversations") {
    return json(res, 200, { ok: true, conversations: await conversations.list() });
  }
  if (method === "GET" && p.startsWith("/conversations/") && p.split("/").length === 3) {
    const id = p.split("/")[2];
    try {
      return json(res, 200, { ok: true, conversation: await conversations.load(id) });
    } catch {
      return json(res, 404, { ok: false, error: "Conversation not found" });
    }
  }
  if (method === "POST" && p === "/conversations") {
    const body = await readBody(req) as { title?: string };
    const conv = conversations.create(body.title ?? "New conversation", planner.name);
    await conversations.save(conv);
    return json(res, 200, { ok: true, conversation: { id: conv.id, title: conv.title } });
  }
  if (method === "POST" && p.match(/^\/conversations\/[^/]+\/send$/)) {
    const id = p.split("/")[2];
    const body = await readBody(req) as { message?: string };
    if (!body.message?.trim()) return json(res, 400, { ok: false, error: "Missing message" });
    let conv;
    try {
      conv = await conversations.load(id);
    } catch {
      return json(res, 404, { ok: false, error: "Conversation not found. Create one first." });
    }
    conversations.addMessage(conv, { role: "user", content: body.message });

    const orchestrator = getAgent();
    const ac = new AbortController();
    activeAbortControllers.set(id, ac);
    let displayText: string;
    try {
      displayText = await orchestrator.run(body.message, id, conv, ac.signal);
    } catch (err: unknown) {
      if (ac.signal.aborted) {
        displayText = "⏹ Execution stopped by user.";
      } else {
        throw err;
      }
    } finally {
      activeAbortControllers.delete(id);
    }

    conversations.addMessage(conv, { role: "assistant", content: displayText });
    await conversations.save(conv);
    broadcast({ type: "conversation:message", conversationId: id, role: "assistant", content: displayText });
    return json(res, 200, { ok: true, response: displayText, turnOk: true, taskId: conv.activeTaskId });
  }
  // Abort running execution
  if (method === "POST" && p.match(/^\/conversations\/[^/]+\/abort$/)) {
    const id = p.split("/")[2];
    const ac = activeAbortControllers.get(id);
    if (ac) {
      ac.abort();
      activeAbortControllers.delete(id);
      broadcast({ type: "conversation:aborted", conversationId: id });
      return json(res, 200, { ok: true, message: "Aborted" });
    }
    return json(res, 200, { ok: true, message: "Nothing running" });
  }

  if (method === "DELETE" && p.startsWith("/conversations/") && p.split("/").length === 3) {
    const id = p.split("/")[2];
    const deleted = await conversations.delete(id);
    if (!deleted) return json(res, 404, { ok: false, error: "Not found" });
    const a = getAgent(); a.resetSession(id);
    broadcast({ type: "conversation:deleted", conversationId: id });
    return json(res, 200, { ok: true, conversationId: id });
  }
  if (method === "DELETE" && p === "/conversations") {
    const list = await conversations.list();
    let count = 0;
    for (const c of list) {
      if (await conversations.delete(c.id)) count++;
    }
    const a = getAgent(); a.resetSession();
    broadcast({ type: "conversations:cleared", count });
    return json(res, 200, { ok: true, deleted: count });
  }

  // Memory
  if (method === "GET" && p === "/memory") {
    return json(res, 200, { ok: true, entries: await memory.list() });
  }
  if (method === "GET" && p.startsWith("/memory/") && p.split("/").length === 3) {
    const key = decodeURIComponent(p.split("/")[2]);
    const content = await memory.read(key);
    if (content === null) return json(res, 404, { ok: false, error: "Not found" });
    return json(res, 200, { ok: true, key, content });
  }
  if (method === "PUT" && p.startsWith("/memory/") && p.split("/").length === 3) {
    const key = decodeURIComponent(p.split("/")[2]);
    const body = await readBody(req) as { content?: string; mode?: string };
    if (!body.content) return json(res, 400, { ok: false, error: "Missing content" });
    if (body.mode === "append") {
      await memory.append(key, body.content);
    } else {
      await memory.write(key, body.content);
    }
    return json(res, 200, { ok: true, key });
  }
  if (method === "DELETE" && p.startsWith("/memory/") && p.split("/").length === 3) {
    const key = decodeURIComponent(p.split("/")[2]);
    await memory.delete(key);
    return json(res, 200, { ok: true });
  }
  if (method === "POST" && p === "/memory/init") {
    await memory.initDefaults();
    return json(res, 200, { ok: true });
  }

  // Project context
  if (method === "GET" && p === "/project-context") {
    const ctx = await loadProjectContext(ROOT);
    return json(res, 200, { ok: true, content: ctx });
  }
  if (method === "POST" && p === "/project-context/init") {
    const path = await initProjectContext(ROOT);
    return json(res, 200, { ok: true, path });
  }

  json(res, 404, { ok: false, error: "Not found" });
}

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => { body += String(chunk); });
    req.on("end", () => { try { resolve(body ? JSON.parse(body) : {}); } catch (e) { reject(e); } });
    req.on("error", reject);
  });
}

function json(res: http.ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(data));
}

server.listen(PORT, "127.0.0.1", () => {
  process.stdout.write(`Agent API server at http://127.0.0.1:${PORT}\n`);
  process.stdout.write(`Planner: ${planner.name}\n`);
  process.stdout.write(`Workspace: ${ROOT}\n`);
});
