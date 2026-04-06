# ROADMAP.md

# ChatGPT-Agent Roadmap

## Goal

Turn ChatGPT-Agent into a **reliable, self-recovering local coding agent** that:
- works without API keys or token budgets
- handles multi-file implementation tasks end-to-end
- recovers gracefully from bridge failures and planner errors
- maintains useful context across sessions
- gives the human clear visibility into what it's doing and why

## Current Pain Points

### 1. Bridge fragility
- ChatGPT DOM selectors in `extension/content.js` break when OpenAI updates the UI
- The Electron webview bridge depends on ChatGPT's internal page structure
- No automatic detection of selector staleness — failures surface as empty responses or timeouts

### 2. Planner reply parsing
- ChatGPT sometimes returns markdown-wrapped JSON, prose before/after JSON, or multi-block responses
- The repair loop (parse → ask to fix → retry) works but burns 2-3 extra turns on bad replies
- No structured output enforcement — relies on prompt instructions alone

### 3. Context window pressure
- Large codebases exceed the prompt budget quickly
- The context pipeline scores files well but can't fit enough for complex cross-module tasks
- Compaction drops older steps, losing important context about what was already tried

### 4. Edit application reliability
- `apply_patch` fails on context mismatch when ChatGPT generates slightly wrong diff context lines
- The local Ollama edit path (orchestrator.ts) depends on a second LLM being available
- No automatic retry with relaxed matching when patches fail

### 5. No test/verification loop
- The runtime requires verification before `done` but doesn't auto-run tests
- The agent must be told to run tests — it doesn't infer which tests are relevant
- No test-failure → re-edit → re-test cycle

### 6. Session continuity
- Conversations persist but the ChatGPT session resets on app restart
- Memory entries help but aren't automatically updated after tasks
- No way to resume a partially completed task from where it left off

## Product Principles

1. **Zero-config start** — `npm run app:dev` should work out of the box with just a ChatGPT tab.
2. **Local-first** — code, state, memory, and conversations stay on the machine.
3. **Graceful degradation** — bridge down → Ollama fallback → manual mode. Never a dead end.
4. **Transparency** — every tool call, planner reply, and decision is visible and logged.
5. **Safety by default** — destructive operations require explicit mode escalation.
6. **Context quality over quantity** — send the right 5 files, not 50 irrelevant ones.

## Roadmap

## Phase 1 — Bridge Reliability

### 1. Selector health monitoring
Add a periodic health check that validates ChatGPT DOM selectors are still working.

Acceptance:
- bridge reports `selector_stale` when known selectors fail to match
- Electron app shows a clear warning with instructions to update
- health endpoint includes selector validation status

### 2. Response extraction hardening
Improve planner reply parsing to handle more ChatGPT response formats.

Acceptance:
- handle JSON inside markdown code fences (already partial)
- handle JSON preceded/followed by prose
- handle streaming artifacts (partial JSON, repeated blocks)
- reduce repair-loop frequency by 50%+

### 3. Automatic bridge reconnection
When the bridge connection drops, automatically retry with backoff.

Acceptance:
- bridge reconnects within 10s of connection loss
- in-flight turns are retried once after reconnection
- SSE clients receive `bridge:reconnected` event

## Phase 2 — Smarter Context

### 4. Incremental context updates
Instead of rebuilding full context each turn, send only what changed since the last turn.

Acceptance:
- tool results that read files update the context cache
- subsequent prompts reference cached file state instead of re-reading
- prompt size stays stable across turns instead of growing

### 5. Automatic memory updates
After task completion, automatically update relevant memory entries.

Acceptance:
- `active-context` updated with what was done and what's next
- `learnings` updated when the agent hit errors and recovered
- `patterns` updated when new coding patterns are established

### 6. Cross-session task resumption
Allow resuming a task from its last checkpoint.

Acceptance:
- `POST /tasks/:id/resume` restarts the tool loop from the last step
- task state includes enough context to continue without re-reading everything
- the planner receives a summary of prior progress

## Phase 3 — Edit Reliability

### 7. Fuzzy patch application
When `apply_patch` fails on context mismatch, retry with fuzzy matching.

Acceptance:
- whitespace-only mismatches are auto-corrected
- single-line context drift (±2 lines) is handled
- failed patches report the specific mismatch for debugging

### 8. Edit verification loop
After applying edits, automatically run relevant tests and feed failures back.

Acceptance:
- agent detects which test files correspond to edited files
- test failures trigger a re-edit cycle (max 2 retries)
- the human sees each cycle: edit → test → fix → test

### 9. Multi-file atomic edits
Group related edits across files and apply them atomically.

Acceptance:
- if any file in a group fails to patch, all are rolled back
- git stash used as the rollback mechanism
- the agent retries the full group with corrected patches

## Phase 4 — Autonomous Task Execution

### 10. Task decomposition
For complex tasks, automatically break into subtasks and execute sequentially.

Acceptance:
- planner produces a plan with 2-5 subtasks
- each subtask runs as a focused tool loop
- subtask results feed into the next subtask's context

### 11. Self-correction on repeated failures
When the same tool fails 3+ times, automatically change strategy.

Acceptance:
- repeated `apply_patch` failures trigger a switch to `write_file`
- repeated search failures trigger broader search patterns
- the agent explains the strategy change in its reasoning

### 12. Parallel context gathering
Read multiple files and run searches concurrently instead of sequentially.

Acceptance:
- `read_multiple_files` used by default for initial context
- search and file reads run in parallel where independent
- initial context gathering is 2-3x faster

## Phase 5 — Developer Experience

### 13. Real-time progress UI
Show granular progress in the Electron app during task execution.

Acceptance:
- each tool call appears as it happens (via SSE)
- file diffs are shown inline as they're applied
- thinking/reasoning steps are visible in a collapsible panel

### 14. Undo/rollback support
Allow undoing the last task's changes with one action.

Acceptance:
- each task creates a git stash before starting
- `POST /tasks/:id/rollback` restores the stash
- the UI shows a "Revert" button after task completion

### 15. Custom tool registration
Allow users to register project-specific tools via config.

Acceptance:
- `.chatgpt-agent.json` supports a `tools` array with custom shell commands
- custom tools appear in the planner's tool list
- tool output follows the standard `ToolResult` shape

## Immediate Backlog

Priority: P0 = blocks daily use, P1 = blocks reliability, P2 = quality of life.

**P0 — Fix first**
1. Harden ChatGPT DOM selectors in `extension/content.js` — current selectors break on UI updates
2. Fix `apply_patch` context mismatch failures — most common tool failure in practice
3. Add Ollama availability check on startup — agent silently fails intent classification when Ollama is down

**P1 — Reliability**
4. Add retry with backoff to `ElectronBridgePlanner.sendTurn` — single network hiccup kills the task
5. Improve `parsePlannerReply` to handle more response formats — reduce repair loop frequency
6. Add automatic `git stash` before edit tasks — safety net for failed edits
7. Update memory entries after task completion — currently manual only

**P2 — Quality of life**
8. Add `/tasks/:id/resume` endpoint — allow continuing interrupted tasks
9. Show real-time tool execution in Electron UI via SSE events — currently only final result visible
10. Add `--workspace` CLI flag to `api:server` — avoid relying on `process.cwd()`
11. Support custom tools in `.chatgpt-agent.json` — project-specific commands

## MVP Success Criteria

ChatGPT-Agent is ready for daily use when:
- the bridge stays connected for a full work session without manual intervention
- 80%+ of `apply_patch` calls succeed on first attempt
- the agent can complete a 3-file edit task end-to-end without human correction
- task state persists across app restarts
- a developer can go from `npm run app:dev` to a working agent in under 60 seconds

## Short Version

ChatGPT-Agent should evolve from:
- a clever bridge hack that sometimes works

to:
- a **reliable local coding agent** that uses your existing ChatGPT subscription
- with **self-recovering bridge connections**, **fuzzy edit application**, and **automatic verification**
- that a developer trusts enough to let run while they do something else
