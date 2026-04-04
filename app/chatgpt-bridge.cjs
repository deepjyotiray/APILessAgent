// In-process bridge: controls the ChatGPT webview embedded in the Electron app.
// No HTTP server, no WebSocket, no extension — just direct JS execution in the webview.

let chatView = null;
let ready = false;

function setBrowserView(view) {
  chatView = view;
  ready = false;
}

function isReady() {
  return ready && chatView && !chatView.webContents.isDestroyed();
}

async function waitUntilReady(timeoutMs = 30000) {
  if (isReady()) return;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (chatView && !chatView.webContents.isDestroyed()) {
      try {
        const hasComposer = await chatView.webContents.executeJavaScript(`
          !!(document.querySelector('#prompt-textarea') ||
             document.querySelector('textarea[placeholder]') ||
             document.querySelector('[contenteditable="true"][role="textbox"]'))
        `);
        if (hasComposer) { ready = true; return; }
      } catch {}
    }
    await sleep(500);
  }
  throw new Error("ChatGPT webview did not become ready in time.");
}

async function getStatus() {
  if (!chatView || chatView.webContents.isDestroyed()) {
    return { ok: false, message: "ChatGPT webview not loaded." };
  }
  try {
    await waitUntilReady(5000);
    return { ok: true, message: "ChatGPT webview is ready.", url: chatView.webContents.getURL() };
  } catch {
    return { ok: false, message: "ChatGPT webview not ready. Please log in." };
  }
}

async function newChat() {
  await waitUntilReady();
  await chatView.webContents.executeJavaScript(`
    (async () => {
      const link = document.querySelector('a[href="/"], a[href="https://chatgpt.com/"]');
      if (link) { link.click(); } else { location.href = "https://chatgpt.com/"; }
      // Wait for composer
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        if (document.querySelector('#prompt-textarea') ||
            document.querySelector('[contenteditable="true"][role="textbox"]')) return;
        await new Promise(r => setTimeout(r, 300));
      }
    })()
  `);
  await sleep(1000);
  return { ok: true, url: chatView.webContents.getURL() };
}

async function sendMessage(prompt, timeoutMs = 120000) {
  await waitUntilReady();

  // Type and send
  await chatView.webContents.executeJavaScript(`
    (async () => {
      const prompt = ${JSON.stringify(prompt)};
      const selectors = [
        '#prompt-textarea',
        'textarea[placeholder]',
        '[contenteditable="true"][role="textbox"]'
      ];
      let composer = null;
      for (const s of selectors) { composer = document.querySelector(s); if (composer) break; }
      if (!composer) throw new Error("Composer not found");

      composer.focus();
      if (composer instanceof HTMLTextAreaElement) {
        composer.value = prompt;
        composer.dispatchEvent(new Event("input", { bubbles: true }));
      } else {
        composer.textContent = prompt;
        composer.dispatchEvent(new Event("input", { bubbles: true }));
      }
      await new Promise(r => setTimeout(r, 150));

      const sendBtn = document.querySelector('button[data-testid="send-button"]');
      if (sendBtn) { sendBtn.click(); }
      else {
        composer.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));
      }
    })()
  `);

  // Wait for response
  const response = await chatView.webContents.executeJavaScript(`
    (async () => {
      const timeoutMs = ${timeoutMs};
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const stopBtn = document.querySelector('button[data-testid="stop-button"]');
        if (stopBtn) { await new Promise(r => setTimeout(r, 500)); continue; }
        await new Promise(r => setTimeout(r, 2000));
        const still = document.querySelector('button[data-testid="stop-button"]');
        if (!still) {
          const msgs = Array.from(document.querySelectorAll('[data-message-author-role]'));
          const last = [...msgs].reverse().find(n => n.getAttribute('data-message-author-role') === 'assistant');
          if (last) return (last.textContent || '').trim();
        }
      }
      throw new Error("Timed out waiting for ChatGPT response.");
    })()
  `);

  return response;
}

async function readMessages() {
  await waitUntilReady();
  return chatView.webContents.executeJavaScript(`
    Array.from(document.querySelectorAll('[data-message-author-role]')).map(n => ({
      role: n.getAttribute('data-message-author-role') || 'unknown',
      text: (n.textContent || '').trim()
    }))
  `);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

module.exports = { setBrowserView, isReady, waitUntilReady, getStatus, newChat, sendMessage, readMessages };
