// Session pool: manages multiple ChatGPT webview sessions for parallel sub-agent work.
// Pre-warms sessions on startup. Sub-agents grab sessions from the pool.

const { BrowserView, session } = require("electron");

const CHATGPT_PARTITION = "persist:chatgpt";
const POOL_SIZE = 3;

let pool = [];       // Available sessions: [{view, ready, id}]
let inUse = new Map(); // role → {view, id}
let poolId = 0;

function createPooledView() {
  const ses = session.fromPartition(CHATGPT_PARTITION);
  ses.setUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36");

  const view = new BrowserView({
    webPreferences: {
      partition: CHATGPT_PARTITION,
      contextIsolation: false,
      nodeIntegration: false,
      sandbox: false,
      offscreen: true  // Don't need to display these
    }
  });

  const id = `pool-${++poolId}`;
  view.webContents.loadURL("https://chatgpt.com/");

  view.webContents.setWindowOpenHandler(({ url }) => {
    return {
      action: "allow",
      overrideBrowserWindowOptions: {
        width: 600, height: 700,
        webPreferences: { partition: CHATGPT_PARTITION, contextIsolation: false, sandbox: false }
      }
    };
  });

  console.log(`[pool] Created session ${id}`);
  return { view, ready: false, id };
}

async function waitForReady(entry, timeoutMs = 30000) {
  if (entry.ready) return true;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const hasComposer = await entry.view.webContents.executeJavaScript(`
        !!(document.querySelector('#prompt-textarea') ||
           document.querySelector('[contenteditable="true"][role="textbox"]'))
      `);
      if (hasComposer) { entry.ready = true; return true; }
    } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

// --- Public API ---

async function initPool() {
  console.log(`[pool] Initializing ${POOL_SIZE} sessions...`);
  for (let i = 0; i < POOL_SIZE; i++) {
    pool.push(createPooledView());
  }
  // Don't wait for all to be ready — they'll warm up in background
}

async function acquireSession(role) {
  // Check if this role already has a session
  if (inUse.has(role)) {
    const entry = inUse.get(role);
    if (!entry.view.webContents.isDestroyed()) {
      const ready = await waitForReady(entry, 10000);
      if (ready) {
        console.log(`[pool] Reusing session ${entry.id} for ${role}`);
        return entry;
      }
    }
    // Session is dead — remove it
    inUse.delete(role);
  }

  // Grab from pool
  while (pool.length > 0) {
    const entry = pool.shift();
    if (entry.view.webContents.isDestroyed()) continue;
    const ready = await waitForReady(entry, 15000);
    if (ready) {
      inUse.set(role, entry);
      console.log(`[pool] Assigned session ${entry.id} to ${role}`);
      // Replenish pool
      pool.push(createPooledView());
      return entry;
    }
  }

  // Pool empty — create a new one
  const entry = createPooledView();
  const ready = await waitForReady(entry, 20000);
  if (ready) {
    inUse.set(role, entry);
    console.log(`[pool] Created new session ${entry.id} for ${role}`);
    return entry;
  }

  throw new Error(`Could not acquire ChatGPT session for role: ${role}`);
}

async function releaseSession(role) {
  const entry = inUse.get(role);
  if (entry) {
    // Open a new chat so it's fresh for next use
    try {
      await entry.view.webContents.executeJavaScript(`
        (async () => {
          const link = document.querySelector('a[href="/"], a[href="https://chatgpt.com/"]');
          if (link) link.click();
          await new Promise(r => setTimeout(r, 1000));
        })()
      `);
    } catch {}
    pool.push(entry);
    inUse.delete(role);
    console.log(`[pool] Released session ${entry.id} from ${role}`);
  }
}

async function sendMessage(role, prompt, timeoutMs = 120000) {
  const entry = await acquireSession(role);
  const view = entry.view;

  // Count messages before
  const countBefore = await view.webContents.executeJavaScript(`
    document.querySelectorAll('[data-message-author-role="assistant"]').length
  `);

  // Type and send
  await view.webContents.executeJavaScript(`
    (async () => {
      const prompt = ${JSON.stringify(prompt)};
      const selectors = ['#prompt-textarea', 'textarea[placeholder]', '[contenteditable="true"][role="textbox"]'];
      let composer = null;
      for (const s of selectors) { composer = document.querySelector(s); if (composer) break; }
      if (!composer) throw new Error("Composer not found");
      composer.focus();
      if (composer instanceof HTMLTextAreaElement) {
        composer.value = prompt;
        composer.dispatchEvent(new Event("input", { bubbles: true }));
        composer.dispatchEvent(new Event("change", { bubbles: true }));
      } else {
        composer.textContent = prompt;
        composer.dispatchEvent(new Event("input", { bubbles: true }));
      }
      await new Promise(r => setTimeout(r, 200));
      const sendBtn = document.querySelector('button[data-testid="send-button"]');
      if (sendBtn && !sendBtn.disabled) sendBtn.click();
      else composer.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true }));
    })()
  `);

  // Wait for new response
  const response = await view.webContents.executeJavaScript(`
    (async () => {
      const countBefore = ${countBefore};
      const deadline = Date.now() + ${timeoutMs};
      const startDeadline = Date.now() + 30000;
      while (Date.now() < startDeadline) {
        const stopBtn = document.querySelector('button[data-testid="stop-button"]');
        const currentCount = document.querySelectorAll('[data-message-author-role="assistant"]').length;
        if (stopBtn || currentCount > countBefore) break;
        await new Promise(r => setTimeout(r, 300));
      }
      while (Date.now() < deadline) {
        const stopBtn = document.querySelector('button[data-testid="stop-button"]');
        if (stopBtn) { await new Promise(r => setTimeout(r, 500)); continue; }
        await new Promise(r => setTimeout(r, 1500));
        const still = document.querySelector('button[data-testid="stop-button"]');
        if (!still) {
          const msgs = document.querySelectorAll('[data-message-author-role="assistant"]');
          if (msgs.length > countBefore) return (msgs[msgs.length - 1].textContent || '').trim();
        }
      }
      throw new Error("Timed out");
    })()
  `);

  return response;
}

async function newChat(role) {
  const entry = await acquireSession(role);
  await entry.view.webContents.executeJavaScript(`
    (async () => {
      const link = document.querySelector('a[href="/"], a[href="https://chatgpt.com/"]');
      if (link) link.click(); else location.href = "https://chatgpt.com/";
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        if (document.querySelector('#prompt-textarea') || document.querySelector('[contenteditable="true"][role="textbox"]')) return;
        await new Promise(r => setTimeout(r, 300));
      }
    })()
  `);
  await new Promise(r => setTimeout(r, 1000));
}

function getPoolStatus() {
  return {
    available: pool.filter(e => !e.view.webContents.isDestroyed()).length,
    inUse: [...inUse.entries()].map(([role, entry]) => ({ role, id: entry.id })),
    total: pool.length + inUse.size
  };
}

function destroyPool() {
  for (const entry of pool) {
    try { entry.view.webContents.destroy(); } catch {}
  }
  for (const [, entry] of inUse) {
    try { entry.view.webContents.destroy(); } catch {}
  }
  pool = [];
  inUse.clear();
}

module.exports = { initPool, acquireSession, releaseSession, sendMessage, newChat, getPoolStatus, destroyPool };
