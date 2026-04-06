# AGENT.md

This file provides guidance to any coding agent working with code in this repository.

## Detected stack
- Languages: TypeScript (src/), JavaScript (app/, extension/).
- Frameworks: Electron (desktop app), Playwright (browser automation fallback), Node.js HTTP server.
- Runtime: Node.js with ESM (`"type": "module"` in package.json).

## Verification
- Run TypeScript verification: `npm run typecheck`
- Build: `npm run build`
- Start API server: `npm run api:server`
- Launch Electron app: `npm run app`
- Dev mode (both): `npm run app:dev`

## Repository shape
- `src/agent/` — core agent runtime: orchestrator, tools, context pipeline, memory, state, planners, hooks, sub-agents.
- `src/api-server.ts` — local HTTP/SSE API bridge connecting the Electron app and extension to the agent runtime.
- `app/` — Electron main process, renderer UI, ChatGPT/Merlin bridge scripts.
- `extension/` — Chrome content script that connects a live ChatGPT tab to the local bridge server.
- `.agent-state/` — persisted task state (JSON per task UUID).
- `.agent-memory/` — persistent memory entries (markdown files).
- `.agent-conversations/` — conversation history (JSON per conversation UUID).

## Architecture overview
- `AgentRuntime` (runtime.ts) drives the structured tool loop: build prompt → send to planner → parse reply → execute tool → feed result back.
- `ChatGPTAgent` (orchestrator.ts) is the higher-level orchestrator used by the Electron app: classifies intent, gathers context, calls ChatGPT, applies edits via local Ollama.
- `ContextPipeline` (context-pipeline.ts) scores and selects relevant files using keyword matching, ripgrep, import graph traversal, vector similarity, and ranking feedback.
- Planners implement `PlannerAdapter`: `ElectronBridgePlanner` (preferred), `OllamaPlanner` (local fallback), `MerlinBridgePlanner`.
- Tools are registered in `LocalToolRegistry` (tools.ts) — 25 tools covering file I/O, search, shell, git, memory, and checkpoints.

## Working agreement
- Prefer small, focused changes. Use `apply_patch` or `replace_text` over `write_file` for existing files.
- Always read a file before editing it.
- After edits, run `git_diff` and a verification command before marking done.
- Safety modes (`auto`, `guarded`, `read_only`) gate destructive operations — respect them.
- Keep `.agent-memory/` entries up to date when project structure or patterns change.
- Config lives in `.chatgpt-agent.json` at the workspace root.
- Do not overwrite this `AGENT.md` automatically; update it intentionally when workflows change.

## Key conventions
- TypeScript strict mode, ES2022 target, NodeNext module resolution.
- All agent source uses `.js` extensions in imports (NodeNext requirement).
- Tool results follow `{ ok, errorCode?, message, data? }` shape (`ToolResult` type).
- Planner replies are JSON: `{ type: "tool" | "done" | "error", ... }`.
- Output truncation at `AGENT_OUTPUT_LIMIT` (default 12000 chars).
- Base64 variants accepted for all string tool args (e.g. `patchBase64`, `contentBase64`).
