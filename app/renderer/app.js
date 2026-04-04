(async function () {
  const API_PORT = await window.agent.getApiPort();
  const API = `http://127.0.0.1:${API_PORT}`;

  let currentConvId = null;
  let currentConv = null;
  let eventSource = null;
  let eventCount = 0;
  let workspaceReady = false;

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => document.querySelectorAll(s);

  const chatMessages = $("#chatMessages");
  const chatInput = $("#chatInput");
  const sendBtn = $("#sendBtn");
  const chatTitle = $("#chatTitle");
  const convList = $("#convList");
  const taskListSidebar = $("#taskListSidebar");
  const backendBadge = $("#backendBadge");
  const workspaceBadge = $("#workspaceBadge");
  const statusDot = $("#statusIndicator");
  const statusText = $("#statusText");
  const eventLog = $("#eventLog");
  const eventCountEl = $("#eventCount");
  const healthOutput = $("#healthOutput");
  const projectCtxPreview = $("#projectCtxPreview");
  const projectPicker = $("#projectPicker");

  // ChatGPT panel toggle
  const chatViewToggle = $("#chatViewToggle");
  const chatViewControls = $("#chatViewControls");
  chatViewToggle.addEventListener("click", async () => {
    const visible = await window.agent.toggleChatView();
    chatViewToggle.textContent = visible ? "👁 Hide ChatGPT" : "👁 Show ChatGPT";
    chatViewControls.classList.toggle("hidden", !visible);
  });
  window.agent.onChatViewToggled((visible) => {
    chatViewToggle.textContent = visible ? "👁 Hide ChatGPT" : "👁 Show ChatGPT";
    chatViewControls.classList.toggle("hidden", !visible);
  });
  $("#cvBack").addEventListener("click", () => window.agent.chatViewBack());
  $("#cvForward").addEventListener("click", () => window.agent.chatViewForward());
  $("#cvRefresh").addEventListener("click", () => window.agent.chatViewRefresh());
  $("#cvHome").addEventListener("click", () => window.agent.chatViewHome());

  // Login button — opens a full browser window, user logs in manually, closes when done
  $("#loginBtn").addEventListener("click", async () => {
    $("#loginBtn").textContent = "🔑 Login window open…";
    const result = await window.agent.loginChatGPT();
    if (result.ok) {
      $("#loginBtn").textContent = "✅ Logged in";
      $("#loginBtn").style.color = "var(--success)";
    } else {
      $("#loginBtn").textContent = "🔑 Login to ChatGPT";
    }
    checkHealth();
  });

  // Import cookies from Chrome
  $("#importCookiesBtn").addEventListener("click", async () => {
    $("#importCookiesBtn").textContent = "🍪 Importing…";
    const result = await window.agent.importChromeSession();
    if (result.ok) {
      $("#importCookiesBtn").textContent = "✅ Imported";
      $("#importCookiesBtn").style.color = "var(--success)";
    } else {
      $("#importCookiesBtn").textContent = "❌ " + (result.error || "Failed").slice(0, 40);
      $("#importCookiesBtn").style.color = "var(--danger)";
      setTimeout(() => {
        $("#importCookiesBtn").textContent = "🍪 Import Chrome Session";
        $("#importCookiesBtn").style.color = "";
      }, 5000);
    }
    checkHealth();
  });

  // --- API helper ---
  async function api(method, path, body) {
    try {
      const opts = { method, headers: { "content-type": "application/json" } };
      if (body) opts.body = JSON.stringify(body);
      const res = await fetch(`${API}${path}`, opts);
      return res.json();
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  // --- Project Picker ---
  async function showProjectPicker() {
    projectPicker.classList.remove("hidden");
    const recents = await window.agent.getRecents();
    const container = $("#pickerRecents");
    container.innerHTML = "";
    if (recents.length) {
      container.innerHTML = "<h3>Recent Projects</h3>";
      for (const dir of recents) {
        const name = dir.split("/").pop();
        const entry = document.createElement("div");
        entry.className = "recent-entry";
        entry.innerHTML = `<span class="recent-name">📁 ${name}</span><span class="recent-path">${dir}</span>`;
        entry.addEventListener("click", () => selectWorkspace(dir));
        container.appendChild(entry);
      }
    }
  }

  $("#pickerOpenBtn").addEventListener("click", async () => {
    const dir = await window.agent.pickFolder();
    if (dir) selectWorkspace(dir);
  });

  async function selectWorkspace(dir) {
    projectPicker.querySelector(".picker-subtitle").textContent = "Starting agent…";
    await window.agent.openWorkspace(dir);

    // Wait for API — hard cap at 15s, then proceed regardless
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`${API}/health`);
        if (res.ok) break;
      } catch {}
      await new Promise(r => setTimeout(r, 500));
    }

    // Always proceed
    projectPicker.classList.add("hidden");
    workspaceReady = true;
    const name = dir.split("/").pop();
    workspaceBadge.textContent = `📁 ${name}`;
    workspaceBadge.title = dir;
    document.title = `Agent — ${name}`;
    connectSSE();
    loadConversations().catch(() => {});
    loadTasks().catch(() => {});
    loadHealth();
    chatInput.focus();
  }

  workspaceBadge.addEventListener("click", async () => {
    const dir = await window.agent.pickFolder();
    if (dir) selectWorkspace(dir);
  });

  window.agent.onWorkspaceChanged(async (dir) => {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      try { const r = await fetch(`${API}/health`); if (r.ok) break; } catch {}
      await new Promise(r => setTimeout(r, 500));
    }
    projectPicker.classList.add("hidden");
    workspaceReady = true;
    const name = dir.split("/").pop();
    workspaceBadge.textContent = `📁 ${name}`;
    workspaceBadge.title = dir;
    document.title = `Agent — ${name}`;
    connectSSE();
    loadConversations().catch(() => {});
    loadTasks().catch(() => {});
    loadHealth();
  });

  // --- SSE ---
  function connectSSE() {
    if (eventSource) eventSource.close();
    try {
      eventSource = new EventSource(`${API}/events`);
      eventSource.onopen = () => updateStatus(true);
      eventSource.onerror = () => updateStatus(false);
      eventSource.onmessage = (e) => {
        try {
          const data = JSON.parse(e.data);
          addEvent(data);
          if (data.type === "backend:switched") {
            backendBadge.textContent = data.backend === "ollama" ? `Ollama: ${data.planner?.replace("ollama:", "") ?? ""}` : data.backend === "electron" ? "ChatGPT (Embedded)" : "ChatGPT Web Bridge";
          }
          if (data.type === "agent:step" && data.data?.step) addMessage("system", data.data.step);
          if (data.type === "agent:tool_call" && data.data?.tool) {
            addMessage("tool", `🔧 Running \`${data.data.tool}\`${data.data.reason ? ` — ${data.data.reason}` : ""}`);
          }
          if (data.type === "agent:init" && data.data) {
            addMessage("system", `⚙️ ${typeof data.data === "string" ? data.data : ""}`);
          }
        } catch {}
      };
    } catch {}
    // Also do an immediate health check
    checkHealth();
  }

  async function checkHealth() {
    try {
      const res = await fetch(`${API}/health`);
      if (res.ok) {
        const data = await res.json();
        const plannerOk = data.plannerStatus?.ok;
        updateStatus(true, plannerOk);
        // Update login button
        const loginBtn = $("#loginBtn");
        if (plannerOk) {
          loginBtn.textContent = "✅ ChatGPT Ready";
          loginBtn.style.color = "var(--success)";
        } else {
          loginBtn.textContent = "🔑 Login to ChatGPT";
          loginBtn.style.color = "var(--warning)";
        }
      } else {
        updateStatus(false);
      }
    } catch {
      updateStatus(false);
    }
  }

  function updateStatus(apiOk, plannerOk) {
    if (apiOk && plannerOk) {
      statusDot.className = "status-dot connected";
      statusText.textContent = "Ready";
    } else if (apiOk) {
      statusDot.className = "status-dot connected";
      statusText.textContent = "API up · ChatGPT not ready";
    } else {
      statusDot.className = "status-dot disconnected";
      statusText.textContent = "Disconnected";
    }
  }

  function addEvent(data) {
    eventCount++;
    eventCountEl.textContent = eventCount;
    const div = document.createElement("div");
    div.textContent = `${new Date().toLocaleTimeString()} ${data.type}`;
    eventLog.appendChild(div);
    if (eventLog.children.length > 200) eventLog.removeChild(eventLog.firstChild);
    eventLog.scrollTop = eventLog.scrollHeight;
  }

  // --- Navigation ---
  $$(".nav-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      $$(".nav-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      $$(".panel").forEach((p) => p.classList.remove("active"));
      $(`#panel-${btn.dataset.panel}`).classList.add("active");
      if (btn.dataset.panel === "tasks") loadTasks();
      if (btn.dataset.panel === "memory") loadMemory();
      if (btn.dataset.panel === "settings") loadHealth();
    });
  });

  $("#eventBarToggle").addEventListener("click", () => {
    $("#eventBar").classList.toggle("collapsed");
    $("#eventBar").classList.toggle("expanded");
  });

  // --- Chat ---
  sendBtn.addEventListener("click", sendMessage);
  chatInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });

  async function sendMessage() {
    if (!workspaceReady) return;
    const text = chatInput.value.trim();
    if (!text) return;
    chatInput.value = "";
    sendBtn.disabled = true;

    if (!currentConvId) {
      const res = await api("POST", "/conversations", { title: text.slice(0, 60) });
      if (res.ok) {
        currentConvId = res.conversation.id;
        chatTitle.textContent = res.conversation.title;
        loadConversations().catch(() => {});
      }
    }

    addMessage("user", text);
    const res = await api("POST", `/conversations/${currentConvId}/send`, { message: text });
    if (res.ok && res.response) {
      addMessage("assistant", res.response);
    } else {
      addMessage("system", `Error: ${res.error ?? "Unknown error"}`);
    }
    sendBtn.disabled = false;
    chatInput.focus();
  }

  function addMessage(role, content) {
    const div = document.createElement("div");
    div.className = `message ${role}`;
    const escaped = content.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const formatted = escaped
      .replace(/```diff\n([\s\S]*?)```/g, '<pre class="diff-block"><code>$1</code></pre>')
      .replace(/```(\w*)\n([\s\S]*?)```/g, "<pre><code>$2</code></pre>")
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/`([^`]+)`/g, "<code>$1</code>");
    div.innerHTML = formatted;
    chatMessages.appendChild(div);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  // --- Conversations ---
  async function loadConversations() {
    if (!workspaceReady) return;
    const res = await api("GET", "/conversations");
    if (!res.ok) return;
    convList.innerHTML = "";
    for (const c of res.conversations) {
      const div = document.createElement("div");
      div.className = `item-entry${c.id === currentConvId ? " active" : ""}`;
      div.innerHTML = `<div>${c.title}</div><div class="item-meta">${c.messageCount} msgs</div>`;
      div.addEventListener("click", () => openConversation(c.id));
      convList.appendChild(div);
    }
  }

  async function openConversation(id) {
    currentConvId = id;
    const res = await api("GET", `/conversations/${id}`);
    if (!res.ok) return;
    currentConv = res.conversation;
    chatTitle.textContent = currentConv.title;
    chatMessages.innerHTML = "";
    for (const msg of currentConv.messages) addMessage(msg.role, msg.content);
    loadConversations().catch(() => {});
    $$(".nav-btn").forEach((b) => b.classList.remove("active"));
    $('[data-panel="chat"]').classList.add("active");
    $$(".panel").forEach((p) => p.classList.remove("active"));
    $("#panel-chat").classList.add("active");
  }

  $("#newConvBtn").addEventListener("click", () => {
    currentConvId = null; currentConv = null;
    chatTitle.textContent = "New Conversation";
    chatMessages.innerHTML = "";
    chatInput.focus();
  });

  // --- Tasks ---
  async function loadTasks() {
    if (!workspaceReady) return;
    const res = await api("GET", "/tasks");
    if (!res.ok) return;
    const detail = $("#taskDetail");
    taskListSidebar.innerHTML = "";
    if (!res.tasks.length) { detail.innerHTML = '<p class="empty-state">No tasks yet.</p>'; return; }
    detail.innerHTML = "";
    for (const t of res.tasks) {
      const sideDiv = document.createElement("div");
      sideDiv.className = "item-entry";
      sideDiv.innerHTML = `<div>${t.goal?.slice(0, 40) ?? t.id.slice(0, 8)}</div><div class="item-meta">${t.status}</div>`;
      sideDiv.addEventListener("click", () => loadTaskDetail(t.id));
      taskListSidebar.appendChild(sideDiv);
      const card = document.createElement("div");
      card.className = "task-card";
      card.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center"><h3>${t.goal?.slice(0, 80) ?? "Untitled"}</h3><span class="status-badge ${t.status}">${t.status}</span></div><div class="meta">${t.id.slice(0,8)} · ${new Date(t.updatedAt).toLocaleString()}</div>`;
      card.style.cursor = "pointer";
      card.addEventListener("click", () => loadTaskDetail(t.id));
      detail.appendChild(card);
    }
  }

  async function loadTaskDetail(id) {
    const res = await api("GET", `/tasks/${id}`);
    if (!res.ok) return;
    const t = res.task;
    $("#taskDetail").innerHTML = `<div class="task-card"><h3>${t.goal}</h3><span class="status-badge ${t.status}">${t.status}</span><div class="meta">Steps: ${t.steps.length} · Changed: ${t.changedFiles.join(", ") || "(none)"}</div>${t.lastError ? `<div style="color:var(--danger);margin-top:8px">${t.lastError}</div>` : ""}</div>`;
  }

  window.abortTask = async (id) => { await api("POST", `/tasks/${id}/abort`); loadTasks(); };
  $("#newTaskBtn").addEventListener("click", () => {
    showModal("New Task", '<input id="taskGoal" placeholder="Describe the task…">', async () => {
      const goal = $("#taskGoal").value.trim();
      if (!goal) return;
      await api("POST", "/tasks", { goal, safetyMode: $("#safetyMode").value });
      hideModal(); loadTasks();
    });
  });

  // --- Memory ---
  async function loadMemory() {
    if (!workspaceReady) return;
    const res = await api("GET", "/memory");
    if (!res.ok) return;
    const grid = $("#memoryContent");
    grid.innerHTML = "";
    for (const entry of res.entries) {
      const card = document.createElement("div");
      card.className = "memory-card";
      card.innerHTML = `<h3>📝 ${entry.key}</h3><div class="preview">${entry.content.replace(/</g, "&lt;").slice(0, 200)}</div><div class="updated">${new Date(entry.updatedAt).toLocaleString()}</div>`;
      card.addEventListener("click", () => editMemory(entry.key));
      grid.appendChild(card);
    }
  }

  async function editMemory(key) {
    const res = await api("GET", `/memory/${encodeURIComponent(key)}`);
    if (!res.ok) return;
    showModal(`Edit: ${key}`, `<textarea id="memoryEdit" rows="12">${res.content.replace(/</g, "&lt;")}</textarea>`, async () => {
      await api("PUT", `/memory/${encodeURIComponent(key)}`, { content: $("#memoryEdit").value });
      hideModal(); loadMemory();
    });
  }

  $("#initMemoryBtn").addEventListener("click", async () => { await api("POST", "/memory/init"); loadMemory(); });

  // --- Settings ---
  async function loadHealth() {
    if (!workspaceReady) return;
    const res = await api("GET", "/health");
    healthOutput.textContent = JSON.stringify(res, null, 2);
    backendBadge.textContent = res.backend === "ollama" ? `Ollama: ${res.planner?.replace("ollama:", "") ?? ""}` : res.backend === "electron" ? "ChatGPT (Embedded)" : "ChatGPT Web Bridge";
    const ctxRes = await api("GET", "/project-context");
    projectCtxPreview.textContent = ctxRes.content || "(No AGENT.md found.)";
  }

  $("#setElectron").addEventListener("click", async () => { await api("POST", "/backend", { backend: "electron" }); loadHealth(); });
  $("#setChatGPT").addEventListener("click", async () => { await api("POST", "/backend", { backend: "chatgpt_web" }); loadHealth(); });
  $("#setOllama").addEventListener("click", async () => {
    await api("POST", "/backend", { backend: "ollama", model: $("#ollamaModel").value.trim() || "qwen2.5-coder:7b" });
    loadHealth();
  });
  $("#initProjectCtx").addEventListener("click", async () => { await api("POST", "/project-context/init"); loadHealth(); });

  backendBadge.addEventListener("click", async () => {
    const res = await api("GET", "/health");
    const order = ["electron", "ollama", "chatgpt_web"];
    const next = order[(order.indexOf(res.backend) + 1) % order.length];
    await api("POST", "/backend", { backend: next, model: $("#ollamaModel")?.value?.trim() || "qwen2.5-coder:7b" });
    loadHealth();
  });

  // --- Modal ---
  function showModal(title, bodyHtml, onConfirm) {
    $("#modalTitle").textContent = title;
    $("#modalBody").innerHTML = bodyHtml;
    $("#modal").classList.remove("hidden");
    $("#modalConfirm").onclick = onConfirm;
    $("#modalCancel").onclick = hideModal;
    setTimeout(() => { const inp = $("#modalBody input, #modalBody textarea"); if (inp) inp.focus(); }, 50);
  }
  function hideModal() { $("#modal").classList.add("hidden"); }
  $("#modal").addEventListener("click", (e) => { if (e.target === $("#modal")) hideModal(); });

  // --- IPC ---
  window.agent.onAction((action) => {
    if (action === "new-conversation") $("#newConvBtn").click();
    if (action === "new-task") {
      $$(".nav-btn").forEach((b) => b.classList.remove("active"));
      $('[data-panel="tasks"]').classList.add("active");
      $$(".panel").forEach((p) => p.classList.remove("active"));
      $("#panel-tasks").classList.add("active");
      loadTasks();
    }
  });
  window.agent.onNavigate((page) => { const btn = $(`[data-panel="${page}"]`); if (btn) btn.click(); });

  // --- Init ---
  showProjectPicker();

  setInterval(async () => {
    if (!workspaceReady) return;
    loadConversations().catch(() => {});
    if ($("#panel-tasks").classList.contains("active")) loadTasks().catch(() => {});
    checkHealth();
  }, 5000);
})();
