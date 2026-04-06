// In-process bridge: controls the Merlin chat webview embedded in the Electron app.
// Selectors derived from live DOM inspection of getmerlin.in/chat
//
// DOM structure:
//   Composer:  div.tiptap.ProseMirror[contenteditable] inside .merlin-scrollbar
//   Send btn:  button[type="submit"] inside the composer's ancestor
//   User msg:  article.ml-auto  → .prose.prose-zinc
//   Bot msg:   article (no ml-auto) → child[0] = model header, child[1] = .grid > .prose.prose-neutral
//   New chat:  a[href="/chat"] (text "New")

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
          !!document.querySelector('.ProseMirror')
        `);
        if (hasComposer) { ready = true; return; }
      } catch {}
    }
    await sleep(500);
  }
  throw new Error("Merlin webview did not become ready in time.");
}

async function getStatus() {
  if (!chatView || chatView.webContents.isDestroyed()) {
    return { ok: false, message: "Merlin webview not loaded." };
  }
  try {
    await waitUntilReady(5000);
    return { ok: true, message: "Merlin webview is ready.", url: chatView.webContents.getURL() };
  } catch {
    return { ok: false, message: "Merlin webview not ready. Please log in." };
  }
}

async function newChat() {
  await waitUntilReady();
  await chatView.webContents.executeJavaScript(`
    (async () => {
      // Merlin sidebar has a[href="/chat"] with text "New"
      const link = document.querySelector('a[href="/chat"]');
      if (link) {
        link.click();
      } else {
        location.href = "https://www.getmerlin.in/chat";
      }
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        if (document.querySelector('.ProseMirror')) return;
        await new Promise(r => setTimeout(r, 300));
      }
    })()
  `);
  await sleep(1500);
  return { ok: true, url: chatView.webContents.getURL() };
}

// Count only assistant articles (those without ml-auto)
const COUNT_ASSISTANT_JS = `
  (function() {
    const articles = document.querySelectorAll('article');
    let count = 0;
    articles.forEach(a => { if (!a.className.includes('ml-auto')) count++; });
    return count;
  })()
`;

// Max chars per message part to avoid ProseMirror truncation
const PART_CHAR_LIMIT = 30000;

function splitPromptIntoParts(prompt) {
  if (prompt.length <= PART_CHAR_LIMIT) return [prompt];

  // Try to find the user's actual question — it's typically after the last
  // section marker or at the very end of the prompt.
  // Common markers: "QUESTION:", "USER QUESTION:", "Based on", or just the last paragraph.
  const questionMarkers = [
    /\n(USER QUESTION:.*)/s,
    /\n(QUESTION:.*)/s,
    /\n(Based on your exploration above,.*)/s,
    /\n(Now give .*)/s,
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

  // If no marker found, treat the last 2000 chars as the question tail
  if (!questionPart && prompt.length > PART_CHAR_LIMIT) {
    const cutPoint = prompt.lastIndexOf('\n\n', prompt.length - 2000);
    if (cutPoint > PART_CHAR_LIMIT / 2) {
      contextPart = prompt.slice(0, cutPoint).trim();
      questionPart = prompt.slice(cutPoint).trim();
    }
  }

  // Split the context part at double-newline boundaries
  const parts = [];
  let remaining = contextPart;
  while (remaining.length > PART_CHAR_LIMIT) {
    // Find the last double-newline within the limit
    let splitAt = remaining.lastIndexOf('\n\n', PART_CHAR_LIMIT);
    if (splitAt < PART_CHAR_LIMIT / 2) splitAt = PART_CHAR_LIMIT; // fallback: hard cut
    parts.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }

  // Append remaining context + question into the final part
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
      const composer = document.querySelector('.ProseMirror');
      if (!composer) throw new Error("Merlin composer not found");

      composer.focus();

      // Clear existing content via select-all + delete so ProseMirror state stays in sync
      document.execCommand('selectAll', false, null);
      document.execCommand('delete', false, null);
      await new Promise(r => setTimeout(r, 100));

      // Use insertText which ProseMirror intercepts and processes through its transaction system
      // This is the only reliable way to update ProseMirror's internal doc state
      document.execCommand('insertText', false, text);
      await new Promise(r => setTimeout(r, 300));

      // Verify ProseMirror picked it up — if not, fall back to clipboard paste
      const currentText = composer.textContent || '';
      if (currentText.trim().length < Math.min(text.length * 0.5, 20)) {
        // insertText failed — try clipboard paste
        composer.focus();
        document.execCommand('selectAll', false, null);
        document.execCommand('delete', false, null);
        await new Promise(r => setTimeout(r, 100));

        const dt = new DataTransfer();
        dt.setData('text/plain', text);
        composer.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
        await new Promise(r => setTimeout(r, 300));
      }

      // Try to find and click the send button
      const composerArea = composer.closest('.merlin-scrollbar')?.parentElement?.parentElement;
      let sendBtn = composerArea?.querySelector('button[type="submit"]');
      if (!sendBtn) sendBtn = document.querySelector('button[type="submit"]');

      if (sendBtn && !sendBtn.disabled) {
        sendBtn.click();
      } else {
        // Wait for button to enable (ProseMirror may need a tick)
        await new Promise(r => setTimeout(r, 500));
        sendBtn = composerArea?.querySelector('button[type="submit"]') || document.querySelector('button[type="submit"]');
        if (sendBtn && !sendBtn.disabled) {
          sendBtn.click();
        } else {
          // Last resort: Enter key
          composer.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
            bubbles: true, cancelable: true
          }));
        }
      }
    })()
  `);
}

async function waitForAssistantIdle(countBefore, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  let stableCount = 0;
  let lastCount = countBefore;
  // Wait for a new assistant message to appear and stop generating
  while (Date.now() < deadline) {
    const count = await chatView.webContents.executeJavaScript(COUNT_ASSISTANT_JS);
    if (count > countBefore) {
      const generating = await chatView.webContents.executeJavaScript(`
        !!(document.querySelector('[class*="animate-pulse"]') ||
           document.querySelector('[class*="animate-spin"]') ||
           document.querySelector('[class*="streaming"]') ||
           document.querySelector('button[aria-label="Stop"]') ||
           document.querySelector('button[aria-label="stop"]'))
      `);
      if (!generating) {
        stableCount++;
        if (stableCount >= 3) return;
      } else {
        stableCount = 0;
      }
    }
    await sleep(500);
  }
}

// Count user articles (those with ml-auto)
const COUNT_USER_JS = `
  (function() {
    const articles = document.querySelectorAll('article');
    let count = 0;
    articles.forEach(a => { if (a.className.includes('ml-auto')) count++; });
    return count;
  })()
`;

async function sendAndVerify(text, retries = 2) {
  const userCountBefore = await chatView.webContents.executeJavaScript(COUNT_USER_JS);
  await typeAndSend(text);
  // Verify the user message actually appeared in the DOM
  const verifyDeadline = Date.now() + 5000;
  while (Date.now() < verifyDeadline) {
    const userCountAfter = await chatView.webContents.executeJavaScript(COUNT_USER_JS);
    if (userCountAfter > userCountBefore) return; // message was sent
    await sleep(500);
  }
  // Message didn't appear — retry
  if (retries > 0) {
    console.log(`[merlin-bridge] Message not sent, retrying (${retries} left)`);
    await sleep(500);
    return sendAndVerify(text, retries - 1);
  }
  console.log('[merlin-bridge] WARNING: Could not verify message was sent after retries');
}

async function sendMessage(prompt, timeoutMs = 120000) {
  await waitUntilReady();

  const parts = splitPromptIntoParts(prompt);
  let msgCountBefore;

  if (parts.length > 1) {
    // Send context parts first, wait for each to be acknowledged
    for (let i = 0; i < parts.length - 1; i++) {
      const countBefore = await chatView.webContents.executeJavaScript(COUNT_ASSISTANT_JS);
      const header = `[PROMPT PART ${i + 1}/${parts.length} — do NOT answer yet, just confirm receipt]\n\n`;
      await sendAndVerify(header + parts[i]);
      await waitForAssistantIdle(countBefore, 60000);
      await sleep(500);
    }
    // Send the final part with instruction to answer
    msgCountBefore = await chatView.webContents.executeJavaScript(COUNT_ASSISTANT_JS);
    const header = `[PROMPT PART ${parts.length}/${parts.length} — this is the FINAL part. Now process ALL parts together and respond.]\n\n`;
    await sendAndVerify(header + parts[parts.length - 1]);
  } else {
    msgCountBefore = await chatView.webContents.executeJavaScript(COUNT_ASSISTANT_JS);
    await sendAndVerify(prompt);
  }

  // Step 3: Wait for new assistant article and extract clean prose text
  const response = await chatView.webContents.executeJavaScript(`
    (async () => {
      const countBefore = ${msgCountBefore};
      const deadline = Date.now() + ${timeoutMs};

      function countAssistant() {
        let count = 0;
        document.querySelectorAll('article').forEach(a => {
          if (!a.className.includes('ml-auto')) count++;
        });
        return count;
      }

      function htmlToMarkdown(el) {
        const BT = String.fromCharCode(96);
        const FENCE = BT + BT + BT;
        let md = '';
        function walk(node) {
          if (node.nodeType === 3) { md += node.textContent; return; }
          if (node.nodeType !== 1) return;
          const tag = node.tagName.toLowerCase();
          if (tag === 'style' || tag === 'script') return;
          if (tag === 'br') { md += '\\n'; return; }
          if (tag === 'p') { md += '\\n\\n'; node.childNodes.forEach(walk); return; }
          if (tag === 'strong' || tag === 'b') { md += '**'; node.childNodes.forEach(walk); md += '**'; return; }
          if (tag === 'em' || tag === 'i') { md += '*'; node.childNodes.forEach(walk); md += '*'; return; }
          if (tag === 'code' && node.parentElement?.tagName !== 'PRE') { md += BT; node.childNodes.forEach(walk); md += BT; return; }
          if (tag === 'pre') {
            const codeEl = node.querySelector('code');
            const lang = codeEl?.className?.match(/language-(\\w+)/)?.[1] || '';
            md += '\\n' + FENCE + lang + '\\n' + (codeEl || node).textContent + FENCE + '\\n';
            return;
          }
          if (tag === 'h1') { md += '\\n# '; node.childNodes.forEach(walk); md += '\\n'; return; }
          if (tag === 'h2') { md += '\\n## '; node.childNodes.forEach(walk); md += '\\n'; return; }
          if (tag === 'h3') { md += '\\n### '; node.childNodes.forEach(walk); md += '\\n'; return; }
          if (tag === 'h4') { md += '\\n#### '; node.childNodes.forEach(walk); md += '\\n'; return; }
          if (tag === 'li') {
            const parent = node.parentElement?.tagName?.toLowerCase();
            if (parent === 'ol') {
              const idx = [...node.parentElement.children].indexOf(node) + 1;
              md += idx + '. ';
            } else {
              md += '- ';
            }
            node.childNodes.forEach(walk);
            md += '\\n';
            return;
          }
          if (tag === 'ul' || tag === 'ol') { md += '\\n'; node.childNodes.forEach(walk); md += '\\n'; return; }
          if (tag === 'table') {
            const rows = node.querySelectorAll('tr');
            rows.forEach((row, ri) => {
              const cells = row.querySelectorAll('th, td');
              md += '| ' + [...cells].map(c => c.textContent.trim()).join(' | ') + ' |\\n';
              if (ri === 0) md += '| ' + [...cells].map(() => '---').join(' | ') + ' |\\n';
            });
            md += '\\n';
            return;
          }
          if (tag === 'a') { md += '['; node.childNodes.forEach(walk); md += '](' + (node.href || '') + ')'; return; }
          if (tag === 'hr') { md += '\\n---\\n'; return; }
          node.childNodes.forEach(walk);
        }
        walk(el);
        return md.replace(/\\n{3,}/g, '\\n\\n').trim();
      }

      function getLastAssistantText() {
        const articles = [...document.querySelectorAll('article')].filter(
          a => !a.className.includes('ml-auto')
        );
        if (articles.length <= countBefore) return null;
        const last = articles[articles.length - 1];

        // Merlin articles: child[0]=model header, child[1]=grid with thought accordion + answer
        // There may be multiple .prose elements: one inside the Thought accordion, one for the answer.
        // The thought accordion trigger has class 'group/chat-accordion-trigger'.
        const allProse = [...last.querySelectorAll('.prose')];

        // Separate thought prose from answer prose
        let thoughtText = '';
        let answerText = '';

        for (const prose of allProse) {
          // Check if this prose is inside a thought/accordion section
          const inAccordion = prose.closest('[data-state]') ||
            prose.closest('[class*="accordion"]') ||
            (prose.parentElement?.previousElementSibling?.querySelector('[class*="accordion-trigger"]'));
          if (inAccordion) {
            thoughtText = htmlToMarkdown(prose);
          } else {
            answerText = htmlToMarkdown(prose);
          }
        }

        // If we only found thought prose and no separate answer, the answer may still be streaming
        // or the thought IS the only content — return what we have
        let result = '';
        if (thoughtText) {
          result += '<details><summary>Thought</summary>\\n' + thoughtText + '\\n</details>\\n\\n';
        }
        if (answerText) {
          result += answerText;
        } else if (!thoughtText && allProse.length) {
          // Fallback: just use the last prose element
          result = htmlToMarkdown(allProse[allProse.length - 1]);
        }

        if (result.trim()) return result.trim();

        const children = [...last.children];
        if (children.length >= 2) return children.slice(1).map(c => c.textContent?.trim()).join('\\n').trim() || null;
        return last.textContent?.trim() || null;
      }

      function isGenerating() {
        if (document.querySelector('[class*="animate-pulse"]')) return true;
        if (document.querySelector('[class*="animate-spin"]')) return true;
        if (document.querySelector('[class*="streaming"]')) return true;
        // Merlin shows a stop button while generating
        if (document.querySelector('button[aria-label="Stop"]')) return true;
        if (document.querySelector('button[aria-label="stop"]')) return true;
        return false;
      }

      // Wait for generation to start
      const startDeadline = Date.now() + 30000;
      while (Date.now() < startDeadline) {
        if (isGenerating() || countAssistant() > countBefore) break;
        await new Promise(r => setTimeout(r, 300));
      }

      // Wait for generation to finish with text stability check
      let lastText = '';
      let stableCount = 0;
      while (Date.now() < deadline) {
        if (isGenerating()) {
          stableCount = 0;
          await new Promise(r => setTimeout(r, 500));
          continue;
        }

        const text = getLastAssistantText();
        if (text && text.length > 0) {
          if (text === lastText) {
            stableCount++;
            // If we only have a thought (no answer after it), wait longer
            // because the model may still be about to produce the answer
            const hasAnswer = !text.endsWith('</details>') && text.includes('</details>');
            const threshold = hasAnswer ? 3 : 8;
            if (stableCount >= threshold) return text;
          } else {
            lastText = text;
            stableCount = 0;
          }
        }
        await new Promise(r => setTimeout(r, 500));
      }

      // Final grab
      const text = getLastAssistantText();
      if (text) return text;
      throw new Error("Timed out waiting for Merlin response.");
    })()
  `);

  return response;
}

async function readMessages() {
  await waitUntilReady();
  return chatView.webContents.executeJavaScript(`
    (function() {
      const messages = [];
      document.querySelectorAll('article').forEach(article => {
        const isUser = article.className.includes('ml-auto');
        let text;
        if (!isUser) {
          // For assistant messages, get all prose elements and skip thought accordion
          const allProse = [...article.querySelectorAll('.prose')];
          const parts = [];
          for (const prose of allProse) {
            const inAccordion = prose.closest('[data-state]') || prose.closest('[class*="accordion"]');
            if (!inAccordion) {
              parts.push(prose.innerText?.trim() || '');
            }
          }
          text = parts.filter(Boolean).join('\n').trim();
          if (!text && allProse.length) text = allProse[allProse.length - 1].innerText?.trim() || '';
        } else {
          const proseEl = article.querySelector('.prose');
          text = proseEl ? proseEl.innerText?.trim() || '' : article.innerText?.trim() || '';
        }
        if (text.length > 0) {
          messages.push({ role: isUser ? 'user' : 'assistant', text });
        }
      });
      return messages;
    })()
  `);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

module.exports = { setBrowserView, isReady, waitUntilReady, getStatus, newChat, sendMessage, readMessages };
