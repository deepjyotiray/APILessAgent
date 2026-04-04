(function () {
  const BRIDGE_URL = "ws://127.0.0.1:3847/ws";
  let socket = null;
  let reconnectTimer = null;

  connect();

  function connect() {
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
      return;
    }

    socket = new WebSocket(BRIDGE_URL);

    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({
        type: "hello",
        source: "chatgpt-content-script",
        url: location.href,
        title: document.title
      }));
    });

    socket.addEventListener("message", async (event) => {
      let payload;
      try {
        payload = JSON.parse(event.data);
      } catch {
        return;
      }

      if (payload.type !== "command") {
        return;
      }

      try {
        const data = await runCommand(payload);
        reply(payload.id, true, data);
      } catch (error) {
        reply(payload.id, false, null, serializeError(error));
      }
    });

    socket.addEventListener("close", scheduleReconnect);
    socket.addEventListener("error", scheduleReconnect);
  }

  function scheduleReconnect() {
    if (reconnectTimer) {
      return;
    }

    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, 1500);
  }

  function reply(id, ok, data, error) {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }

    socket.send(JSON.stringify({
      type: "result",
      id,
      ok,
      data,
      error
    }));
  }

  async function runCommand(payload) {
    if (payload.command === "ping") {
      return { pong: true };
    }

    if (payload.command === "getMessages") {
      return readMessages();
    }

    if (payload.command === "readLastAssistant") {
      const messages = readMessages();
      return [...messages].reverse().find((message) => message.role === "assistant") ?? null;
    }

    if (payload.command === "newChat") {
      await openNewChat();
      return {
        ok: true,
        url: location.href
      };
    }

    if (payload.command === "sendMessage") {
      if (!payload.prompt || !payload.prompt.trim()) {
        throw new Error("Prompt was empty.");
      }

      await sendMessage(payload.prompt);
      const response = await waitForAssistantResponse(payload.timeoutMs);
      return {
        response,
        messages: readMessages()
      };
    }

    if (payload.command === "getCookies") {
      return { cookies: document.cookie };
    }

    throw new Error(`Unknown command: ${payload.command}`);
  }

  function readMessages() {
    return Array.from(document.querySelectorAll("[data-message-author-role]")).map((node) => ({
      role: node.getAttribute("data-message-author-role") || "unknown",
      text: extractNodeText(node)
    }));
  }

  async function sendMessage(prompt) {
    const composer = await step("waitForComposer", () => waitForComposer(15000));
    await step("focusComposer", () => safeFocus(composer));
    await step("populateComposer", () => populateComposer(composer, prompt));
    await step("waitAfterPopulate", () => sleep(150));
    await step("submitComposer", () => submitComposer(composer));
  }

  async function waitForAssistantResponse(timeoutMs) {
    const timeoutAt = Date.now() + (timeoutMs || 120000);

    while (Date.now() < timeoutAt) {
      const stopButton = document.querySelector('button[data-testid="stop-button"]');
      if (stopButton) {
        await sleep(500);
        continue;
      }

      await sleep(2000);
      const stillGenerating = document.querySelector('button[data-testid="stop-button"]');
      if (!stillGenerating) {
        const messages = readMessages();
        const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
        if (lastAssistant) {
          return lastAssistant.text;
        }
      }
    }

    throw new Error("Timed out waiting for ChatGPT to finish responding.");
  }

  async function openNewChat() {
    const newChatLink = document.querySelector('a[href="/"], a[href="https://chatgpt.com/"]');
    if (newChatLink && typeof newChatLink.click === "function") {
      newChatLink.click();
    } else {
      location.href = "https://chatgpt.com/";
    }

    await waitForComposer(15000);

    // Report updated URL back to bridge
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({
        type: "hello",
        source: "chatgpt-content-script",
        url: location.href,
        title: document.title
      }));
    }
  }

  function waitForElement(selector, timeoutMs) {
    return new Promise((resolve, reject) => {
      const existing = document.querySelector(selector);
      if (existing) {
        resolve(existing);
        return;
      }

      const deadline = Date.now() + timeoutMs;
      const observer = new MutationObserver(() => {
        const node = document.querySelector(selector);
        if (node) {
          observer.disconnect();
          resolve(node);
          return;
        }

        if (Date.now() > deadline) {
          observer.disconnect();
          reject(new Error(`Timed out waiting for ${selector}`));
        }
      });

      observer.observe(document.documentElement, {
        childList: true,
        subtree: true
      });

      window.setTimeout(() => {
        observer.disconnect();
        reject(new Error(`Timed out waiting for ${selector}`));
      }, timeoutMs);
    });
  }

  async function waitForComposer(timeoutMs) {
    const selectors = [
      "#prompt-textarea",
      'textarea[placeholder]',
      '[contenteditable="true"][data-testid*="composer"]',
      '[contenteditable="true"][role="textbox"]'
    ];

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      for (const selector of selectors) {
        const node = document.querySelector(selector);
        if (node) {
          return node;
        }
      }

      await sleep(250);
    }

    throw new Error("Timed out waiting for the ChatGPT composer.");
  }

  function extractNodeText(node) {
    return (node.textContent || "").trim();
  }

  function serializeError(error) {
    if (error instanceof Error) {
      return [error.message, error.stack].filter(Boolean).join("\n");
    }

    return String(error);
  }

  async function step(name, fn) {
    try {
      return await fn();
    } catch (error) {
      throw new Error(`${name} failed: ${serializeError(error)}`);
    }
  }

  function safeFocus(node) {
    if (node && typeof node.focus === "function") {
      node.focus();
    }
  }

  function populateComposer(composer, prompt) {
    if (composer instanceof HTMLTextAreaElement) {
      composer.value = prompt;
      composer.dispatchEvent(new Event("input", { bubbles: true }));
      composer.dispatchEvent(new Event("change", { bubbles: true }));
      return;
    }

    composer.textContent = prompt;
    composer.dispatchEvent(new Event("input", { bubbles: true }));
    composer.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function submitComposer(composer) {
    const sendButton = document.querySelector('button[data-testid="send-button"]');
    if (sendButton && typeof sendButton.click === "function") {
      sendButton.click();
      return;
    }

    composer.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Enter",
      code: "Enter",
      bubbles: true,
      cancelable: true
    }));
    composer.dispatchEvent(new KeyboardEvent("keyup", {
      key: "Enter",
      code: "Enter",
      bubbles: true,
      cancelable: true
    }));
  }

  function sleep(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }
})();
