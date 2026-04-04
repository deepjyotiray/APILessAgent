const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("agent", {
  getApiPort: () => ipcRenderer.invoke("get-api-port"),
  getRecents: () => ipcRenderer.invoke("get-recents"),
  getWorkspace: () => ipcRenderer.invoke("get-workspace"),
  pickFolder: () => ipcRenderer.invoke("pick-folder"),
  openWorkspace: (dir) => ipcRenderer.invoke("open-workspace", dir),
  openExternal: (url) => ipcRenderer.invoke("open-external", url),
  toggleChatView: () => ipcRenderer.invoke("toggle-chatview"),
  getChatViewVisible: () => ipcRenderer.invoke("get-chatview-visible"),
  chatViewBack: () => ipcRenderer.invoke("chatview-back"),
  chatViewForward: () => ipcRenderer.invoke("chatview-forward"),
  chatViewRefresh: () => ipcRenderer.invoke("chatview-refresh"),
  chatViewHome: () => ipcRenderer.invoke("chatview-home"),
  bridgeStatus: () => ipcRenderer.invoke("bridge:status"),
  importChromeSession: () => ipcRenderer.invoke("import-chrome-cookies"),
  loginChatGPT: () => ipcRenderer.invoke("login-chatgpt"),
  onAction: (cb) => ipcRenderer.on("action", (_, action) => cb(action)),
  onNavigate: (cb) => ipcRenderer.on("navigate", (_, page) => cb(page)),
  onWorkspaceChanged: (cb) => ipcRenderer.on("workspace-changed", (_, path) => cb(path)),
  onChatViewToggled: (cb) => ipcRenderer.on("chatview-toggled", (_, visible) => cb(visible))
});
