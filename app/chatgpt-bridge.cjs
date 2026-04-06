// In-process bridge: controls the ChatGPT webview embedded in the Electron app.

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
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        if (document.querySelector('#prompt-textarea') ||
            document.querySelector('[contenteditable="true"][role="textbox"]')) return;
        await new Promise(r => setTimeout(r, 300));
      }
    })()
  `);
  await sleep(1500);
  return { ok: true, url: chatView.webContents.getURL() };
}

// Max chars per message part — ChatGPT's composer can handle ~60k reliably
const PART_CHAR_LIMIT = 50000;

function splitPromptIntoParts(prompt) {
  if (prompt.length <= PART_CHAR_LIMIT) return [prompt];
  const questionMarkers = [
    /\n(QUESTION:.*)/s,
    /\n(Based on your exploration above,.*)/s,
    /\n(CRITICAL: Respond with.*)/s,
  ];
  let questionPart = '';
  let contextPart = prompt;
  for (const re of questionMarkers) {
    const m = prompt.match(re);
    if (m && m.index != null) {
      contextPart = prompt.slice(0, m.index).trim();
      questionPart = m[1].trim();
      break;
    }
  }
  if (!questionPart && prompt.length > PART_CHAR_LIMIT) {
    const cutPoint = prompt.lastIndexOf('\n\n', prompt.length - 2000);
    if (cutPoint > PART_CHAR_LIMIT / 2) {
      contextPart = prompt.slice(0, cutPoint).trim();
      questionPart = prompt.slice(cutPoint).trim();
    }
  }
  const parts = [];
  let remaining = contextPart;
  while (remaining.length > PART_CHAR_LIMIT) {
    let splitAt = remaining.lastIndexOf('\n\n', PART_CHAR_LIMIT);
    if (splitAt < PART_CHAR_LIMIT / 2) splitAt = PART_CHAR_LIMIT;
    parts.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }
  if (questionPart) {
    parts.push((remaining + '\n\n' + questionPart).trim());
  } else {
    parts.push(remaining.trim());
  }
  return parts.filter(p => p.length > 0);
}

async function typeAndSend(text) {
  await chatView.webContents.executeJavaScript(`
    (async () => {
      const text = ${JSON.stringify(text)};
      const selectors = [
        '#prompt-textarea',
        '[contenteditable="true"][role="textbox"]',
        'textarea[placeholder]'
      ];
      let composer = null;
      for (const s of selectors) { composer = document.querySelector(s); if (composer) break; }
      if (!composer) throw new Error("Composer not found");

      composer.focus();

      if (composer instanceof HTMLTextAreaElement) {
        // Native textarea — set value + dispatch events
        const nativeSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
        nativeSetter.call(composer, text);
        composer.dispatchEvent(new Event('input', { bubbles: true }));
        composer.dispatchEvent(new Event('change', { bubbles: true }));
      } else {
        // Contenteditable (ProseMirror/React) — use execCommand for proper state sync
        document.execCommand('selectAll', false, null);
        document.execCommand('delete', false, null);
        await new Promise(r => setTimeout(r, 100));

        document.execCommand('insertText', false, text);
        await new Promise(r => setTimeout(r, 300));

        // Verify content was inserted — fall back to clipboard paste if not
        const currentText = composer.textContent || '';
        if (currentText.trim().length < Math.min(text.length * 0.5, 20)) {
          composer.focus();
          document.execCommand('selectAll', false, null);
          document.execCommand('delete', false, null);
          await new Promise(r => setTimeout(r, 100));

          const dt = new DataTransfer();
          dt.setData('text/plain', text);
          composer.dispatchEvent(new ClipboardEvent('paste', {
            clipboardData: dt, bubbles: true, cancelable: true
          }));
          await new Promise(r => setTimeout(r, 300));
        }
      }

      await new Promise(r => setTimeout(r, 200));

      const sendBtn = document.querySelector('button[data-testid="send-button"]');
      if (sendBtn && !sendBtn.disabled) {
        sendBtn.click();
      } else {
        // Wait a tick for React to enable the button
        await new Promise(r => setTimeout(r, 500));
        const retryBtn = document.querySelector('button[data-testid="send-button"]');
        if (retryBtn && !retryBtn.disabled) {
          retryBtn.click();
        } else {
          composer.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Enter', code: 'Enter', bubbles: true, cancelable: true
          }));
        }
      }
    })()
  `);
}

async function waitForResponse(countBefore, timeoutMs) {
  return chatView.webContents.executeJavaScript(`
    (async () => {
      const countBefore = ${countBefore};
      const deadline = Date.now() + ${timeoutMs};

      // Wait for generation to start
      const startDeadline = Date.now() + 30000;
      while (Date.now() < startDeadline) {
        const stopBtn = document.querySelector('button[data-testid="stop-button"]');
        const currentCount = document.querySelectorAll('[data-message-author-role="assistant"]').length;
        if (stopBtn || currentCount > countBefore) break;
        await new Promise(r => setTimeout(r, 300));
      }

      // Wait for generation to finish
      while (Date.now() < deadline) {
        const stopBtn = document.querySelector('button[data-testid="stop-button"]');
        if (stopBtn) { await new Promise(r => setTimeout(r, 500)); continue; }
        await new Promise(r => setTimeout(r, 1500));
        const stillGenerating = document.querySelector('button[data-testid="stop-button"]');
        if (!stillGenerating) {
          const assistantMsgs = document.querySelectorAll('[data-message-author-role="assistant"]');
          if (assistantMsgs.length > countBefore) {
            const lastMsg = assistantMsgs[assistantMsgs.length - 1];
            // Extract text preserving code blocks — innerText loses backticks
            // that ChatGPT renders as <pre><code>. Reconstruct them.
            const parts = [];
            for (const node of lastMsg.querySelectorAll('p, pre, li, h1, h2, h3, h4, div.text-base > div')) {
              if (node.tagName === 'PRE') {
                const codeEl = node.querySelector('code');
                const lang = codeEl?.className?.match(/language-(\\w+)/)?.[1] || '';
                const BT = String.fromCharCode(96);
                parts.push(BT+BT+BT + lang + '\\n' + (codeEl || node).textContent + BT+BT+BT);
              } else {
                const text = node.textContent?.trim();
                if (text) parts.push(text);
              }
            }
            // If structured extraction got content, use it; otherwise fall back to textContent
            const extracted = parts.join('\\n').trim();
            return extracted || (lastMsg.textContent || '').trim();
          }
        }
      }
      throw new Error("Timed out waiting for ChatGPT response.");
    })()
  `);
}

async function sendMessage(prompt, timeoutMs = 120000) {
  await waitUntilReady();

  const parts = splitPromptIntoParts(prompt);

  if (parts.length > 1) {
    // Send context parts first, wait for acknowledgement
    for (let i = 0; i < parts.length - 1; i++) {
      const countBefore = await chatView.webContents.executeJavaScript(
        `document.querySelectorAll('[data-message-author-role="assistant"]').length`
      );
      const header = `[CONTEXT PART ${i + 1}/${parts.length} — do NOT answer yet, just say OK]\n\n`;
      await typeAndSend(header + parts[i]);
      await waitForResponse(countBefore, 60000);
      await sleep(500);
    }
  }

  // Send the final (or only) part
  const msgCountBefore = await chatView.webContents.executeJavaScript(
    `document.querySelectorAll('[data-message-author-role="assistant"]').length`
  );
  const lastPart = parts.length > 1
    ? `[CONTEXT PART ${parts.length}/${parts.length} — FINAL part. Now process ALL parts and respond.]\n\n` + parts[parts.length - 1]
    : prompt;
  await typeAndSend(lastPart);
  return waitForResponse(msgCountBefore, timeoutMs);
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
