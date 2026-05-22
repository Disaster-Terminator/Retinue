import fs from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { resolveHttpTimeoutMs } from "../../core/http.js";
import { getJobPaths, getRetinueTracePath, resolveStateDir } from "../../core/paths.js";
import { isCleanupSafeStatus } from "../../core/status.js";
import type {
  CleanupOptions,
  CleanupResult,
  JobAttemptSummary,
  JobMeta,
  JobProblem,
  JobResult,
  JobStatusResult,
  RetinueOptions,
  WaitResult
} from "../../core/types.js";
import type {
  AgentBackend,
  AgentContinueOptions,
  AgentHandle,
  AgentPermissionListResult,
  AgentPermissionReply,
  AgentPermissionReplyResult,
  AgentPermissionRequest,
  AgentRunOptions
} from "../types.js";
import {
  OpenCodeClient,
  OpenCodeClientError,
  type OpenCodeAgentInfo,
  type OpenCodeMessage,
  type OpenCodePermissionRequest,
  type OpenCodePermissionRule
} from "./client.js";
import { scheduleManagedOpenCodeServerIdleShutdown } from "./serverManager.js";

export interface OpenCodeBackendOptions {
  client?: OpenCodeClient;
  baseUrl?: string;
  target?: (cwd: string | undefined) => Promise<OpenCodeBackendTarget>;
  stateDir?: string;
  env?: RetinueOptions["env"];
  onServerIdle?: (baseUrl: string, cwd: string | undefined) => void;
}
export interface OpenCodeBackendTarget {
  client: OpenCodeClient;
  baseUrl: string;
}
type OpenCodeReadOnlyBashPolicy = "none" | "readonly_git";
type OpenCodeRunnerMode = "per-spawn" | "shared-root";

interface SharedRootSession {
  id: string;
  baseUrl: string;
  cwd?: string;
  agent: string;
}

const SHARED_ROOT_SESSIONS = new Map<string, SharedRootSession>();

const OPENCODE_READ_ONLY_TOOLS_NO_BASH: Record<string, boolean> = {
  bash: false,
  edit: false,
  write: false,
  apply_patch: false,
  patch: false,
  task: false
};
const OPENCODE_READ_ONLY_TOOLS_WITH_READONLY_GIT_BASH: Record<string, boolean> = {
  edit: false,
  write: false,
  apply_patch: false,
  patch: false,
  task: false
};
const OPENCODE_FINAL_ANSWER_ONLY_TOOLS: Record<string, boolean> = {
  read: false,
  glob: false,
  grep: false,
  list: false,
  todoread: false,
  todowrite: false,
  webfetch: false,
  lsp: false,
  bash: false,
  edit: false,
  write: false,
  apply_patch: false,
  patch: false,
  task: false
};
const OPENCODE_SOFT_STALL_RESCUE_PROMPT = [
  "Retinue recovery request:",
  "Stop using tools now and produce the final answer from the information already gathered.",
  "Do not call read, grep, glob, bash, edit, write, patch, apply_patch, task, or any other tool.",
  "If the available information is insufficient, state the limitation clearly instead of inspecting more files.",
  "Return concise plain text only. Do not emit patch blocks, unified diffs, or apply-ready replacement snippets."
].join("\n");

const DEFAULT_TASK_ATTEMPT_MAX = 1;

function createReadOnlyPromptContract(bashPolicy: OpenCodeReadOnlyBashPolicy): string {
  const allowsReadonlyGit = bashPolicy === "readonly_git";
  return [
    "Retinue read-only child agent contract:",
    allowsReadonlyGit
      ? "- Use only OpenCode read, grep, glob, and allowed read-only git bash commands plus plain-text reasoning."
      : "- Use only OpenCode read, grep, and glob tools plus plain-text reasoning.",
    allowsReadonlyGit
      ? "- Allowed bash is limited to read-only git inspection commands: pwd, git status --short, git status --porcelain, git diff --cached, git diff --staged, git diff --name-only --cached, git diff --name-status --cached, git diff --stat --cached, git diff -- <path>, git show --stat, git show --name-only, git ls-files, and git rev-parse --show-toplevel."
      : undefined,
    allowsReadonlyGit
      ? "- For staged diff review, use git diff --cached or git diff --staged; for unstaged file review, use git diff -- <path>."
      : undefined,
    allowsReadonlyGit
      ? "- Do not call bash except for allowed read-only git inspection commands; do not use shell pipes, redirects, command separators, command substitution, or write-capable git commands."
      : "- Do not call bash, edit, write, apply_patch, task, or nested agents.",
    "- Do not attempt non-allowed shell commands, file writes, patches, or interactive approvals.",
    "- Do not enter patch mode. If you identify a change, describe the affected interfaces, functions, tests, and risks in prose only.",
    "- Do not emit unified diffs.",
    "- Do not include patch blocks, edit scripts, or apply-ready replacement snippets.",
    "- For code review, return findings as plain text with severity and file references; describe suggested fixes in prose.",
    "- If the user provides enough facts to answer, answer from those facts without repository inspection.",
    "- Do not use tools just to confirm prompt-provided facts; use tools only when the task names files, symbols, or explicitly asks for repository inspection.",
    "- Use at most six inspection tool calls total before producing a final textual answer.",
    "- Before using any tool, classify whether the user task depends on git-only state such as staged changes, staged diff, uncommitted diff, git history, or the latest commit.",
    allowsReadonlyGit
      ? "- You may inspect staged or unstaged diff only with the allowed read-only git commands. If a requested git state is outside that allowlist or needs shell composition, state the limitation instead of approximating it from repository files."
      : "- If it asks for staged diff, uncommitted diff, git diff, git history, or the latest commit and the prompt did not include the needed diff/content, do not inspect the repository; immediately state that the read-only boundary cannot access that git-only state and ask the caller to provide the diff/content or use profile access.",
    allowsReadonlyGit
      ? "- You cannot inspect git history, commits beyond allowed git show metadata, or shell-composed repository state unless the task provides the relevant content."
      : "- You cannot inspect git history, staged changes, uncommitted diffs, or the latest commit unless the task provides the relevant file paths or content.",
    "- If the task asks for a diff, commit, or git-only state you cannot access, state that limitation instead of approximating it from repository files.",
    "- For broad audits, start with grep/glob and read only a small set of targeted files; avoid bulk-reading large generated, cache, log, or backup directories.",
    "- Use read serially: do not issue multiple read calls in one assistant turn, and stop reading once you have enough evidence to answer.",
    "- If the task needs non-allowed shell or write access, say that the read-only boundary prevents that part and provide the best file-based answer you can.",
    "- Always finish with a concise textual result; do not stop after tool calls without a final answer."
  ]
    .filter((line): line is string => typeof line === "string")
    .join("\n");
}

const OPENCODE_READ_ONLY_BASE_PERMISSION: OpenCodePermissionRule[] = [
  { permission: "read", pattern: "*", action: "allow" },
  { permission: "glob", pattern: "*", action: "allow" },
  { permission: "grep", pattern: "*", action: "allow" },
  { permission: "list", pattern: "*", action: "allow" },
  { permission: "todoread", pattern: "*", action: "allow" },
  { permission: "todowrite", pattern: "*", action: "allow" },
  { permission: "webfetch", pattern: "*", action: "allow" },
  { permission: "lsp", pattern: "*", action: "allow" },
  { permission: "question", pattern: "*", action: "deny" },
  { permission: "edit", pattern: "*", action: "deny" },
  { permission: "write", pattern: "*", action: "deny" },
  { permission: "apply_patch", pattern: "*", action: "deny" },
  { permission: "patch", pattern: "*", action: "deny" },
  { permission: "task", pattern: "*", action: "deny" },
  { permission: "external_directory", pattern: "*", action: "deny" },
  { permission: "doom_loop", pattern: "*", action: "deny" },
  { permission: "bash", pattern: "*", action: "deny" }
];
const OPENCODE_READONLY_GIT_BASH_PERMISSION: OpenCodePermissionRule[] = [
  { permission: "bash", pattern: "pwd", action: "allow" },
  { permission: "bash", pattern: "git status --short*", action: "allow" },
  { permission: "bash", pattern: "git status --porcelain*", action: "allow" },
  { permission: "bash", pattern: "git diff --cached*", action: "allow" },
  { permission: "bash", pattern: "git diff --staged*", action: "allow" },
  { permission: "bash", pattern: "git diff --name-only --cached*", action: "allow" },
  { permission: "bash", pattern: "git diff --name-status --cached*", action: "allow" },
  { permission: "bash", pattern: "git diff --stat --cached*", action: "allow" },
  { permission: "bash", pattern: "git diff -- *", action: "allow" },
  { permission: "bash", pattern: "git show --stat*", action: "allow" },
  { permission: "bash", pattern: "git show --name-only*", action: "allow" },
  { permission: "bash", pattern: "git ls-files*", action: "allow" },
  { permission: "bash", pattern: "git rev-parse --show-toplevel", action: "allow" }
];
const DEFAULT_WAIT_TIMEOUT_MS = 30_000;
const DEFAULT_WAIT_POLL_MS = 250;
const DEFAULT_STALL_MS = 10 * 60_000;
const DEFAULT_INCOMPLETE_ASSISTANT_STALL_MS = 45_000;
const DEFAULT_SERVER_IDLE_MS = 30_000;
const DEFAULT_BLANK_ASSISTANT_STALL_MS = 45_000;
const DEFAULT_ZERO_PROGRESS_ASSISTANT_STALL_MS = 45_000;
const DEFAULT_READ_TOOL_STALL_MS = 45_000;
const DEFAULT_COMPLETED_TOOL_LOOP_STALL_MS = 45_000;
const DEFAULT_SOFT_STALL_RESCUE_GRACE_MS = 60_000;
const DEFAULT_STALL_TOOL_CALL_ROUNDS = 6;
const DEFAULT_STALL_EMPTY_ASSISTANT_ROUNDS = 1;
const DIAGNOSTIC_VALUE_PREVIEW_BYTES = 1000;

interface DiagnosticValuePreview {
  type: string;
  preview: string;
  truncated?: boolean;
}

interface OpenCodePartSummary {
  type?: string;
  tool?: string;
  callID?: string;
  stateStatus?: string;
  stateInput?: DiagnosticValuePreview;
  textBytes?: number;
}

interface OpenCodePermissionSummary extends AgentPermissionRequest {
  id: string;
  sessionID?: string;
  permission: string;
  patterns: string[];
  always?: string[];
  toolCallID?: string;
  metadata?: DiagnosticValuePreview;
}

interface OpenCodeJobDiagnostic {
  baseUrl: string;
  sessionId?: string;
  runnerMode?: JobMeta["externalRunnerMode"];
  rootAgent?: string;
  rootSessionId?: string;
  parentSessionId?: string;
  childSessionIds?: string[];
  sessionDirectory?: string;
  sessionPath?: string;
  sessionState?: unknown;
  sessionAborted?: boolean;
  baselineMessageCount?: number;
  baselineCompletedAssistantCount?: number;
  messageCount?: number;
  jobMessageCount?: number;
  completedAssistantCount?: number;
  jobCompletedAssistantCount?: number;
  lastMessageRole?: string;
  lastMessageFinish?: string;
  lastMessageInfoKeys?: string[];
  lastMessagePartTypes?: string[];
  lastMessagePartSummaries?: OpenCodePartSummary[];
  lastMessageTextBytes?: number;
  lastMessageError?: DiagnosticValuePreview;
  lastAssistantFinish?: string;
  lastAssistantPartTypes?: string[];
  lastAssistantPartSummaries?: OpenCodePartSummary[];
  lastAssistantTextBytes?: number;
  lastAssistantError?: DiagnosticValuePreview;
  lastAssistantProviderID?: string;
  lastAssistantModelID?: string;
  lastAssistantAgent?: string;
  lastAssistantMode?: string;
  lastAssistantCost?: number;
  lastAssistantTokens?: unknown;
  patchPartCount?: number;
  readOnlyPatchPartCount?: number;
  writeIntentToolPartCount?: number;
  readOnlyWriteIntentToolPartCount?: number;
  readOnlyWriteIntent?: boolean;
  readOnlyWriteIntentRecoveryJobMessageCount?: number;
  recoveredFromReadOnlyWriteIntent?: boolean;
  recoveryStallReason?: OpenCodeStallReason;
  recoveryStallSummary?: string;
  readOnlyAdvisoryText?: boolean;
  readOnlyAdvisoryTextSummary?: string;
  readOnlyTextWarning?: boolean;
  readOnlyTextWarningSummary?: string;
  messageSummaries?: Array<{
    role?: string;
    finish?: string;
    partTypes?: string[];
    partSummaries?: OpenCodePartSummary[];
    textBytes: number;
    completed: boolean;
    messageError?: DiagnosticValuePreview;
  }>;
  selectedAssistantTextBytes?: number;
  selectedAssistantSha256?: string;
  selectedAssistantPreview?: string;
  toolCallAssistantRounds?: number;
  emptyAssistantRounds?: number;
  blankAssistantRounds?: number;
  zeroProgressAssistantRounds?: number;
  runningReadToolParts?: number;
  runningReadToolCallIds?: string[];
  runningReadToolPartSummaries?: OpenCodePartSummary[];
  malformedReadToolParts?: number;
  pendingPermissionCount?: number;
  pendingPermissions?: OpenCodePermissionSummary[];
  pendingExternalDirectoryPermissionCount?: number;
  pendingExternalDirectoryPermissions?: OpenCodePermissionSummary[];
  noCompletedAssistantDurationMs?: number;
  stallThresholdMs?: number;
  blankAssistantStallThresholdMs?: number;
  zeroProgressAssistantStallThresholdMs?: number;
  readToolStallThresholdMs?: number;
  completedToolLoopStallThresholdMs?: number;
  incompleteAssistantStallThresholdMs?: number;
  stallToolCallRoundThreshold?: number;
  stallEmptyAssistantRoundThreshold?: number;
  incompleteAssistantRound?: boolean;
  stallReason?: OpenCodeStallReason;
  stallSummary?: string;
  softStallRescueSourceReason?: OpenCodeStallReason;
  softStallRescueSourceSummary?: string;
  error?: string;
}

type OpenCodeStallReason =
  | "read_only_write_intent"
  | "provider_error"
  | "provider_reasoning_content_error"
  | "provider_blank_assistant"
  | "provider_zero_progress"
  | "read_tool_invalid_input"
  | "read_tool_stalled"
  | "external_directory_permission_pending"
  | "incomplete_assistant_round"
  | "backend_no_final_text"
  | "tool_loop_no_completion";

export class OpenCodeBackend implements AgentBackend {
  readonly kind = "opencode" as const;
  private readonly client?: OpenCodeClient;
  private readonly baseUrl?: string;
  private readonly resolveTarget: (cwd: string | undefined) => Promise<OpenCodeBackendTarget>;
  private readonly stateDir: string;
  private readonly env?: RetinueOptions["env"];
  private readonly httpTimeoutMs: number;
  private readonly onServerIdle: (baseUrl: string, cwd: string | undefined) => void;

  constructor(options: OpenCodeBackendOptions) {
    this.client = options.client;
    this.baseUrl = options.baseUrl?.replace(/\/+$/, "");
    this.resolveTarget =
      options.target ??
      (async () => {
        if (!this.client || !this.baseUrl) {
          throw new Error("OpenCode backend target is not configured");
        }
        return { client: this.client, baseUrl: this.baseUrl };
      });
    this.stateDir = resolveStateDir({ explicitStateDir: options.stateDir, env: options.env });
    this.env = options.env;
    this.httpTimeoutMs = resolveHttpTimeoutMs(options.env);
    this.onServerIdle =
      options.onServerIdle ??
      ((baseUrl, cwd) =>
        scheduleManagedOpenCodeServerIdleShutdown(baseUrl, {
          stateDir: this.stateDir,
          cwd,
          delayMs: resolveServerIdleMs(this.env)
        }));
  }

  async run(options: AgentRunOptions): Promise<JobMeta> {
    const jobId = `job_${randomUUID()}`;
    const paths = getJobPaths(this.stateDir, jobId);
    await fs.mkdir(paths.dir, { recursive: true });
    await fs.writeFile(paths.prompt, options.prompt, "utf8");

    const target = await this.resolveTarget(options.cwd);
    const readOnlyBashPolicy = resolveReadOnlyBashPolicy(options.readOnlyBashPolicy);
    const runnerMode = resolveRunnerMode(this.env);
    const rootAgent = resolveRootAgent(this.env);
    const requestedAgent = options.agent ?? "explore";
    const agents = await this.listAgents(target.client);
    const parentSession =
      runnerMode === "shared-root"
        ? await this.getOrCreateSharedRootSession(target, options.cwd, rootAgent)
        : await target.client.createSession({
            cwd: options.cwd,
            title: options.title ?? options.name,
            agent: rootAgent
          });
    const childSession = await target.client.createSession({
      cwd: options.cwd,
      title: options.title ?? options.name,
      parentID: parentSession.id,
      agent: requestedAgent,
      model: options.model,
      permission: this.buildChildSessionPermission({
        parentSession,
        parentAgent: findOpenCodeAgent(agents, rootAgent),
        childAgent: findOpenCodeAgent(agents, requestedAgent),
        readOnly: options.readOnly === true,
        readOnlyBashPolicy
      })
    });
    const baseline = await this.captureMessageBaseline(target.client, childSession.id);
    const now = new Date().toISOString();
    const meta: JobMeta = {
      schemaVersion: 1,
      backend: "opencode",
      jobId,
      pid: -1,
      status: "running",
      cwd: options.cwd,
      promptPath: paths.prompt,
      promptPreview: createPromptPreview(options.prompt),
      promptSha256: sha256(options.prompt),
      name: options.name,
      title: options.title,
      model: options.model,
      agent: options.agent,
      readOnly: options.readOnly === true,
      readOnlyPromptContract: options.readOnlyPromptContract === true,
      readOnlyToolDeny: options.readOnlyToolDeny === true,
      externalSessionId: childSession.id,
      externalRunnerMode: runnerMode,
      externalRootAgent: rootAgent,
      externalRootSessionId: parentSession.id,
      externalParentSessionId: parentSession.id,
      externalChildSessionIds: [childSession.id],
      externalServerUrl: target.baseUrl,
      externalSessionDirectory: childSession.directory ?? childSession.cwd,
      externalMessageBaselineCount: baseline.messageCount,
      externalCompletedAssistantBaselineCount: baseline.completedAssistantCount,
      parentJobId: options.parentJobId,
      parentSessionId: options.parentSessionId,
      recoveredFromJobId: options.recoveredFromJobId,
      attempt: options.attempt,
      recoveryReason: options.recoveryReason,
      recoveryPolicy: options.recoveryPolicy,
      originalStallReason: options.originalStallReason,
      recoveryStallReason: options.recoveryStallReason,
      args: [],
      createdAt: now,
      updatedAt: now
    };
    await writeJsonAtomic(paths.meta, meta);
    let submittedFinished = false;
    const submitted = this.submitPromptAsync(target.client, childSession.id, meta, options).then(() => {
      submittedFinished = true;
    });
    await Promise.race([submitted, sleep(50)]);
    if (submittedFinished) {
      return this.refreshNativeChildSessions(target.client, meta);
    }
    return this.readCurrentMetaOrFallback(jobId, meta);
  }

  async continueJob(options: AgentContinueOptions): Promise<JobMeta> {
    if (!options.externalSessionId) {
      return this.run(options);
    }
    if (options.readOnly === true) {
      return this.run({
        cwd: options.cwd,
        prompt: options.prompt,
        name: options.name,
        title: options.title,
        model: options.model,
        agent: options.agent,
        readOnly: true,
        readOnlyBashPolicy: options.readOnlyBashPolicy,
        parentJobId: options.parentJobId,
        parentSessionId: options.parentSessionId ?? options.externalSessionId,
        recoveredFromJobId: options.recoveredFromJobId,
        attempt: options.attempt,
        recoveryReason: options.recoveryReason,
        recoveryPolicy: options.recoveryPolicy,
        originalStallReason: options.originalStallReason,
        recoveryStallReason: options.recoveryStallReason,
        maxTurns: options.maxTurns,
        permissionMode: options.permissionMode,
        timeoutMs: options.timeoutMs
      });
    }
    const jobId = `job_${randomUUID()}`;
    const paths = getJobPaths(this.stateDir, jobId);
    await fs.mkdir(paths.dir, { recursive: true });
    await fs.writeFile(paths.prompt, options.prompt, "utf8");
    const target = await this.targetForContinue(options);
    const baseline = await this.captureMessageBaseline(target.client, options.externalSessionId);
    const now = new Date().toISOString();
    const meta: JobMeta = {
      schemaVersion: 1,
      backend: "opencode",
      jobId,
      pid: -1,
      status: "running",
      cwd: options.cwd,
      promptPath: paths.prompt,
      promptPreview: createPromptPreview(options.prompt),
      promptSha256: sha256(options.prompt),
      name: options.name,
      title: options.title,
      model: options.model,
      agent: options.agent,
      readOnly: false,
      externalSessionId: options.externalSessionId,
      externalServerUrl: target.baseUrl,
      externalSessionDirectory: options.cwd,
      externalMessageBaselineCount: baseline.messageCount,
      externalCompletedAssistantBaselineCount: baseline.completedAssistantCount,
      parentJobId: options.parentJobId,
      parentSessionId: options.parentSessionId,
      recoveredFromJobId: options.recoveredFromJobId,
      attempt: options.attempt,
      recoveryReason: options.recoveryReason,
      recoveryPolicy: options.recoveryPolicy,
      originalStallReason: options.originalStallReason,
      recoveryStallReason: options.recoveryStallReason,
      args: [],
      createdAt: now,
      updatedAt: now
    };
    await writeJsonAtomic(paths.meta, meta);
    const submitted = this.submitPromptAsync(target.client, options.externalSessionId, meta, options);
    await Promise.race([submitted, sleep(50)]);
    return this.readCurrentMetaOrFallback(jobId, meta);
  }

  async status(handle: AgentHandle): Promise<JobStatusResult> {
    const meta = await this.readMeta(handle.jobId);
    if (isProblem(meta)) {
      return meta;
    }
    return this.reconcileStatus(meta);
  }

  async listPermissions(handle: AgentHandle): Promise<AgentPermissionListResult> {
    const meta = await this.readMeta(handle.jobId);
    if (isProblem(meta)) {
      throw new Error(`Cannot list OpenCode permissions for ${handle.jobId}: ${meta.status}${meta.error ? `: ${meta.error}` : ""}`);
    }
    if (!meta.externalSessionId) {
      throw new Error(`Cannot list OpenCode permissions for ${handle.jobId}: missing OpenCode session id`);
    }
    const permissions = await this.pendingPermissionsForJob(this.clientForMeta(meta), meta);
    return {
      jobId: handle.jobId,
      backend: "opencode",
      status: meta.status,
      permissions: summarizePermissionRequests(permissions)
    };
  }

  async replyPermission(
    handle: AgentHandle,
    options: { requestId: string; reply: AgentPermissionReply; message?: string }
  ): Promise<AgentPermissionReplyResult> {
    const meta = await this.readMeta(handle.jobId);
    if (isProblem(meta)) {
      throw new Error(`Cannot reply to OpenCode permission for ${handle.jobId}: ${meta.status}${meta.error ? `: ${meta.error}` : ""}`);
    }
    if (!meta.externalSessionId) {
      throw new Error(`Cannot reply to OpenCode permission for ${handle.jobId}: missing OpenCode session id`);
    }
    const client = this.clientForMeta(meta);
    const permissions = await this.pendingPermissionsForJob(client, meta);
    const request = permissions.find((permission) => permission.id === options.requestId);
    if (!request) {
      throw new Error(`OpenCode permission request ${options.requestId} is not pending for Retinue job ${handle.jobId}`);
    }
    await client.replyPermission(options.requestId, options.reply, options.message);
    const activeMeta = await this.reopenExternalPermissionStall(meta, request);
    const remaining = await this.pendingPermissionsForJob(client, activeMeta);
    const result: AgentPermissionReplyResult = {
      jobId: handle.jobId,
      backend: "opencode",
      status: activeMeta.status,
      repliedRequestId: options.requestId,
      reply: options.reply,
      permissions: summarizePermissionRequests(remaining)
    };
    await this.writeJobTrace("opencode_permission_replied", activeMeta, {
      baseUrl: activeMeta.externalServerUrl ?? this.baseUrl ?? "",
      sessionId: activeMeta.externalSessionId,
      pendingPermissionCount: result.permissions.length
    }, {
      requestId: options.requestId,
      reply: options.reply
    });
    await appendJobDiagnostic(this.stateDir, handle.jobId, {
      event: "opencode_permission_replied",
      requestId: options.requestId,
      reply: options.reply,
      remainingPermissionCount: result.permissions.length
    });
    return result;
  }

  private async maybeSubmitSoftStallRescue(meta: JobMeta, diagnostic: Partial<OpenCodeJobDiagnostic>): Promise<void> {
    const recoverReadOnlyWriteIntent = diagnostic.readOnlyWriteIntent === true;
    if (
      !meta.externalSessionId ||
      meta.externalRescuePromptSubmittedAt ||
      !isSoftStallRescueEligible(diagnostic)
    ) {
      return;
    }
    const updated: JobMeta = {
      ...meta,
      status: meta.status === "stalled" ? "running" : meta.status,
      externalRescuePromptSubmittedAt: new Date().toISOString(),
      externalSoftStallRescueSourceReason: diagnostic.stallReason,
      externalSoftStallRescueSourceSummary: diagnostic.stallSummary,
      externalReadOnlyWriteIntentRecoveryJobMessageCount: recoverReadOnlyWriteIntent
        ? (diagnostic.jobMessageCount ?? meta.externalReadOnlyWriteIntentRecoveryJobMessageCount)
        : meta.externalReadOnlyWriteIntentRecoveryJobMessageCount,
      updatedAt: new Date().toISOString()
    };
    await writeJsonAtomic(getJobPaths(this.stateDir, meta.jobId).meta, updated);
    try {
      await this.clientForMeta(meta).promptAsync(meta.externalSessionId, {
        prompt: OPENCODE_SOFT_STALL_RESCUE_PROMPT,
        model: meta.model,
        agent: resolveSoftStallRescueAgent(meta.agent, this.env),
        tools: OPENCODE_FINAL_ANSWER_ONLY_TOOLS
      });
      const submittedDiagnostic = await this.inspectJob(updated);
      await this.writeJobTrace("opencode_job_soft_stall_rescue_submitted", updated, submittedDiagnostic);
      await appendJobDiagnostic(this.stateDir, meta.jobId, { event: "opencode_job_soft_stall_rescue_submitted", diagnostic: submittedDiagnostic });
    } catch (error) {
      const failedDiagnostic = {
        ...(await this.inspectJob(updated)),
        error: error instanceof Error ? error.message : String(error)
      };
      await this.writeJobTrace("opencode_job_soft_stall_rescue_failed", updated, failedDiagnostic);
      await appendJobDiagnostic(this.stateDir, meta.jobId, {
        event: "opencode_job_soft_stall_rescue_failed",
        error: error instanceof Error ? error.message : String(error),
        diagnostic: failedDiagnostic
      });
    }
  }

  private async maybeStartTaskLevelAttempt(meta: JobMeta, diagnostic: Partial<OpenCodeJobDiagnostic>): Promise<JobMeta | undefined> {
    const recoveryReason = selectTaskLevelAttemptReason(meta, diagnostic);
    if (!recoveryReason || (meta.attempt ?? 0) >= resolveTaskAttemptMax(this.env)) {
      return undefined;
    }
    const current = await this.readCurrentMetaOrFallback(meta.jobId, meta);
    if (current.selectedAttemptJobId) {
      const existing = await this.readMeta(current.selectedAttemptJobId);
      return isProblem(existing) ? undefined : existing;
    }
    const originalPrompt = await readTextIfExists(current.promptPath);
    if (!originalPrompt.trim()) {
      return undefined;
    }
    const attemptNumber = (current.attempt ?? 0) + 1;
    const attemptPrompt = createTaskLevelAttemptPrompt(originalPrompt, recoveryReason, diagnostic);
    const started = await this.run({
      cwd: current.cwd,
      prompt: attemptPrompt,
      name: current.name,
      title: current.title ?? current.name,
      model: current.model,
      agent: current.agent,
      readOnly: current.readOnly,
      parentJobId: current.jobId,
      parentSessionId: current.externalSessionId ?? current.parentSessionId,
      recoveredFromJobId: current.jobId,
      attempt: attemptNumber,
      recoveryReason,
      recoveryPolicy: "fresh_task_attempt",
      originalStallReason: diagnostic.softStallRescueSourceReason ?? diagnostic.stallReason,
      recoveryStallReason: diagnostic.recoveryStallReason ?? diagnostic.stallReason
    });
    const updated: JobMeta = {
      ...current,
      attemptJobIds: [...(current.attemptJobIds ?? []), started.jobId],
      selectedAttemptJobId: started.jobId,
      updatedAt: new Date().toISOString()
    };
    await writeJsonAtomic(getJobPaths(this.stateDir, current.jobId).meta, updated);
    const event = {
      event: "opencode_task_level_attempt_started",
      attemptJobId: started.jobId,
      attempt: started.attempt,
      recoveryReason,
      originalStallReason: started.originalStallReason,
      recoveryStallReason: started.recoveryStallReason
    };
    await this.writeJobTrace("opencode_task_level_attempt_started", updated, await this.inspectJob(updated), event);
    await appendJobDiagnostic(this.stateDir, current.jobId, event);
    await appendJobDiagnostic(this.stateDir, started.jobId, {
      event: "opencode_task_level_attempt_child",
      recoveredFromJobId: current.jobId,
      attempt: started.attempt,
      recoveryReason
    });
    return started;
  }

  private async selectedAttemptFor(meta: JobMeta): Promise<JobMeta | undefined> {
    if (!meta.selectedAttemptJobId) {
      return undefined;
    }
    const selected = await this.readMeta(meta.selectedAttemptJobId);
    return isProblem(selected) ? undefined : selected;
  }

  private async buildAttemptChain(meta: JobMeta): Promise<JobAttemptSummary[]> {
    const root = await this.findAttemptRoot(meta);
    const chain: JobAttemptSummary[] = [summarizeAttempt(root, root.selectedAttemptJobId)];
    for (const jobId of root.attemptJobIds ?? []) {
      const attempt = await this.readMeta(jobId);
      if (!isProblem(attempt)) {
        chain.push(summarizeAttempt(attempt, root.selectedAttemptJobId));
      }
    }
    if (meta.recoveredFromJobId && !chain.some((attempt) => attempt.jobId === meta.jobId)) {
      chain.push(summarizeAttempt(meta, root.selectedAttemptJobId));
    }
    return chain;
  }

  private async findAttemptRoot(meta: JobMeta): Promise<JobMeta> {
    let current = meta;
    const seen = new Set<string>();
    while (current.recoveredFromJobId && !seen.has(current.recoveredFromJobId)) {
      seen.add(current.jobId);
      const parent = await this.readMeta(current.recoveredFromJobId);
      if (isProblem(parent)) {
        return current;
      }
      current = parent;
    }
    return current;
  }

  private async decorateResultWithAttemptChain(result: JobResult, meta: JobMeta): Promise<JobResult> {
    const chain = await this.buildAttemptChain(meta);
    if (chain.length <= 1 && !meta.selectedAttemptJobId && !meta.recoveredFromJobId) {
      return result;
    }
    const root = await this.findAttemptRoot(meta);
    return {
      ...result,
      selectedAttemptJobId: root.selectedAttemptJobId,
      attemptChain: chain
    };
  }

  async result(handle: AgentHandle): Promise<JobResult> {
    const meta = await this.status(handle);
    if (isProblem(meta)) {
      return { jobId: handle.jobId, status: meta.status, error: meta.error };
    }
    const selectedAttempt = await this.selectedAttemptFor(meta);
    if (selectedAttempt) {
      return this.decorateResultWithAttemptChain(await this.result({ jobId: selectedAttempt.jobId }), meta);
    }
    if (!meta.externalSessionId) {
      return { jobId: handle.jobId, status: "corrupted", error: "Missing OpenCode session id" };
    }
    const paths = getJobPaths(this.stateDir, handle.jobId);
    if (meta.status === "stalled") {
      const cachedStdout = await readTextIfExists(paths.stdout);
      if (cachedStdout.trim()) {
        const cachedStderr = await readTextIfExists(paths.stderr);
        return this.decorateResultWithAttemptChain({
          jobId: handle.jobId,
          status: meta.status,
          stdout: cachedStdout,
          stderr: cachedStderr,
          stdoutPath: paths.stdout,
          stderrPath: paths.stderr,
          stdoutBytes: Buffer.byteLength(cachedStdout, "utf8"),
          stderrBytes: Buffer.byteLength(cachedStderr, "utf8"),
          stdoutTruncated: false,
          stderrTruncated: false,
          sessionId: meta.externalSessionId,
          parsedStdout: { result: cachedStdout },
          error: cachedStderr || cachedStdout
        }, meta);
      }
    }
    const client = this.clientForMeta(meta);
    const messages = await client.messages(meta.externalSessionId);
    const jobMessages = selectMessagesForMeta(messages, meta);
    const diagnostic = await this.inspectJob(meta);
    if (meta.status === "stalled") {
      const stderr = createStallMessage(diagnostic);
      const advisoryText = selectReadOnlyWriteIntentAdvisoryText(jobMessages, meta, diagnostic);
      if (advisoryText) {
        diagnostic.readOnlyAdvisoryText = true;
        diagnostic.readOnlyAdvisoryTextSummary =
          "Retinue returned visible read-only write-intent text as advisory stdout only; it is not trusted evidence.";
      }
      const text = advisoryText;
      const stdout = text || stderr;
      const textWarning =
        advisoryText ? createReadOnlyAdvisoryWarning() : meta.readOnly === true ? createReadOnlyTextWarning(stdout) : undefined;
      if (textWarning) {
        diagnostic.readOnlyTextWarning = true;
        diagnostic.readOnlyTextWarningSummary = textWarning;
      }
      await fs.writeFile(paths.stdout, stdout, "utf8");
      const stderrText = textWarning ? `${stderr}\n${textWarning}` : stderr;
      await fs.appendFile(paths.stderr, `${stderrText}\n`, "utf8");
      diagnostic.selectedAssistantTextBytes = Buffer.byteLength(stdout, "utf8");
      diagnostic.selectedAssistantSha256 = sha256(stdout);
      if (process.env.RETINUE_TRACE_TEXT_PREVIEW === "1") {
        diagnostic.selectedAssistantPreview = createPromptPreview(stdout);
      }
      await this.writeJobTrace("opencode_job_result_read", meta, diagnostic);
      await appendJobDiagnostic(this.stateDir, handle.jobId, { event: "opencode_job_result_read", diagnostic });
      return this.decorateResultWithAttemptChain({
        jobId: handle.jobId,
        status: meta.status,
        stdout,
        stderr: stderrText,
        stdoutPath: paths.stdout,
        stderrPath: paths.stderr,
        stdoutBytes: Buffer.byteLength(stdout, "utf8"),
        stderrBytes: Buffer.byteLength(stderrText, "utf8"),
        stdoutTruncated: false,
        stderrTruncated: false,
        sessionId: meta.externalSessionId,
        parsedStdout: { result: stdout },
        error: stderrText
      }, meta);
    }
    const resultMessages = selectResultMessagesForMeta(jobMessages, meta);
    const text = meta.externalMessageBaselineCount === undefined && resultMessages === jobMessages ? latestAssistantMessageText(messages) : latestAssistantMessageText(resultMessages);
    const textWarning = meta.readOnly === true ? createReadOnlyTextWarning(text) : undefined;
    if (textWarning) {
      diagnostic.readOnlyTextWarning = true;
      diagnostic.readOnlyTextWarningSummary = textWarning;
    }
    await fs.writeFile(paths.stdout, text, "utf8");
    diagnostic.selectedAssistantTextBytes = Buffer.byteLength(text, "utf8");
    diagnostic.selectedAssistantSha256 = sha256(text);
    if (process.env.RETINUE_TRACE_TEXT_PREVIEW === "1") {
      diagnostic.selectedAssistantPreview = createPromptPreview(text);
    }
    await this.writeJobTrace("opencode_job_result_read", meta, diagnostic);
    await appendJobDiagnostic(this.stateDir, handle.jobId, { event: "opencode_job_result_read", diagnostic });
    return this.decorateResultWithAttemptChain({
      jobId: handle.jobId,
      status: meta.status,
      stdout: text,
      stderr: textWarning ?? "",
      stdoutPath: paths.stdout,
      stderrPath: paths.stderr,
      stdoutBytes: Buffer.byteLength(text, "utf8"),
      stderrBytes: Buffer.byteLength(textWarning ?? "", "utf8"),
      stdoutTruncated: false,
      stderrTruncated: false,
      sessionId: meta.externalSessionId,
      parsedStdout: { result: text }
    }, meta);
  }

  async abort(handle: AgentHandle): Promise<void> {
    const meta = await this.readMeta(handle.jobId);
    if (isProblem(meta) || !meta.externalSessionId) {
      return;
    }
    let abortError: string | undefined;
    try {
      await this.clientForMeta(meta).abort(meta.externalSessionId);
    } catch (error) {
      abortError = error instanceof Error ? error.message : String(error);
      await appendJobDiagnostic(this.stateDir, handle.jobId, { event: "opencode_job_abort_failed", error: abortError });
    }
    const updated: JobMeta = {
      ...meta,
      status: "killed",
      updatedAt: new Date().toISOString()
    };
    await writeJsonAtomic(getJobPaths(this.stateDir, handle.jobId).meta, updated);
    if (abortError) {
      await appendJobDiagnostic(this.stateDir, handle.jobId, { event: "opencode_job_abort_marked_killed", error: abortError });
    }
    await this.maybeScheduleServerIdleShutdown(updated);
  }

  async wait(handle: AgentHandle, timeoutMs = DEFAULT_WAIT_TIMEOUT_MS): Promise<WaitResult> {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    let deferredSoftStall = false;
    for (;;) {
      const status = await this.status(handle);
      if (isProblem(status)) {
        return { jobId: handle.jobId, status: status.status };
      }
      const selectedAttempt = await this.selectedAttemptFor(status);
      if (selectedAttempt) {
        const waited = await this.wait({ jobId: selectedAttempt.jobId }, Math.max(0, deadline - Date.now()));
        return {
          ...waited,
          requestedJobId: handle.jobId,
          selectedAttemptJobId: selectedAttempt.jobId,
          attemptChain: await this.buildAttemptChain(status)
        };
      }
      if (status.status === "stalled") {
        const diagnostic = await this.inspectJob(status);
        const canDeferStall =
          isSoftStallRescueEligible(diagnostic) ||
          (diagnostic.readOnlyWriteIntent === true && status.externalRescuePromptSubmittedAt === undefined);
        if (canDeferStall && Date.now() < deadline) {
          await this.maybeSubmitSoftStallRescue(status, diagnostic);
          if (!deferredSoftStall) {
            await this.writeJobTrace("opencode_job_soft_stall_deferred", status, diagnostic);
            await appendJobDiagnostic(this.stateDir, handle.jobId, { event: "opencode_job_soft_stall_deferred", diagnostic });
            deferredSoftStall = true;
          }
          await sleep(DEFAULT_WAIT_POLL_MS);
          continue;
        }
        if (this.isSoftStallRescuePending(status, diagnostic)) {
          await this.writeJobTrace("opencode_job_soft_stall_rescue_pending", status, diagnostic);
          await appendJobDiagnostic(this.stateDir, handle.jobId, { event: "opencode_job_soft_stall_rescue_pending", diagnostic });
          return { jobId: handle.jobId, status: "running" };
        }
        const attempt = await this.maybeStartTaskLevelAttempt(status, diagnostic);
        if (attempt) {
          const waited = await this.wait({ jobId: attempt.jobId }, Math.max(0, deadline - Date.now()));
          const updatedRoot = await this.readCurrentMetaOrFallback(status.jobId, status);
          return {
            ...waited,
            requestedJobId: handle.jobId,
            selectedAttemptJobId: attempt.jobId,
            attemptChain: await this.buildAttemptChain(updatedRoot)
          };
        }
        await this.maybeScheduleServerIdleShutdown(status);
        return { jobId: handle.jobId, status: status.status };
      }
      if (isTerminal(status.status)) {
        return { jobId: handle.jobId, status: status.status };
      }
      if (Date.now() >= deadline) {
        const meta = await this.readMeta(handle.jobId);
        if (!isProblem(meta)) {
          const diagnostic = await this.inspectJob(meta);
          if (this.isReadOnlyWriteIntentRecoveryExpired(meta, diagnostic)) {
            const expiredDiagnostic: OpenCodeJobDiagnostic = {
              ...diagnostic,
              stallReason: "read_only_write_intent",
              stallSummary:
                "OpenCode read-only job attempted a write-capable tool, and recovery did not produce usable final text."
            };
            const stalled: JobMeta = { ...meta, status: "stalled", updatedAt: new Date().toISOString() };
            await writeJsonAtomic(getJobPaths(this.stateDir, handle.jobId).meta, stalled);
            await this.writeJobTrace("opencode_job_wait_timeout", stalled, expiredDiagnostic);
            await appendJobDiagnostic(this.stateDir, handle.jobId, { event: "opencode_job_wait_timeout", diagnostic: expiredDiagnostic });
            await this.writeJobTrace("opencode_job_stalled", stalled, expiredDiagnostic, { fromStatus: meta.status, toStatus: "stalled" });
            await appendJobDiagnostic(this.stateDir, handle.jobId, {
              event: "opencode_job_stalled",
              fromStatus: meta.status,
              toStatus: "stalled",
              diagnostic: expiredDiagnostic
            });
            return { jobId: handle.jobId, status: "stalled" };
          }
          if (diagnostic.stallReason) {
            if (this.isSoftStallRescuePending(meta, diagnostic)) {
              await this.writeJobTrace("opencode_job_wait_timeout", meta, diagnostic);
              await appendJobDiagnostic(this.stateDir, handle.jobId, { event: "opencode_job_wait_timeout", diagnostic });
              await this.writeJobTrace("opencode_job_soft_stall_rescue_pending", meta, diagnostic);
              await appendJobDiagnostic(this.stateDir, handle.jobId, { event: "opencode_job_soft_stall_rescue_pending", diagnostic });
              return { jobId: handle.jobId, status: "running" };
            }
            const stalled: JobMeta = { ...meta, status: "stalled", updatedAt: new Date().toISOString() };
            await writeJsonAtomic(getJobPaths(this.stateDir, handle.jobId).meta, stalled);
            await this.writeJobTrace("opencode_job_wait_timeout", stalled, diagnostic);
            await appendJobDiagnostic(this.stateDir, handle.jobId, { event: "opencode_job_wait_timeout", diagnostic });
            await this.writeJobTrace("opencode_job_stalled", stalled, diagnostic, { fromStatus: meta.status, toStatus: "stalled" });
            await appendJobDiagnostic(this.stateDir, handle.jobId, {
              event: "opencode_job_stalled",
              fromStatus: meta.status,
              toStatus: "stalled",
              diagnostic
            });
            const attempt = await this.maybeStartTaskLevelAttempt(stalled, diagnostic);
            if (attempt) {
              const waited = await this.wait({ jobId: attempt.jobId }, Math.max(0, deadline - Date.now()));
              const updatedRoot = await this.readCurrentMetaOrFallback(stalled.jobId, stalled);
              return {
                ...waited,
                requestedJobId: handle.jobId,
                selectedAttemptJobId: attempt.jobId,
                attemptChain: await this.buildAttemptChain(updatedRoot)
              };
            }
            if (isHardStallDiagnostic(diagnostic)) {
              await this.maybeScheduleServerIdleShutdown(stalled);
            }
            return { jobId: handle.jobId, status: "stalled" };
          }
          await this.writeJobTrace("opencode_job_wait_timeout", meta, diagnostic);
          await appendJobDiagnostic(this.stateDir, handle.jobId, { event: "opencode_job_wait_timeout", diagnostic });
        }
        return { jobId: handle.jobId, status: "running" };
      }
      await sleep(DEFAULT_WAIT_POLL_MS);
    }
  }

  private isSoftStallRescuePending(meta: JobMeta, diagnostic: Partial<OpenCodeJobDiagnostic>): boolean {
    if (!meta.externalRescuePromptSubmittedAt || diagnostic.recoveredFromReadOnlyWriteIntent === true) {
      return false;
    }
    if (isHardStallDiagnostic(diagnostic) || !isSoftStallRescueEligible(diagnostic)) {
      return false;
    }
    const submittedAt = Date.parse(meta.externalRescuePromptSubmittedAt);
    if (!Number.isFinite(submittedAt)) {
      return false;
    }
    return Date.now() - submittedAt < resolveSoftStallRescueGraceMs(this.env);
  }

  private isReadOnlyWriteIntentRecoveryExpired(meta: JobMeta, diagnostic: Partial<OpenCodeJobDiagnostic>): boolean {
    if (
      !meta.externalRescuePromptSubmittedAt ||
      meta.externalReadOnlyWriteIntentRecoveryJobMessageCount === undefined ||
      diagnostic.recoveredFromReadOnlyWriteIntent === true ||
      diagnostic.readOnlyWriteIntent === true
    ) {
      return false;
    }
    const submittedAt = Date.parse(meta.externalRescuePromptSubmittedAt);
    if (!Number.isFinite(submittedAt)) {
      return false;
    }
    return Date.now() - submittedAt >= resolveSoftStallRescueGraceMs(this.env);
  }

  async cleanup(options: CleanupOptions = {}): Promise<CleanupResult> {
    const olderThanMs = options.olderThanMs ?? 0;
    const removedJobIds: string[] = [];
    const removedTempFiles: string[] = [];
    const now = Date.now();

    for (const entry of await readDirIfExists(getJobsDir(this.stateDir))) {
      if (!entry.isDirectory()) {
        continue;
      }
      const meta = await this.readMeta(entry.name);
      if (isProblem(meta) || meta.backend !== "opencode" || !isCleanupSafeStatus(meta.status)) {
        continue;
      }
      const updatedAt = Date.parse(meta.updatedAt);
      if (Number.isFinite(updatedAt) && now - updatedAt < olderThanMs) {
        continue;
      }
      const paths = getJobPaths(this.stateDir, entry.name);
      removedTempFiles.push(...(await listTempFiles(paths.dir)));
      await fs.rm(paths.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      removedJobIds.push(entry.name);
    }

    return { removedJobIds, removedTempFiles };
  }

  private async readMeta(jobId: string): Promise<JobMeta | JobProblem> {
    try {
      return JSON.parse(await fs.readFile(getJobPaths(this.stateDir, jobId).meta, "utf8")) as JobMeta;
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
        return { jobId, status: "not_found" };
      }
      return { jobId, status: "corrupted", error: error instanceof Error ? error.message : String(error) };
    }
  }

  private async readCurrentMetaOrFallback(jobId: string, fallback: JobMeta): Promise<JobMeta> {
    const current = await this.readMeta(jobId);
    return isProblem(current) ? fallback : current;
  }

  private async reconcileStatus(meta: JobMeta): Promise<JobMeta | JobProblem> {
    if (meta.status === "stalled") {
      const cachedStdout = await readTextIfExists(getJobPaths(this.stateDir, meta.jobId).stdout);
      if (cachedStdout.trim()) {
        return meta;
      }
    }
    if (!meta.externalSessionId || (isTerminal(meta.status) && meta.status !== "stalled" && meta.status !== "killed")) {
      return meta;
    }
    try {
      const client = this.clientForMeta(meta);
      const session = await client.getSession(meta.externalSessionId);
      let status = meta.status;
      if (await this.hasReadOnlyWriteIntent(client, meta.externalSessionId, meta)) {
        status = "stalled";
      } else if (session.state === "completed") {
        status = "completed";
      } else if (session.state === "failed") {
        status = "failed";
      } else if (await this.hasNewCompletedAssistantMessage(client, meta.externalSessionId, meta)) {
        status = "completed";
      } else if (session.aborted === true) {
        status = "killed";
      } else if (meta.status === "stalled") {
        status = "stalled";
      } else if (await this.isStalledOpenCodeJob(client, meta.externalSessionId, meta)) {
        status = "stalled";
      } else {
        status = "running";
      }
      if (status === meta.status) {
        return meta;
      }
      const updated: JobMeta = {
        ...meta,
        status,
        externalReadOnlyWriteIntentRecoveredAt:
          status === "completed" && meta.externalReadOnlyWriteIntentRecoveryJobMessageCount !== undefined
            ? (meta.externalReadOnlyWriteIntentRecoveredAt ?? new Date().toISOString())
            : meta.externalReadOnlyWriteIntentRecoveredAt,
        updatedAt: new Date().toISOString()
      };
      await writeJsonAtomic(getJobPaths(this.stateDir, meta.jobId).meta, updated);
      const diagnostic = await this.inspectJob(updated);
      await this.writeJobTrace("opencode_job_status_changed", updated, diagnostic, { fromStatus: meta.status, toStatus: status });
      await appendJobDiagnostic(this.stateDir, meta.jobId, {
        event: "opencode_job_status_changed",
        fromStatus: meta.status,
        toStatus: status,
        diagnostic
      });
      if (status === "stalled") {
        await this.writeJobTrace("opencode_job_stalled", updated, diagnostic, { fromStatus: meta.status, toStatus: status });
        await appendJobDiagnostic(this.stateDir, meta.jobId, {
          event: "opencode_job_stalled",
          fromStatus: meta.status,
          toStatus: status,
          diagnostic
        });
      }
      if (isTerminal(status) && (status !== "stalled" || isHardStallDiagnostic(diagnostic))) {
        await this.maybeScheduleServerIdleShutdown(updated);
      }
      return updated;
    } catch (error) {
      if (error instanceof OpenCodeClientError && error.status === 404) {
        return { jobId: meta.jobId, status: "not_found", error: "OpenCode session not found" };
      }
      if (meta.status === "killed") {
        return meta;
      }
      if (isBackendUnavailableError(error)) {
        return { jobId: meta.jobId, status: "backend_unreachable", error: error instanceof Error ? error.message : String(error) };
      }
      return { jobId: meta.jobId, status: "corrupted", error: error instanceof Error ? error.message : String(error) };
    }
  }

  private async captureMessageBaseline(client: OpenCodeClient, sessionId: string): Promise<{ messageCount: number; completedAssistantCount: number }> {
    const messages = await client.messages(sessionId);
    return {
      messageCount: messages.length,
      completedAssistantCount: countCompletedAssistantMessages(messages)
    };
  }

  private async hasNewCompletedAssistantMessage(client: OpenCodeClient, sessionId: string, meta: JobMeta): Promise<boolean> {
    const messages = await client.messages(sessionId);
    const jobMessages = selectMessagesForMeta(messages, meta);
    const completionMessages = selectResultMessagesForMeta(jobMessages, meta);
    if (completionMessages.some(isCompletedAssistantMessage)) {
      return true;
    }
    if (meta.externalMessageBaselineCount !== undefined || meta.externalReadOnlyWriteIntentRecoveryJobMessageCount !== undefined) {
      return false;
    }
    return countCompletedAssistantMessages(messages) > (meta.externalCompletedAssistantBaselineCount ?? 0);
  }

  private async hasReadOnlyWriteIntent(client: OpenCodeClient, sessionId: string, meta: JobMeta): Promise<boolean> {
    if (meta.readOnly !== true) {
      return false;
    }
    const messages = await client.messages(sessionId);
    const jobMessages = selectMessagesForMeta(messages, meta);
    const writeIntentMessages = selectReadOnlyWriteIntentMessagesForMeta(jobMessages, meta);
    return countWriteIntentToolParts(writeIntentMessages) > 0;
  }

  private async isStalledOpenCodeJob(client: OpenCodeClient, sessionId: string, meta: JobMeta): Promise<boolean> {
    const messages = await client.messages(sessionId);
    const jobMessages = selectMessagesForMeta(messages, meta);
    const pendingPermissions = await this.pendingPermissionsForJob(client, meta);
    const stall = computeStallDiagnostic(jobMessages, meta, this.env, pendingPermissions);
    return stall !== undefined;
  }

  private async pendingPermissionsForJob(client: OpenCodeClient, meta: JobMeta): Promise<OpenCodePermissionRequest[]> {
    if (!meta.externalSessionId) {
      return [];
    }
    try {
      const permissions = await client.permissions();
      const sessionIds = new Set([meta.externalSessionId, ...(meta.externalChildSessionIds ?? [])].filter(Boolean));
      return permissions.filter((permission) => sessionIds.has(permission.sessionID));
    } catch (error) {
      if (error instanceof OpenCodeClientError && (error.status === 404 || error.status === 405)) {
        return [];
      }
      throw error;
    }
  }

  private async reopenExternalPermissionStall(meta: JobMeta, request: OpenCodePermissionRequest): Promise<JobMeta> {
    if (meta.status !== "stalled" || request.permission !== "external_directory") {
      return meta;
    }
    const updated: JobMeta = {
      ...meta,
      status: "running",
      updatedAt: new Date().toISOString()
    };
    const paths = getJobPaths(this.stateDir, meta.jobId);
    await Promise.all([
      writeJsonAtomic(paths.meta, updated),
      fs.rm(paths.stdout, { force: true }),
      fs.rm(paths.stderr, { force: true })
    ]);
    return updated;
  }

  private async inspectJob(meta: JobMeta): Promise<OpenCodeJobDiagnostic> {
    const diagnostic: OpenCodeJobDiagnostic = {
      baseUrl: meta.externalServerUrl ?? this.baseUrl ?? "",
      sessionId: meta.externalSessionId,
      runnerMode: meta.externalRunnerMode,
      rootAgent: meta.externalRootAgent,
      rootSessionId: meta.externalRootSessionId,
      parentSessionId: meta.externalParentSessionId,
      childSessionIds: meta.externalChildSessionIds
    };
    if (!meta.externalSessionId) {
      return diagnostic;
    }
    try {
      const client = this.clientForMeta(meta);
      const [session, messages, pendingPermissions] = await Promise.all([
        client.getSession(meta.externalSessionId),
        client.messages(meta.externalSessionId),
        this.pendingPermissionsForJob(client, meta)
      ]);
      const jobMessages = selectMessagesForMeta(messages, meta);
      const lastMessage = jobMessages.at(-1) ?? messages.at(-1);
      const lastAssistant = [...jobMessages].reverse().find((message) => message.info?.role === "assistant");
      diagnostic.sessionDirectory = typeof session.directory === "string" ? session.directory : undefined;
      diagnostic.sessionPath = typeof session.path === "string" ? session.path : undefined;
      diagnostic.sessionState = session.state;
      diagnostic.sessionAborted = session.aborted === true;
      diagnostic.baselineMessageCount = meta.externalMessageBaselineCount;
      diagnostic.baselineCompletedAssistantCount = meta.externalCompletedAssistantBaselineCount;
      diagnostic.messageCount = messages.length;
      diagnostic.jobMessageCount = jobMessages.length;
      diagnostic.completedAssistantCount = countCompletedAssistantMessages(messages);
      diagnostic.jobCompletedAssistantCount = countCompletedAssistantMessages(jobMessages);
      diagnostic.lastMessageRole = lastMessage?.info?.role;
      diagnostic.lastMessageFinish = stringInfo(lastMessage, "finish");
      diagnostic.lastMessageInfoKeys = Object.keys(lastMessage?.info ?? {}).sort();
      diagnostic.lastMessagePartTypes = lastMessage?.parts?.map((part) => part.type ?? "unknown");
      diagnostic.lastMessagePartSummaries = summarizeMessageParts(lastMessage);
      diagnostic.lastMessageTextBytes = Buffer.byteLength(extractMessageText(lastMessage ?? {}), "utf8");
      diagnostic.lastMessageError = diagnosticValuePreview(lastMessage?.info?.error);
      diagnostic.lastAssistantFinish = stringInfo(lastAssistant, "finish");
      diagnostic.lastAssistantPartTypes = lastAssistant?.parts?.map((part) => part.type ?? "unknown");
      diagnostic.lastAssistantPartSummaries = summarizeMessageParts(lastAssistant);
      diagnostic.lastAssistantTextBytes = Buffer.byteLength(latestAssistantMessageText(jobMessages), "utf8");
      diagnostic.lastAssistantError = diagnosticValuePreview(lastAssistant?.info?.error);
      diagnostic.lastAssistantProviderID = stringInfo(lastAssistant, "providerID");
      diagnostic.lastAssistantModelID = stringInfo(lastAssistant, "modelID");
      diagnostic.lastAssistantAgent = stringInfo(lastAssistant, "agent");
      diagnostic.lastAssistantMode = stringInfo(lastAssistant, "mode");
      diagnostic.lastAssistantCost = numberInfo(lastAssistant, "cost");
      diagnostic.lastAssistantTokens = lastAssistant?.info?.tokens;
      diagnostic.patchPartCount = countPatchParts(jobMessages);
      const readOnlyWriteIntentMessages = selectReadOnlyWriteIntentMessagesForMeta(jobMessages, meta);
      diagnostic.readOnlyPatchPartCount = meta.readOnly === true ? countPatchParts(readOnlyWriteIntentMessages) : 0;
      diagnostic.writeIntentToolPartCount = countWriteIntentToolParts(jobMessages);
      diagnostic.readOnlyWriteIntentToolPartCount = meta.readOnly === true ? countWriteIntentToolParts(readOnlyWriteIntentMessages) : 0;
      diagnostic.readOnlyWriteIntent = (diagnostic.readOnlyWriteIntentToolPartCount ?? 0) > 0;
      diagnostic.readOnlyWriteIntentRecoveryJobMessageCount = meta.externalReadOnlyWriteIntentRecoveryJobMessageCount;
      diagnostic.softStallRescueSourceReason = isOpenCodeStallReason(meta.externalSoftStallRescueSourceReason)
        ? meta.externalSoftStallRescueSourceReason
        : undefined;
      diagnostic.softStallRescueSourceSummary = meta.externalSoftStallRescueSourceSummary;
      diagnostic.recoveredFromReadOnlyWriteIntent =
        meta.readOnly === true &&
        meta.externalReadOnlyWriteIntentRecoveryJobMessageCount !== undefined &&
        diagnostic.readOnlyWriteIntent !== true &&
        selectResultMessagesForMeta(jobMessages, meta).some(isCompletedAssistantMessage);
      diagnostic.messageSummaries = jobMessages.map((message) => ({
        role: message.info?.role,
        finish: stringInfo(message, "finish"),
        partTypes: message.parts?.map((part) => part.type ?? "unknown") ?? [],
        partSummaries: summarizeMessageParts(message),
        textBytes: Buffer.byteLength(extractMessageText(message), "utf8"),
        completed: isCompletedAssistantMessage(message),
        messageError: diagnosticValuePreview(message.info?.error)
      }));
      Object.assign(diagnostic, computeStallDiagnostic(jobMessages, meta, this.env, pendingPermissions));
      if (
        meta.status === "stalled" &&
        diagnostic.softStallRescueSourceReason &&
        diagnostic.stallReason &&
        diagnostic.stallReason !== diagnostic.softStallRescueSourceReason
      ) {
        diagnostic.recoveryStallReason = diagnostic.stallReason;
        diagnostic.recoveryStallSummary = diagnostic.stallSummary;
      }
      if (
        meta.status === "stalled" &&
        meta.readOnly === true &&
        meta.externalReadOnlyWriteIntentRecoveryJobMessageCount !== undefined &&
        diagnostic.recoveredFromReadOnlyWriteIntent !== true &&
        diagnostic.readOnlyWriteIntent !== true
      ) {
        if (diagnostic.stallReason && diagnostic.stallReason !== "read_only_write_intent") {
          diagnostic.recoveryStallReason = diagnostic.stallReason;
          diagnostic.recoveryStallSummary = diagnostic.stallSummary;
        }
        diagnostic.stallReason = "read_only_write_intent";
        diagnostic.stallSummary = "OpenCode read-only job attempted a write-capable tool, and recovery did not produce usable final text.";
      }
    } catch (error) {
      diagnostic.error = error instanceof Error ? error.message : String(error);
    }
    return diagnostic;
  }

  private async maybeScheduleServerIdleShutdown(meta: JobMeta): Promise<void> {
    if (!meta.externalServerUrl) {
      return;
    }
    if (await this.hasRunningJobsForServer(meta.externalServerUrl)) {
      return;
    }
    this.onServerIdle(meta.externalServerUrl, meta.cwd);
  }

  private async hasRunningJobsForServer(baseUrl: string): Promise<boolean> {
    for (const entry of await readDirIfExists(getJobsDir(this.stateDir))) {
      if (!entry.isDirectory()) {
        continue;
      }
      const meta = await this.readMeta(entry.name);
      if (isProblem(meta) || meta.backend !== "opencode") {
        continue;
      }
      if (meta.status === "running" && meta.externalServerUrl === baseUrl) {
        return true;
      }
    }
    return false;
  }

  private async writeJobTrace(event: string, meta: JobMeta, diagnostic: OpenCodeJobDiagnostic, extra: Record<string, unknown> = {}): Promise<void> {
    await writeRetinueTrace(this.stateDir, {
      event,
      backend: "opencode",
      jobId: meta.jobId,
      status: meta.status,
      ...extra,
      cwd: meta.cwd,
      promptSha256: meta.promptSha256,
      diagnostic
    });
  }

  private async submitPromptAsync(client: OpenCodeClient, sessionId: string, meta: JobMeta, options: AgentRunOptions): Promise<void> {
    try {
      const prompt = buildOpenCodePrompt(
        options.prompt,
        options.readOnly === true && options.readOnlyPromptContract === true,
        resolveReadOnlyBashPolicy(options.readOnlyBashPolicy)
      );
      await client.promptAsync(sessionId, {
        prompt,
        agent: options.agent ?? "explore",
        model: options.model,
        tools:
          options.readOnly === true && options.readOnlyToolDeny === true
            ? buildReadOnlyTools(resolveReadOnlyBashPolicy(options.readOnlyBashPolicy))
            : undefined
      });
      await this.writeJobTrace("opencode_job_prompt_submitted", meta, await this.inspectJob(meta));
    } catch (error) {
      const failed: JobMeta = { ...meta, status: "failed", updatedAt: new Date().toISOString() };
      await writeJsonAtomic(getJobPaths(this.stateDir, meta.jobId).meta, failed);
      await appendJobDiagnostic(this.stateDir, meta.jobId, {
        event: "opencode_job_prompt_failed",
        error: error instanceof Error ? error.message : String(error)
      });
      await this.writeJobTrace("opencode_job_prompt_failed", failed, await this.inspectJob(failed));
      await this.maybeScheduleServerIdleShutdown(failed);
    }
  }

  private async refreshNativeChildSessions(client: OpenCodeClient, meta: JobMeta): Promise<JobMeta> {
    if (!meta.externalParentSessionId) {
      return meta;
    }
    try {
      const current = await this.readCurrentMetaOrFallback(meta.jobId, meta);
      if (current.status !== "running") {
        return current;
      }
      const children = await client.children(meta.externalParentSessionId);
      const childIds = children.map((session) => session.id).filter((id): id is string => typeof id === "string");
      const updated: JobMeta = { ...current, externalChildSessionIds: childIds, updatedAt: new Date().toISOString() };
      await writeJsonAtomic(getJobPaths(this.stateDir, meta.jobId).meta, updated);
      return updated;
    } catch {
      return meta;
    }
  }

  private async getOrCreateSharedRootSession(target: OpenCodeBackendTarget, cwd: string | undefined, agent: string) {
    const key = [target.baseUrl, cwd ?? "", agent].join("\0");
    const existing = SHARED_ROOT_SESSIONS.get(key);
    if (existing) {
      try {
        const session = await target.client.getSession(existing.id);
        return session;
      } catch {
        SHARED_ROOT_SESSIONS.delete(key);
      }
    }
    const session = await target.client.createSession({
      cwd,
      title: "retinue-shared-root",
      agent
    });
    SHARED_ROOT_SESSIONS.set(key, { id: session.id, baseUrl: target.baseUrl, cwd, agent });
    return session;
  }

  private async listAgents(client: OpenCodeClient): Promise<OpenCodeAgentInfo[]> {
    try {
      return await client.agents();
    } catch {
      return [];
    }
  }

  private buildChildSessionPermission(input: {
    parentSession: { permission?: OpenCodePermissionRule[] };
    parentAgent: OpenCodeAgentInfo | undefined;
    childAgent: OpenCodeAgentInfo | undefined;
    readOnly: boolean;
    readOnlyBashPolicy: OpenCodeReadOnlyBashPolicy;
  }): OpenCodePermissionRule[] | undefined {
    const derived = deriveSubagentSessionPermission({
      parentSessionPermission: normalizePermissionRules(input.parentSession.permission),
      parentAgent: input.parentAgent,
      subagent: input.childAgent
    });
    if (input.readOnly) {
      return mergePermissionRules(derived, buildReadOnlyPermission(input.readOnlyBashPolicy));
    }
    return derived.length > 0 ? derived : undefined;
  }

  private clientForMeta(meta: JobMeta): OpenCodeClient {
    const baseUrl = meta.externalServerUrl?.replace(/\/+$/, "");
    if (baseUrl && baseUrl !== this.baseUrl) {
      return new OpenCodeClient(baseUrl, { timeoutMs: this.httpTimeoutMs });
    }
    if (!this.client) {
      throw new Error("OpenCode backend client is not configured");
    }
    return this.client;
  }

  private async targetForContinue(options: AgentContinueOptions): Promise<OpenCodeBackendTarget> {
    if (options.parentJobId) {
      const parent = await this.readMeta(options.parentJobId);
      if (!isProblem(parent) && parent.externalServerUrl) {
        const baseUrl = parent.externalServerUrl.replace(/\/+$/, "");
        return { client: new OpenCodeClient(baseUrl, { timeoutMs: this.httpTimeoutMs }), baseUrl };
      }
    }
    return this.resolveTarget(options.cwd);
  }
}

async function appendJobDiagnostic(stateDir: string, jobId: string, value: unknown): Promise<void> {
  const paths = getJobPaths(stateDir, jobId);
  try {
    await fs.mkdir(paths.dir, { recursive: true });
    await fs.appendFile(paths.stderr, `${JSON.stringify({ time: new Date().toISOString(), ...asRecord(value) })}\n`, "utf8");
  } catch {
    // Diagnostics must never make Retinue tool calls fail.
  }
}

async function writeRetinueTrace(stateDir: string, value: unknown): Promise<void> {
  const tracePath = getRetinueTracePath(stateDir);
  try {
    await fs.mkdir(tracePath.replace(/[\\/][^\\/]+$/, ""), { recursive: true });
    await fs.appendFile(tracePath, `${JSON.stringify({ time: new Date().toISOString(), pid: process.pid, ...asRecord(value) })}\n`, "utf8");
  } catch {
    // Diagnostics must never make Retinue tool calls fail.
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : { value };
}

function diagnosticValuePreview(value: unknown): DiagnosticValuePreview | undefined {
  if (value === undefined) {
    return undefined;
  }
  const type = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  let text: string;
  if (typeof value === "string") {
    text = value;
  } else {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
  }
  const redacted = redactDiagnosticValue(text);
  const bytes = Buffer.byteLength(redacted, "utf8");
  if (bytes <= DIAGNOSTIC_VALUE_PREVIEW_BYTES) {
    return { type, preview: redacted };
  }
  return {
    type,
    preview: truncateUtf8(redacted, DIAGNOSTIC_VALUE_PREVIEW_BYTES),
    truncated: true
  };
}

function summarizeMessageParts(message: OpenCodeMessage | undefined): OpenCodePartSummary[] | undefined {
  if (!Array.isArray(message?.parts)) {
    return undefined;
  }
  return message.parts.map((part) => {
    const state = typeof part.state === "object" && part.state !== null ? (part.state as Record<string, unknown>) : undefined;
    const summary: OpenCodePartSummary = {
      type: typeof part.type === "string" ? part.type : "unknown"
    };
    if (typeof part.tool === "string") {
      summary.tool = part.tool;
    }
    if (typeof part.callID === "string") {
      summary.callID = part.callID;
    }
    if (typeof state?.status === "string") {
      summary.stateStatus = state.status;
    }
    summary.stateInput = diagnosticValuePreview(state?.input);
    if (typeof part.text === "string") {
      summary.textBytes = Buffer.byteLength(part.text, "utf8");
    }
    return summary;
  });
}

function redactDiagnosticValue(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]")
    .replace(/sk-[A-Za-z0-9_-]{16,}/g, "sk-[REDACTED]");
}

function truncateUtf8(value: string, maxBytes: number): string {
  let bytes = 0;
  let result = "";
  for (const char of value) {
    const charBytes = Buffer.byteLength(char, "utf8");
    if (bytes + charBytes > maxBytes) {
      break;
    }
    result += char;
    bytes += charBytes;
  }
  return result;
}

function isTerminal(status: JobStatusResult["status"]): boolean {
  return status === "completed" || status === "failed" || status === "killed" || status === "timed_out" || status === "stalled";
}
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isProblem(value: JobStatusResult): value is JobProblem {
  return value.status === "not_found" || value.status === "corrupted" || value.status === "backend_unreachable";
}

function isBackendUnavailableError(error: unknown): boolean {
  if (!(error instanceof OpenCodeClientError)) {
    return false;
  }
  return error.code === "transport_error" || error.code === "invalid_json" || error.status === 0 || (error.status ?? 0) >= 500;
}

function selectMessagesForMeta(messages: OpenCodeMessage[], meta: JobMeta): OpenCodeMessage[] {
  if (meta.externalMessageBaselineCount === undefined) {
    return messages;
  }
  return messages.slice(Math.max(0, meta.externalMessageBaselineCount));
}

function selectResultMessagesForMeta(jobMessages: OpenCodeMessage[], meta: JobMeta): OpenCodeMessage[] {
  if (meta.externalReadOnlyWriteIntentRecoveryJobMessageCount === undefined) {
    return jobMessages;
  }
  return jobMessages.slice(Math.max(0, meta.externalReadOnlyWriteIntentRecoveryJobMessageCount));
}

function selectReadOnlyWriteIntentMessagesForMeta(jobMessages: OpenCodeMessage[], meta: JobMeta): OpenCodeMessage[] {
  return selectResultMessagesForMeta(jobMessages, meta);
}

function latestAssistantMessageText(messages: OpenCodeMessage[]): string {
  return (
    [...messages]
      .reverse()
      .filter(isFinalAssistantTextMessage)
      .map(extractMessageText)
      .at(0) ?? ""
  );
}

function latestAssistantVisibleText(messages: OpenCodeMessage[]): string {
  return (
    [...messages]
      .reverse()
      .filter((message) => message.info?.role === "assistant")
      .map(extractMessageText)
      .find((text) => text.length > 0) ?? ""
  );
}

function countCompletedAssistantMessages(messages: OpenCodeMessage[]): number {
  return messages.filter(isCompletedAssistantMessage).length;
}

function isCompletedAssistantMessage(message: OpenCodeMessage): boolean {
  if (!isFinalAssistantTextMessage(message)) {
    return false;
  }
  const info = message.info!;
  const time = typeof info.time === "object" && info.time !== null ? info.time : undefined;
  return Boolean(time && "completed" in time && typeof time.completed === "number");
}

function isFinalAssistantTextMessage(message: OpenCodeMessage): boolean {
  if (message.info?.role !== "assistant") {
    return false;
  }
  if (isToolCallAssistantMessage(message)) {
    return false;
  }
  return extractMessageText(message).length > 0;
}

function isToolCallAssistantMessage(message: OpenCodeMessage): boolean {
  return message.info?.finish === "tool-calls" || hasToolPart(message);
}

function countPatchParts(messages: OpenCodeMessage[]): number {
  return messages.reduce((count, message) => count + (message.parts?.filter((part) => part?.type === "patch").length ?? 0), 0);
}

function countWriteIntentToolParts(messages: OpenCodeMessage[]): number {
  return messages.reduce(
    (count, message) => count + (message.parts?.filter((part) => part?.type === "tool" && isWriteIntentTool(part.tool)).length ?? 0),
    0
  );
}

function isWriteIntentTool(tool: unknown): boolean {
  return tool === "write" || tool === "edit" || tool === "apply_patch";
}

function hasAssistantError(messages: OpenCodeMessage[]): boolean {
  return messages.some((message) => message.info?.role === "assistant" && message.info.error !== undefined);
}

function hasReasoningContentProviderError(messages: OpenCodeMessage[]): boolean {
  return messages.some((message) => {
    if (message.info?.role !== "assistant" || message.info.error === undefined) {
      return false;
    }
    const errorText = JSON.stringify(message.info.error).toLowerCase();
    return (
      errorText.includes("reasoning_content") &&
      (errorText.includes("deepseek") || errorText.includes("deepseekexception") || errorText.includes("thinking mode"))
    );
  });
}

function computeStallDiagnostic(
  jobMessages: OpenCodeMessage[],
  meta: JobMeta,
  env: RetinueOptions["env"] | undefined,
  pendingPermissions: OpenCodePermissionRequest[] = []
): Partial<OpenCodeJobDiagnostic> | undefined {
  const activeMessages = selectResultMessagesForMeta(jobMessages, meta);
  const writeIntentMessages = selectReadOnlyWriteIntentMessagesForMeta(jobMessages, meta);
  const patchPartCount = countPatchParts(writeIntentMessages);
  const writeIntentToolPartCount = countWriteIntentToolParts(writeIntentMessages);
  if (hasAssistantError(activeMessages)) {
    const reasoningContentError = hasReasoningContentProviderError(activeMessages);
    return {
      patchPartCount,
      readOnlyPatchPartCount: meta.readOnly === true ? patchPartCount : 0,
      writeIntentToolPartCount,
      readOnlyWriteIntentToolPartCount: meta.readOnly === true ? writeIntentToolPartCount : 0,
      readOnlyWriteIntent: false,
      stallReason: reasoningContentError ? "provider_reasoning_content_error" : "provider_error",
      stallSummary: reasoningContentError
        ? "OpenCode provider rejected a DeepSeek thinking-mode request because reasoning_content was not preserved."
        : "OpenCode provider returned an assistant error."
    };
  }
  if (meta.readOnly === true && writeIntentToolPartCount > 0) {
    return {
      patchPartCount,
      readOnlyPatchPartCount: patchPartCount,
      writeIntentToolPartCount,
      readOnlyWriteIntentToolPartCount: writeIntentToolPartCount,
      readOnlyWriteIntent: true,
      stallReason: "read_only_write_intent",
      stallSummary: "OpenCode read-only job attempted a write-capable tool."
    };
  }
  if (activeMessages.some(isCompletedAssistantMessage)) {
    return undefined;
  }
  const thresholdMs = parseOptionalNonNegativeInt(env?.RETINUE_OPENCODE_STALL_MS, DEFAULT_STALL_MS);
  if (thresholdMs <= 0) {
    return undefined;
  }
  const incompleteThresholdMs = parseOptionalNonNegativeInt(env?.RETINUE_OPENCODE_STALL_INCOMPLETE_ASSISTANT_MS, DEFAULT_INCOMPLETE_ASSISTANT_STALL_MS);
  const blankAssistantThresholdMs = parseOptionalNonNegativeInt(env?.RETINUE_OPENCODE_STALL_BLANK_ASSISTANT_MS, DEFAULT_BLANK_ASSISTANT_STALL_MS);
  const zeroProgressAssistantThresholdMs = parseOptionalNonNegativeInt(
    env?.RETINUE_OPENCODE_STALL_ZERO_PROGRESS_ASSISTANT_MS,
    DEFAULT_ZERO_PROGRESS_ASSISTANT_STALL_MS
  );
  const readToolThresholdMs = parseOptionalNonNegativeInt(env?.RETINUE_OPENCODE_STALL_READ_TOOL_MS, DEFAULT_READ_TOOL_STALL_MS);
  const completedToolLoopThresholdMs = parseOptionalNonNegativeInt(
    env?.RETINUE_OPENCODE_STALL_COMPLETED_TOOL_LOOP_MS,
    DEFAULT_COMPLETED_TOOL_LOOP_STALL_MS
  );
  const roundThreshold = parseOptionalNonNegativeInt(env?.RETINUE_OPENCODE_STALL_TOOL_CALL_ROUNDS, DEFAULT_STALL_TOOL_CALL_ROUNDS);
  const emptyAssistantThreshold = parseOptionalNonNegativeInt(env?.RETINUE_OPENCODE_STALL_EMPTY_ASSISTANT_ROUNDS, DEFAULT_STALL_EMPTY_ASSISTANT_ROUNDS);
  const toolCallAssistantRounds = activeMessages.filter((message) => message.info?.role === "assistant" && isToolCallAssistantMessage(message)).length;
  const emptyAssistantRounds = activeMessages.filter((message) => message.info?.role === "assistant" && isEmptyStopAssistantMessage(message)).length;
  const blankAssistantRounds = activeMessages.filter((message) => message.info?.role === "assistant" && isBlankAssistantPlaceholder(message)).length;
  const zeroProgressAssistantRounds = activeMessages.filter((message) => message.info?.role === "assistant" && isZeroProgressAssistantPlaceholder(message)).length;
  const runningReadToolPartSummaries = collectRunningReadToolPartSummaries(activeMessages);
  const runningReadToolParts = runningReadToolPartSummaries.length;
  const malformedReadToolParts = runningReadToolPartSummaries.filter(isMalformedReadToolInput).length;
  const runningReadToolCallIds = runningReadToolPartSummaries.flatMap((part) => (part.callID ? [part.callID] : []));
  const pendingPermissionSummaries = summarizePermissionRequests(pendingPermissions);
  const pendingExternalDirectoryPermissionSummaries = pendingPermissionSummaries.filter(
    (permission) => permission.permission === "external_directory"
  );
  const lastAssistant = [...activeMessages].reverse().find((message) => message.info?.role === "assistant");
  const incompleteAssistantRound = isIncompleteAssistantMessage(lastAssistant);
  if (
    toolCallAssistantRounds < roundThreshold &&
    emptyAssistantRounds < emptyAssistantThreshold &&
    blankAssistantRounds === 0 &&
    zeroProgressAssistantRounds === 0 &&
    runningReadToolParts === 0 &&
    pendingExternalDirectoryPermissionSummaries.length === 0 &&
    !incompleteAssistantRound
  ) {
    return undefined;
  }
  const startedAt = Date.parse(meta.createdAt);
  const durationMs = Number.isFinite(startedAt) ? Date.now() - startedAt : 0;
  const emptyAssistantStalled = emptyAssistantRounds >= emptyAssistantThreshold;
  const blankAssistantStalled = blankAssistantRounds > 0 && durationMs >= blankAssistantThresholdMs;
  const zeroProgressAssistantStalled = zeroProgressAssistantRounds > 0 && durationMs >= zeroProgressAssistantThresholdMs;
  const readToolStalled = runningReadToolParts > 0 && durationMs >= readToolThresholdMs;
  const readToolInvalidInputStalled = malformedReadToolParts > 0 && durationMs >= readToolThresholdMs;
  const externalDirectoryPermissionStalled = pendingExternalDirectoryPermissionSummaries.length > 0 && durationMs >= readToolThresholdMs;
  const completedToolLoopStalled =
    toolCallAssistantRounds >= roundThreshold &&
    runningReadToolParts === 0 &&
    !incompleteAssistantRound &&
    durationMs >= completedToolLoopThresholdMs;
  const incompleteAssistantStalled = incompleteAssistantRound && durationMs >= incompleteThresholdMs;
  if (
    !emptyAssistantStalled &&
    !blankAssistantStalled &&
    !zeroProgressAssistantStalled &&
    !readToolStalled &&
    !externalDirectoryPermissionStalled &&
    !completedToolLoopStalled &&
    !incompleteAssistantStalled &&
    durationMs < thresholdMs
  ) {
    return undefined;
  }
  const diagnostic = {
    toolCallAssistantRounds,
    emptyAssistantRounds,
    blankAssistantRounds,
    zeroProgressAssistantRounds,
    runningReadToolParts,
    runningReadToolCallIds,
    runningReadToolPartSummaries,
    malformedReadToolParts,
    pendingPermissionCount: pendingPermissionSummaries.length,
    pendingPermissions: pendingPermissionSummaries,
    pendingExternalDirectoryPermissionCount: pendingExternalDirectoryPermissionSummaries.length,
    pendingExternalDirectoryPermissions: pendingExternalDirectoryPermissionSummaries,
    noCompletedAssistantDurationMs: Math.max(0, durationMs),
    stallThresholdMs: thresholdMs,
    blankAssistantStallThresholdMs: blankAssistantThresholdMs,
    zeroProgressAssistantStallThresholdMs: zeroProgressAssistantThresholdMs,
    readToolStallThresholdMs: readToolThresholdMs,
    completedToolLoopStallThresholdMs: completedToolLoopThresholdMs,
    incompleteAssistantStallThresholdMs: incompleteThresholdMs,
    stallToolCallRoundThreshold: roundThreshold,
    stallEmptyAssistantRoundThreshold: emptyAssistantThreshold,
    incompleteAssistantRound,
    stallReason: selectStallReason({
      emptyAssistantStalled,
      blankAssistantStalled,
      zeroProgressAssistantStalled,
      readToolInvalidInputStalled,
      externalDirectoryPermissionStalled,
      readToolStalled,
      completedToolLoopStalled,
      incompleteAssistantStalled
    })
  };
  return {
    ...diagnostic,
    stallSummary: createStallSummary(diagnostic)
  };
}

function createStallMessage(diagnostic: OpenCodeJobDiagnostic): string {
  const providerDetails = formatProviderDetails(diagnostic);
  const rescueDetails = formatSoftStallRescueDetails(diagnostic);
  if (diagnostic.readOnlyWriteIntent === true) {
    return `OpenCode read-only job attempted a write-capable tool; Retinue did not treat the child result as trusted output. Inspect Retinue trace/job diagnostics for message summaries.`;
  }
  if (diagnostic.stallReason === "read_only_write_intent") {
    return `OpenCode read-only job attempted a write-capable tool; Retinue requested a no-tools prose-only recovery, but no trusted final text was produced. Inspect Retinue trace/job diagnostics for message summaries.`;
  }
  if (diagnostic.stallReason === "provider_reasoning_content_error") {
    const preview = diagnostic.lastAssistantError?.preview ?? diagnostic.lastMessageError?.preview;
    const suffix = preview ? ` Error summary: ${preview}` : " Inspect Retinue trace/job diagnostics for lastAssistantError and message summaries.";
    return `OpenCode provider rejected a DeepSeek reasoning_content request through LiteLLM/semantic-router. This is a provider/router compatibility issue for thinking-mode messages, not a trusted child-agent result.${suffix}`;
  }
  if (diagnostic.stallReason === "provider_error") {
    const preview = diagnostic.lastAssistantError?.preview ?? diagnostic.lastMessageError?.preview;
    const suffix = preview ? ` Error summary: ${preview}` : " Inspect Retinue trace/job diagnostics for lastAssistantError and message summaries.";
    return `OpenCode provider returned an assistant error before producing final text.${suffix}`;
  }
  const rounds = diagnostic.toolCallAssistantRounds ?? 0;
  const emptyRounds = diagnostic.emptyAssistantRounds ?? 0;
  const blankRounds = diagnostic.blankAssistantRounds ?? 0;
  const zeroProgressRounds = diagnostic.zeroProgressAssistantRounds ?? 0;
  const runningReadToolParts = diagnostic.runningReadToolParts ?? 0;
  const malformedReadToolParts = diagnostic.malformedReadToolParts ?? 0;
  const durationMs = diagnostic.noCompletedAssistantDurationMs ?? 0;
  if (diagnostic.stallReason === "read_tool_invalid_input" && malformedReadToolParts > 0) {
    const details = formatReadToolStallDetails(diagnostic);
    return `OpenCode job stalled: observed ${malformedReadToolParts} read tool call(s) with missing or invalid input for ${durationMs}ms.${details}${providerDetails}${rescueDetails} The OpenCode provider/model emitted a malformed read tool call; inspect Retinue trace/job diagnostics for full message summaries.`;
  }
  if (diagnostic.stallReason === "external_directory_permission_pending") {
    const permissionDetails = formatPendingPermissionDetails(diagnostic);
    const readDetails = formatReadToolStallDetails(diagnostic);
    return `OpenCode job is waiting for external_directory permission after ${durationMs}ms.${permissionDetails}${readDetails}${providerDetails}${rescueDetails} Retinue is running headless and did not auto-approve access outside the session directory; inspect Retinue trace/job diagnostics for the pending OpenCode permission request.`;
  }
  if (diagnostic.recoveryStallReason === "read_tool_stalled" && runningReadToolParts > 0) {
    const details = formatReadToolStallDetails(diagnostic);
    return `OpenCode job stalled: soft-stall rescue reached ${runningReadToolParts} pending/running read tool call(s) with no completed assistant text for ${durationMs}ms.${details}${providerDetails}${rescueDetails} The OpenCode tool executor may be stuck; inspect Retinue trace/job diagnostics for full message summaries.`;
  }
  if (blankRounds > 0) {
    return `OpenCode job stalled: observed ${blankRounds} blank assistant placeholder(s) with no completed assistant text for ${durationMs}ms.${providerDetails}${rescueDetails} The OpenCode provider or model router may be unavailable; inspect Retinue trace/job diagnostics for message summaries.`;
  }
  if (zeroProgressRounds > 0) {
    return `OpenCode job stalled: observed ${zeroProgressRounds} zero-progress assistant placeholder(s) with no completed assistant text for ${durationMs}ms.${providerDetails}${rescueDetails} The OpenCode provider or model router may be unavailable or stuck after tool calls; inspect Retinue trace/job diagnostics for message summaries.`;
  }
  if (runningReadToolParts > 0) {
    const details = formatReadToolStallDetails(diagnostic);
    return `OpenCode job stalled: observed ${runningReadToolParts} pending/running read tool call(s) with no completed assistant text for ${durationMs}ms.${details}${providerDetails}${rescueDetails} The OpenCode tool executor may be stuck; inspect Retinue trace/job diagnostics for full message summaries.`;
  }
  return `OpenCode job stalled: observed ${rounds} tool-call assistant round(s) and ${emptyRounds} empty assistant round(s) with no completed assistant text for ${durationMs}ms.${providerDetails}${rescueDetails} Inspect Retinue trace/job diagnostics for message summaries.`;
}

function selectReadOnlyWriteIntentAdvisoryText(
  jobMessages: OpenCodeMessage[],
  meta: JobMeta,
  diagnostic: OpenCodeJobDiagnostic
): string {
  if (meta.readOnly !== true) {
    return "";
  }
  if (diagnostic.readOnlyWriteIntent !== true && diagnostic.stallReason !== "read_only_write_intent") {
    return "";
  }
  return latestAssistantVisibleText(jobMessages);
}

function isHardStallDiagnostic(diagnostic: Partial<OpenCodeJobDiagnostic>): boolean {
  return (
    diagnostic.readOnlyWriteIntent === true ||
    diagnostic.stallReason === "provider_error" ||
    diagnostic.stallReason === "external_directory_permission_pending"
  );
}

function isSoftStallRescueEligible(diagnostic: Partial<OpenCodeJobDiagnostic>): boolean {
  if (diagnostic.readOnlyWriteIntent === true) {
    return true;
  }
  const hasToolProgress = (diagnostic.toolCallAssistantRounds ?? 0) > 0;
  return (
    diagnostic.stallReason === "backend_no_final_text" ||
    diagnostic.stallReason === "tool_loop_no_completion" ||
    diagnostic.stallReason === "incomplete_assistant_round" ||
    (hasToolProgress && diagnostic.stallReason === "provider_blank_assistant") ||
    (hasToolProgress && diagnostic.stallReason === "provider_zero_progress")
  );
}

function createReadOnlyTextWarning(text: string): string | undefined {
  if (!text.trim()) {
    return undefined;
  }
  const riskyPatterns = [
    /^```(?:diff|patch)\b/im,
    /^---\s+a\//m,
    /^\+\+\+\s+b\//m,
    /^@@\s+-\d/m,
    /^\s*(?:sudo\s+|rm\s+-rf\b|chmod\s+|cat\s+>|tee\s+)/m
  ];
  if (!riskyPatterns.some((pattern) => pattern.test(text))) {
    return undefined;
  }
  return "Retinue read-only result may contain patch or write-command text; treat stdout as untrusted analysis, not executable instructions.";
}

function createReadOnlyAdvisoryWarning(): string {
  return "Retinue returned read-only write-intent text as advisory stdout only; treat it as untrusted analysis, not executable instructions or project evidence.";
}

function selectStallReason(stalled: {
  emptyAssistantStalled: boolean;
  blankAssistantStalled: boolean;
  zeroProgressAssistantStalled: boolean;
  readToolStalled: boolean;
  readToolInvalidInputStalled: boolean;
  externalDirectoryPermissionStalled: boolean;
  completedToolLoopStalled: boolean;
  incompleteAssistantStalled: boolean;
}): OpenCodeStallReason {
  if (stalled.readToolInvalidInputStalled) {
    return "read_tool_invalid_input";
  }
  if (stalled.externalDirectoryPermissionStalled) {
    return "external_directory_permission_pending";
  }
  if (stalled.readToolStalled) {
    return "read_tool_stalled";
  }
  if (stalled.blankAssistantStalled) {
    return "provider_blank_assistant";
  }
  if (stalled.zeroProgressAssistantStalled) {
    return "provider_zero_progress";
  }
  if (stalled.completedToolLoopStalled) {
    return "tool_loop_no_completion";
  }
  if (stalled.incompleteAssistantStalled) {
    return "incomplete_assistant_round";
  }
  if (stalled.emptyAssistantStalled) {
    return "backend_no_final_text";
  }
  return "tool_loop_no_completion";
}

function createStallSummary(diagnostic: Partial<OpenCodeJobDiagnostic>): string {
  const durationMs = diagnostic.noCompletedAssistantDurationMs ?? 0;
  const rescueDetails = formatSoftStallRescueDetails(diagnostic);
  switch (diagnostic.stallReason) {
    case "read_only_write_intent":
      return "OpenCode read-only job attempted a write-capable tool.";
    case "provider_error":
      return "OpenCode provider returned an assistant error before final text.";
    case "provider_reasoning_content_error":
      return "OpenCode provider rejected a DeepSeek reasoning_content thinking-mode request.";
    case "provider_blank_assistant":
      return `OpenCode provider/router produced blank assistant output for ${durationMs}ms.${rescueDetails}`;
    case "provider_zero_progress":
      return `OpenCode provider/router produced zero-progress assistant output for ${durationMs}ms.${rescueDetails}`;
    case "read_tool_invalid_input":
      return `OpenCode provider/model emitted read tool call(s) with missing or invalid input for ${durationMs}ms.${formatReadToolStallDetails(diagnostic)}${rescueDetails}`;
    case "external_directory_permission_pending":
      return `OpenCode is waiting for external_directory permission for ${durationMs}ms.${formatPendingPermissionDetails(diagnostic)}${formatReadToolStallDetails(diagnostic)}${rescueDetails}`;
    case "read_tool_stalled":
      return `OpenCode tool executor left read tool call(s) running for ${durationMs}ms.${formatReadToolStallDetails(diagnostic)}${rescueDetails}`;
    case "incomplete_assistant_round":
      return `OpenCode left the latest assistant round incomplete for ${durationMs}ms.`;
    case "backend_no_final_text":
      return `OpenCode produced assistant rounds with no final text for ${durationMs}ms.`;
    case "tool_loop_no_completion":
      return `OpenCode ran repeated tool-call assistant rounds with no final text for ${durationMs}ms.`;
    default:
      return `OpenCode job stalled with no completed assistant text for ${durationMs}ms.`;
  }
}

function isOpenCodeStallReason(value: unknown): value is OpenCodeStallReason {
  return (
    value === "read_only_write_intent" ||
    value === "provider_error" ||
    value === "provider_reasoning_content_error" ||
    value === "provider_blank_assistant" ||
    value === "provider_zero_progress" ||
    value === "read_tool_invalid_input" ||
    value === "read_tool_stalled" ||
    value === "external_directory_permission_pending" ||
    value === "incomplete_assistant_round" ||
    value === "backend_no_final_text" ||
    value === "tool_loop_no_completion"
  );
}

function formatProviderDetails(diagnostic: Partial<OpenCodeJobDiagnostic>): string {
  const entries = [
    diagnostic.lastAssistantProviderID ? `provider=${diagnostic.lastAssistantProviderID}` : undefined,
    diagnostic.lastAssistantModelID ? `model=${diagnostic.lastAssistantModelID}` : undefined,
    diagnostic.lastAssistantAgent ? `agent=${diagnostic.lastAssistantAgent}` : undefined,
    diagnostic.lastAssistantMode ? `mode=${diagnostic.lastAssistantMode}` : undefined
  ].filter(Boolean);
  return entries.length > 0 ? ` ${entries.join(" ")}.` : "";
}

function formatSoftStallRescueDetails(diagnostic: Partial<OpenCodeJobDiagnostic>): string {
  if (!diagnostic.softStallRescueSourceReason) {
    return "";
  }
  const recovery = diagnostic.recoveryStallReason ? ` recovery=${diagnostic.recoveryStallReason}` : "";
  return ` rescueSource=${diagnostic.softStallRescueSourceReason}${recovery}.`;
}

function isMalformedReadToolInput(part: OpenCodePartSummary): boolean {
  if (part.tool !== "read") {
    return false;
  }
  const preview = part.stateInput?.preview?.trim();
  return !preview || preview === "{}" || preview === "null";
}

function formatReadToolStallDetails(diagnostic: Partial<OpenCodeJobDiagnostic>): string {
  const summaries = diagnostic.runningReadToolPartSummaries ?? [];
  const callIds = diagnostic.runningReadToolCallIds ?? [];
  const stateDetails = summaries
    .map((part) =>
      [part.callID, part.stateStatus, part.stateInput ? `input=${part.stateInput.preview}` : undefined].filter(Boolean).join(":")
    )
    .filter((value) => value.length > 0);
  if (stateDetails.length > 0) {
    return ` readToolCalls=${stateDetails.join(",")}.`;
  }
  if (callIds.length > 0) {
    return ` readToolCallIds=${callIds.join(",")}.`;
  }
  return "";
}

function summarizePermissionRequests(requests: OpenCodePermissionRequest[]): OpenCodePermissionSummary[] {
  return requests.map((request) => ({
    id: request.id,
    sessionID: request.sessionID,
    permission: request.permission,
    patterns: Array.isArray(request.patterns) ? request.patterns.map(String) : [],
    always: Array.isArray(request.always) ? request.always.map(String) : undefined,
    toolCallID: typeof request.tool?.callID === "string" ? request.tool.callID : undefined,
    metadata: diagnosticValuePreview(request.metadata)
  }));
}

function formatPendingPermissionDetails(diagnostic: Partial<OpenCodeJobDiagnostic>): string {
  const permissions = diagnostic.pendingExternalDirectoryPermissions ?? diagnostic.pendingPermissions ?? [];
  const details = permissions
    .map((permission) =>
      [
        permission.id,
        permission.sessionID ? `session=${permission.sessionID}` : undefined,
        permission.permission,
        permission.patterns.length > 0 ? `patterns=${permission.patterns.join("|")}` : undefined,
        permission.toolCallID ? `call=${permission.toolCallID}` : undefined,
        permission.metadata ? `metadata=${permission.metadata.preview}` : undefined
      ]
        .filter(Boolean)
        .join(":")
    )
    .filter((value) => value.length > 0);
  return details.length > 0 ? ` pendingPermissions=${details.join(",")}.` : "";
}

function parseOptionalNonNegativeInt(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

function resolveServerIdleMs(env?: RetinueOptions["env"]): number {
  return parseOptionalNonNegativeInt(env?.RETINUE_OPENCODE_SERVER_IDLE_MS, DEFAULT_SERVER_IDLE_MS);
}

function resolveSoftStallRescueGraceMs(env?: RetinueOptions["env"]): number {
  return parseOptionalNonNegativeInt(env?.RETINUE_OPENCODE_SOFT_STALL_RESCUE_GRACE_MS, DEFAULT_SOFT_STALL_RESCUE_GRACE_MS);
}

function resolveSoftStallRescueAgent(currentAgent: string | undefined, env?: RetinueOptions["env"]): string | undefined {
  const configured = env?.RETINUE_OPENCODE_SOFT_STALL_RESCUE_AGENT?.trim();
  if (configured === "0" || configured === "false" || configured === "none") {
    return currentAgent;
  }
  return configured || "build";
}

function resolveTaskAttemptMax(env?: RetinueOptions["env"]): number {
  return parseOptionalNonNegativeInt(env?.RETINUE_OPENCODE_TASK_ATTEMPT_MAX, DEFAULT_TASK_ATTEMPT_MAX);
}

function selectTaskLevelAttemptReason(meta: JobMeta, diagnostic: Partial<OpenCodeJobDiagnostic>): string | undefined {
  if (diagnostic.readOnlyWriteIntent === true || diagnostic.stallReason === "read_only_write_intent") {
    return undefined;
  }
  if (diagnostic.stallReason === "external_directory_permission_pending") {
    return undefined;
  }
  if (diagnostic.stallReason === "read_tool_invalid_input") {
    return diagnostic.softStallRescueSourceReason ? "rescue_malformed_read_tool_call" : "malformed_read_tool_call";
  }
  if (diagnostic.recoveryStallReason) {
    return `rescue_${diagnostic.recoveryStallReason}`;
  }
  if (
    meta.externalRescuePromptSubmittedAt &&
    (diagnostic.stallReason === "provider_zero_progress" || diagnostic.stallReason === "provider_blank_assistant")
  ) {
    return `rescue_${diagnostic.stallReason}`;
  }
  if (meta.externalRescuePromptSubmittedAt && diagnostic.stallReason === "incomplete_assistant_round") {
    return "rescue_incomplete_assistant_round";
  }
  return undefined;
}

function createTaskLevelAttemptPrompt(
  originalPrompt: string,
  recoveryReason: string,
  diagnostic: Partial<OpenCodeJobDiagnostic>
): string {
  const stall = diagnostic.stallReason ? `stallReason=${diagnostic.stallReason}` : "stallReason=unknown";
  const source = diagnostic.softStallRescueSourceReason ? ` rescueSource=${diagnostic.softStallRescueSourceReason}` : "";
  const recovery = diagnostic.recoveryStallReason ? ` recovery=${diagnostic.recoveryStallReason}` : "";
  const readHint =
    diagnostic.stallReason === "read_tool_invalid_input" || diagnostic.recoveryStallReason === "read_tool_invalid_input"
      ? "The previous attempt emitted a malformed OpenCode read tool call. Prefer grep/glob or read-only shell inspection over the OpenCode read tool when source inspection is needed."
      : "Use a smaller inspection path and produce a final answer as soon as enough evidence is available.";
  return [
    "Retinue task-level retry request:",
    `Previous attempt failed as non-evidence (${stall}${source}${recovery}; recoveryReason=${recoveryReason}).`,
    "Start a fresh controlled attempt. Do not rely on the previous stalled output as evidence.",
    readHint,
    "Do not modify files. Return a concise final answer with path evidence when applicable.",
    "",
    "Original task:",
    originalPrompt
  ].join("\n");
}

function summarizeAttempt(meta: JobMeta, selectedAttemptJobId: string | undefined): JobAttemptSummary {
  return {
    jobId: meta.jobId,
    attempt: meta.attempt ?? 0,
    status: meta.status,
    recoveredFromJobId: meta.recoveredFromJobId,
    recoveryReason: meta.recoveryReason,
    recoveryPolicy: meta.recoveryPolicy,
    originalStallReason: meta.originalStallReason,
    recoveryStallReason: meta.recoveryStallReason,
    selected: meta.jobId === selectedAttemptJobId,
    backend: meta.backend,
    externalSessionId: meta.externalSessionId,
    externalParentSessionId: meta.externalParentSessionId,
    externalRootSessionId: meta.externalRootSessionId
  };
}

function hasToolPart(message: OpenCodeMessage): boolean {
  return Array.isArray(message.parts) && message.parts.some((part) => part?.type === "tool");
}

function collectRunningReadToolPartSummaries(messages: OpenCodeMessage[]): OpenCodePartSummary[] {
  return messages.flatMap(
    (message) => summarizeMessageParts(message)?.filter((part) => part.type === "tool" && part.tool === "read" && isActiveToolState(part.stateStatus)) ?? []
  );
}

function isActiveToolState(status: string | undefined): boolean {
  return status === "pending" || status === "running";
}

function isEmptyStopAssistantMessage(message: OpenCodeMessage): boolean {
  if (message.info?.finish !== "stop") {
    return false;
  }
  if (extractMessageText(message).length > 0) {
    return false;
  }
  const partTypes = message.parts?.map((part) => part?.type ?? "unknown") ?? [];
  return partTypes.length > 0 && partTypes.every((type) => type === "step-start" || type === "step-finish");
}

function isBlankAssistantPlaceholder(message: OpenCodeMessage): boolean {
  if (message.info?.role !== "assistant") {
    return false;
  }
  if (extractMessageText(message).length > 0) {
    return false;
  }
  const partTypes = message.parts?.map((part) => part?.type ?? "unknown") ?? [];
  return partTypes.length === 0;
}

function isZeroProgressAssistantPlaceholder(message: OpenCodeMessage): boolean {
  if (message.info?.role !== "assistant") {
    return false;
  }
  if (typeof message.info.finish === "string") {
    return false;
  }
  if (extractMessageText(message).length > 0) {
    return false;
  }
  const summaries = summarizeMessageParts(message);
  if (!summaries || summaries.length === 0) {
    return false;
  }
  if (summaries.some((part) => part.type === "tool" || (part.textBytes ?? 0) > 0)) {
    return false;
  }
  return summaries.every((part) => part.type === "step-start" || part.type === "reasoning");
}

function isIncompleteAssistantMessage(message: OpenCodeMessage | undefined): boolean {
  if (message?.info?.role !== "assistant") {
    return false;
  }
  if (typeof message.info.finish === "string") {
    return false;
  }
  const partTypes = message.parts?.map((part) => part?.type ?? "unknown") ?? [];
  return partTypes.length === 0 || !partTypes.includes("step-finish");
}

function extractMessageText(message: { parts?: Array<{ type?: string; text?: string }> }): string {
  if (!Array.isArray(message.parts)) {
    return "";
  }
  return message.parts
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text ?? "")
    .join("");
}

function stringInfo(message: OpenCodeMessage | undefined, key: string): string | undefined {
  const value = message?.info?.[key];
  return typeof value === "string" ? value : undefined;
}

function numberInfo(message: OpenCodeMessage | undefined, key: string): number | undefined {
  const value = message?.info?.[key];
  return typeof value === "number" ? value : undefined;
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(filePath.replace(/[\\/][^\\/]+$/, ""), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(tempPath, filePath);
}

async function readTextIfExists(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

function createPromptPreview(prompt: string): string {
  const normalized = prompt.replace(/\s+/g, " ").trim();
  return normalized.length > 120 ? `${normalized.slice(0, 117)}...` : normalized;
}

function resolveReadOnlyBashPolicy(value: AgentRunOptions["readOnlyBashPolicy"]): OpenCodeReadOnlyBashPolicy {
  return value ?? "readonly_git";
}

function resolveRunnerMode(env: RetinueOptions["env"]): OpenCodeRunnerMode {
  const value = env?.RETINUE_OPENCODE_ROOT_BINDING_MODE?.trim().toLowerCase();
  if (value === undefined || value === "" || value === "per_spawn" || value === "per-spawn") {
    return "per-spawn";
  }
  if (value === "shared_root" || value === "shared-root") {
    return "shared-root";
  }
  throw new Error(`Unsupported RETINUE_OPENCODE_ROOT_BINDING_MODE: ${value}`);
}

function resolveRootAgent(env: RetinueOptions["env"]): string {
  const value = env?.RETINUE_OPENCODE_ROOT_AGENT?.trim();
  if (value === undefined || value === "") {
    return "build";
  }
  return value;
}

function buildReadOnlyPermission(bashPolicy: OpenCodeReadOnlyBashPolicy): OpenCodePermissionRule[] {
  return bashPolicy === "readonly_git"
    ? [...OPENCODE_READONLY_GIT_BASH_PERMISSION, ...OPENCODE_READ_ONLY_BASE_PERMISSION]
    : OPENCODE_READ_ONLY_BASE_PERMISSION;
}

function buildReadOnlyTools(bashPolicy: OpenCodeReadOnlyBashPolicy): Record<string, boolean> {
  return bashPolicy === "readonly_git" ? OPENCODE_READ_ONLY_TOOLS_WITH_READONLY_GIT_BASH : OPENCODE_READ_ONLY_TOOLS_NO_BASH;
}

function findOpenCodeAgent(agents: OpenCodeAgentInfo[], name: string): OpenCodeAgentInfo | undefined {
  return agents.find((agent) => agent.name === name);
}

function normalizePermissionRules(value: unknown): OpenCodePermissionRule[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(isOpenCodePermissionRule);
}

function isOpenCodePermissionRule(value: unknown): value is OpenCodePermissionRule {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.permission === "string" &&
    typeof candidate.pattern === "string" &&
    (candidate.action === "allow" || candidate.action === "deny" || candidate.action === "ask")
  );
}

function deriveSubagentSessionPermission(input: {
  parentSessionPermission: OpenCodePermissionRule[];
  parentAgent: OpenCodeAgentInfo | undefined;
  subagent: OpenCodeAgentInfo | undefined;
}): OpenCodePermissionRule[] {
  const subagentPermission = normalizePermissionRules(input.subagent?.permission);
  const canTask = subagentPermission.some((rule) => rule.permission === "task");
  const canTodo = subagentPermission.some((rule) => rule.permission === "todowrite");
  const parentAgentDenies = normalizePermissionRules(input.parentAgent?.permission).filter(
    (rule) => rule.action === "deny" && rule.permission === "edit"
  );
  return [
    ...parentAgentDenies,
    ...input.parentSessionPermission.filter((rule) => rule.permission === "external_directory" || rule.action === "deny"),
    ...(canTodo ? [] : [{ permission: "todowrite", pattern: "*", action: "deny" } satisfies OpenCodePermissionRule]),
    ...(canTask ? [] : [{ permission: "task", pattern: "*", action: "deny" } satisfies OpenCodePermissionRule])
  ];
}

function mergePermissionRules(...groups: Array<OpenCodePermissionRule[] | undefined>): OpenCodePermissionRule[] | undefined {
  const rules = groups.flatMap((group) => group ?? []);
  return rules.length > 0 ? rules : undefined;
}

function buildOpenCodePrompt(prompt: string, readOnly: boolean, bashPolicy: OpenCodeReadOnlyBashPolicy): string {
  if (!readOnly) {
    return prompt;
  }
  return `${createReadOnlyPromptContract(bashPolicy)}\n\nUser task:\n${prompt}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function getJobsDir(stateDir: string): string {
  return getJobPaths(stateDir, "placeholder").dir.replace(/[\\/]placeholder$/, "");
}

async function readDirIfExists(dirPath: string) {
  try {
    return await fs.readdir(dirPath, { withFileTypes: true });
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function listTempFiles(dirPath: string): Promise<string[]> {
  const entries = await readDirIfExists(dirPath);
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".tmp"))
    .map((entry) => `${dirPath}${dirPath.includes("\\") ? "\\" : "/"}${entry.name}`);
}
