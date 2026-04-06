# API Less Agent - Free of Token Cost

**A powerful desktop coding assistant that brings AI-powered development directly to your Mac.** This Electron app embeds ChatGPT or Merlin AI in a native interface, allowing you to interact with your codebase through natural conversation while the agent handles file operations, command execution, and intelligent code analysis.

## ✨ Key Features

### 🖥️ Native Desktop Experience
- **Embedded AI Chat**: Native webviews for ChatGPT and Merlin — no browser extensions needed
- **Session Pool**: Multiple concurrent chat sessions with smart session management
- **Project Workspace**: Pick any directory as your workspace; the agent maintains full context
- **Real-time Updates**: Server-Sent Events (SSE) for live agent status and progress

### 🤖 Multiple AI Backends
- **ChatGPT Mode**: Leverages ChatGPT's reasoning via embedded browser automation
- **Merlin Mode**: Alternative AI backend with ProseMirror-based interface
- **Ollama Mode**: Local LLM support (qwen2.5-coder, deepseek-coder, etc.) for offline work

### 🛠️ Intelligent Code Operations
- **File Operations**: Read, write, edit, and delete files with context awareness
- **Smart Editing**: Multiple edit strategies including exact replacement, fuzzy matching, and diff application
- **Command Execution**: Run shell commands and capture output
- **Project Search**: Ripgrep-powered codebase search
- **Git Integration**: View diffs and track changes

### 🧠 Contextual Intelligence
- **Auto-Generated Knowledge Base**: Builds project summaries, architecture maps, file roles, and API surface documentation using local Ollama
- **Smart Context Ranking**: TF-IDF and semantic embedding-based file ranking
- **Import Graph Analysis**: Understands module dependencies and relationships
- **Symbol Indexing**: Maintains a structural map of classes, functions, and exports
- **Conversation Memory**: Persistent conversation history with task tracking

### 📊 Developer-Friendly UI
- **Project Picker**: Easy workspace selection with recent projects
- **Status Indicators**: Visual feedback for agent thinking, tool execution, and errors
- **Event Timeline**: See every step the agent takes in real-time
- **Menu Integration**: Native macOS menu with keyboard shortcuts

## 🚀 Getting Started

### Installation

```bash
# Clone the repository
git clone <repo-url>
cd ChatGPT-Agent

# Install dependencies
npm install

# Start development mode (API server + Electron app)
npm run app:dev
```

### Building for Production

```bash
# Build TypeScript sources
npm run app:build

# Package as macOS app
npm run app:pack
```

### Prerequisites

- **Node.js** v18+ (tested on v24.1.0)
- **macOS** (current version targets Darwin/arm64)
- **Ollama** (optional, for local LLM and knowledge base generation): [Install Ollama](https://ollama.ai)

### First Run

1. Launch the app (`npm run app:dev`)
2. Log in to ChatGPT or Merlin in the embedded webview (one-time setup)
3. Select your project workspace via "Open Folder"
4. Start chatting! The agent will automatically:
   - Build a knowledge base on first use (if Ollama is running)
   - Index your codebase structure
   - Rank relevant files for context

## 💡 Usage Examples

**Ask questions about your code:**
```
"What does the orchestrator.ts file do?"
"How does the session pool work?"
```

**Request implementations:**
```
"Add error handling to the API server"
"Create a new tool for running tests"
```

**Debug issues:**
```
"Why is the webview not loading?"
"Find all TODO comments in the agent module"
```

**Refactor code:**
```
"Extract the diff parsing logic into a separate function"
"Rename getUserData to fetchUser across the codebase"
```

## 🏗️ Architecture Overview

| Layer | Module(s) | Purpose |
|---|---|---|
| **Electron Frontend** | `app/main.cjs`, `app/renderer/app.js` | Main Electron process, window management, and menu. Renderer provides the UI: project picker, chat interface, status display, and event timeline. |
| **Orchestrator** | `src/agent/orchestrator.ts` (`ChatGPTAgent`) | Core agent loop: interprets user queries, gathers context via embedding ranking, executes tool calls, and manages the conversation flow. |
| **Planner Backends** | `src/agent/electron-planner.ts`, `src/agent/merlin-planner.ts`, `src/agent/ollama-planner.ts` | Pluggable AI backends implementing `PlannerAdapter`. Each communicates with a different AI service (ChatGPT webview, Merlin webview, or local Ollama). |
| **Browser Bridges** | `app/chatgpt-bridge.cjs`, `app/merlin-bridge.cjs` | In-process webview controllers that automate ChatGPT and Merlin interactions: logging in, composing messages, reading responses, managing sessions. |
| **Session Pool** | `app/session-pool.cjs` | Manages concurrent ChatGPT/Merlin sessions with pooling and reuse logic to avoid rate limits. |
| **API Server** | `src/api-server.ts` | Express-based HTTP API with SSE support. Exposes agent endpoints: `/query`, `/status`, `/chat`. Used by the Electron renderer for real-time communication. |
| **Tool Runtime** | `src/agent/tools.ts`, `src/agent/runtime.ts` | `LocalToolRegistry` defines available tools (`read_file`, `write_file`, `replace_text`, `run_command`, `search`, `git_diff`, etc.). `AgentRuntime` executes tools with error handling and verification. |
| **Context Pipeline** | `src/agent/context-pipeline.ts` | Intelligent context scoring: keyword matching, ripgrep search, TF-IDF ranking, and semantic embeddings. Formats results with symbols, imports, and usage graphs. |
| **Knowledge Base** | `src/agent/knowledge-base.ts` | Auto-generates project documentation (summary, architecture, file roles, API surface, patterns, dependencies) using Ollama on first workspace load. |
| **Smart File Editing** | `src/agent/fuzzy-match.ts`, `src/agent/smart-patch.ts` | Multiple edit strategies: exact line replacement, fuzzy matching, diff application, and full-file rewrites for robust code modification. |
| **Semantic Search** | `src/agent/vector-index.ts` (`VectorStore`) | Embeds code via Ollama (`nomic-embed-text`), stores chunks, and performs cosine-similarity search for semantic context retrieval. |
| **Project Analysis** | `src/agent/repo-map.ts`, `src/agent/import-graph.ts` | Builds structural maps: symbol index, import graph, file dependencies. Enables usage-based context ranking and architectural understanding. |
| **Conversation Memory** | `src/agent/conversation.ts` (`ConversationStore`) | Persistent storage for conversations, messages, task history, and agent state per workspace. |
| **Task Management** | `src/agent/state.ts` (`TaskStateStore`) | Checkpointed task tracking with status progression (started → thinking → tool_call → completed/failed). |
| **Memory Store** | `src/agent/memory.ts` (`MemoryStore`) | Long-term memory for agent decisions, patterns learned, and project-specific notes. |
| **Hooks** | `src/agent/hooks.ts` (`HookRunner`) | Lifecycle callbacks: `onTaskStart`, `onTaskComplete`, `beforeTool`, `afterTool` for extensibility. |
| **Sub-Agents** | `src/agent/sub-agents.ts` (`SubAgentRunner`) | Specialized agents for different phases: planning, code exploration, editing, writing, and review. |
| **Conversation Summarizer** | `src/agent/conversation-summarizer.ts` | Intelligent cross-turn memory: summarizes conversation history via Ollama when token pressure builds, injects running summary into prompts. |
| **Ranking Feedback** | `src/agent/ranking-feedback.ts` | Tracks which files were useful in past interactions to boost their relevance in future context selections. |
| **Configuration** | `src/agent/config.ts` | Loads environment-based settings for context limits, timeouts, model selection, and behavior/types.ts` → `AgentConfig`. |
| **Project Context** | `src/agent/project-context.ts` | Loads an optional `AGENT.md` at the repo root and injects its contents into every prompt. |

## How Context Is Built

The context pipeline uses a multi-signal ranking approach:

1. **Keyword extraction** — identifiers, camelCase, snake_case, quoted phrases from the user message
2. **Ripgrep search** — TF-IDF-like scoring based on grep hit counts per file
3. **Explicit file detection** — file paths mentioned in the user message (e.g. "read README.md") are force-included with case-insensitive resolution
4. **Embedding search** — Ollama `nomic-embed-text` embeds code chunks (60 lines, 10-line overlap), cosine similarity ranks them against the query. Full chunk text is stored and passed to the LLM.
5. **Import graph expansion** — directly connected files (1-2 hops) are added within budget
6. **Ranking feedback** — files used/edited in past tasks get a persistent boost

The formatted context sent to the planner includes:
- **Symbol index** — functions, classes, interfaces per file with line numbers
- **Usage graph** — imports and callers for the top files
- **File contents** — embedding-ranked, with smart truncation at function boundaries
- **Semantic chunks** — additional embedding-matched code snippets not in the main file list

## Planner Backends

All planners implement `PlannerAdapter` (`sendTurn`, `startSession`, `resetSession`, `getPlannerStatus`). The orchestrator is fully planner-agnostic.

1. **ChatGPT Bridge** (`src/agent/electron-planner.ts` + `app/chatgpt-bridge.cjs`) — Embeds ChatGPT in an Electron `BrowserView`, communicates via DOM injection. Preferred for daily use.
2. **Merlin Bridge** (`src/agent/merlin-planner.ts` + `app/merlin-bridge.cjs`) — Embeds Merlin (getmerlin.in) in a second `BrowserView`. Supports multi-part prompt splitting for large context (30k char limit per message). Includes HTML-to-Markdown extraction and thought/answer separation.
3. **Ollama** (`src/agent/ollama-planner.ts`) — Sends prompts to a locally running Ollama model. Auto-pulls missing models. Used when no browser-based planner is available.

Switch planners at runtime via `POST /planner?target=chatgpt|merlin|ollama`.

## Implementation Flow (Tool-Call Loop)

For implementation/debugging tasks, the orchestrator runs a structured tool-call loop:

```
User message
  → classifyIntent() → IMPLEMENTATION / DEBUGGING
  → extractExplicitFiles() from user message
  → gatherContext() with embedding ranking + usage graph
  → Explore phase: planner analyzes code with full context
  → NEED_FILE loop: large files sent in multiple parts (12k per part)
  → Tool-call loop (up to 15 steps):
      → Planner emits: {"type":"tool","tool":"replace_text","args":{...}}
      → Local tool registry executes directly
      → Result fed back to planner
      → Planner emits next tool call or {"type":"done"}
  → JSON parse retry with protocol-error prompt on failure
```

The planner generates exact `oldText`/`newText` for `replace_text` because it has the file content in context — no re-interpretation by a second model needed.

## QA / Architecture Flow

For code questions, the orchestrator uses a single-call path:

```
User message
  → classifyIntent() → CODEBASE_QA / ARCHITECTURE
  → gatherContext() with embeddings
  → Build repo map (symbols + imports)
  → Single prompt: system + knowledge base + repo map + formatted context + question
  → NEED_FILE follow-up loop (up to 4 rounds, multi-part for large files)
  → Direct prose answer (no tool calls)
```

## Electron Desktop App

- **Main process** — `app/main.cjs` starts the API server, creates the main `BrowserWindow`, and embeds `BrowserView`s for ChatGPT and Merlin.
- **Renderer** — `app/renderer/app.js` connects to the API via SSE, displays conversation history, and supports workspace switching.
- **ChatGPT Bridge** — `app/chatgpt-bridge.cjs` provides DOM interaction functions for the ChatGPT webview.
- **Merlin Bridge** — `app/merlin-bridge.cjs` provides DOM interaction functions for the Merlin webview, including multi-part prompt splitting and HTML-to-Markdown response extraction.

## API Server

Implemented in `src/api-server.ts`:

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Health check + planner status |
| `GET` | `/messages` | SSE stream of agent events |
| `POST` | `/send` | Submit a user prompt |
| `GET` | `/last-assistant` | Most recent assistant reply |
| `POST` | `/reset` | Reset the current planner session |
| `POST` | `/planner` | Switch planner (`?target=chatgpt\|merlin\|ollama`) |
| `GET` | `/conversations` | List stored conversations |
| `POST` | `/conversations` | Create a new conversation |

## Quickstart

```bash
# Install dependencies
npm install

# Start only the API server
npm run api:server

# Start only the Electron UI (auto-starts API if not running)
npm run app

# Development: run both together
npm run app:dev
```

### Prerequisites

- **Ollama** (recommended) — for embeddings (`nomic-embed-text`), conversation summarization, and knowledge base generation (`qwen2.5-coder:7b`). Install from [ollama.com](https://ollama.com). Models are auto-pulled on first use.
- **Node.js 18+**
- **Electron** (bundled via devDependencies)

### Build & Package (macOS)

```bash
npm run app:build   # distributable bundle
npm run app:pack    # .dmg installer
```

## Configuration

`src/agent/config.ts` loads `.chatgpt-agent.json` from the workspace root:

- `compaction.keepRecentSteps` — how many recent steps to keep in prompt (default: 6)
- `compaction.maxPromptChars` — total prompt character budget (default: 24000)
- `hooks` — optional lifecycle callbacks defined in `src/agent/hooks.ts`

### Environment Variables

| Variable | Default | Purpose |
|---|---|---|
| `OLLAMA_URL` | `http://localhost:11434` | Ollama API endpoint |
| `EMBED_MODEL` | `nomic-embed-text` | Model for vector embeddings |
| `CLASSIFY_MODEL` | `qwen2.5-coder:7b` | Model for intent classification |
| `EDITOR_MODEL` | `qwen2.5-coder:7b` | Model for fallback file editing |
| `KB_MODEL` | `qwen2.5-coder:7b` | Model for knowledge base generation |
| `AGENT_MAX_STEPS` | `24` | Max steps in runtime task loop |
| `AGENT_OUTPUT_LIMIT` | `12000` | Max chars for diff/output in prompts |

## Project-Level Instructions

Create an `AGENT.md` file at the repository root to give the agent persistent guidance (coding standards, prohibited files, preferred patterns, etc.). Loaded by `src/agent/project-context.ts` and injected into every prompt.
