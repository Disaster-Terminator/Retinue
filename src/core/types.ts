export type PermissionMode = "default" | "acceptEdits" | "plan" | "auto" | "dontAsk";
export type AgentBackendKind = "claude-code" | "opencode" | "kilo";

export type JobTerminalStatus = "completed" | "failed" | "killed" | "timed_out";
export type JobProblemStatus = "not_found" | "corrupted" | "backend_unreachable";
export type JobStatus = "queued" | "running" | "stalled" | "orphaned" | "abandoned" | JobProblemStatus | JobTerminalStatus;

export interface RunOptions {
  cwd: string;
  prompt: string;
  name?: string;
  resume?: string;
  parentJobId?: string;
  parentSessionId?: string;
  recoveredFromJobId?: string;
  attempt?: number;
  recoveryReason?: string;
  recoveryPolicy?: AttemptRecoveryPolicy;
  originalStallReason?: string;
  recoveryStallReason?: string;
  maxTurns?: number;
  permissionMode?: PermissionMode;
  timeoutMs?: number;
}

export type AttemptRecoveryPolicy = "fresh_task_attempt" | "fresh_task_reroute" | "same_session_finalization_rescue";

export interface JobAttemptSummary {
  jobId: string;
  attempt: number;
  status: JobStatus;
  recoveredFromJobId?: string;
  recoveryReason?: string;
  recoveryPolicy?: AttemptRecoveryPolicy;
  originalStallReason?: string;
  recoveryStallReason?: string;
  selected?: boolean;
  backend?: AgentBackendKind;
  externalSessionId?: string;
  externalParentSessionId?: string;
  externalRootSessionId?: string;
}

export type PermissionReplyOption = "once" | "always" | "reject";

export interface RetinuePermissionDecisionOption {
  reply: PermissionReplyOption;
  label: string;
  effect: string;
  requiresConfirmation?: boolean;
}

export interface RetinuePermissionApprovalRequest {
  kind: "opencode_permission" | "claude_code_permission";
  title: string;
  lines: string[];
  guidance: string[];
  recommendedReply?: PermissionReplyOption;
  recommendedMessage?: string;
  scope?: {
    permission: string;
    target?: string;
    cwd?: string;
    sessionDirectory?: string;
    relation?: "inside_workspace" | "outside_workspace" | "unknown";
  };
  options: RetinuePermissionDecisionOption[];
}

export interface RetinuePermissionRequest {
  id: string;
  sessionID?: string;
  permission: string;
  patterns: string[];
  always?: string[];
  toolCallID?: string;
  metadata?: unknown;
  approval?: RetinuePermissionApprovalRequest;
}

export interface PermissionAttentionRequired {
  kind: "permission";
  backend: AgentBackendKind;
  reason: string;
  permissions: RetinuePermissionRequest[];
  replyOptions: PermissionReplyOption[];
}

export type RetinueAttentionRequired = PermissionAttentionRequired;

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
  recoveredFromJobId?: string;
  attempt?: number;
  recoveryReason?: string;
  recoveryPolicy?: AttemptRecoveryPolicy;
  originalStallReason?: string;
  recoveryStallReason?: string;
  attemptJobIds?: string[];
  selectedAttemptJobId?: string;
  sessionId?: string;
  externalSessionId?: string;
  externalRunnerMode?: "per-spawn" | "shared-root";
  externalRootAgent?: string;
  externalRootSessionId?: string;
  externalParentSessionId?: string;
  externalChildSessionIds?: string[];
  externalServerUrl?: string;
  externalBackendError?: string;
  externalSessionDirectory?: string;
  externalMessageId?: string;
  externalRescuePromptSubmittedAt?: string;
  externalSoftStallRescueStrategy?: "final_answer_no_tools";
  externalSoftStallRescueAgent?: string;
  externalSoftStallRescueModel?: string;
  externalSoftStallRescueTools?: string[];
  externalSoftStallRescueSourceReason?: string;
  externalSoftStallRescueSourceSummary?: string;
  externalReadOnlyWriteIntentRecoveryJobMessageCount?: number;
  externalReadOnlyWriteIntentRecoveredAt?: string;
  externalMessageBaselineCount?: number;
  externalCompletedAssistantBaselineCount?: number;
  model?: string;
  agent?: string;
  readOnly?: boolean;
  readOnlyPromptContract?: boolean;
  readOnlyToolDeny?: boolean;
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
  requestedJobId?: string;
  selectedAttemptJobId?: string;
  attemptChain?: JobAttemptSummary[];
  attentionRequired?: RetinueAttentionRequired;
  permissionRequired?: boolean;
  permissions?: RetinuePermissionRequest[];
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
  selectedAttemptJobId?: string;
  attemptChain?: JobAttemptSummary[];
  attentionRequired?: RetinueAttentionRequired;
  permissionRequired?: boolean;
  permissions?: RetinuePermissionRequest[];
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
