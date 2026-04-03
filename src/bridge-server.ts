import http from "node:http";
import { randomUUID } from "node:crypto";
import { URL } from "node:url";
import { WebSocketServer } from "ws";

type BridgeCommandType = "ping" | "getMessages" | "sendMessage" | "readLastAssistant" | "newChat";

interface BridgeClientHello {
  type: "hello";
  source: "chatgpt-content-script";
  url?: string;
  title?: string;
}

interface BridgeCommand {
  type: "command";
  id: string;
  command: BridgeCommandType;
  prompt?: string;
  timeoutMs?: number;
}

interface BridgeResult {
  type: "result";
  id: string;
  ok: boolean;
  data?: unknown;
  error?: string;
}

interface ConnectedClient {
  id: string;
  socket: any;
  meta?: BridgeClientHello;
}

const HTTP_PORT = Number(process.env.BRIDGE_PORT ?? "3847");
const WS_PATH = "/ws";
const clients = new Map<string, ConnectedClient>();
const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();

const server = http.createServer(async (req, res) => {
  try {
    await handleHttpRequest(req, res);
  } catch (error) {
    sendJson(res, 500, {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
  }
});

const wss = new WebSocketServer({ server, path: WS_PATH });

wss.on("connection", (socket: any) => {
  const clientId = randomUUID();
  const client: ConnectedClient = { id: clientId, socket };
  clients.set(clientId, client);

  socket.on("message", (raw: Buffer) => {
    try {
      const message = JSON.parse(String(raw)) as BridgeClientHello | BridgeResult;

      if (message.type === "hello") {
        client.meta = message;
        return;
      }

      if (message.type === "result") {
        const pendingRequest = pending.get(message.id);
        if (!pendingRequest) {
          return;
        }

        clearTimeout(pendingRequest.timer);
        pending.delete(message.id);

        if (message.ok) {
          pendingRequest.resolve(message.data);
        } else {
          pendingRequest.reject(new Error(message.error ?? "Unknown bridge error"));
        }
      }
    } catch {
      return;
    }
  });

  socket.on("close", () => {
    clients.delete(clientId);
  });
});

server.listen(HTTP_PORT, "127.0.0.1", () => {
  process.stdout.write(
    `ChatGPT bridge server listening at http://127.0.0.1:${HTTP_PORT}\n`
  );
});

async function handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${HTTP_PORT}`);

  if (method === "GET" && url.pathname === "/health") {
    sendJson(res, 200, {
      ok: true,
      clients: getClientSummaries()
    });
    return;
  }

  if (method === "GET" && url.pathname === "/messages") {
    const data = await sendCommandToActiveClient({
      command: "getMessages"
    });
    sendJson(res, 200, { ok: true, data });
    return;
  }

  if (method === "GET" && url.pathname === "/last-assistant") {
    const data = await sendCommandToActiveClient({
      command: "readLastAssistant"
    });
    sendJson(res, 200, { ok: true, data });
    return;
  }

  if (method === "POST" && url.pathname === "/new-chat") {
    const data = await sendCommandToActiveClient({
      command: "newChat",
      timeoutMs: 30_000
    });
    sendJson(res, 200, { ok: true, data });
    return;
  }

  if (method === "POST" && url.pathname === "/send") {
    const body = await readJsonBody(req) as { prompt?: string; timeoutMs?: number };
    if (!body.prompt?.trim()) {
      sendJson(res, 400, { ok: false, error: "Missing prompt" });
      return;
    }

    const data = await sendCommandToActiveClient({
      command: "sendMessage",
      prompt: body.prompt,
      timeoutMs: body.timeoutMs
    });
    sendJson(res, 200, { ok: true, data });
    return;
  }

  sendJson(res, 404, { ok: false, error: "Not found" });
}

async function sendCommandToActiveClient(input: {
  command: BridgeCommandType;
  prompt?: string;
  timeoutMs?: number;
}): Promise<unknown> {
  const client = [...clients.values()].find((entry) => entry.socket.readyState === entry.socket.OPEN);
  if (!client) {
    throw new Error("No active ChatGPT tab is connected. Open chatgpt.com with the extension loaded.");
  }

  const id = randomUUID();
  const payload: BridgeCommand = {
    type: "command",
    id,
    command: input.command,
    prompt: input.prompt,
    timeoutMs: input.timeoutMs
  };

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("Timed out waiting for the ChatGPT tab."));
    }, input.timeoutMs ?? 120_000);

    pending.set(id, { resolve, reject, timer });
    client.socket.send(JSON.stringify(payload));
  });
}

function getClientSummaries() {
  return [...clients.values()].map((client) => ({
    id: client.id,
    url: client.meta?.url ?? null,
    title: client.meta?.title ?? null
  }));
}

function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += String(chunk);
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown) {
  res.writeHead(status, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type"
  });
  res.end(JSON.stringify(payload, null, 2));
}
