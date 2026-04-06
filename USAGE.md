# ChatGPT-Agent Usage

This guide covers setup, running, configuration, tools, and the API surface.

## Prerequisites

- Node.js (v18+)
- npm
- Chromium (installed via Playwright for fallback mode)
- Optional: [Ollama](https://ollama.ai) for local LLM fallback and intent classification

## Install

```bash
npm install
npx playwright install chromium
```

## Quick start

### Extension bridge (preferred)

1. Start the API server and Electron app:
```bash
npm run app:dev
```

2. Load `extension/` as an unpacked extension in Chrome (`chrome://extensions` → Developer mode → Load unpacked).

3. Open ChatGPT in a Chrome tab. The content script connects automatically.

4. Use the Electron app UI to send tasks.

### Electron app only

```bash
npm run app
```

The app embeds a ChatGPT webview directly — no separate browser tab needed.

### API server only

```bash
npm run api:server
```

The server runs at `http://127.0.0.1:3850` by default.

## Build

```bash
npm run build        # compile TypeScript to dist/
npm run typecheck    # type-check without emitting
```

## macOS distributable

```bash
npm run app:build    # build .dmg for arm64 + x64
npm run app:pack     # package app directory without installer
```

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `APP_PORT` | `3850` | API server port |
| `AGENT_ROOT` | `process.cwd()` | Workspace root directory |
| `BRIDGE_RELAY_URL` | `http://127.0.0.1:3851` | Electron bridge relay URL |
| `AGENT_MAX_STEPS` | `24` | Max tool loop iterations per task |
| `AGENT_OUTPUT_LIMIT` | `12000` | Max chars for tool output truncation |
| `AGENT_COMMAND_TIMEOUT_MS` | `30000` | Shell command timeout |
| `OLLAMA_URL` | `http://localhost:11434` | Ollama API endpoint |
| `CLASSIFY_MODEL` | `qwen2.5-coder:32b` | Ollama model for intent classification |

## Configuration

Place a `.chatgpt-agent.json` in your workspace root:

```json
{
  "hooks": {
    "onTaskStart": ["echo 'Task started'"],
    "onTaskComplete": ["echo 'Task done'"],
    "beforeTool": [],
    "afterTool": []
  },
  "compaction": {
    "keepRecentSteps": 6,
    "maxPromptChars": 24000
  }
}
```

Hook commands receive environment variables: `AGENT_TASK_ID`, `AGENT_TASK_GOAL`, `AGENT_TASK_STATUS`, `AGENT_TOOL_NAME`, `AGENT_TOOL_ARGS`, `AGENT_TOOL_OK`, `AGENT_CHANGED_FILES`.

## Planner backends

Switch planners at runtime via the API:

```bash
# ChatGPT via Electron bridge (default)
curl -X POST http://127.0.0.1:3850/planner -d '{"planner":"chatgpt"}'

# Local Ollama
curl -X POST http://127.0.0.1:3850/planner -d '{"planner":"ollama","model":"qwen2.5-coder:7b"}'

# Merlin bridge
curl -X POST http://127.0.0.1:3850/planner -d '{"planner":"merlin"}'
```

## Safety modes

| Mode | Behavior |
|---|---|
| `auto` | All tools allowed, dangerous commands blocked |
| `guarded` | Shell limited to safe commands (ls, git status, npm test, etc.) |
| `read_only` | No file writes, no destructive commands |

## Tools

### Reading & search
- `list_files` — list directory contents (configurable depth)
- `read_file` — read full file with truncation
- `read_file_range` — read specific line range
- `read_multiple_files` — batch read up to 20 files
- `file_metadata` — file size, timestamps, type
- `summarize_file` — line count, byte size, preview
- `search` — ripgrep search across workspace

### Writing & patching
- `write_file` — create or overwrite a file
- `replace_text` — find and replace in a file
- `insert_text` — insert before/after a marker
- `apply_patch` — apply unified diff patches
- `remember_text` — capture text output, optionally write to file

### Shell & git
- `run_command` — run a shell command (safety-gated)
- `run_tests` — run project test command from package.json
- `run_build` — run project build command
- `run_lint` — run project lint command
- `run_format_check` — run format check if configured
- `git_status` — short git status
- `git_diff` — working tree diff
- `git_diff_cached` — staged diff
- `git_show` — show a git ref

### Task & memory
- `task_checkpoint_save` — save current task state
- `task_checkpoint_load` — restore a saved checkpoint
- `memory_read` — read a memory entry by key
- `memory_write` — write or append to memory
- `memory_list` — list all memory entries

## API endpoints

### Core
| Method | Path | Description |
|---|---|---|
| GET | `/health` | Server health + planner status |
| GET | `/events` | SSE stream for real-time events |
| GET | `/workspace` | Current workspace root |
| POST | `/workspace` | Switch workspace `{ path }` |
| GET | `/planner` | Active planner info |
| POST | `/planner` | Switch planner `{ planner, model? }` |

### Conversations
| Method | Path | Description |
|---|---|---|
| GET | `/conversations` | List all conversations |
| POST | `/conversations` | Create conversation `{ title }` |
| GET | `/conversations/:id` | Load a conversation |
| POST | `/conversations/:id/send` | Send message `{ message }` |
| DELETE | `/conversations/:id` | Delete a conversation |
| DELETE | `/conversations` | Delete all conversations |

### Tasks
| Method | Path | Description |
|---|---|---|
| GET | `/tasks` | List all tasks |
| GET | `/tasks/:id` | Load a task |

### Memory
| Method | Path | Description |
|---|---|---|
| GET | `/memory` | List all memory entries |
| GET | `/memory/:key` | Read a memory entry |
| PUT | `/memory/:key` | Write/append `{ content, mode? }` |
| DELETE | `/memory/:key` | Delete a memory entry |
| POST | `/memory/init` | Initialize default memory entries |

### Project context
| Method | Path | Description |
|---|---|---|
| GET | `/project-context` | Load project instructions (AGENT.md) |
| POST | `/project-context/init` | Create default AGENT.md |

## Memory system

The agent maintains persistent memory in `.agent-memory/`:

| Key | Purpose |
|---|---|
| `project-summary` | What the project does, key technologies |
| `architecture` | Project structure, modules, data flow |
| `patterns` | Coding conventions and style preferences |
| `active-context` | Current work, recent decisions, next steps |
| `learnings` | Gotchas, workarounds, discoveries |

Custom keys are supported. Memory is included in every agent prompt.

## Persistent state

- `.agent-state/<task-uuid>/task.json` — full task state including steps, diffs, verification
- `.agent-conversations/<uuid>.json` — conversation history with messages and task steps
- `.agent-memory/*.md` — memory entries
