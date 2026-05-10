export type PermissionMode = "default" | "acceptEdits" | "plan" | "auto" | "dontAsk";
export type AgentBackendKind = "claude-code" | "opencode";
export type JobTerminalStatus = "completed" | "failed" | "killed" | "timed_out";
export type JobProblemStatus = "not_found" | "corrupted";
export type JobStatus = "running" | "orphaned" | "abandoned" | JobProblemStatus | JobTerminalStatus;
export interface RunOptions {
    cwd: string;
    prompt: string;
    name?: string;
    resume?: string;
    parentJobId?: string;
    parentSessionId?: string;
    maxTurns?: number;
    permissionMode?: PermissionMode;
    timeoutMs?: number;
}
export interface RetinueOptions {
    claudeCommand?: string;
    claudePrefixArgs?: string[];
    stateDir?: string;
    env?: NodeJS.ProcessEnv;
    defaultRuntimeTimeoutMs?: number;
    maxConcurrentJobs?: number;
}
export interface JobMeta {
    schemaVersion?: number;
    backend?: AgentBackendKind;
    jobId: string;
    pid: number;
    status: JobStatus;
    cwd: string;
    prompt?: string;
    promptPath: string;
    promptPreview: string;
    promptSha256: string;
    name?: string;
    resume?: string;
    parentJobId?: string;
    parentSessionId?: string;
    sessionId?: string;
    externalSessionId?: string;
    externalServerUrl?: string;
    externalMessageId?: string;
    externalMessageBaselineCount?: number;
    externalCompletedAssistantBaselineCount?: number;
    model?: string;
    agent?: string;
    title?: string;
    runtimeTimeoutMs?: number;
    args: string[];
    createdAt: string;
    updatedAt: string;
}
export interface JobProblem {
    jobId: string;
    status: JobProblemStatus;
    error?: string;
}
export type JobStatusResult = JobMeta | JobProblem;
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
    stdout?: string;
    stderr?: string;
    stdoutPath?: string;
    stderrPath?: string;
    stdoutBytes?: number;
    stderrBytes?: number;
    stdoutTruncated?: boolean;
    stderrTruncated?: boolean;
    sessionId?: string;
    parsedStdout?: unknown;
    exitStatus?: ExitStatus;
    error?: string;
}
export interface PeekOptions {
    stdoutTailBytes?: number;
    stderrTailBytes?: number;
}
export interface PeekResult {
    jobId: string;
    status: JobStatus;
    stdoutTail?: string;
    stderrTail?: string;
    stdoutPath?: string;
    stderrPath?: string;
    error?: string;
}
export interface KillResult {
    jobId: string;
    status: JobStatus;
}
export interface CleanupOptions {
    olderThanMs?: number;
}
export interface CleanupResult {
    removedJobIds: string[];
    removedTempFiles: string[];
}
export interface ContinueOptions {
    cwd: string;
    prompt: string;
    jobId?: string;
    sessionId?: string;
    name?: string;
    maxTurns?: number;
    permissionMode?: PermissionMode;
    timeoutMs?: number;
}
export interface RetinueApi {
    run(options: RunOptions): Promise<JobMeta>;
    status(jobId: string): Promise<JobStatusResult>;
    wait(jobId: string, options?: WaitOptions): Promise<WaitResult>;
    result(jobId: string): Promise<JobResult>;
    continueJob(options: ContinueOptions): Promise<JobMeta>;
    peek(jobId: string, options?: PeekOptions): Promise<PeekResult>;
    kill(jobId: string): Promise<KillResult>;
    cleanup(options?: CleanupOptions): Promise<CleanupResult>;
}
