# ChatGPT-Agent Philosophy

## The Browser Is the API

Most coding agents require API keys, token budgets, and billing dashboards. ChatGPT-Agent takes a different approach: it uses the ChatGPT you already have open in your browser as the planning brain, and runs everything else locally.

The insight is simple: **if you can talk to ChatGPT in a tab, your local tools can too.**

A Chrome extension bridges your live ChatGPT session to a local HTTP server. The agent reads your codebase, builds structured prompts, sends them through the bridge, parses the response, and executes tool calls — all without an API key.

## The Two-Layer System

### 1. Remote brain (ChatGPT)
ChatGPT handles reasoning, planning, and code generation. It receives structured prompts with repo context, tool definitions, and task state. It replies with JSON tool calls or completion signals.

The agent doesn't care which model is behind the tab. GPT-4, GPT-4o, whatever OpenAI ships next — the bridge just sends text and reads text.

### 2. Local runtime (your machine)
Everything else runs locally:
- File reading, writing, patching
- Shell commands, git operations
- Context gathering (keyword scoring, import graphs, vector search)
- Memory persistence across sessions
- Safety enforcement (read-only, guarded, auto modes)
- Task state, checkpoints, conversation history

The local runtime is the part that actually touches your code. ChatGPT never sees your files directly — it sees curated context that the pipeline selects.

## Why This Architecture

### No API costs
You're already paying for ChatGPT. This agent rides on that subscription instead of burning tokens through a separate API.

### No credential management
No API keys to rotate, no billing alerts, no rate limit handling. The bridge talks to the same ChatGPT session your browser uses.

### Graceful degradation
If the bridge breaks, the agent falls back to local Ollama models. If Ollama isn't running, the structured tool loop still works — you just need a different planner.

### Privacy by default
Your code stays on your machine. The context pipeline controls exactly what gets sent to ChatGPT. Safety modes prevent destructive operations. Memory and state are local files, not cloud storage.

## What the Agent Actually Does

The agent is not a chatbot wrapper. It runs a structured tool loop:

1. Classify the user's intent (shell, code question, implementation, debugging)
2. Gather relevant context (keyword scoring, ripgrep, import graph, vector similarity)
3. Build a prompt with tool definitions, repo map, and selected file contents
4. Send to ChatGPT, parse the JSON response
5. Execute the tool call locally
6. Feed the result back and repeat

For implementation tasks, it explores the codebase first, generates precise change instructions, then applies edits through a local LLM. The human sees the plan, the diffs, and the results.

## What Still Matters

The agent handles the mechanical parts: reading files, searching code, applying patches, running tests. What it can't replace:

- Knowing what to build
- Judging whether the approach is right
- Understanding the domain beyond the code
- Deciding when to stop

The human sets direction. The agent does the grinding.

## Short Version

**ChatGPT-Agent turns your existing ChatGPT subscription into a local coding agent.**

No API keys. No token billing. Your browser is the API.
The local runtime handles tools, safety, and state.
ChatGPT handles reasoning.
Your code never leaves your machine unless you send it.
