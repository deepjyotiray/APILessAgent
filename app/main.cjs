const { app, BrowserWindow, BrowserView, Menu, ipcMain, dialog, shell, session } = require("electron");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const bridge = require("./chatgpt-bridge.cjs");
const merlinBridge = require("./merlin-bridge.cjs");
const sessionPool = require("./session-pool.cjs");

let mainWindow = null;
let chatView = null;
let merlinView = null;
let apiProcess = null;
let currentWorkspace = null;
let chatViewVisible = false;
let merlinViewVisible = false;
const API_PORT = process.env.APP_PORT ?? "3850";
const RECENTS_FILE = path.join(app.getPath("userData"), "recent-projects.json");
const CHATGPT_PARTITION = "persist:chatgpt";
const MERLIN_PARTITION = "persist:merlin";

// --- Recent projects ---
function loadRecents() {
  try { return JSON.parse(fs.readFileSync(RECENTS_FILE, "utf8")); }
  catch { return []; }
}
function saveRecent(dir) {
  let recents = loadRecents().filter(r => r !== dir);
  recents.unshift(dir);
  recents = recents.slice(0, 10);
  fs.mkdirSync(path.dirname(RECENTS_FILE), { recursive: true });
  fs.writeFileSync(RECENTS_FILE, JSON.stringify(recents), "utf8");
  return recents;
}

// --- API server ---
function startApiServer(workspace) {
  const http = require("http");
  const checkReq = http.get(`http://127.0.0.1:${API_PORT}/health`, (res) => {
    res.resume();
    if (res.statusCode === 200) {
      console.log("[app] API server already running, switching workspace");
      const data = JSON.stringify({ path: workspace });
      const req2 = http.request({ hostname: "127.0.0.1", port: API_PORT, path: "/workspace", method: "POST",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data) } });
      req2.on("error", () => {});
      req2.write(data); req2.end();
      return;
    }
    launchApiServer(workspace);
  });
  checkReq.on("error", () => launchApiServer(workspace));
  checkReq.setTimeout(2000, () => { checkReq.destroy(); launchApiServer(workspace); });
}

function launchApiServer(workspace) {
  if (apiProcess) { apiProcess.kill(); apiProcess = null; }
  const tsxPath = path.join(__dirname, "..", "node_modules", ".bin", "tsx");
  const serverPath = path.join(__dirname, "..", "src", "api-server.ts");
  apiProcess = spawn(tsxPath, [serverPath], {
    cwd: path.join(__dirname, ".."),
    env: { ...process.env, APP_PORT: API_PORT, AGENT_ROOT: workspace, USE_ELECTRON_BRIDGE: "true" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  apiProcess.stdout?.on("data", d => process.stdout.write(`[api] ${d}`));
  apiProcess.stderr?.on("data", d => process.stderr.write(`[api:err] ${d}`));
  apiProcess.on("exit", code => { if (code) console.error(`API server exited with ${code}`); });
  console.log(`[app] Started API server for: ${workspace}`);
}

// --- Merlin BrowserView ---
function createMerlinView() {
  const ses = session.fromPartition(MERLIN_PARTITION);
  ses.setUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36");
  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    details.requestHeaders["User-Agent"] = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
    callback({ requestHeaders: details.requestHeaders });
  });

  merlinView = new BrowserView({
    webPreferences: {
      partition: MERLIN_PARTITION,
      contextIsolation: false,
      nodeIntegration: false,
      sandbox: false,
      javascript: true,
      webgl: true
    }
  });
  merlinBridge.setBrowserView(merlinView);
  merlinView.webContents.loadURL("https://www.getmerlin.in/chat");

  merlinView.webContents.setWindowOpenHandler(({ url }) => {
    return {
      action: "allow",
      overrideBrowserWindowOptions: {
        width: 600, height: 750,
        webPreferences: { partition: MERLIN_PARTITION, contextIsolation: false, sandbox: false }
      }
    };
  });

  merlinView.webContents.on("did-finish-load", () => {
    console.log("[merlin] Loaded:", merlinView.webContents.getURL().slice(0, 100));
  });
  merlinView.webContents.on("did-fail-load", (event, errorCode, errorDescription, validatedURL) => {
    console.log("[merlin] Failed:", errorCode, errorDescription, validatedURL?.slice(0, 80));
  });
}

function layoutMerlinView() {
  if (!mainWindow || !merlinView) return;
  const bounds = mainWindow.getContentBounds();
  if (merlinViewVisible) {
    const chatWidth = Math.floor(bounds.width * 0.4);
    mainWindow.addBrowserView(merlinView);
    merlinView.setBounds({ x: bounds.width - chatWidth, y: 0, width: chatWidth, height: bounds.height });
    merlinView.setAutoResize({ width: false, height: true });
  } else {
    mainWindow.removeBrowserView(merlinView);
  }
}

// --- ChatGPT BrowserView ---
function createChatView() {
  const ses = session.fromPartition(CHATGPT_PARTITION);

  ses.setUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36");

  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    details.requestHeaders["User-Agent"] = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
    callback({ requestHeaders: details.requestHeaders });
  });

  chatView = new BrowserView({
    webPreferences: {
      partition: CHATGPT_PARTITION,
      contextIsolation: false,
      nodeIntegration: false,
      sandbox: false,
      javascript: true,
      webgl: true
    }
  });
  bridge.setBrowserView(chatView);
  chatView.webContents.loadURL("https://chatgpt.com/");

  chatView.webContents.setWindowOpenHandler(({ url }) => {
    return {
      action: "allow",
      overrideBrowserWindowOptions: {
        width: 600, height: 750,
        webPreferences: { partition: CHATGPT_PARTITION, contextIsolation: false, sandbox: false }
      }
    };
  });

  chatView.webContents.on("did-finish-load", () => {
    console.log("[chatgpt] Loaded:", chatView.webContents.getURL().slice(0, 100));
  });

  chatView.webContents.on("did-fail-load", (event, errorCode, errorDescription, validatedURL) => {
    console.log("[chatgpt] Failed:", errorCode, errorDescription, validatedURL?.slice(0, 80));
  });
}

function layoutChatView() {
  if (!mainWindow || !chatView) return;
  const bounds = mainWindow.getContentBounds();
  if (chatViewVisible) {
    const chatWidth = Math.floor(bounds.width * 0.4);
    mainWindow.addBrowserView(chatView);
    chatView.setBounds({ x: bounds.width - chatWidth, y: 0, width: chatWidth, height: bounds.height });
    chatView.setAutoResize({ width: false, height: true });
  } else {
    mainWindow.removeBrowserView(chatView);
  }
}

// --- Window ---
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400, height: 900, minWidth: 900, minHeight: 600,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 16 },
    backgroundColor: "#0d1117",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": ["default-src 'self' 'unsafe-inline' 'unsafe-eval'; connect-src 'self' http://127.0.0.1:* ws://127.0.0.1:*; img-src 'self' data:;"]
      }
    });
  });

  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
  mainWindow.on("closed", () => { mainWindow = null; });
  mainWindow.on("resize", () => { layoutChatView(); layoutMerlinView(); });

  // Create the ChatGPT and Merlin views (hidden)
  createChatView();
  createMerlinView();
}

// --- Menu ---
function buildMenu() {
  const template = [
    {
      label: app.name,
      submenu: [
        { role: "about" },
        { type: "separator" },
        { label: "Settings…", accelerator: "Cmd+,", click: () => mainWindow?.webContents.send("navigate", "settings") },
        { type: "separator" },
        { role: "quit" }
      ]
    },
    {
      label: "File",
      submenu: [
        { label: "New Conversation", accelerator: "Cmd+N", click: () => mainWindow?.webContents.send("action", "new-conversation") },
        { label: "New Task", accelerator: "Cmd+T", click: () => mainWindow?.webContents.send("action", "new-task") },
        { type: "separator" },
        { label: "Open Project…", accelerator: "Cmd+O", click: () => pickAndOpenWorkspace() },
        { type: "separator" },
        { label: "Toggle ChatGPT Panel", accelerator: "Cmd+Shift+G", click: () => toggleChatView() },
        { label: "Toggle Merlin Panel", accelerator: "Cmd+Shift+M", click: () => toggleMerlinView() },
        { type: "separator" },
        { role: "close" }
      ]
    },
    { label: "Edit", submenu: [{ role: "undo" }, { role: "redo" }, { type: "separator" }, { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" }] },
    { label: "View", submenu: [{ role: "reload" }, { role: "toggleDevTools" }, { type: "separator" }, { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }, { type: "separator" }, { role: "togglefullscreen" }] },
    { label: "Window", submenu: [{ role: "minimize" }, { role: "zoom" }] }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function toggleChatView() {
  chatViewVisible = !chatViewVisible;
  if (chatViewVisible && merlinViewVisible) { merlinViewVisible = false; layoutMerlinView(); mainWindow?.webContents.send("merlinview-toggled", false); }
  layoutChatView();
  mainWindow?.webContents.send("chatview-toggled", chatViewVisible);
}

function toggleMerlinView() {
  merlinViewVisible = !merlinViewVisible;
  if (merlinViewVisible && chatViewVisible) { chatViewVisible = false; layoutChatView(); mainWindow?.webContents.send("chatview-toggled", false); }
  layoutMerlinView();
  mainWindow?.webContents.send("merlinview-toggled", merlinViewVisible);
}

// --- Workspace ---
async function pickAndOpenWorkspace() {
  const win = mainWindow ?? BrowserWindow.getFocusedWindow();
  const opts = { properties: ["openDirectory"], title: "Open Project Workspace" };
  const result = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
  if (result.canceled || !result.filePaths[0]) return;
  openWorkspace(result.filePaths[0]);
}

function openWorkspace(dir) {
  currentWorkspace = dir;
  saveRecent(dir);
  startApiServer(dir);
  if (mainWindow) {
    mainWindow.webContents.send("workspace-changed", dir);
    mainWindow.setTitle(`Agent — ${path.basename(dir)}`);
  }
}

// --- IPC: general ---
ipcMain.handle("get-api-port", () => API_PORT);
ipcMain.handle("get-recents", () => loadRecents());
ipcMain.handle("get-workspace", () => currentWorkspace);
ipcMain.handle("open-external", (_, url) => shell.openExternal(url));
ipcMain.handle("pick-folder", async () => {
  const win = mainWindow ?? BrowserWindow.getFocusedWindow();
  const opts = { properties: ["openDirectory"], title: "Open Project Workspace" };
  const result = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
  if (result.canceled || !result.filePaths[0]) return null;
  return result.filePaths[0];
});
ipcMain.handle("open-workspace", (_, dir) => { openWorkspace(dir); return true; });
ipcMain.handle("toggle-chatview", () => { toggleChatView(); return chatViewVisible; });
ipcMain.handle("get-chatview-visible", () => chatViewVisible);
ipcMain.handle("toggle-merlinview", () => { toggleMerlinView(); return merlinViewVisible; });
ipcMain.handle("get-merlinview-visible", () => merlinViewVisible);
ipcMain.handle("merlinview-back", () => { if (merlinView && !merlinView.webContents.isDestroyed()) merlinView.webContents.navigationHistory.goBack(); });
ipcMain.handle("merlinview-forward", () => { if (merlinView && !merlinView.webContents.isDestroyed()) merlinView.webContents.navigationHistory.goForward(); });
ipcMain.handle("merlinview-refresh", () => { if (merlinView && !merlinView.webContents.isDestroyed()) merlinView.webContents.reload(); });
ipcMain.handle("merlinview-home", () => { if (merlinView && !merlinView.webContents.isDestroyed()) merlinView.webContents.loadURL("https://www.getmerlin.in/chat"); });
ipcMain.handle("merlinview-inspect-dom", async () => {
  if (!merlinView || merlinView.webContents.isDestroyed()) return { ok: false };
  try {
    const result = await merlinView.webContents.executeJavaScript(`
      (function() {
        const info = { composer: null, sendBtn: null, messages: [], articles: [], newChatBtn: null, stopBtn: null, sidebarLinks: [], allBtnSummary: [] };
        // Find composer
        const ta = document.querySelector('textarea');
        const pm = document.querySelector('.ProseMirror');
        const ce = document.querySelector('[contenteditable="true"]');
        const tb = document.querySelector('[role="textbox"]');
        const el = pm || ta || ce || tb;
        if (el) info.composer = { tag: el.tagName, id: el.id, classes: el.className?.slice(0,150), contentEditable: el.contentEditable, placeholder: el.getAttribute('placeholder') || el.getAttribute('data-placeholder'), parent: el.parentElement?.className?.slice(0,150), grandparent: el.parentElement?.parentElement?.className?.slice(0,150) };
        // Find send button
        const allBtns = [...document.querySelectorAll('button')];
        for (const b of allBtns) {
          const aria = b.getAttribute('aria-label') || '';
          const text = b.textContent?.trim() || '';
          if (/send/i.test(aria) || /send/i.test(text) || b.type === 'submit') {
            info.sendBtn = { tag: 'button', classes: b.className?.slice(0,150), aria, text: text.slice(0,30), type: b.type, disabled: b.disabled, parent: b.parentElement?.className?.slice(0,150) };
            break;
          }
        }
        // Articles (Merlin message containers)
        const articles = document.querySelectorAll('article');
        articles.forEach((a, i) => {
          const firstChild = a.children[0];
          const secondChild = a.children[1];
          info.articles.push({
            index: i,
            classes: a.className?.slice(0,120),
            childCount: a.children.length,
            text: (a.textContent || '').trim().slice(0,120),
            firstChildTag: firstChild?.tagName,
            firstChildClasses: firstChild?.className?.slice(0,100),
            secondChildTag: secondChild?.tagName,
            secondChildClasses: secondChild?.className?.slice(0,100),
            hasMarkdown: !!a.querySelector('.markdown, .prose, [class*="markdown"], [class*="prose"]'),
            proseEl: a.querySelector('.prose, [class*="prose"]')?.className?.slice(0,100),
          });
        });
        // Sidebar links for new chat
        const links = document.querySelectorAll('a[href]');
        links.forEach(l => {
          const href = l.getAttribute('href') || '';
          const text = l.textContent?.trim() || '';
          if (/chat|new/i.test(href) || /new/i.test(text)) {
            info.sidebarLinks.push({ href, text: text.slice(0,40), classes: l.className?.slice(0,80) });
          }
        });
        // All buttons summary (first 20)
        allBtns.slice(0, 25).forEach(b => {
          info.allBtnSummary.push({ text: (b.textContent?.trim() || '').slice(0,30), aria: b.getAttribute('aria-label')?.slice(0,30), type: b.type, classes: b.className?.slice(0,60) });
        });
        // Stop/generating indicators
        const loadingEls = document.querySelectorAll('[class*="loading"], [class*="typing"], [class*="generating"], [class*="streaming"], [class*="animate-pulse"], [class*="animate-spin"]');
        if (loadingEls.length > 0) {
          info.stopBtn = { found: true, count: loadingEls.length, first: loadingEls[0].className?.slice(0,100) };
        }
        return info;
      })()
    `);
    console.log('[merlin-dom]', JSON.stringify(result, null, 2));
    return { ok: true, dom: result };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
ipcMain.handle("chatview-back", () => { if (chatView && !chatView.webContents.isDestroyed()) chatView.webContents.navigationHistory.goBack(); });
ipcMain.handle("chatview-forward", () => { if (chatView && !chatView.webContents.isDestroyed()) chatView.webContents.navigationHistory.goForward(); });
ipcMain.handle("chatview-refresh", () => { if (chatView && !chatView.webContents.isDestroyed()) chatView.webContents.reload(); });
ipcMain.handle("chatview-home", () => { if (chatView && !chatView.webContents.isDestroyed()) chatView.webContents.loadURL("https://chatgpt.com/"); });

// --- IPC: ChatGPT bridge ---
ipcMain.handle("bridge:status", () => bridge.getStatus());
ipcMain.handle("bridge:new-chat", () => bridge.newChat());
ipcMain.handle("bridge:send", (_, prompt, timeoutMs) => bridge.sendMessage(prompt, timeoutMs));
ipcMain.handle("bridge:messages", () => bridge.readMessages());

// --- IPC: Merlin bridge ---
ipcMain.handle("bridge:merlin:status", () => merlinBridge.getStatus());
ipcMain.handle("bridge:merlin:new-chat", () => merlinBridge.newChat());
ipcMain.handle("bridge:merlin:send", (_, prompt, timeoutMs) => merlinBridge.sendMessage(prompt, timeoutMs));
ipcMain.handle("bridge:merlin:messages", () => merlinBridge.readMessages());

// --- IPC: ChatGPT login ---

// Option 1: Full login window — stays open until you're fully logged in
ipcMain.handle("login-chatgpt", async () => {
  const loginWin = new BrowserWindow({
    width: 1000, height: 750,
    title: "Log in to ChatGPT — close this window when done",
    webPreferences: {
      partition: CHATGPT_PARTITION,
      contextIsolation: false,
      sandbox: false,
      webSecurity: true,
      allowRunningInsecureContent: false
    }
  });

  loginWin.webContents.setUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36");

  // Allow ALL popups — OAuth, Turnstile, verification, etc.
  loginWin.webContents.setWindowOpenHandler(({ url }) => {
    return {
      action: "allow",
      overrideBrowserWindowOptions: {
        width: 600, height: 700,
        webPreferences: { partition: CHATGPT_PARTITION, contextIsolation: false, sandbox: false }
      }
    };
  });

  // Handle permission requests (notifications, clipboard, etc.)
  loginWin.webContents.session.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(true);
  });

  // Log navigation for debugging
  loginWin.webContents.on("did-navigate", (e, url) => console.log("[login] Navigated:", url.slice(0, 100)));
  loginWin.webContents.on("did-navigate-in-page", (e, url) => console.log("[login] In-page nav:", url.slice(0, 100)));
  loginWin.webContents.on("did-fail-load", (e, code, desc, url) => {
    console.log("[login] Failed:", code, desc, url?.slice(0, 80));
    // If it failed on a redirect, try loading the URL directly
    if (code === -3 && url) {
      loginWin.webContents.loadURL(url);
    }
  });

  // Handle redirects that get stuck
  loginWin.webContents.on("will-redirect", (e, url) => {
    console.log("[login] Redirect:", url.slice(0, 100));
  });

  loginWin.loadURL("https://chatgpt.com/");

  return new Promise((resolve) => {
    loginWin.on("closed", () => {
      console.log("[app] Login window closed, reloading webview");
      if (chatView && !chatView.webContents.isDestroyed()) {
        chatView.webContents.loadURL("https://chatgpt.com/");
      }
      setTimeout(async () => {
        const status = await bridge.getStatus();
        resolve(status);
      }, 3000);
    });
  });
});

// --- IPC: Merlin login ---
ipcMain.handle("login-merlin", async () => {
  const loginWin = new BrowserWindow({
    width: 1000, height: 750,
    title: "Log in to Merlin — close this window when done",
    webPreferences: {
      partition: MERLIN_PARTITION,
      contextIsolation: false,
      sandbox: false,
      webSecurity: true,
      allowRunningInsecureContent: false
    }
  });
  loginWin.webContents.setUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36");
  loginWin.webContents.setWindowOpenHandler(({ url }) => {
    return {
      action: "allow",
      overrideBrowserWindowOptions: {
        width: 600, height: 700,
        webPreferences: { partition: MERLIN_PARTITION, contextIsolation: false, sandbox: false }
      }
    };
  });
  loginWin.webContents.session.setPermissionRequestHandler((webContents, permission, callback) => { callback(true); });
  loginWin.webContents.on("did-navigate", (e, url) => console.log("[merlin-login] Navigated:", url.slice(0, 100)));
  loginWin.webContents.on("did-fail-load", (e, code, desc, url) => {
    console.log("[merlin-login] Failed:", code, desc, url?.slice(0, 80));
    if (code === -3 && url) loginWin.webContents.loadURL(url);
  });
  loginWin.loadURL("https://www.getmerlin.in/chat");

  return new Promise((resolve) => {
    loginWin.on("closed", () => {
      console.log("[app] Merlin login window closed, reloading webview");
      if (merlinView && !merlinView.webContents.isDestroyed()) {
        merlinView.webContents.loadURL("https://www.getmerlin.in/chat");
      }
      setTimeout(async () => {
        const status = await merlinBridge.getStatus();
        resolve(status);
      }, 3000);
    });
  });
});

// Option 2: Import cookies from Chrome via the bridge extension
ipcMain.handle("import-chrome-cookies", async () => {
  try {
    const http = require("http");
    const BRIDGE_PORT = 3847;

    // Fetch cookies from the extension via bridge server
    const cookieData = await new Promise((resolve, reject) => {
      const req = http.get(`http://127.0.0.1:${BRIDGE_PORT}/cookies`, (res) => {
        let data = "";
        res.on("data", c => data += c);
        res.on("end", () => {
          try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
        });
      });
      req.on("error", reject);
      req.setTimeout(10000, () => { req.destroy(); reject(new Error("Bridge timeout")); });
    });

    if (!cookieData.ok || !cookieData.data?.cookies) {
      return { ok: false, error: "No cookies returned. Make sure the bridge server is running and the extension is loaded on chatgpt.com." };
    }

    const rawCookies = cookieData.data.cookies;
    if (!rawCookies.trim()) {
      return { ok: false, error: "Empty cookie string. You may not be logged in on the ChatGPT tab." };
    }

    // Parse cookie string and inject into Electron session
    const ses = session.fromPartition(CHATGPT_PARTITION);
    const pairs = rawCookies.split(";").map(s => s.trim()).filter(Boolean);
    let imported = 0;

    for (const pair of pairs) {
      const eqIdx = pair.indexOf("=");
      if (eqIdx < 1) continue;
      const name = pair.slice(0, eqIdx).trim();
      const value = pair.slice(eqIdx + 1).trim();
      try {
        await ses.cookies.set({
          url: "https://chatgpt.com",
          name,
          value,
          domain: ".chatgpt.com",
          path: "/",
          secure: true,
          httpOnly: false
        });
        imported++;
      } catch {}
    }

    // Also set for openai.com
    for (const pair of pairs) {
      const eqIdx = pair.indexOf("=");
      if (eqIdx < 1) continue;
      const name = pair.slice(0, eqIdx).trim();
      const value = pair.slice(eqIdx + 1).trim();
      try {
        await ses.cookies.set({
          url: "https://auth.openai.com",
          name,
          value,
          domain: ".openai.com",
          path: "/",
          secure: true,
          httpOnly: false
        });
      } catch {}
    }

    console.log(`[app] Imported ${imported} cookies from Chrome extension`);

    // Reload webview
    if (chatView && !chatView.webContents.isDestroyed()) {
      chatView.webContents.loadURL("https://chatgpt.com/");
    }

    await new Promise(r => setTimeout(r, 4000));
    const status = await bridge.getStatus();
    return {
      ok: status.ok,
      imported,
      message: status.ok ? `Imported ${imported} cookies. ChatGPT is ready!` : `Imported ${imported} cookies. Webview reloading...`
    };
  } catch (err) {
    return { ok: false, error: `Cookie import failed: ${err.message}. Make sure npm run bridge:server is running and the extension is loaded.` };
  }
});

// --- Bridge HTTP relay (API server child process calls this to reach the webview) ---
const BRIDGE_RELAY_PORT = 3851;
const relayHttp = require("http");
const relayServer = relayHttp.createServer(async (req, res) => {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  const url = new (require("url").URL)(req.url ?? "/", `http://127.0.0.1:${BRIDGE_RELAY_PORT}`);
  try {
    if (url.pathname === "/bridge/status") {
      const status = await bridge.getStatus();
      return relayJson(res, 200, status);
    }
    if (req.method === "POST" && url.pathname === "/bridge/new-chat") {
      const result = await bridge.newChat();
      return relayJson(res, 200, { ok: true, ...result });
    }
    if (req.method === "POST" && url.pathname === "/bridge/send") {
      const body = await relayReadBody(req);
      const response = await bridge.sendMessage(body.prompt, body.timeoutMs ?? 120000);
      return relayJson(res, 200, { ok: true, response });
    }
    if (url.pathname === "/bridge/messages") {
      const msgs = await bridge.readMessages();
      return relayJson(res, 200, { ok: true, messages: msgs });
    }
    // --- Merlin bridge relay ---
    if (url.pathname === "/bridge/merlin/status") {
      const status = await merlinBridge.getStatus();
      return relayJson(res, 200, status);
    }
    if (req.method === "POST" && url.pathname === "/bridge/merlin/new-chat") {
      const result = await merlinBridge.newChat();
      return relayJson(res, 200, { ok: true, ...result });
    }
    if (req.method === "POST" && url.pathname === "/bridge/merlin/send") {
      const body = await relayReadBody(req);
      const response = await merlinBridge.sendMessage(body.prompt, body.timeoutMs ?? 120000);
      return relayJson(res, 200, { ok: true, response });
    }
    if (url.pathname === "/bridge/merlin/messages") {
      const msgs = await merlinBridge.readMessages();
      return relayJson(res, 200, { ok: true, messages: msgs });
    }
    if (url.pathname === "/bridge/pool/status") {
      return relayJson(res, 200, { ok: true, ...sessionPool.getPoolStatus() });
    }
    if (req.method === "POST" && url.pathname === "/bridge/pool/send") {
      const body = await relayReadBody(req);
      const response = await sessionPool.sendMessage(body.role, body.prompt, body.timeoutMs ?? 120000);
      return relayJson(res, 200, { ok: true, response });
    }
    if (req.method === "POST" && url.pathname === "/bridge/pool/new-chat") {
      const body = await relayReadBody(req);
      await sessionPool.newChat(body.role);
      return relayJson(res, 200, { ok: true });
    }
    relayJson(res, 404, { ok: false, error: "Not found" });
  } catch (err) {
    relayJson(res, 500, { ok: false, error: err.message ?? String(err) });
  }
});

function relayJson(res, status, data) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(data));
}
function relayReadBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", c => body += c);
    req.on("end", () => { try { resolve(body ? JSON.parse(body) : {}); } catch(e) { reject(e); } });
    req.on("error", reject);
  });
}

// --- App lifecycle ---
app.whenReady().then(() => {
  require("events").EventEmitter.defaultMaxListeners = 30;
  buildMenu();
  createWindow();
  relayServer.listen(BRIDGE_RELAY_PORT, "127.0.0.1", () => {
    console.log(`[app] Bridge relay at http://127.0.0.1:${BRIDGE_RELAY_PORT}`);
  });
  app.on("activate", () => { if (!mainWindow) createWindow(); });
});

app.on("window-all-closed", () => {
  if (apiProcess) { try { apiProcess.kill(); } catch {} apiProcess = null; }
  try { relayServer.close(); } catch {}
  sessionPool.destroyPool();
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  if (apiProcess) { try { apiProcess.kill(); } catch {} apiProcess = null; }
  try { relayServer.close(); } catch {}
});
