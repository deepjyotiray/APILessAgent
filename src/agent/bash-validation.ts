/**
 * Bash command validation pipeline.
 * Ported from Claude Code's rust/crates/runtime/src/bash_validation.rs
 *
 * Layers:
 *  1. modeValidation — enforce permission mode constraints
 *  2. sedValidation — validate sed expressions
 *  3. destructiveCommandWarning — flag dangerous commands
 *  4. pathValidation — detect suspicious path patterns
 *  5. commandSemantics — classify command intent
 */

import type { SafetyMode } from "./types.js";

// --- Public types ---

export type ValidationResult =
  | { kind: "allow" }
  | { kind: "block"; reason: string }
  | { kind: "warn"; message: string };

export type CommandIntent =
  | "read_only"
  | "write"
  | "destructive"
  | "network"
  | "process_management"
  | "package_management"
  | "system_admin"
  | "unknown";

// --- Constants ---

const WRITE_COMMANDS = new Set([
  "cp", "mv", "rm", "mkdir", "rmdir", "touch", "chmod", "chown", "chgrp",
  "ln", "install", "tee", "truncate", "shred", "mkfifo", "mknod", "dd",
]);

const STATE_MODIFYING_COMMANDS = new Set([
  "apt", "apt-get", "yum", "dnf", "pacman", "brew",
  "pip", "pip3", "npm", "yarn", "pnpm", "bun", "cargo", "gem", "go", "rustup",
  "docker", "systemctl", "service", "mount", "umount",
  "kill", "pkill", "killall", "reboot", "shutdown", "halt", "poweroff",
  "useradd", "userdel", "usermod", "groupadd", "groupdel", "crontab", "at",
]);

const WRITE_REDIRECTIONS = [">", ">>", ">&"];

const GIT_READ_ONLY_SUBCOMMANDS = new Set([
  "status", "log", "diff", "show", "branch", "tag", "stash", "remote",
  "fetch", "ls-files", "ls-tree", "cat-file", "rev-parse", "describe",
  "shortlog", "blame", "bisect", "reflog", "config",
]);

const READ_ONLY_COMMANDS = new Set([
  "ls", "cat", "head", "tail", "less", "more", "wc", "sort", "uniq",
  "grep", "egrep", "fgrep", "find", "which", "whereis", "whatis",
  "man", "info", "file", "stat", "du", "df", "free", "uptime", "uname",
  "hostname", "whoami", "id", "groups", "env", "printenv", "echo", "printf",
  "date", "cal", "bc", "expr", "test", "true", "false", "pwd", "tree",
  "diff", "cmp", "md5sum", "sha256sum", "sha1sum", "xxd", "od", "hexdump",
  "strings", "readlink", "realpath", "basename", "dirname", "seq", "yes",
  "tput", "column", "jq", "yq", "xargs", "tr", "cut", "paste", "awk", "sed",
  "rg",
]);

const NETWORK_COMMANDS = new Set([
  "curl", "wget", "ssh", "scp", "rsync", "ftp", "sftp", "nc", "ncat",
  "telnet", "ping", "traceroute", "dig", "nslookup", "host", "whois",
  "ifconfig", "ip", "netstat", "ss", "nmap",
]);

const PROCESS_COMMANDS = new Set([
  "kill", "pkill", "killall", "ps", "top", "htop", "bg", "fg", "jobs",
  "nohup", "disown", "wait", "nice", "renice",
]);

const PACKAGE_COMMANDS = new Set([
  "apt", "apt-get", "yum", "dnf", "pacman", "brew", "pip", "pip3",
  "npm", "yarn", "pnpm", "bun", "cargo", "gem", "go", "rustup", "snap", "flatpak",
]);

const SYSTEM_ADMIN_COMMANDS = new Set([
  "sudo", "su", "chroot", "mount", "umount", "fdisk", "parted", "lsblk", "blkid",
  "systemctl", "service", "journalctl", "dmesg", "modprobe", "insmod", "rmmod",
  "iptables", "ufw", "firewall-cmd", "sysctl", "crontab", "at",
  "useradd", "userdel", "usermod", "groupadd", "groupdel", "passwd", "visudo",
]);

const ALWAYS_DESTRUCTIVE_COMMANDS = new Set(["shred", "wipefs"]);

const DESTRUCTIVE_PATTERNS: Array<[string, string]> = [
  ["rm -rf /", "Recursive forced deletion at root — this will destroy the system"],
  ["rm -rf ~", "Recursive forced deletion of home directory"],
  ["rm -rf *", "Recursive forced deletion of all files in current directory"],
  ["rm -rf .", "Recursive forced deletion of current directory"],
  ["mkfs", "Filesystem creation will destroy existing data on the device"],
  ["dd if=", "Direct disk write — can overwrite partitions or devices"],
  ["> /dev/sd", "Writing to raw disk device"],
  ["chmod -R 777", "Recursively setting world-writable permissions"],
  ["chmod -R 000", "Recursively removing all permissions"],
  [":(){ :|:& };:", "Fork bomb — will crash the system"],
];

const SYSTEM_PATHS = [
  "/etc/", "/usr/", "/var/", "/boot/", "/sys/", "/proc/", "/dev/", "/sbin/", "/lib/", "/opt/",
];

// --- Pipeline ---

/** Run the full validation pipeline. Returns the first non-allow result. */
export function validateCommand(command: string, safetyMode: SafetyMode, workspaceRoot: string): ValidationResult {
  const allow: ValidationResult = { kind: "allow" };

  // 1. Mode-level validation (includes read-only checks)
  const modeResult = validateMode(command, safetyMode);
  if (modeResult.kind !== "allow") return modeResult;

  // 2. Sed-specific validation
  const sedResult = validateSed(command, safetyMode);
  if (sedResult.kind !== "allow") return sedResult;

  // 3. Destructive command warnings
  const destructiveResult = checkDestructive(command);
  if (destructiveResult.kind !== "allow") return destructiveResult;

  // 4. Path validation
  const pathResult = validatePaths(command, workspaceRoot);
  if (pathResult.kind !== "allow") return pathResult;

  return allow;
}

/** Classify the semantic intent of a bash command. */
export function classifyCommand(command: string): CommandIntent {
  const first = extractFirstCommand(command);

  if (READ_ONLY_COMMANDS.has(first)) {
    if (first === "sed" && command.includes(" -i")) return "write";
    return "read_only";
  }
  if (ALWAYS_DESTRUCTIVE_COMMANDS.has(first) || first === "rm") return "destructive";
  if (WRITE_COMMANDS.has(first)) return "write";
  if (NETWORK_COMMANDS.has(first)) return "network";
  if (PROCESS_COMMANDS.has(first)) return "process_management";
  if (PACKAGE_COMMANDS.has(first)) return "package_management";
  if (SYSTEM_ADMIN_COMMANDS.has(first)) return "system_admin";
  if (first === "git") return classifyGitCommand(command);
  return "unknown";
}

// --- Layer implementations ---

function validateReadOnly(command: string, safetyMode: SafetyMode): ValidationResult {
  if (safetyMode !== "read_only") return { kind: "allow" };

  const first = extractFirstCommand(command);

  if (WRITE_COMMANDS.has(first)) {
    return { kind: "block", reason: `Command '${first}' modifies the filesystem and is not allowed in read_only mode` };
  }
  if (STATE_MODIFYING_COMMANDS.has(first)) {
    return { kind: "block", reason: `Command '${first}' modifies system state and is not allowed in read_only mode` };
  }
  if (first === "sudo") {
    const inner = extractSudoInner(command);
    if (inner) {
      const innerResult = validateReadOnly(inner, safetyMode);
      if (innerResult.kind !== "allow") return innerResult;
    }
  }
  for (const redir of WRITE_REDIRECTIONS) {
    if (command.includes(redir)) {
      return { kind: "block", reason: `Command contains write redirection '${redir}' which is not allowed in read_only mode` };
    }
  }
  if (first === "git") return validateGitReadOnly(command);

  return { kind: "allow" };
}

function validateMode(command: string, safetyMode: SafetyMode): ValidationResult {
  if (safetyMode === "read_only") return validateReadOnly(command, safetyMode);

  if (safetyMode === "guarded") {
    if (commandTargetsOutsideWorkspace(command)) {
      return { kind: "warn", message: "Command appears to target files outside the workspace — requires elevated permission" };
    }
  }

  return { kind: "allow" };
}

function validateSed(command: string, safetyMode: SafetyMode): ValidationResult {
  if (extractFirstCommand(command) !== "sed") return { kind: "allow" };
  if (safetyMode === "read_only" && command.includes(" -i")) {
    return { kind: "block", reason: "sed -i (in-place editing) is not allowed in read_only mode" };
  }
  return { kind: "allow" };
}

function checkDestructive(command: string): ValidationResult {
  for (const [pattern, warning] of DESTRUCTIVE_PATTERNS) {
    if (command.includes(pattern)) {
      return { kind: "warn", message: `Destructive command detected: ${warning}` };
    }
  }
  const first = extractFirstCommand(command);
  if (ALWAYS_DESTRUCTIVE_COMMANDS.has(first)) {
    return { kind: "warn", message: `Command '${first}' is inherently destructive and may cause data loss` };
  }
  if (command.includes("rm ") && command.includes("-r") && command.includes("-f")) {
    return { kind: "warn", message: "Recursive forced deletion detected — verify the target path is correct" };
  }
  return { kind: "allow" };
}

function validatePaths(command: string, workspaceRoot: string): ValidationResult {
  if (command.includes("../") && !command.includes(workspaceRoot)) {
    return { kind: "warn", message: "Command contains directory traversal pattern '../' — verify the target path resolves within the workspace" };
  }
  if (command.includes("~/") || command.includes("$HOME")) {
    return { kind: "warn", message: "Command references home directory — verify it stays within the workspace scope" };
  }
  return { kind: "allow" };
}

function validateGitReadOnly(command: string): ValidationResult {
  const sub = extractGitSubcommand(command);
  if (!sub) return { kind: "allow" };
  if (GIT_READ_ONLY_SUBCOMMANDS.has(sub)) return { kind: "allow" };
  return { kind: "block", reason: `Git subcommand '${sub}' modifies repository state and is not allowed in read_only mode` };
}

function classifyGitCommand(command: string): CommandIntent {
  const sub = extractGitSubcommand(command);
  if (sub && GIT_READ_ONLY_SUBCOMMANDS.has(sub)) return "read_only";
  return "write";
}

function commandTargetsOutsideWorkspace(command: string): boolean {
  const first = extractFirstCommand(command);
  if (!WRITE_COMMANDS.has(first) && !STATE_MODIFYING_COMMANDS.has(first)) return false;
  return SYSTEM_PATHS.some((p) => command.includes(p));
}

// --- Helpers ---

function extractFirstCommand(command: string): string {
  let remaining = command.trim();
  // Skip leading env var assignments (KEY=val cmd ...)
  while (true) {
    const eqIdx = remaining.indexOf("=");
    if (eqIdx === -1) break;
    const before = remaining.slice(0, eqIdx);
    if (!before.length || !/^[a-zA-Z0-9_]+$/.test(before)) break;
    const afterEq = remaining.slice(eqIdx + 1);
    const spaceIdx = findEndOfValue(afterEq);
    if (spaceIdx === -1) return "";
    remaining = afterEq.slice(spaceIdx).trimStart();
  }
  return remaining.split(/\s+/)[0] ?? "";
}

function extractSudoInner(command: string): string | null {
  const parts = command.split(/\s+/);
  const sudoIdx = parts.indexOf("sudo");
  if (sudoIdx === -1) return null;
  const rest = parts.slice(sudoIdx + 1);
  const innerCmd = rest.find((p) => !p.startsWith("-"));
  if (!innerCmd) return null;
  const offset = command.indexOf(innerCmd, command.indexOf("sudo") + 4);
  return command.slice(offset);
}

function extractGitSubcommand(command: string): string | null {
  const parts = command.split(/\s+/);
  return parts.slice(1).find((p) => !p.startsWith("-")) ?? null;
}

function findEndOfValue(s: string): number {
  const trimmed = s.trimStart();
  if (!trimmed.length) return -1;
  const first = trimmed[0];
  if (first === '"' || first === "'") {
    let i = 1;
    while (i < trimmed.length) {
      if (trimmed[i] === first && trimmed[i - 1] !== "\\") {
        i++;
        while (i < trimmed.length && !/\s/.test(trimmed[i])) i++;
        return i < trimmed.length ? i + (s.length - trimmed.length) : -1;
      }
      i++;
    }
    return -1;
  }
  const idx = trimmed.search(/\s/);
  return idx === -1 ? -1 : idx + (s.length - trimmed.length);
}
