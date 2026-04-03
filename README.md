# ChatGPT Web Wrapper

This project now supports two approaches:

1. Browser automation with Playwright
2. A Chrome extension bridge that talks to your real signed-in ChatGPT tab

## Important note

If your goal is to build a production integration, the official API is still the stable option. If your goal is specifically "use the ChatGPT website as my brain," the extension bridge is the closer fit because it runs inside your real Chrome profile and real ChatGPT session.

## Recommended path: extension bridge

This avoids the test-profile issue entirely.

### What it does

- Runs a content script inside your real ChatGPT tab
- Connects that tab to a local bridge server on `127.0.0.1:3847`
- Lets your local code send prompts and read visible messages over HTTP

### Start the local bridge server

```bash
npm run bridge:server
```

### Load the extension in Chrome

1. Open `chrome://extensions`
2. Enable Developer mode
3. Click Load unpacked
4. Select [extension](/Users/deepjyotiray/Documents/ChatGPT%20Wrapper/extension)
5. Open your normal signed-in ChatGPT tab

### Use the bridge

Health check:

```bash
curl http://127.0.0.1:3847/health
```

Read visible messages:

```bash
curl http://127.0.0.1:3847/messages
```

Send a prompt:

```bash
curl -X POST http://127.0.0.1:3847/send \
  -H "content-type: application/json" \
  -d '{"prompt":"Say hello in one sentence"}'
```

Read the last assistant message:

```bash
curl http://127.0.0.1:3847/last-assistant
```

## Bridge Quickstart

- Start the bridge server with npm run bridge:server
- Load the Chrome extension from the extension folder
- Test the connection with curl http://127.0.0.1:3847/health


## Starter coding agent

You can now run a minimal coding-agent loop that uses your real ChatGPT tab as the planner and a local structured tool runner as the executor.

Start the bridge first:

```bash
npm run bridge:server
```

Then run the agent:

```bash
npm run agent -- start "Inspect this repo and add a README section describing the bridge API"
```

The agent will use a live terminal dashboard by default when running in a TTY. You can force it on with `--tui` or disable it with `--no-tui`.

For a persistent full-screen terminal app with sessions and history:

```bash
npm run agent:tui
```

How it works:

- The local runner sends your goal plus repo context to ChatGPT through the bridge
- ChatGPT replies with exactly one JSON tool call at a time
- The runner executes that tool locally
- The tool result is sent back to ChatGPT
- The loop continues until ChatGPT returns `{"type":"done",...}`

Current tools:

- `list_files`
- `read_file`
- `read_file_range`
- `read_multiple_files`
- `file_metadata`
- `summarize_file`
- `write_file`
- `replace_text`
- `insert_text`
- `apply_patch`
- `remember_text`
- `search`
- `run_command`
- `run_tests`
- `run_build`
- `run_lint`
- `run_format_check`
- `git_status`
- `git_diff`
- `git_diff_cached`
- `git_show`
- `task_checkpoint_save`
- `task_checkpoint_load`

CLI commands:

- `npm run agent -- start "<goal>"`
- `npm run agent -- resume <task-id>`
- `npm run agent -- status <task-id>`
- `npm run agent -- list`
- `npm run agent -- abort <task-id>`
- `npm run agent:tui`

TUI:

- Persistent full-screen interface with sessions on the left and task detail/history on the right
- Supports command bar actions like `start <goal>`, `resume <task-id>`, `abort <task-id>`, `refresh`, and `quit`
- Shows current planner/tool history, changed files, and diff preview
- `npm run agent -- ...` still uses the lightweight dashboard flow
- Displays the latest non-edit textual output (e.g., a LinkedIn post) in the history pane and lets the planner capture it via the `remember_text` tool so you can either read it immediately or have the agent write it to a file automatically

Optional config:

- Create `.chatgpt-agent.json` in the workspace root to tune compaction and hooks
- Supported keys:
  - `compaction.keepRecentSteps`
  - `compaction.maxPromptChars`
  - `hooks.onTaskStart`
  - `hooks.onTaskComplete`
  - `hooks.beforeTool`
  - `hooks.afterTool`

Example:

```json
{
  "compaction": {
    "keepRecentSteps": 8,
    "maxPromptChars": 30000
  },
  "hooks": {
    "beforeTool": [
      "echo \"running $AGENT_TOOL_NAME for $AGENT_TASK_ID\""
    ],
    "onTaskComplete": [
      "echo \"task $AGENT_TASK_ID finished with status $AGENT_TASK_STATUS\""
    ]
  }
}
```

Current limits:

- One tool call per step
- `write_file` still replaces the whole file content when used
- `apply_patch` now accepts unified diff style hunks, but it is still text-based rather than AST-aware
- `replace_text` and `insert_text` are still literal-text operations
- Safety modes exist as `auto`, `guarded`, and `read_only`
- No interactive terminal support
- Best suited for small to medium coding tasks

## Playwright mode

Playwright mode is still available below, but it may open a separate automated browser context unless you attach Chrome under very specific conditions.

## What it does

- Opens the ChatGPT website in a persistent browser profile
- Reuses your logged-in session after the first login
- Sends a prompt into the ChatGPT composer
- Waits for the assistant response to finish
- Reads conversation messages from the page

## Setup

```bash
npm install
npx playwright install chromium
```

## First run

Run this once:

```bash
npm run chat -- "Say hello in one sentence"
```

On the first run:

1. A Chromium window will open.
2. Log in to ChatGPT manually if needed.
3. Re-run the command after login if the script exits before the composer is visible.

Your browser session is saved under `.auth/chatgpt`.

## Use your existing Chrome session

If you want to automate the already-running Chrome window and open ChatGPT in a new tab inside that same session, attach over Chrome DevTools Protocol.

The easiest way on macOS is:

```bash
npm run chrome:attach -- "Summarize my last visible conversation in one sentence"
```

Important:

1. This will start Chrome with remote debugging if needed, then attach to it.
2. The wrapper opens a new tab in that same Chrome session.
3. Make sure the attached Chrome session is already logged into ChatGPT.

If you want to launch Chrome yourself first, you can still do it manually:

```bash
open -na "Google Chrome" --args --remote-debugging-port=9222
export CHROME_CDP_URL="http://127.0.0.1:9222"
npm run chat -- "Summarize my last visible conversation in one sentence"
```

If you prefer launching a separate automated Chrome instance with a chosen profile directory, the older `CHROME_USER_DATA_DIR` and `CHROME_PROFILE_DIRECTORY` mode is still available, but it is not the same thing as attaching to an existing window.

## Example usage in code

```ts
import { ChatGPTWebWrapper } from "./src/index.js";

const wrapper = new ChatGPTWebWrapper({
  headless: false,
  cdpUrl: process.env.CHROME_CDP_URL
});

await wrapper.start();
await wrapper.ensureReady();
await wrapper.sendMessage("Write a haiku about rain.");
const reply = await wrapper.waitForAssistantResponse();
console.log(reply);

const messages = await wrapper.readMessages();
console.log(messages);

await wrapper.close();
```

## API

### `new ChatGPTWebWrapper(options)`

Options:

- `headless`: Launch browser headlessly or visibly. Default: `false`
- `userDataDir`: Folder for the persistent logged-in profile. Default: `.auth/chatgpt`
- `browserChannel`: Set to `"chrome"` to launch installed Google Chrome with your real profile
- `profileDirectory`: Chrome profile folder name such as `Default` or `Profile 1`
- `cdpUrl`: Attach to an already running Chrome instance, for example `http://127.0.0.1:9222`
- `chatUrl`: Defaults to `https://chatgpt.com/`
- `timeoutMs`: Playwright timeout. Default: `60000`

### Methods

- `start()`: launches the browser session
- `ensureReady()`: checks that the composer is visible
- `sendMessage(text)`: types and submits a message
- `waitForAssistantResponse()`: waits until generation stops and returns the latest assistant message
- `readMessages()`: returns all visible conversation messages
- `getLastMessage(role?)`: returns the last message, optionally filtered by role
- `gotoNewChat()`: navigates to a fresh chat page
- `close()`: closes the browser

## Limitations

- This depends on ChatGPT's current DOM structure, so selectors may need updates if the website changes.
- Attaching to an existing Chrome window requires Chrome to be started with remote debugging enabled.
- CAPTCHA, login challenges, rate limits, and plan-gated UI changes can break automation.
- This is UI automation, not a stable public integration surface.
