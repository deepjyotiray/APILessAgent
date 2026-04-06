# Architecture

`mermaid
graph TB
 subgraph User["👤 User"]
 ElectronUI["Electron Renderer<br/><i>app/renderer/app.js</i>"]
 end

 subgraph Electron["Electron Main Process — app/main.cjs"]
 MainProcess["Window Manager<br/>Menu · IPC · Lifecycle"]
 ChatGPTView["ChatGPT BrowserView<br/><i>persist:chatgpt session</i>"]
 MerlinView["Merlin BrowserView<br/><i>persist:merlin session</i>"]
 ChatBridge["chatgpt-bridge.cjs<br/><i>executeJavaScript ↔ DOM</i>"]
 MerlinBridgeMod["merlin-bridge.cjs"]
 SessionPool["session-pool.cjs"]
 RelayServer["Bridge Relay HTTP<br/><i>:3851</i>"]
 end

 subgraph APIServer["API Server — src/api-server.ts :3850"]
 Routes["REST Routes<br/>/conversations · /memory<br/>/workspace · /planner · /events (SSE)"]
 end

 subgraph Agent["Agent Layer — src/agent/"]
 Orchestrator["ChatGPTAgent<br/><i>orchestrator.ts</i><br/>classify → explore → instruct → apply"]
 Runtime["AgentRuntime<br/><i>runtime.ts</i><br/>step loop · prompt builder"]
 ContextPipe["ContextPipeline<br/><i>context-pipeline.ts</i><br/>keyword extraction · file ranking"]
 Tools["LocalToolRegistry<br/><i>tools.ts</i><br/>read · write · patch · shell · git"]
 Memory["MemoryStore<br/><i>memory.ts</i>"]
 ConvStore["ConversationStore<br/><i>conversation.ts</i>"]
 TaskState["TaskStateStore<br/><i>state.ts</i>"]
 FileEditor["file-editor.ts<br/><i>Ollama-powered apply</i>"]
 KnowledgeBase["knowledge-base.ts"]
 end

 subgraph Planners["Planner Adapters"]
 ElectronPlanner["ElectronBridgePlanner<br/><i>electron-planner.ts</i>"]
 OllamaPlanner["OllamaPlanner<br/><i>ollama-planner.ts</i>"]
 MerlinPlanner["MerlinBridgePlanner<br/><i>merlin-planner.ts</i>"]
 end

 subgraph External["External Services"]
 ChatGPTWeb["chatgpt.com"]
 MerlinWeb["getmerlin.in"]
 OllamaLocal["Ollama (local)<br/><i>:11434</i>"]
 end

 subgraph ChromeExt["Chrome Extension — extension/"]
 ContentScript["content.js<br/><i>DOM scraping · WebSocket</i>"]
 end

 subgraph Storage["Local Filesystem"]
 AgentState[".agent-state/"]
 AgentMemory[".agent-memory/"]
 AgentConvos[".agent-conversations/"]
 ProjectFiles["Project Source Files"]
 end

 %% User ↔ Electron
 ElectronUI -- "IPC (preload.cjs)" --> MainProcess
 MainProcess --> ChatGPTView
 MainProcess --> MerlinView
 ChatGPTView --> ChatBridge
 MerlinView --> MerlinBridgeMod
 MainProcess --> SessionPool

 %% Electron → Relay → API
 ChatBridge -- "executeJavaScript" --> ChatGPTView
 RelayServer -- "/bridge/*" --> ChatBridge
 RelayServer -- "/bridge/merlin/*" --> MerlinBridgeMod
 APIServer -- "HTTP :3851" --> RelayServer

 %% API Server ↔ Agent
 Routes --> Orchestrator
 Routes --> Memory
 Routes --> ConvStore

 %% Orchestrator internals
 Orchestrator --> ContextPipe
 Orchestrator --> Tools
 Orchestrator --> FileEditor
 Orchestrator --> KnowledgeBase
 Runtime --> Tools
 Runtime --> ContextPipe

 %% Planner selection
 Orchestrator -- "sendTurn()" --> ElectronPlanner
 Orchestrator -. "switchable" .-> OllamaPlanner
 Orchestrator -. "switchable" .-> MerlinPlanner
 ElectronPlanner -- "HTTP :3851" --> RelayServer
 OllamaPlanner -- "HTTP :11434" --> OllamaLocal
 MerlinPlanner -- "HTTP :3851" --> RelayServer

 %% External
 ChatGPTView -- "loads" --> ChatGPTWeb
 MerlinView -- "loads" --> MerlinWeb
 ContentScript -- "WebSocket :3847" --> ChatGPTWeb

 %% Storage
 Tools --> ProjectFiles
 TaskState --> AgentState
 Memory --> AgentMemory
 ConvStore --> AgentConvos

 %% Styling
 classDef external fill:#2d333b,stroke:#f78166,color:#f0f0f0
 classDef electron fill:#1a1e24,stroke:#58a6ff,color:#c9d1d9
 classDef agent fill:#0d1117,stroke:#3fb950,color:#c9d1d9
 classDef storage fill:#161b22,stroke:#8b949e,color:#8b949e

 class ChatGPTWeb,MerlinWeb,OllamaLocal external
 class MainProcess,ChatGPTView,MerlinView,ChatBridge,MerlinBridgeMod,SessionPool,RelayServer electron
 class Orchestrator,Runtime,ContextPipe,Tools,Memory,ConvStore,TaskState,FileEditor,KnowledgeBase agent
 class AgentState,AgentMemory,AgentConvos,ProjectFiles storage
`