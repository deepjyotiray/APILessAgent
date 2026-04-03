export type SafetyMode = "auto" | "guarded" | "read_only";

export type TaskStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "aborted";

export type PlannerReply =
  | {
      type: "tool";
      tool: ToolName;
      args?: Record<string, unknown>;
      reason?: string;
    }
  | {
      type: "done";
      message: string;
      summary?: string;
    }
  | {
      type: "error";
      message: string;
      retryable?: boolean;
    };

export type ToolName =
  | "list_files"
  | "read_file"
  | "read_file_range"
  | "read_multiple_files"
  | "file_metadata"
  | "summarize_file"
  | "write_file"
  | "replace_text"
  | "insert_text"
  | "apply_patch"
  | "search"
  | "run_command"
  | "run_tests"
  | "run_build"
  | "run_lint"
  | "run_format_check"
  | "git_status"
  | "git_diff"
  | "git_diff_cached"
  | "git_show"
  | "remember_text"
  | "task_checkpoint_save"
  | "task_checkpoint_load";

export interface ToolResult {
  ok: boolean;
  errorCode?: string;
  message: string;
  data?: unknown;
}

export interface PlannerStatus {
  ok: boolean;
  errorCode?: string;
  message: string;
  data?: unknown;
}

export interface PlannerSession {
  id: string;
}

export interface PlannerTurnResult {
  ok: boolean;
  raw?: string;
  errorCode?: string;
  message: string;
}

export interface PlannerAdapter {
  readonly name: string;
  getPlannerStatus(): Promise<PlannerStatus>;
  startSession(): Promise<PlannerSession>;
  resetSession(session: PlannerSession): Promise<void>;
  sendTurn(session: PlannerSession, prompt: string): Promise<PlannerTurnResult>;
}

export interface StepRecord {
  index: number;
  startedAt: string;
  finishedAt?: string;
  promptDigest: string;
  plannerRaw?: string;
  plannerReply?: PlannerReply;
  toolName?: ToolName;
  toolArgs?: Record<string, unknown>;
  toolResult?: ToolResult;
  plannerError?: string;
}

export interface VerificationState {
  sawGitDiff: boolean;
  sawVerification: boolean;
  lastCommand?: string;
  lastExitCode?: number;
  lastRunAt?: string;
}

export interface AgentHooksConfig {
  onTaskStart?: string[];
  onTaskComplete?: string[];
  beforeTool?: string[];
  afterTool?: string[];
}

export interface AgentCompactionConfig {
  keepRecentSteps: number;
  maxPromptChars: number;
}

export interface AgentConfig {
  hooks: AgentHooksConfig;
  compaction: AgentCompactionConfig;
}

export interface RuntimeObserver {
  onTaskStarted?(task: TaskState): void;
  onStepStarted?(task: TaskState, step: StepRecord): void;
  onPlannerStarted?(task: TaskState, step: StepRecord): void;
  onPlannerReply?(task: TaskState, step: StepRecord): void;
  onToolStarted?(task: TaskState, step: StepRecord): void;
  onToolFinished?(task: TaskState, step: StepRecord): void;
  onTaskFinished?(task: TaskState): void;
}

export interface TaskState {
  id: string;
  goal: string;
  root: string;
  plannerBackend: string;
  safetyMode: SafetyMode;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  plannerSessionId?: string;
  steps: StepRecord[];
  changedFiles: string[];
  initialContext?: string;
  currentDiff?: string;
  summary?: string;
  lastError?: string;
  lastOutput?: string;
  lastOutputPath?: string;
  verification: VerificationState;
}

export interface ToolExecutionContext {
  root: string;
  safetyMode: SafetyMode;
  task: TaskState;
  saveCheckpoint: (name?: string) => Promise<string>;
  loadCheckpoint: (name: string) => Promise<TaskState>;
}

export interface ToolDefinition {
  name: ToolName;
  description: string;
  execute: (args: Record<string, unknown>, context: ToolExecutionContext) => Promise<ToolResult>;
}

export interface ToolRegistry {
  list(): ToolDefinition[];
  get(name: ToolName): ToolDefinition | undefined;
  execute(name: ToolName, args: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolResult>;
}
