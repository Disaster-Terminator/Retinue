export type PermissionMode = "default" | "acceptEdits" | "plan" | "auto" | "dontAsk";

export type JobTerminalStatus = "completed" | "failed" | "killed";
export type JobStatus = "running" | JobTerminalStatus;

export interface RunOptions {
  cwd: string;
  prompt: string;
  name?: string;
  resume?: string;
  maxTurns?: number;
  permissionMode?: PermissionMode;
}

export interface SupervisorOptions {
  claudeCommand?: string;
  claudePrefixArgs?: string[];
  stateDir?: string;
  env?: NodeJS.ProcessEnv;
}

export interface JobMeta {
  jobId: string;
  pid: number;
  status: JobStatus;
  cwd: string;
  prompt: string;
  name?: string;
  resume?: string;
  args: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ExitStatus {
  status: JobTerminalStatus;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  endedAt: string;
}

export interface WaitOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
}

export interface WaitResult {
  jobId: string;
  status: JobStatus;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
}

export interface JobResult {
  jobId: string;
  status: JobStatus;
  stdout: string;
  stderr: string;
  parsedStdout?: unknown;
  exitStatus?: ExitStatus;
}

export interface KillResult {
  jobId: string;
  status: JobTerminalStatus;
}

export interface CleanupOptions {
  olderThanMs?: number;
}

export interface CleanupResult {
  removedJobIds: string[];
}
