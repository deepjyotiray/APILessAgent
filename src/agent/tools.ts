import { exec } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import type {
  ToolDefinition,
  ToolExecutionContext,
  ToolName,
  ToolRegistry,
  ToolResult
} from "./types.js";
import { MemoryStore } from "./memory.js";

const execAsync = promisify(exec);
const OUTPUT_LIMIT = Number(process.env.AGENT_OUTPUT_LIMIT ?? "12000");
const COMMAND_TIMEOUT_MS = Number(process.env.AGENT_COMMAND_TIMEOUT_MS ?? "30000");

export class LocalToolRegistry implements ToolRegistry {
  private readonly tools = new Map<ToolName, ToolDefinition>();

  constructor() {
    for (const tool of createToolDefinitions()) {
      this.tools.set(tool.name, tool);
    }
  }

  list(): ToolDefinition[] {
    return [...this.tools.values()];
  }

  get(name: ToolName): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  async execute(name: ToolName, args: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return {
        ok: false,
        errorCode: "unknown_tool",
        message: `Unknown tool: ${name}`
      };
    }

    try {
      return await tool.execute(args, context);
    } catch (error) {
      return {
        ok: false,
        errorCode: "tool_execution_failed",
        message: error instanceof Error ? error.message : String(error)
      };
    }
  }
}

function createToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: "list_files",
      description: "List files and directories under a path.",
      execute: async (args, context) => {
        const target = resolveWorkspacePath(context.root, asString(args.path) ?? ".");
        const maxDepth = asNumber(args.maxDepth) ?? 2;
        const results: string[] = [];
        await walk(context.root, target, 0, maxDepth, results);
        return ok("Listed files.", { path: relativeToRoot(context.root, target), files: results.slice(0, 500) });
      }
    },
    {
      name: "read_file",
      description: "Read a full file with output truncation.",
      execute: async (args, context) => {
        const target = resolveWorkspacePath(context.root, asString(args.path));
        const content = await fs.readFile(target, "utf8");
        return ok("Read file.", { path: relativeToRoot(context.root, target), content: limitOutput(content) });
      }
    },
    {
      name: "read_file_range",
      description: "Read a specific line range from a file.",
      execute: async (args, context) => {
        const target = resolveWorkspacePath(context.root, asString(args.path));
        const startLine = asNumber(args.startLine) ?? 1;
        const endLine = asNumber(args.endLine) ?? startLine + 79;
        if (startLine < 1 || endLine < startLine) {
          return err("invalid_args", "Invalid line range.");
        }

        const content = await fs.readFile(target, "utf8");
        const lines = content.split("\n").slice(startLine - 1, endLine);
        return ok("Read file range.", {
          path: relativeToRoot(context.root, target),
          startLine,
          endLine,
          content: limitOutput(lines.join("\n"))
        });
      }
    },
    {
      name: "read_multiple_files",
      description: "Read several files in one tool call.",
      execute: async (args, context) => {
        const paths = Array.isArray(args.paths) ? args.paths.filter((value): value is string => typeof value === "string") : [];
        if (!paths.length) {
          return err("invalid_args", "read_multiple_files requires args.paths.");
        }

        const files = [];
        for (const item of paths.slice(0, 20)) {
          const target = resolveWorkspacePath(context.root, item);
          const content = await fs.readFile(target, "utf8");
          files.push({
            path: relativeToRoot(context.root, target),
            content: limitOutput(content)
          });
        }

        return ok("Read multiple files.", { files });
      }
    },
    {
      name: "file_metadata",
      description: "Read file size and timestamps.",
      execute: async (args, context) => {
        const target = resolveWorkspacePath(context.root, asString(args.path));
        const stat = await fs.stat(target);
        return ok("Read file metadata.", {
          path: relativeToRoot(context.root, target),
          size: stat.size,
          modifiedAt: stat.mtime.toISOString(),
          createdAt: stat.birthtime.toISOString(),
          isDirectory: stat.isDirectory()
        });
      }
    },
    {
      name: "summarize_file",
      description: "Return a lightweight summary of a file.",
      execute: async (args, context) => {
        const target = resolveWorkspacePath(context.root, asString(args.path));
        const content = await fs.readFile(target, "utf8");
        const lines = content.split("\n");
        return ok("Summarized file.", {
          path: relativeToRoot(context.root, target),
          lineCount: lines.length,
          byteSize: Buffer.byteLength(content, "utf8"),
          preview: limitOutput(lines.slice(0, 40).join("\n"))
        });
      }
    },
    {
      name: "write_file",
      description: "Write a full file.",
      execute: async (args, context) => {
        if (context.safetyMode === "read_only") {
          return err("blocked_by_mode", "write_file is blocked in read_only mode.");
        }
        const target = resolveWorkspacePath(context.root, asString(args.path));
        const content = decodeStringArg(args, "content");
        if (content === undefined) {
          return err("invalid_args", "write_file requires args.content or args.contentBase64.");
        }

        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, content, "utf8");
        return ok("Wrote file.", {
          path: relativeToRoot(context.root, target),
          bytes: Buffer.byteLength(content, "utf8")
        });
      }
    },
    {
      name: "replace_text",
      description: "Replace text in a file.",
      execute: async (args, context) => {
        if (context.safetyMode === "read_only") {
          return err("blocked_by_mode", "replace_text is blocked in read_only mode.");
        }
        const target = resolveWorkspacePath(context.root, asString(args.path));
        const oldText = decodeStringArg(args, "oldText");
        const newText = decodeStringArg(args, "newText") ?? "";
        const replaceAll = asBoolean(args.replaceAll) ?? false;
        if (oldText === undefined) {
          return err("invalid_args", "replace_text requires args.oldText or args.oldTextBase64.");
        }

        const original = await fs.readFile(target, "utf8");
        const count = countOccurrences(original, oldText);
        if (count === 0) {
          return err("text_not_found", "replace_text could not find oldText.");
        }

        const updated = replaceAll ? original.split(oldText).join(newText) : original.replace(oldText, newText);
        await fs.writeFile(target, updated, "utf8");
        return ok("Replaced text.", {
          path: relativeToRoot(context.root, target),
          replacements: replaceAll ? count : 1
        });
      }
    },
    {
      name: "insert_text",
      description: "Insert text before or after a marker.",
      execute: async (args, context) => {
        if (context.safetyMode === "read_only") {
          return err("blocked_by_mode", "insert_text is blocked in read_only mode.");
        }
        const target = resolveWorkspacePath(context.root, asString(args.path));
        const text = decodeStringArg(args, "text");
        const before = decodeStringArg(args, "before");
        const after = decodeStringArg(args, "after");
        if (text === undefined || (!before && !after)) {
          return err("invalid_args", "insert_text requires text plus before or after, with optional Base64 forms.");
        }

        const original = await fs.readFile(target, "utf8");
        let updated: string;
        if (after) {
          const index = original.indexOf(after);
          if (index === -1) {
            return err("marker_not_found", "insert_text could not find args.after.");
          }
          updated = `${original.slice(0, index + after.length)}${text}${original.slice(index + after.length)}`;
        } else {
          const index = original.indexOf(before!);
          if (index === -1) {
            return err("marker_not_found", "insert_text could not find args.before.");
          }
          updated = `${original.slice(0, index)}${text}${original.slice(index)}`;
        }

        await fs.writeFile(target, updated, "utf8");
        return ok("Inserted text.", {
          path: relativeToRoot(context.root, target),
          insertedBytes: Buffer.byteLength(text, "utf8")
        });
      }
    },
    {
      name: "apply_patch",
      description: "Apply a unified diff patch.",
      execute: async (args, context) => {
        if (context.safetyMode === "read_only") {
          return err("blocked_by_mode", "apply_patch is blocked in read_only mode.");
        }
        const patch = decodeStringArg(args, "patch");
        if (!patch) {
          return err("invalid_args", "apply_patch requires args.patch or args.patchBase64.");
        }

        const parsed = parseUnifiedDiff(patch);
        if (parsed.length === 0) {
          return err("invalid_patch", "No file patches found in the unified diff.");
        }
        const touchedPaths: string[] = [];
        for (const filePatch of parsed) {
          if (filePatch.newPath === "/dev/null") {
            return err("delete_blocked", "File deletion via apply_patch is blocked in this version.");
          }
          if (filePatch.oldPath !== "/dev/null" && filePatch.newPath !== filePatch.oldPath) {
            return err("rename_blocked", "File rename via apply_patch is blocked in this version.");
          }

          const target = resolveWorkspacePath(context.root, stripDiffPath(filePatch.newPath));
          const original = filePatch.oldPath === "/dev/null" ? "" : await readFileIfExists(target);
          const updated = applyFilePatch(original, filePatch, relativeToRoot(context.root, target));
          await fs.mkdir(path.dirname(target), { recursive: true });
          await fs.writeFile(target, updated, "utf8");
          touchedPaths.push(relativeToRoot(context.root, target));
        }

        return ok("Applied patch.", { files: touchedPaths, fileCount: touchedPaths.length });
      }
    },
    {
      name: "search",
      description: "Search text in the workspace.",
      execute: async (args, context) => {
        const pattern = asString(args.pattern);
        if (!pattern) {
          return err("invalid_args", "search requires args.pattern.");
        }
        const target = resolveWorkspacePath(context.root, asString(args.path) ?? ".");
        const command = `rg -n --hidden --glob '!node_modules' --glob '!.git' ${shellEscape(pattern)} ${shellEscape(target)}`;
        const result = await runShellCommand(command, context);
        return ok("Search completed.", {
          path: relativeToRoot(context.root, target),
          ...result
        });
      }
    },
    {
      name: "run_command",
      description: "Run a non-interactive shell command.",
      execute: async (args, context) => {
        const command = asString(args.command);
        if (!command) {
          return err("invalid_args", "run_command requires args.command.");
        }
        const validation = validateCommand(command, context.safetyMode);
        if (validation) {
          return err(validation.errorCode, validation.message);
        }
        return ok("Command executed.", {
          command,
          ...(await runShellCommand(command, context))
        });
      }
    },
    {
      name: "run_tests",
      description: "Run project-aware verification commands.",
      execute: async (_args, context) => runProjectCommand("test", context)
    },
    {
      name: "run_build",
      description: "Run the project build command.",
      execute: async (_args, context) => runProjectCommand("build", context)
    },
    {
      name: "run_lint",
      description: "Run the project lint command.",
      execute: async (_args, context) => runProjectCommand("lint", context)
    },
    {
      name: "run_format_check",
      description: "Run the project format-check command if configured.",
      execute: async (_args, context) => runProjectCommand("format_check", context)
    },
    {
      name: "git_status",
      description: "Show git status.",
      execute: async (_args, context) => ok("git status completed.", await runShellCommand("git status --short", context))
    },
    {
      name: "git_diff",
      description: "Show working tree diff.",
      execute: async (args, context) => {
        const maybePath = asString(args.path);
        const command = maybePath
          ? `git diff -- ${shellEscape(resolveWorkspacePath(context.root, maybePath))}`
          : "git diff";
        return ok("git diff completed.", await runShellCommand(command, context));
      }
    },
    {
      name: "git_diff_cached",
      description: "Show staged diff.",
      execute: async (_args, context) => ok("git diff --cached completed.", await runShellCommand("git diff --cached", context))
    },
    {
      name: "git_show",
      description: "Show a git object or ref.",
      execute: async (args, context) => {
        const ref = asString(args.ref) ?? "HEAD";
        return ok("git show completed.", await runShellCommand(`git show ${shellEscape(ref)}`, context));
      }
    },
    {
      name: "remember_text",
      description: "Capture planner output text and optionally write it to a file.",
      execute: async (args, context) => {
        const text = decodeStringArg(args, "text");
        if (!text) {
          return err("invalid_args", "remember_text requires args.text or args.textBase64.");
        }

        const pathValue = decodeStringArg(args, "path");
        if (pathValue) {
          if (context.safetyMode === "read_only") {
            return err("blocked_by_mode", "remember_text cannot write files in read_only mode.");
          }
          const target = resolveWorkspacePath(context.root, pathValue);
          await fs.mkdir(path.dirname(target), { recursive: true });
          await fs.writeFile(target, text, "utf8");
          context.task.lastOutputPath = relativeToRoot(context.root, target);
        }

        context.task.lastOutput = text;
        return ok("Captured text output.", {
          length: Buffer.byteLength(text, "utf8"),
          path: context.task.lastOutputPath ?? null
        });
      }
    },
    {
      name: "task_checkpoint_save",
      description: "Save the current task checkpoint.",
      execute: async (args, context) => {
        const name = await context.saveCheckpoint(asString(args.name));
        return ok("Checkpoint saved.", { name });
      }
    },
    {
      name: "task_checkpoint_load",
      description: "Load a saved task checkpoint summary.",
      execute: async (args, context) => {
        const name = asString(args.name);
        if (!name) {
          return err("invalid_args", "task_checkpoint_load requires args.name.");
        }
        const task = await context.loadCheckpoint(name);
        return ok("Checkpoint loaded.", {
          id: task.id,
          goal: task.goal,
          status: task.status,
          changedFiles: task.changedFiles,
          stepCount: task.steps.length
        });
      }
    },
    {
      name: "memory_read",
      description: "Read a memory entry by key. Keys: project-summary, architecture, patterns, active-context, learnings, or custom.",
      execute: async (args, context) => {
        const key = asString(args.key);
        if (!key) return err("invalid_args", "memory_read requires args.key.");
        const store = new MemoryStore(context.root);
        const content = await store.read(key);
        if (content === null) return err("not_found", `Memory key "${key}" not found.`);
        return ok("Memory read.", { key, content: limitOutput(content) });
      }
    },
    {
      name: "memory_write",
      description: "Write or append to a memory entry. Use mode='append' to add, default overwrites.",
      execute: async (args, context) => {
        if (context.safetyMode === "read_only") return err("blocked_by_mode", "memory_write blocked in read_only.");
        const key = asString(args.key);
        const content = decodeStringArg(args, "content");
        if (!key || content === undefined) return err("invalid_args", "memory_write requires key and content.");
        const store = new MemoryStore(context.root);
        const mode = asString(args.mode);
        if (mode === "append") {
          await store.append(key, content);
        } else {
          await store.write(key, content);
        }
        return ok("Memory written.", { key, mode: mode ?? "overwrite" });
      }
    },
    {
      name: "memory_list",
      description: "List all memory entries with keys and last-updated timestamps.",
      execute: async (_args, context) => {
        const store = new MemoryStore(context.root);
        const entries = await store.list();
        return ok("Memory listed.", {
          entries: entries.map((e) => ({ key: e.key, updatedAt: e.updatedAt, preview: e.content.slice(0, 100) }))
        });
      }
    }
  ];
}

async function walk(root: string, currentPath: string, depth: number, maxDepth: number, results: string[]) {
  const entries = await fs.readdir(currentPath, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === "node_modules" || entry.name === ".git" || entry.name === ".agent-state") {
      continue;
    }
    const fullPath = path.join(currentPath, entry.name);
    const relative = relativeToRoot(root, fullPath);
    if (entry.isDirectory()) {
      results.push(`${relative}/`);
      if (depth < maxDepth) {
        await walk(root, fullPath, depth + 1, maxDepth, results);
      }
    } else {
      results.push(relative);
    }
  }
}

async function runShellCommand(command: string, context: ToolExecutionContext): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd: context.root,
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      shell: "/bin/zsh"
    });
    return { exitCode: 0, stdout: limitOutput(stdout), stderr: limitOutput(stderr) };
  } catch (error: unknown) {
    const execError = error as { code?: number | string; stdout?: string; stderr?: string; message?: string };
    return {
      exitCode: typeof execError.code === "number" ? execError.code : 1,
      stdout: limitOutput(execError.stdout ?? ""),
      stderr: limitOutput(execError.stderr ?? execError.message ?? "")
    };
  }
}

async function runProjectCommand(kind: "test" | "build" | "lint" | "format_check", context: ToolExecutionContext): Promise<ToolResult> {
  const packageJsonPath = path.join(context.root, "package.json");
  let packageJson: { scripts?: Record<string, string> } | null = null;

  try {
    const raw = await fs.readFile(packageJsonPath, "utf8");
    packageJson = JSON.parse(raw) as { scripts?: Record<string, string> };
  } catch {
    return err("not_configured", "package.json is not available for project-aware commands.");
  }

  const scripts = packageJson.scripts ?? {};
  let command: string | null = null;

  if (kind === "build") {
    command = scripts.build ? "npm run build" : null;
  } else if (kind === "lint") {
    command = scripts.lint ? "npm run lint" : null;
  } else if (kind === "format_check") {
    if (scripts["format:check"]) {
      command = "npm run format:check";
    } else if (scripts.format) {
      command = "npm run format -- --check";
    }
  } else {
    if (scripts.build) {
      command = scripts.test ? "npm run build && npm test" : "npm run build";
    } else if (scripts.test) {
      command = "npm test";
    }
  }

  if (!command) {
    return err("not_configured", `${kind} command is not configured in package.json.`);
  }

  if (validateCommand(command, context.safetyMode)) {
    return err("blocked_by_mode", `${kind} command is blocked in the current safety mode.`);
  }

  return ok(`${kind} command completed.`, {
    command,
    ...(await runShellCommand(command, context))
  });
}

type ParsedFilePatch = {
  oldPath: string;
  newPath: string;
  hunks: ParsedHunk[];
};

type ParsedHunk = {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: string[];
};

function parseUnifiedDiff(patch: string): ParsedFilePatch[] {
  const normalized = patch.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const files: ParsedFilePatch[] = [];
  let index = 0;

  while (index < lines.length) {
    if (!lines[index].startsWith("--- ")) {
      index += 1;
      continue;
    }

    const oldPath = lines[index].slice(4).trim();
    index += 1;
    if (index >= lines.length || !lines[index].startsWith("+++ ")) {
      throw new Error("Invalid unified diff: missing +++ line.");
    }
    const newPath = lines[index].slice(4).trim();
    index += 1;

    const hunks: ParsedHunk[] = [];
    while (index < lines.length && lines[index].startsWith("@@")) {
      const header = lines[index];
      const match = header.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)?$/);
      if (!match) {
        throw new Error(`Invalid hunk header: ${header}`);
      }
      index += 1;

      const hunkLines: string[] = [];
      while (index < lines.length && !lines[index].startsWith("@@") && !lines[index].startsWith("--- ")) {
        const line = lines[index];
        if (line.startsWith("\\ No newline at end of file")) {
          index += 1;
          continue;
        }
        if (line !== "" && ![" ", "+", "-"].includes(line[0])) {
          throw new Error(`Invalid hunk line: ${line}`);
        }
        hunkLines.push(line);
        index += 1;
      }

      hunks.push({
        oldStart: Number(match[1]),
        oldCount: Number(match[2] ?? "1"),
        newStart: Number(match[3]),
        newCount: Number(match[4] ?? "1"),
        lines: hunkLines
      });
    }

    files.push({
      oldPath,
      newPath,
      hunks
    });
  }

  if (!files.length) {
    throw new Error("No file patches found in unified diff.");
  }

  return files;
}

function applyFilePatch(original: string, filePatch: ParsedFilePatch, label: string): string {
  const originalLines = original.split("\n");
  const output: string[] = [];
  let cursor = 0;

  for (const hunk of filePatch.hunks) {
    const hunkStart = Math.max(0, hunk.oldStart - 1);
    while (cursor < hunkStart) {
      output.push(originalLines[cursor] ?? "");
      cursor += 1;
    }

    for (const line of hunk.lines) {
      const marker = line[0] ?? " ";
      const content = line.slice(1);

      if (marker === " ") {
        if ((originalLines[cursor] ?? "") !== content) {
          throw new Error(`Patch context mismatch in ${label} near old line ${cursor + 1}.`);
        }
        output.push(content);
        cursor += 1;
      } else if (marker === "-") {
        if ((originalLines[cursor] ?? "") !== content) {
          throw new Error(`Patch deletion mismatch in ${label} near old line ${cursor + 1}.`);
        }
        cursor += 1;
      } else if (marker === "+") {
        output.push(content);
      } else {
        throw new Error(`Unsupported patch marker ${marker} in ${label}.`);
      }
    }
  }

  while (cursor < originalLines.length) {
    output.push(originalLines[cursor] ?? "");
    cursor += 1;
  }

  return output.join("\n");
}

async function readFileIfExists(target: string): Promise<string> {
  try {
    return await fs.readFile(target, "utf8");
  } catch (error: unknown) {
    const maybe = error as { code?: string };
    if (maybe.code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

function stripDiffPath(value: string): string {
  if (value === "/dev/null") {
    return value;
  }
  return value.replace(/^[ab]\//, "");
}

function validateCommand(command: string, safetyMode: ToolExecutionContext["safetyMode"]): { errorCode: string; message: string } | null {
  const blockedPatterns = [
    /\brm\s+-rf\b/i,
    /\bsudo\b/i,
    /\bgit\s+reset\s+--hard\b/i,
    /\bgit\s+checkout\s+--\b/i,
    /\bshutdown\b/i,
    /\breboot\b/i
  ];

  if (blockedPatterns.some((pattern) => pattern.test(command))) {
    return {
      errorCode: "blocked_command",
      message: `Blocked command: ${command}`
    };
  }

  if (safetyMode === "read_only") {
    const readOnlyAllowed = /^(pwd|ls|find|rg|cat|sed|git status|git diff|git show|npm run build|npm test|npm run test)/;
    if (!readOnlyAllowed.test(command)) {
      return {
        errorCode: "blocked_by_mode",
        message: `Command blocked in read_only mode: ${command}`
      };
    }
  }

  if (safetyMode === "guarded") {
    const guardedAllowed = /^(pwd|ls|find|rg|cat|sed|git status|git diff|git show|npm run build|npm run lint|npm test|npm run test)/;
    if (!guardedAllowed.test(command)) {
      return {
        errorCode: "blocked_by_mode",
        message: `Command blocked in guarded mode: ${command}`
      };
    }
  }

  if (/(\|\||;\s*|\n)/.test(command)) {
    return {
      errorCode: "interactive_or_multi_command",
      message: "Multiple chained commands are not allowed in run_command."
    };
  }

  return null;
}

function resolveWorkspacePath(root: string, input: string | undefined): string {
  if (!input) {
    throw new Error("Missing required path.");
  }
  const resolved = path.resolve(root, input);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Path escapes workspace: ${input}`);
  }
  return resolved;
}

function relativeToRoot(root: string, target: string): string {
  const relative = path.relative(root, target);
  return relative || ".";
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) {
    return 0;
  }
  let count = 0;
  let index = 0;
  while (true) {
    const found = haystack.indexOf(needle, index);
    if (found === -1) {
      return count;
    }
    count += 1;
    index = found + needle.length;
  }
}

function limitOutput(text: string): string {
  if (text.length <= OUTPUT_LIMIT) {
    return text;
  }
  return `${text.slice(0, OUTPUT_LIMIT)}\n...[truncated]`;
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function decodeStringArg(args: Record<string, unknown>, key: string): string | undefined {
  const direct = asString(args[key]);
  if (direct !== undefined) {
    return direct;
  }

  const encoded = asString(args[`${key}Base64`]);
  if (encoded === undefined) {
    return undefined;
  }

  try {
    return Buffer.from(encoded, "base64").toString("utf8");
  } catch {
    throw new Error(`Invalid base64 for ${key}Base64`);
  }
}

function ok(message: string, data?: unknown): ToolResult {
  return { ok: true, message, data };
}

function err(errorCode: string, message: string): ToolResult {
  return { ok: false, errorCode, message };
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}
