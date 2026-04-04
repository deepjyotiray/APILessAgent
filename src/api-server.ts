import http from "node:http";
import { URL } from "node:url";

import { loadAgentConfig } from "./agent/config.js";
import { ChatGPTWebPlanner } from "./agent/planner.js";
import { OllamaPlanner } from "./agent/ollama-planner.js";
import { AgentRuntime } from "./agent/runtime.js";
import { TaskStateStore } from "./agent/state.js";
import { LocalToolRegistry } from "./agent/tools.js";
import { MemoryStore } from "./agent/memory.js";
import { ConversationStore } from "./agent/conversation.js";
import { loadProjectContext, initProjectContext } from "./agent/project-context.js";
import { ChatGPTAgent } from "./agent/orchestrator.js";
import { ElectronBridgePlanner } from "./agent/electron-planner.js";
import type { PlannerAdapter, RuntimeObserver, SafetyMode, StepRecord, TaskState } from "./agent/types.js";

const PORT = Number(process.env.APP_PORT ?? "3850");
let ROOT = process.env.AGENT_ROOT ?? process.cwd();
const BRIDGE_URL = process.env.BRIDGE_BASE_URL ?? "http://127.0.0.1:3847";
const BRIDGE_RELAY_URL = process.env.BRIDGE_RELAY_URL ?? "http://127.0.0.1:3851";
const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://127.0.0.1:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? "qwen2.5-coder:7b";
const USE_ELECTRON = process.env.USE_ELECTRON_BRIDGE === "true";

let currentBackend: "electron" | "chatgpt_web" | "ollama" = USE_ELECTRON ? "electron" : "chatgpt_web";
let planner: PlannerAdapter = createPlanner(currentBackend);
let store = new TaskStateStore(ROOT);
let memory = new MemoryStore(ROOT);
let conversations = new ConversationStore(ROOT);
const tools = new LocalToolRegistry();
const sseClients = new Set<http.ServerResponse>();
let agent: ChatGPTAgent | null = null;

function getAgent(): ChatGPTAgent {
  if (!agent) {
    agent = new ChatGPTAgent(planner, tools, ROOT, (event) => {
      broadcast({ type: `agent:${event.type}`, data: event.data });
    });
  }
  return agent;
}

function createPlanner(backend: string): PlannerAdapter {
  if (backend === "ollama") {
    return new OllamaPlanner(OLLAMA_URL, OLLAMA_MODEL, 120_000);
  }
  if (backend === "electron") {
    return new ElectronBridgePlanner(BRIDGE_RELAY_URL, 120_000);
  }
  return new ChatGPTWebPlanner(BRIDGE_URL, 120_000);
}

function createObserver(): RuntimeObserver {
  return {
    onTaskStarted: (task) => broadcast({ type: "task:started", taskId: task.id, status: task.status }),
    onStepStarted: (task, step) => broadcast({ type: "step:started", taskId: task.id, step: step.index }),
    onPlannerStarted: (task, step) => broadcast({ type: "planner:thinking", taskId: task.id, step: step.index }),
    onPlannerReply: (task, step) => broadcast({ type: "planner:reply", taskId: task.id, step: step.index, reply: step.plannerReply }),
    onToolStarted: (task, step) => broadcast({ type: "tool:started", taskId: task.id, tool: step.toolName }),
    onToolFinished: (task, step) => broadcast({ type: "tool:finished", taskId: task.id, tool: step.toolName, result: step.toolResult }),
    onTaskFinished: (task) => broadcast({ type: "task:finished", taskId: task.id, status: task.status })
  };
}

function broadcast(data: unknown) {
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try { client.write(payload); } catch { sseClients.delete(client); }
  }
}

const server = http.createServer(async (req, res) => {
  // CORS
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
    return json(res, 200, { ok: true, backend: currentBackend, planner: planner.name, plannerStatus: status, root: ROOT });
  }

  // Switch workspace
  if (method === "POST" && p === "/workspace") {
    const body = await readBody(req) as { path?: string };
    if (!body.path?.trim()) return json(res, 400, { ok: false, error: "Missing path" });
    ROOT = body.path;
    store = new TaskStateStore(ROOT);
    memory = new MemoryStore(ROOT);
    conversations = new ConversationStore(ROOT);
    // Keep the current backend, just reset the agent session
    if (agent) { agent.resetSession(); agent.setRoot(ROOT); }
    broadcast({ type: "workspace:changed", root: ROOT });
    return json(res, 200, { ok: true, root: ROOT });
  }

  // Get workspace
  if (method === "GET" && p === "/workspace") {
    return json(res, 200, { ok: true, root: ROOT });
  }

  // Switch backend
  if (method === "POST" && p === "/backend") {
    const body = await readBody(req) as { backend?: string; model?: string };
    const target = body.backend ?? "chatgpt_web";
    if (target === "ollama") {
      const model = body.model ?? OLLAMA_MODEL;
      planner = new OllamaPlanner(OLLAMA_URL, model, 120_000);
      currentBackend = "ollama";
    } else if (target === "electron") {
      planner = new ElectronBridgePlanner(BRIDGE_RELAY_URL, 120_000);
      currentBackend = "electron";
    } else {
      planner = new ChatGPTWebPlanner(BRIDGE_URL, 120_000);
      currentBackend = "chatgpt_web";
    }
    const status = await Promise.race([
      planner.getPlannerStatus(),
      new Promise<{ok: boolean; message: string}>(r => setTimeout(() => r({ ok: false, message: "Status check timed out" }), 5000))
    ]);
    agent = null; // Reset agent on backend switch
    broadcast({ type: "backend:switched", backend: currentBackend, planner: planner.name });
    return json(res, 200, { ok: true, backend: currentBackend, planner: planner.name, status });
  }

  // Tasks
  if (method === "GET" && p === "/tasks") {
    return json(res, 200, { ok: true, tasks: await store.list() });
  }
  if (method === "GET" && p.startsWith("/tasks/") && p.split("/").length === 3) {
    const id = p.split("/")[2];
    return json(res, 200, { ok: true, task: await store.load(id) });
  }
  if (method === "POST" && p === "/tasks") {
    const body = await readBody(req) as { goal?: string; safetyMode?: SafetyMode };
    if (!body.goal?.trim()) return json(res, 400, { ok: false, error: "Missing goal" });
    const config = await loadAgentConfig(ROOT);
    const runtime = new AgentRuntime(ROOT, planner, tools, store, config, createObserver());
    const task = await runtime.createTask(body.goal, body.safetyMode ?? "auto");
    // Run async
    runtime.run(task).catch(() => {});
    return json(res, 200, { ok: true, task: { id: task.id, status: task.status, goal: task.goal } });
  }
  if (method === "POST" && p.match(/^\/tasks\/[^/]+\/abort$/)) {
    const id = p.split("/")[2];
    const task = await store.setStatus(id, "aborted", "Aborted from app.");
    return json(res, 200, { ok: true, task: { id: task.id, status: task.status } });
  }

  // Conversations
  if (method === "GET" && p === "/conversations") {
    return json(res, 200, { ok: true, conversations: await conversations.list() });
  }
  if (method === "GET" && p.startsWith("/conversations/") && p.split("/").length === 3) {
    const id = p.split("/")[2];
    return json(res, 200, { ok: true, conversation: await conversations.load(id) });
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
    const conv = await conversations.load(id);
    conversations.addMessage(conv, { role: "user", content: body.message });

    // Use the orchestrator — proper agent loop with tool calling
    const orchestrator = getAgent();
    const displayText = await orchestrator.run(body.message, id);

    conversations.addMessage(conv, { role: "assistant", content: displayText });
    await conversations.save(conv);
    broadcast({ type: "conversation:message", conversationId: id, role: "assistant", content: displayText });
    return json(res, 200, { ok: true, response: displayText, turnOk: true });
  }
  if (method === "DELETE" && p.startsWith("/conversations/") && p.split("/").length === 3) {
    const id = p.split("/")[2];
    await conversations.delete(id);
    const a = getAgent(); a.resetSession(id);
    return json(res, 200, { ok: true });
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
  process.stdout.write(`Backend: ${currentBackend} (${planner.name})\n`);
  process.stdout.write(`Workspace: ${ROOT}\n`);
});
