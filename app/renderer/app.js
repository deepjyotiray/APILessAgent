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

  // Strip leading line numbers from code block text
  function stripLineNums(text) {
    const lines = text.split('\n');
    const nonEmpty = lines.filter(l => l.trim());
    if (nonEmpty.length < 2) return text;
    const nums = nonEmpty.map(l => { const m = l.match(/^(\d+)/); return m ? parseInt(m[1]) : null; });
    if (nums.some(n => n === null)) return text;
    for (let i = 1; i < nums.length; i++) { if (nums[i] < nums[i-1]) return text; }
    return lines.map(l => !l.trim() ? '' : l.replace(/^\d+\s?[|:]?\s?/, '')).join('\n');
  }

  const chatMessages = $("#chatMessages");
  const chatInput = $("#chatInput");
  const sendBtn = $("#sendBtn");
  const stopBtn = $("#stopBtn");
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

  // --- Active model state ---
  const MODELS = ["chatgpt", "merlin", "ollama"];
  let activeModel = "chatgpt";
  const modelViewToggle = $("#modelViewToggle");
  const chatViewControls = $("#chatViewControls");
  const merlinViewControls = $("#merlinViewControls");

  const MODEL_VIEW_CFG = {
    chatgpt: { icon: "👁", label: "ChatGPT", toggle: () => window.agent.toggleChatView(), controls: chatViewControls, loginId: "#loginBtn" },
    merlin:  { icon: "🔮", label: "Merlin",  toggle: () => window.agent.toggleMerlinView(), controls: merlinViewControls, loginId: "#loginMerlinBtn" },
    ollama:  { icon: "🦙", label: "Ollama",  toggle: null, controls: null, loginId: null },
  };

  function refreshModelUI() {
    const cfg = MODEL_VIEW_CFG[activeModel];
    // Badge text
    if (activeModel === "ollama") {
      backendBadge.textContent = `🦙 Ollama (${ollamaModelInput.value.trim() || "7b"})`;
    } else if (activeModel === "merlin") {
      backendBadge.textContent = "🔮 Merlin (Embedded)";
    } else {
      backendBadge.textContent = "ChatGPT (Embedded)";
    }
    // Show/hide view toggle
    if (cfg.toggle) {
      modelViewToggle.classList.remove("hidden");
      modelViewToggle.textContent = `${cfg.icon} Show ${cfg.label}`;
    } else {
      modelViewToggle.classList.add("hidden");
    }
    // Hide all controls
    chatViewControls.classList.add("hidden");
    merlinViewControls.classList.add("hidden");
    // Show/hide login buttons for active model only
    $("#loginBtn").classList.toggle("hidden", activeModel !== "chatgpt");
    $("#loginMerlinBtn").classList.toggle("hidden", activeModel !== "merlin");
  }

  // Cycle model on badge click
  backendBadge.addEventListener("click", async () => {
    const next = MODELS[(MODELS.indexOf(activeModel) + 1) % MODELS.length];
    const res = await api("POST", "/planner", {
      planner: next,
      model: next === "ollama" ? ollamaModelInput.value.trim() : undefined
    });
    if (res.ok) {
      activeModel = res.active || next;
      syncPlannerUI(activeModel, ollamaModelInput.value.trim());
    }
  });

  // View toggle click
  modelViewToggle.addEventListener("click", async () => {
    const cfg = MODEL_VIEW_CFG[activeModel];
    if (!cfg?.toggle) return;
    const visible = await cfg.toggle();
    modelViewToggle.textContent = visible ? `${cfg.icon} Hide ${cfg.label}` : `${cfg.icon} Show ${cfg.label}`;
    if (cfg.controls) cfg.controls.classList.toggle("hidden", !visible);
  });

  window.agent.onChatViewToggled((visible) => {
    if (activeModel !== "chatgpt") return;
    modelViewToggle.textContent = visible ? "👁 Hide ChatGPT" : "👁 Show ChatGPT";
    chatViewControls.classList.toggle("hidden", !visible);
  });
  window.agent.onMerlinViewToggled((visible) => {
    if (activeModel !== "merlin") return;
    modelViewToggle.textContent = visible ? "🔮 Hide Merlin" : "🔮 Show Merlin";
    merlinViewControls.classList.toggle("hidden", !visible);
  });

  $("#cvBack").addEventListener("click", () => window.agent.chatViewBack());
  $("#cvForward").addEventListener("click", () => window.agent.chatViewForward());
  $("#cvRefresh").addEventListener("click", () => window.agent.chatViewRefresh());
  $("#cvHome").addEventListener("click", () => window.agent.chatViewHome());
  $("#mvBack").addEventListener("click", () => window.agent.merlinViewBack());
  $("#mvForward").addEventListener("click", () => window.agent.merlinViewForward());
  $("#mvRefresh").addEventListener("click", () => window.agent.merlinViewRefresh());
  $("#mvHome").addEventListener("click", () => window.agent.merlinViewHome());

  // Login buttons
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

  $("#loginMerlinBtn").addEventListener("click", async () => {
    $("#loginMerlinBtn").textContent = "🔮 Login window open…";
    const result = await window.agent.loginMerlin();
    if (result.ok) {
      $("#loginMerlinBtn").textContent = "✅ Merlin Ready";
      $("#loginMerlinBtn").style.color = "var(--success)";
    } else {
      $("#loginMerlinBtn").textContent = "🔮 Login to Merlin";
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
          if (data.type === "agent:step" && data.data?.step) addMessage("system", data.data.step);
          if (data.type === "agent:tool_call" && data.data?.tool) {
            addMessage("tool", `🔧 Running \`${data.data.tool}\`${data.data.reason ? ` — ${data.data.reason}` : ""}`);
          }
          if (data.type === "agent:init" && data.data) {
            addMessage("system", `⚙️ ${typeof data.data === "string" ? data.data : ""}`);
          }
          if (data.type === "ollama:log" && data.message) {
            addOllamaLog(data.message, data.message.includes("failed") || data.message.includes("error"));
          }
          if (data.type === "planner:switched") {
            syncPlannerUI(data.planner, data.model);
            addMessage("system", `🔄 Planner switched to ${data.planner}${data.model ? ` (${data.model})` : ""}`);
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
        const active = data.activePlanner || "chatgpt";
        activeModel = active;
        updateStatus(true, plannerOk, active);
        refreshModelUI();
        // Update login button state for active model
        const loginId = MODEL_VIEW_CFG[active]?.loginId;
        if (loginId) {
          const btn = $(loginId);
          if (plannerOk) {
            btn.textContent = `✅ ${MODEL_VIEW_CFG[active].label} Ready`;
            btn.style.color = "var(--success)";
          } else {
            btn.textContent = `${MODEL_VIEW_CFG[active].icon} Login to ${MODEL_VIEW_CFG[active].label}`;
            btn.style.color = "var(--warning)";
          }
        }
      } else {
        updateStatus(false);
      }
    } catch {
      updateStatus(false);
    }
  }

  function updateStatus(apiOk, plannerOk, active) {
    const name = MODEL_VIEW_CFG[active]?.label || active || "Planner";
    if (apiOk && plannerOk) {
      statusDot.className = "status-dot connected";
      statusText.textContent = `${name} Ready`;
    } else if (apiOk) {
      statusDot.className = "status-dot connected";
      statusText.textContent = `API up · ${name} not ready`;
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
  stopBtn.addEventListener("click", abortExecution);
  chatInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });

  async function sendMessage() {
    if (!workspaceReady) return;
    const text = chatInput.value.trim();
    if (!text) return;
    chatInput.value = "";
    sendBtn.classList.add("hidden");
    stopBtn.classList.remove("hidden");

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
    } else if (res.error?.includes("not found")) {
      // Stale conversation — create a new one and retry
      currentConvId = null;
      const createRes = await api("POST", "/conversations", { title: text.slice(0, 60) });
      if (createRes.ok) {
        currentConvId = createRes.conversation.id;
        chatTitle.textContent = createRes.conversation.title;
        loadConversations().catch(() => {});
        const retry = await api("POST", `/conversations/${currentConvId}/send`, { message: text });
        if (retry.ok && retry.response) addMessage("assistant", retry.response);
        else addMessage("system", `Error: ${retry.error ?? "Unknown error"}`);
      } else {
        addMessage("system", `Error: ${createRes.error ?? "Could not create conversation"}`);
      }
    } else {
      addMessage("system", `Error: ${res.error ?? "Unknown error"}`);
    }
    stopBtn.classList.add("hidden");
    sendBtn.classList.remove("hidden");
    chatInput.focus();
  }

  async function abortExecution() {
    if (!currentConvId) return;
    stopBtn.disabled = true;
    stopBtn.textContent = "Stopping…";
    await api("POST", `/conversations/${currentConvId}/abort`);
    stopBtn.disabled = false;
    stopBtn.textContent = "■ Stop";
  }

  function addMessage(role, content) {
    const div = document.createElement("div");
    const displayRole = role === "task" ? "system" : role;
    div.className = `message ${displayRole}`;
    const escaped = content.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const formatted = escaped
      // Code blocks with language + copy button
      .replace(/```diff\n([\s\S]*?)```/g, (_, code) => `<pre class="code-block diff-block"><button class="copy-btn" onclick="navigator.clipboard.writeText(this.nextElementSibling.textContent);this.textContent='✓';setTimeout(()=>this.textContent='Copy',1500)">Copy</button><code>${stripLineNums(code)}</code></pre>`)
      .replace(/```(\w+)\n([\s\S]*?)```/g, (_, lang, code) => `<pre class="code-block"><div class="code-lang">${lang}<button class="copy-btn" onclick="navigator.clipboard.writeText(this.closest('pre').querySelector('code').textContent);this.textContent='✓';setTimeout(()=>this.textContent='Copy',1500)">Copy</button></div><code>${stripLineNums(code)}</code></pre>`)
      .replace(/```\n([\s\S]*?)```/g, (_, code) => `<pre class="code-block"><button class="copy-btn" onclick="navigator.clipboard.writeText(this.nextElementSibling.textContent);this.textContent='✓';setTimeout(()=>this.textContent='Copy',1500)">Copy</button><code>${stripLineNums(code)}</code></pre>`)
      // Tables: header | row | separator
      .replace(/^(\|.+\|)\n(\|[-| :]+\|)\n((?:\|.+\|\n?)+)/gm, (_, hdr, _sep, body) => {
        const th = hdr.split('|').filter(c => c.trim()).map(c => `<th>${c.trim()}</th>`).join('');
        const rows = body.trim().split('\n').map(r => {
          const cells = r.split('|').filter(c => c.trim()).map(c => `<td>${c.trim()}</td>`).join('');
          return `<tr>${cells}</tr>`;
        }).join('');
        return `<table><thead><tr>${th}</tr></thead><tbody>${rows}</tbody></table>`;
      })
      // Headers
      .replace(/^### (.+)$/gm, '<h4>$1</h4>')
      .replace(/^## (.+)$/gm, '<h3>$1</h3>')
      .replace(/^# (.+)$/gm, '<h2>$1</h2>')
      // Bold and italic
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      // Inline code
      .replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>')
      // Links
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
      // Ordered lists
      .replace(/((?:^\d+\. .+$\n?)+)/gm, (block) => {
        const items = block.trim().split('\n').map(l => `<li>${l.replace(/^\d+\.\s/, '')}</li>`).join('');
        return `<ol>${items}</ol>`;
      })
      // Unordered lists
      .replace(/((?:^[-*] .+$\n?)+)/gm, (block) => {
        const items = block.trim().split('\n').map(l => `<li>${l.replace(/^[-*]\s/, '')}</li>`).join('');
        return `<ul>${items}</ul>`;
      })
      // Horizontal rules
      .replace(/^---$/gm, '<hr>')
      // Details/summary
      .replace(/&lt;details&gt;&lt;summary&gt;(.+?)&lt;\/summary&gt;/g, '<details><summary>$1</summary>')
      .replace(/&lt;\/details&gt;/g, '</details>')
      // Paragraphs: double newline
      .replace(/\n\n/g, '</p><p>')
      // Single line breaks
      .replace(/\n/g, '<br>');
    // Clean up <br>/<p> inside <pre> blocks
    const cleaned = formatted
      .replace(/<pre([^>]*)>(.*?)<\/pre>/gs, (m) => m.replace(/<br>/g, '\n').replace(/<\/p><p>/g, '\n\n'));
    div.innerHTML = `<p>${cleaned}</p>`;
    // Remove empty <p> tags
    div.querySelectorAll('p').forEach(p => { if (!p.innerHTML.trim()) p.remove(); });
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
      div.innerHTML = `<div class="item-entry-content"><div>${c.title}</div><div class="item-meta">${c.messageCount} msgs</div></div><button class="item-delete-btn" title="Delete chat">🗑</button>`;
      div.querySelector(".item-entry-content").addEventListener("click", () => openConversation(c.id));
      div.querySelector(".item-delete-btn").addEventListener("click", async (e) => {
        e.stopPropagation();
        if (!confirm("Delete this chat?")) return;
        await api("DELETE", `/conversations/${c.id}`);
        if (currentConvId === c.id) {
          currentConvId = null; currentConv = null;
          chatTitle.textContent = "New Conversation";
          chatMessages.innerHTML = "";
        }
        loadConversations();
      });
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

  $("#clearAllChatsBtn").addEventListener("click", async () => {
    if (!workspaceReady) return;
    if (!confirm("Delete ALL chats for this project? This cannot be undone.")) return;
    const res = await api("DELETE", "/conversations");
    if (res.ok) {
      currentConvId = null; currentConv = null;
      chatTitle.textContent = "New Conversation";
      chatMessages.innerHTML = "";
      loadConversations();
    }
  });

  $("#newConvBtn").addEventListener("click", () => {
    currentConvId = null; currentConv = null;
    chatTitle.textContent = "New Conversation";
    chatMessages.innerHTML = "";
    chatInput.focus();
  });

  // --- Tasks ---
  async function loadTasks() {
    if (!workspaceReady) return;
    const detail = $("#taskDetail");
    taskListSidebar.innerHTML = "";
    // Pull tasks from conversations
    const res = await api("GET", "/conversations");
    if (!res.ok) return;
    const tasks = [];
    for (const c of res.conversations) {
      const full = await api("GET", `/conversations/${c.id}`);
      if (!full.ok) continue;
      const taskMsgs = (full.conversation.messages || []).filter(m => m.role === "task");
      if (!taskMsgs.length) continue;
      const started = taskMsgs.find(m => m.taskStatus === "started");
      const finished = taskMsgs.find(m => m.taskStatus === "completed" || m.taskStatus === "failed");
      tasks.push({
        convId: c.id,
        taskId: started?.taskId ?? c.id,
        goal: started?.content ?? c.title,
        status: finished?.taskStatus ?? "running",
        summary: finished?.content ?? "",
        steps: taskMsgs.length,
        updatedAt: c.updatedAt,
      });
    }
    if (!tasks.length) { detail.innerHTML = '<p class="empty-state">No tasks yet. Send a message to start one.</p>'; return; }
    detail.innerHTML = "";
    for (const t of tasks) {
      const sideDiv = document.createElement("div");
      sideDiv.className = "item-entry";
      sideDiv.innerHTML = `<div>${t.goal?.slice(0, 40)}</div><div class="item-meta">${t.status}</div>`;
      sideDiv.addEventListener("click", () => openConversation(t.convId));
      taskListSidebar.appendChild(sideDiv);
      const card = document.createElement("div");
      card.className = "task-card";
      card.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center"><h3>${t.goal?.slice(0, 80)}</h3><span class="status-badge ${t.status}">${t.status}</span></div><div class="meta">${t.steps} steps · ${new Date(t.updatedAt).toLocaleString()}${t.summary ? ` · ${t.summary}` : ""}</div>`;
      card.style.cursor = "pointer";
      card.addEventListener("click", () => openConversation(t.convId));
      detail.appendChild(card);
    }
  }
  $("#newTaskBtn").addEventListener("click", () => {
    showModal("New Task", '<input id="taskGoal" placeholder="Describe the task…">', async () => {
      const goal = $("#taskGoal").value.trim();
      if (!goal) return;
      hideModal();
      // Switch to chat panel
      $$(".nav-btn").forEach((b) => b.classList.remove("active"));
      $('[data-panel="chat"]').classList.add("active");
      $$(".panel").forEach((p) => p.classList.remove("active"));
      $("#panel-chat").classList.add("active");
      // Send as a chat message
      chatInput.value = goal;
      sendMessage();
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
    // Sync planner toggle with server state
    const plannerRes = await api("GET", "/planner");
    if (plannerRes.ok) {
      syncPlannerUI(plannerRes.active, plannerRes.ollamaModel);
    }
    const ctxRes = await api("GET", "/project-context");
    projectCtxPreview.textContent = ctxRes.content || "(No AGENT.md found.)";
  }

  // --- Planner toggle ---
  const plannerBtns = $$(".toggle-btn[data-planner]");
  const ollamaModelGroup = $("#ollamaModelGroup");
  const ollamaModelInput = $("#ollamaModelInput");
  const ollamaStatusEl = $("#ollamaStatus");
  const ollamaLogs = $("#ollamaLogs");

  function syncPlannerUI(active, model) {
    activeModel = active;
    plannerBtns.forEach(b => b.classList.toggle("active", b.dataset.planner === active));
    ollamaModelGroup.classList.toggle("hidden", active !== "ollama");
    if (model) ollamaModelInput.value = model;
    refreshModelUI();
  }

  plannerBtns.forEach(btn => {
    btn.addEventListener("click", async () => {
      const target = btn.dataset.planner;
      ollamaStatusEl.textContent = "Switching…";
      ollamaStatusEl.className = "ollama-status";
      const res = await api("POST", "/planner", {
        planner: target,
        model: target === "ollama" ? ollamaModelInput.value.trim() : undefined
      });
      if (res.ok) {
        syncPlannerUI(res.active, ollamaModelInput.value.trim());
        ollamaStatusEl.textContent = res.plannerStatus?.ok ? `✅ ${res.plannerStatus.message}` : `❌ ${res.plannerStatus?.message ?? "Not ready"}`;
        ollamaStatusEl.className = `ollama-status ${res.plannerStatus?.ok ? "ok" : "error"}`;
        addOllamaLog(`Switched to ${res.active}`);
      } else {
        ollamaStatusEl.textContent = `❌ ${res.error ?? "Switch failed"}`;
        ollamaStatusEl.className = "ollama-status error";
      }
    });
  });

  $("#ollamaModelApply").addEventListener("click", async () => {
    const model = ollamaModelInput.value.trim();
    if (!model) return;
    ollamaStatusEl.textContent = "Checking model…";
    ollamaStatusEl.className = "ollama-status";
    const res = await api("POST", "/planner", { planner: "ollama", model });
    if (res.ok) {
      syncPlannerUI("ollama", model);
      ollamaStatusEl.textContent = res.plannerStatus?.ok ? `✅ ${res.plannerStatus.message}` : `❌ ${res.plannerStatus?.message}`;
      ollamaStatusEl.className = `ollama-status ${res.plannerStatus?.ok ? "ok" : "error"}`;
      addOllamaLog(`Model set to ${model}`);
    } else {
      ollamaStatusEl.textContent = `❌ ${res.error}`;
      ollamaStatusEl.className = "ollama-status error";
    }
  });

  function addOllamaLog(msg, isError) {
    const div = document.createElement("div");
    div.className = `log-entry${isError ? " error" : ""}`;
    const ts = new Date().toLocaleTimeString("en-GB", { hour12: false });
    div.innerHTML = `<span class="log-ts">${ts}</span><span class="log-msg">${msg.replace(/</g, "&lt;")}</span>`;
    ollamaLogs.appendChild(div);
    if (ollamaLogs.children.length > 500) ollamaLogs.removeChild(ollamaLogs.firstChild);
    ollamaLogs.scrollTop = ollamaLogs.scrollHeight;
  }

  $("#merlinInspectBtn").addEventListener("click", async () => {
    $("#merlinDomOutput").textContent = "Inspecting…";
    const result = await window.agent.merlinInspectDom();
    $("#merlinDomOutput").textContent = JSON.stringify(result, null, 2);
  });

  $("#initProjectCtx").addEventListener("click", async () => { await api("POST", "/project-context/init"); loadHealth(); });

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
  // Theme switcher
  if (window.themeManager) {
    const switcher = document.createElement('div');
    switcher.className = 'theme-switcher';
    window.themeManager.getAvailableThemes().forEach(theme => {
      const btn = document.createElement('button');
      btn.className = `theme-button ${theme.id === window.themeManager.getCurrentTheme() ? 'active' : ''}`;
      btn.textContent = theme.name;
      btn.onclick = () => {
        window.themeManager.applyTheme(theme.id);
        switcher.querySelectorAll('.theme-button').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      };
      switcher.appendChild(btn);
    });
    document.body.appendChild(switcher);
  }
})();
