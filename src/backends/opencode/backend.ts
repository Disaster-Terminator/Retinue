import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { resolveHttpTimeoutMs } from "../../core/http.js";
import { getJobPaths, getRetinueTracePath, resolveStateDir } from "../../core/paths.js";
import { isCleanupSafeStatus } from "../../core/status.js";
import type {
  AgentBackendKind,
  CleanupOptions,
  CleanupResult,
  JobAttemptSummary,
  JobMeta,
  JobProblem,
  JobResult,
  JobStatusResult,
  RetinueAttentionRequired,
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
  kind?: Extract<AgentBackendKind, "opencode" | "kilo">;
  client?: OpenCodeClient;
  baseUrl?: string;
  target?: (cwd: string | undefined) => Promise<OpenCodeBackendTarget>;
  stateDir?: string;
  env?: RetinueOptions["env"];
  onServerIdle?: (baseUrl: string, cwd: string | undefined) => void;
  sharedRootSessions?: OpenCodeSharedRootSessionStore;
}
export interface OpenCodeBackendTarget {
  client: OpenCodeClient;
  baseUrl: string;
}
type OpenCodeRunnerMode = "per-spawn" | "shared-root";

interface SharedRootSession {
  id: string;
  baseUrl: string;
  cwd?: string;
  agent: string;
}

export type OpenCodeSharedRootSessionStore = Map<string, SharedRootSession>;

const DEFAULT_TASK_ATTEMPT_MAX = 1;
const DEFAULT_WAIT_TIMEOUT_MS = 30_000;
const DEFAULT_WAIT_POLL_MS = 250;
const DEFAULT_STALL_MS = 10 * 60_000;
const DEFAULT_INCOMPLETE_ASSISTANT_STALL_MS = 45_000;
const DEFAULT_SERVER_IDLE_MS = 30_000;
const DEFAULT_BLANK_ASSISTANT_STALL_MS = 45_000;
const DEFAULT_ZERO_PROGRESS_ASSISTANT_STALL_MS = 45_000;
const DEFAULT_READ_TOOL_STALL_MS = 45_000;
const DEFAULT_COMPLETED_TOOL_LOOP_STALL_MS = 45_000;
const DEFAULT_FINALIZATION_AFTER_TOOL_PROGRESS_STALL_MS = 120_000;
const DEFAULT_STALL_TOOL_CALL_ROUNDS = 6;
const DEFAULT_STALL_EMPTY_ASSISTANT_ROUNDS = 1;
const DIAGNOSTIC_VALUE_PREVIEW_BYTES = 1000;
const ATTEMPT_HANDOFF_TOOL_EVIDENCE_LIMIT = 8;
const ATTEMPT_HANDOFF_PREVIEW_BYTES = 240;

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

interface AttemptHandoffToolEvidence {
  tool: string;
  callID?: string;
  status?: string;
  inputPreview?: string;
}

interface AttemptHandoffCapsule {
  sourceJobId: string;
  sourceSessionId?: string;
  cwd: string;
  stallReason?: OpenCodeStallReason;
  recoveryReason: string;
  trustedFinalText: false;
  completedTools: AttemptHandoffToolEvidence[];
  fileEvidence: string[];
  commandEvidence: string[];
  warnings: string[];
}

interface PermissionApprovalContext {
  cwd?: string;
  sessionDirectory?: string;
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
  lastMessageReasoningTextBytes?: number;
  lastMessageError?: DiagnosticValuePreview;
  lastAssistantFinish?: string;
  lastAssistantPartTypes?: string[];
  lastAssistantPartSummaries?: OpenCodePartSummary[];
  lastAssistantTextBytes?: number;
  lastAssistantReasoningTextBytes?: number;
  lastAssistantError?: DiagnosticValuePreview;
  lastAssistantProviderID?: string;
  lastAssistantModelID?: string;
  lastAssistantAgent?: string;
  lastAssistantMode?: string;
  lastAssistantCost?: number;
  lastAssistantTokens?: unknown;
  patchPartCount?: number;
  writeIntentToolPartCount?: number;
  recoveryStallReason?: OpenCodeStallReason;
  recoveryStallSummary?: string;
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
  failedToolCallAssistantRounds?: number;
  emptyAssistantRounds?: number;
  blankAssistantRounds?: number;
  zeroProgressAssistantRounds?: number;
  runningToolParts?: number;
  runningToolCallIds?: string[];
  runningToolPartSummaries?: OpenCodePartSummary[];
  malformedToolParts?: number;
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
  finalizationAfterToolProgressStallThresholdMs?: number;
  stallToolCallRoundThreshold?: number;
  stallEmptyAssistantRoundThreshold?: number;
  incompleteAssistantRound?: boolean;
  incompleteAssistantHasReasoningProgress?: boolean;
  finalizationAfterToolProgress?: boolean;
  stallReason?: OpenCodeStallReason;
  stallSummary?: string;
  error?: string;
}

type OpenCodeStallReason =
  | "provider_error"
  | "provider_reasoning_content_error"
  | "provider_blank_assistant"
  | "provider_zero_progress"
  | "tool_invalid_input"
  | "read_tool_invalid_input"
  | "read_tool_stalled"
  | "external_directory_permission_pending"
  | "incomplete_assistant_round"
  | "backend_no_final_text"
  | "tool_loop_no_completion";

export class OpenCodeBackend implements AgentBackend {
  readonly kind: Extract<AgentBackendKind, "opencode" | "kilo">;
  private readonly client?: OpenCodeClient;
  private readonly baseUrl?: string;
  private readonly resolveTarget: (cwd: string | undefined) => Promise<OpenCodeBackendTarget>;
  private readonly stateDir: string;
  private readonly env?: RetinueOptions["env"];
  private readonly httpTimeoutMs: number;
  private readonly onServerIdle: (baseUrl: string, cwd: string | undefined) => void;
  private readonly sharedRootSessions: OpenCodeSharedRootSessionStore;

  constructor(options: OpenCodeBackendOptions) {
    this.kind = options.kind ?? "opencode";
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
    this.sharedRootSessions = options.sharedRootSessions ?? new Map();
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
    const runnerMode = resolveRunnerMode(this.env);
    const rootAgent = resolveRootAgent(this.env);
    const requestedAgent = options.agent ?? "explore";
    const agents = await this.listAgents(target.client);
    const parentAgent = findOpenCodeAgent(agents, rootAgent);
    const childAgent = findOpenCodeAgent(agents, requestedAgent);
    validateOpenCodeAgent(agents, rootAgent, "root", this.kind);
    validateOpenCodeAgent(agents, requestedAgent, "child", this.kind);
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
        parentAgent,
        childAgent
      })
    });
    const baseline = await this.captureMessageBaseline(target.client, childSession.id);
    const now = new Date().toISOString();
    const meta: JobMeta = {
      schemaVersion: 1,
      backend: this.kind,
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
      backend: this.kind,
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
      return problemFromMeta(meta);
    }
    return this.reconcileStatus(meta);
  }

  private async statusForWait(handle: AgentHandle): Promise<JobStatusResult> {
    const meta = await this.readMeta(handle.jobId);
    if (isProblem(meta)) {
      return problemFromMeta(meta);
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
      backend: this.kind,
      status: meta.status,
      permissions: summarizePermissionRequests(permissions, permissionApprovalContext(meta))
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
      backend: this.kind,
      status: activeMeta.status,
      repliedRequestId: options.requestId,
      reply: options.reply,
      permissions: summarizePermissionRequests(remaining, permissionApprovalContext(activeMeta))
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
    const handoffCapsule = buildAttemptHandoffCapsule(current, recoveryReason, diagnostic);
    const attemptPrompt = createTaskLevelAttemptPrompt(originalPrompt, recoveryReason, diagnostic, handoffCapsule);
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
      originalStallReason: diagnostic.stallReason,
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
      recoveryStallReason: started.recoveryStallReason,
      handoffCapsule
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
    if (meta.status === "completed") {
      return undefined;
    }
    if (!meta.selectedAttemptJobId) {
      return undefined;
    }
    const selected = await this.readMeta(meta.selectedAttemptJobId);
    return isProblem(selected) ? undefined : selected;
  }

  private async buildAttemptChain(meta: JobMeta): Promise<JobAttemptSummary[]> {
    const root = await this.findAttemptRoot(meta);
    const selectedJobId = selectedAttemptChainJobId(root);
    const chain: JobAttemptSummary[] = [summarizeAttempt(root, selectedJobId)];
    for (const jobId of root.attemptJobIds ?? []) {
      const attempt = await this.readMeta(jobId);
      if (!isProblem(attempt)) {
        chain.push(summarizeAttempt(attempt, selectedJobId));
      }
    }
    if (meta.recoveredFromJobId && !chain.some((attempt) => attempt.jobId === meta.jobId)) {
      chain.push(summarizeAttempt(meta, selectedJobId));
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
      selectedAttemptJobId: root.status === "completed" && root.externalSessionId ? undefined : root.selectedAttemptJobId,
      attemptChain: chain
    };
  }

  private async createTaskAttemptExhaustedMessage(meta: JobMeta, diagnostic: Partial<OpenCodeJobDiagnostic>): Promise<string | undefined> {
    if (meta.status !== "stalled") {
      return undefined;
    }
    const root = await this.findAttemptRoot(meta);
    if (root.status === "completed" || root.selectedAttemptJobId !== meta.jobId) {
      return undefined;
    }
    const chain = await this.buildAttemptChain(meta);
    if (chain.length <= 1) {
      return undefined;
    }
    const rootAttempt = chain[0];
    const provider = [diagnostic.lastAssistantProviderID, diagnostic.lastAssistantModelID].filter(Boolean).join("/");
    const reasonDetails = [
      meta.originalStallReason ? `rootStall=${meta.originalStallReason}` : "",
      meta.recoveryStallReason ? `recoveryStall=${meta.recoveryStallReason}` : ""
    ]
      .filter(Boolean)
      .join(" ");
    const providerDetails = provider ? ` provider=${provider}.` : "";
    return `Retinue task-level attempt budget exhausted: root job ${rootAttempt.jobId} selected attempt ${meta.jobId} but the selected attempt also stalled (${diagnostic.stallReason ?? "unknown"}).${reasonDetails ? ` ${reasonDetails}.` : ""}${providerDetails} No usable child-agent conclusion is available; treat the original and retry outputs as non-evidence.`;
  }

  async result(handle: AgentHandle): Promise<JobResult> {
    const meta = await this.status(handle);
    if (isProblem(meta)) {
      return { jobId: handle.jobId, status: meta.status, error: meta.error };
    }
    if (!meta.externalSessionId && meta.selectedAttemptJobId) {
      const selected = await this.readMeta(meta.selectedAttemptJobId);
      if (!isProblem(selected)) {
        return this.decorateResultWithAttemptChain(await this.result({ jobId: selected.jobId }), meta);
      }
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
          ...permissionAttentionFields(await this.inspectJob(meta), this.kind),
          error: cachedStderr || cachedStdout
        }, meta);
      }
    }
    const client = this.clientForMeta(meta);
    let messages: OpenCodeMessage[];
    try {
      messages = await client.messages(meta.externalSessionId);
    } catch (error) {
      if (meta.status === "completed" && isBackendUnavailableError(error)) {
        const cachedResult = await this.completedCachedResult(handle.jobId, meta, paths);
        if (cachedResult) {
          return this.decorateResultWithAttemptChain(cachedResult, meta);
        }
        return this.decorateResultWithAttemptChain(await this.completedResultBackendUnavailable(handle.jobId, meta, paths, error), meta);
      }
      throw error;
    }
    const jobMessages = selectMessagesForMeta(messages, meta);
    const diagnostic = await this.inspectJob(meta);
    if (meta.status === "stalled") {
      const attemptExhaustedMessage = await this.createTaskAttemptExhaustedMessage(meta, diagnostic);
      const stderr = [createStallMessage(diagnostic), attemptExhaustedMessage].filter(Boolean).join("\n");
      const stdout = stderr;
      await fs.writeFile(paths.stdout, stdout, "utf8");
      await fs.appendFile(paths.stderr, `${stderr}\n`, "utf8");
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
        stderr,
        stdoutPath: paths.stdout,
        stderrPath: paths.stderr,
        stdoutBytes: Buffer.byteLength(stdout, "utf8"),
        stderrBytes: Buffer.byteLength(stderr, "utf8"),
        stdoutTruncated: false,
        stderrTruncated: false,
        sessionId: meta.externalSessionId,
        parsedStdout: { result: stdout },
        ...permissionAttentionFields(diagnostic, this.kind),
        error: stderr
      }, meta);
    }
    const resultMessages = selectResultMessagesForMeta(jobMessages, meta);
    const text = meta.externalMessageBaselineCount === undefined && resultMessages === jobMessages ? latestAssistantMessageText(messages) : latestAssistantMessageText(resultMessages);
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
      stderr: "",
      stdoutPath: paths.stdout,
      stderrPath: paths.stderr,
      stdoutBytes: Buffer.byteLength(text, "utf8"),
      stderrBytes: 0,
      stdoutTruncated: false,
      stderrTruncated: false,
      sessionId: meta.externalSessionId,
      parsedStdout: { result: text }
    }, meta);
  }

  private async completedResultBackendUnavailable(
    jobId: string,
    meta: JobMeta,
    paths: ReturnType<typeof getJobPaths>,
    error: unknown
  ): Promise<JobResult> {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const diagnostic: OpenCodeJobDiagnostic = {
      baseUrl: meta.externalServerUrl ?? this.baseUrl ?? "",
      sessionId: meta.externalSessionId,
      runnerMode: meta.externalRunnerMode,
      rootAgent: meta.externalRootAgent,
      rootSessionId: meta.externalRootSessionId,
      parentSessionId: meta.externalParentSessionId,
      childSessionIds: meta.externalChildSessionIds,
      sessionDirectory: meta.externalSessionDirectory,
      error: errorMessage
    };
    await this.writeJobTrace("opencode_job_completed_result_backend_unreachable", meta, diagnostic);
    await appendJobDiagnostic(this.stateDir, jobId, {
      event: "opencode_job_completed_result_backend_unreachable",
      diagnostic
    });
    return {
      jobId,
      status: "backend_unreachable",
      error: `OpenCode completed job result was not cached and the backend is unreachable: ${errorMessage}`,
      stdoutPath: paths.stdout,
      stderrPath: paths.stderr,
      sessionId: meta.externalSessionId
    };
  }

  private async completedCachedResult(jobId: string, meta: JobMeta, paths: ReturnType<typeof getJobPaths>): Promise<JobResult | undefined> {
    const cachedStdout = await readTextIfExists(paths.stdout);
    if (!cachedStdout.trim()) {
      return undefined;
    }
    const diagnostic: OpenCodeJobDiagnostic = {
      baseUrl: meta.externalServerUrl ?? this.baseUrl ?? "",
      sessionId: meta.externalSessionId,
      runnerMode: meta.externalRunnerMode,
      rootAgent: meta.externalRootAgent,
      rootSessionId: meta.externalRootSessionId,
      parentSessionId: meta.externalParentSessionId,
      childSessionIds: meta.externalChildSessionIds,
      sessionDirectory: meta.externalSessionDirectory,
      selectedAssistantTextBytes: Buffer.byteLength(cachedStdout, "utf8"),
      selectedAssistantSha256: sha256(cachedStdout)
    };
    if (process.env.RETINUE_TRACE_TEXT_PREVIEW === "1") {
      diagnostic.selectedAssistantPreview = createPromptPreview(cachedStdout);
    }
    await this.writeJobTrace("opencode_job_result_read", meta, diagnostic);
    await appendJobDiagnostic(this.stateDir, jobId, { event: "opencode_job_result_read", diagnostic });
    const cachedStderr = await readTextIfExists(paths.stderr);
    return {
      jobId,
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
      parsedStdout: { result: cachedStdout }
    };
  }

  private async persistCompletedResultSnapshot(
    meta: JobMeta,
    client: OpenCodeClient,
    diagnostic: OpenCodeJobDiagnostic
  ): Promise<void> {
    if (meta.status !== "completed" || !meta.externalSessionId) {
      return;
    }
    const paths = getJobPaths(this.stateDir, meta.jobId);
    const cachedStdout = await readTextIfExists(paths.stdout);
    if (cachedStdout.trim()) {
      return;
    }
    const messages = await client.messages(meta.externalSessionId);
    const jobMessages = selectMessagesForMeta(messages, meta);
    const resultMessages = selectResultMessagesForMeta(jobMessages, meta);
    const text =
      meta.externalMessageBaselineCount === undefined && resultMessages === jobMessages
        ? latestAssistantMessageText(messages)
        : latestAssistantMessageText(resultMessages);
    if (!text.trim()) {
      return;
    }
    await fs.writeFile(paths.stdout, text, "utf8");
    diagnostic.selectedAssistantTextBytes = Buffer.byteLength(text, "utf8");
    diagnostic.selectedAssistantSha256 = sha256(text);
    if (process.env.RETINUE_TRACE_TEXT_PREVIEW === "1") {
      diagnostic.selectedAssistantPreview = createPromptPreview(text);
    }
    await this.writeJobTrace("opencode_job_completed_result_cached", meta, diagnostic);
    await appendJobDiagnostic(this.stateDir, meta.jobId, { event: "opencode_job_completed_result_cached", diagnostic });
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
    for (;;) {
      const status = await this.statusForWait(handle);
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
          if (diagnostic.stallReason) {
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
            return { jobId: handle.jobId, status: "stalled", ...permissionAttentionFields(diagnostic, this.kind) };
          }
          await this.writeJobTrace("opencode_job_wait_timeout", meta, diagnostic);
          await appendJobDiagnostic(this.stateDir, handle.jobId, { event: "opencode_job_wait_timeout", diagnostic });
        }
        return { jobId: handle.jobId, status: "running" };
      }
      await sleep(DEFAULT_WAIT_POLL_MS);
    }
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
      if (isProblem(meta) || meta.backend !== this.kind || !isCleanupSafeStatus(meta.status)) {
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
    if (!meta.externalSessionId && meta.selectedAttemptJobId) {
      return this.reconcileVirtualSelectedAttemptStatus(meta);
    }
    if (meta.status === "backend_unreachable") {
      return { jobId: meta.jobId, status: "backend_unreachable", error: meta.externalBackendError };
    }
    if (!meta.externalSessionId || (isTerminal(meta.status) && meta.status !== "stalled")) {
      return meta;
    }
    try {
      const client = this.clientForMeta(meta);
      const session = await client.getSession(meta.externalSessionId);
      let status = meta.status;
      if (session.state === "completed") {
        status = "completed";
      } else if (session.state === "failed") {
        status = "failed";
      } else if (await this.hasNewCompletedAssistantMessage(client, meta.externalSessionId, meta)) {
        status = "completed";
      } else if (session.aborted === true) {
        status = "killed";
      } else if (meta.status === "stalled") {
        const diagnostic = await this.stallDiagnosticForOpenCodeJob(client, meta.externalSessionId, meta);
        status = diagnostic ? "stalled" : "running";
      } else {
        const diagnostic = await this.stallDiagnosticForOpenCodeJob(client, meta.externalSessionId, meta);
        status = diagnostic ? "stalled" : "running";
      }
      if (status === meta.status) {
        return meta;
      }
      const updated: JobMeta = {
        ...meta,
        status,
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
      if (status === "completed") {
        await this.persistCompletedResultSnapshot(updated, client, diagnostic);
      }
      if (status === "stalled") {
        await this.writeJobTrace("opencode_job_stalled", updated, diagnostic, { fromStatus: meta.status, toStatus: status });
        await appendJobDiagnostic(this.stateDir, meta.jobId, {
          event: "opencode_job_stalled",
          fromStatus: meta.status,
          toStatus: status,
          diagnostic
        });
      }
      if (isTerminal(status)) {
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
        return this.markBackendUnreachable(meta, error);
      }
      return { jobId: meta.jobId, status: "corrupted", error: error instanceof Error ? error.message : String(error) };
    }
  }

  private async markBackendUnreachable(meta: JobMeta, error: unknown): Promise<JobProblem> {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const updated: JobMeta = { ...meta, status: "backend_unreachable", externalBackendError: errorMessage, updatedAt: new Date().toISOString() };
    await writeJsonAtomic(getJobPaths(this.stateDir, meta.jobId).meta, updated);
    const diagnostic: OpenCodeJobDiagnostic = {
      baseUrl: meta.externalServerUrl ?? this.baseUrl ?? "",
      sessionId: meta.externalSessionId,
      runnerMode: meta.externalRunnerMode,
      rootAgent: meta.externalRootAgent,
      rootSessionId: meta.externalRootSessionId,
      parentSessionId: meta.externalParentSessionId,
      childSessionIds: meta.externalChildSessionIds,
      sessionDirectory: meta.externalSessionDirectory,
      error: errorMessage
    };
    await this.writeJobTrace("opencode_job_backend_unreachable", updated, diagnostic, {
      fromStatus: meta.status,
      toStatus: "backend_unreachable"
    });
    await appendJobDiagnostic(this.stateDir, meta.jobId, {
      event: "opencode_job_backend_unreachable",
      fromStatus: meta.status,
      toStatus: "backend_unreachable",
      diagnostic
    });
    return { jobId: meta.jobId, status: "backend_unreachable", error: errorMessage };
  }

  private async reconcileVirtualSelectedAttemptStatus(meta: JobMeta): Promise<JobMeta | JobProblem> {
    if (!meta.selectedAttemptJobId || meta.selectedAttemptJobId === meta.jobId) {
      return meta;
    }
    const selected = await this.readMeta(meta.selectedAttemptJobId);
    if (isProblem(selected)) {
      return meta;
    }
    const selectedStatus = await this.reconcileStatus(selected);
    if (isProblem(selectedStatus) || !isTerminal(selectedStatus.status) || selectedStatus.status === meta.status) {
      return meta;
    }
    const updated: JobMeta = {
      ...meta,
      status: selectedStatus.status,
      updatedAt: new Date().toISOString()
    };
    await writeJsonAtomic(getJobPaths(this.stateDir, meta.jobId).meta, updated);
    return updated;
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
    if (meta.externalMessageBaselineCount !== undefined) {
      return false;
    }
    return countCompletedAssistantMessages(messages) > (meta.externalCompletedAssistantBaselineCount ?? 0);
  }

  private async stallDiagnosticForOpenCodeJob(
    client: OpenCodeClient,
    sessionId: string,
    meta: JobMeta
  ): Promise<Partial<OpenCodeJobDiagnostic> | undefined> {
    const messages = await client.messages(sessionId);
    const jobMessages = selectMessagesForMeta(messages, meta);
    const pendingPermissions = await this.pendingPermissionsForJob(client, meta);
    return computeStallDiagnostic(jobMessages, meta, this.env, pendingPermissions);
  }

  private async pendingPermissionsForJob(client: OpenCodeClient, meta: JobMeta): Promise<OpenCodePermissionRequest[]> {
    if (!meta.externalSessionId) {
      return [];
    }
    try {
      const permissions = await client.permissions();
      const sessionIds = new Set([meta.externalSessionId].filter(Boolean));
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
      diagnostic.lastMessageReasoningTextBytes = extractReasoningTextBytes(lastMessage);
      diagnostic.lastMessageError = diagnosticValuePreview(lastMessage?.info?.error);
      diagnostic.lastAssistantFinish = stringInfo(lastAssistant, "finish");
      diagnostic.lastAssistantPartTypes = lastAssistant?.parts?.map((part) => part.type ?? "unknown");
      diagnostic.lastAssistantPartSummaries = summarizeMessageParts(lastAssistant);
      diagnostic.lastAssistantTextBytes = Buffer.byteLength(latestAssistantMessageText(jobMessages), "utf8");
      diagnostic.lastAssistantReasoningTextBytes = extractReasoningTextBytes(lastAssistant);
      diagnostic.lastAssistantError = diagnosticValuePreview(lastAssistant?.info?.error);
      diagnostic.lastAssistantProviderID = stringInfo(lastAssistant, "providerID");
      diagnostic.lastAssistantModelID = stringInfo(lastAssistant, "modelID");
      diagnostic.lastAssistantAgent = stringInfo(lastAssistant, "agent");
      diagnostic.lastAssistantMode = stringInfo(lastAssistant, "mode");
      diagnostic.lastAssistantCost = numberInfo(lastAssistant, "cost");
      diagnostic.lastAssistantTokens = lastAssistant?.info?.tokens;
      diagnostic.patchPartCount = countPatchParts(jobMessages);
      diagnostic.writeIntentToolPartCount = countWriteIntentToolParts(jobMessages);
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
    } catch (error) {
      diagnostic.error = error instanceof Error ? error.message : String(error);
    }
    return diagnostic;
  }

  private async maybeScheduleServerIdleShutdown(meta: JobMeta): Promise<void> {
    if (!meta.externalServerUrl) {
      return;
    }
    if (await this.hasOpenJobsForServer(meta.externalServerUrl)) {
      return;
    }
    this.onServerIdle(meta.externalServerUrl, meta.cwd);
  }

  private async hasOpenJobsForServer(baseUrl: string): Promise<boolean> {
    for (const entry of await readDirIfExists(getJobsDir(this.stateDir))) {
      if (!entry.isDirectory()) {
        continue;
      }
      const meta = await this.readMeta(entry.name);
      if (isProblem(meta) || meta.backend !== this.kind) {
        continue;
      }
      if (meta.externalServerUrl !== baseUrl) {
        continue;
      }
      const status = meta.status === "running" ? await this.reconcileStatus(meta) : meta;
      if (!isProblem(status) && status.status === "running" && status.externalServerUrl === baseUrl) {
        return true;
      }
      if (!isProblem(status) && status.status === "stalled" && status.externalServerUrl === baseUrl) {
        return true;
      }
    }
    return false;
  }

  private async writeJobTrace(event: string, meta: JobMeta, diagnostic: OpenCodeJobDiagnostic, extra: Record<string, unknown> = {}): Promise<void> {
    await writeRetinueTrace(this.stateDir, {
      event,
      backend: this.kind,
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
      await client.promptAsync(sessionId, {
        prompt: options.prompt,
        agent: options.agent ?? "explore",
        model: options.model
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
    const existing = this.sharedRootSessions.get(key);
    if (existing) {
      try {
        const session = await target.client.getSession(existing.id);
        return session;
      } catch {
        this.sharedRootSessions.delete(key);
      }
    }
    const session = await target.client.createSession({
      cwd,
      title: "retinue-shared-root",
      agent
    });
    this.sharedRootSessions.set(key, { id: session.id, baseUrl: target.baseUrl, cwd, agent });
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
  }): OpenCodePermissionRule[] | undefined {
    const derived = deriveSubagentSessionPermission({
      parentSessionPermission: normalizePermissionRules(input.parentSession.permission),
      parentAgent: input.parentAgent,
      subagent: input.childAgent
    });
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

function problemFromMeta(value: JobMeta | JobProblem): JobProblem {
  if (value.status === "backend_unreachable" && "externalBackendError" in value && typeof value.externalBackendError === "string") {
    return { jobId: value.jobId, status: "backend_unreachable", error: value.externalBackendError };
  }
  return value as JobProblem;
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
  return jobMessages;
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
  const patchPartCount = countPatchParts(activeMessages);
  const writeIntentToolPartCount = countWriteIntentToolParts(activeMessages);
  if (hasAssistantError(activeMessages)) {
    const reasoningContentError = hasReasoningContentProviderError(activeMessages);
    return {
      patchPartCount,
      writeIntentToolPartCount,
      stallReason: reasoningContentError ? "provider_reasoning_content_error" : "provider_error",
      stallSummary: reasoningContentError
        ? "OpenCode provider rejected a DeepSeek thinking-mode request because reasoning_content was not preserved."
        : "OpenCode provider returned an assistant error."
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
  const finalizationAfterToolProgressThresholdMs = parseOptionalNonNegativeInt(
    env?.RETINUE_OPENCODE_STALL_FINALIZATION_AFTER_TOOL_PROGRESS_MS,
    DEFAULT_FINALIZATION_AFTER_TOOL_PROGRESS_STALL_MS
  );
  const roundThreshold = parseOptionalNonNegativeInt(env?.RETINUE_OPENCODE_STALL_TOOL_CALL_ROUNDS, DEFAULT_STALL_TOOL_CALL_ROUNDS);
  const emptyAssistantThreshold = parseOptionalNonNegativeInt(env?.RETINUE_OPENCODE_STALL_EMPTY_ASSISTANT_ROUNDS, DEFAULT_STALL_EMPTY_ASSISTANT_ROUNDS);
  const toolCallAssistantRounds = activeMessages.filter((message) => message.info?.role === "assistant" && isToolCallAssistantMessage(message)).length;
  const failedToolCallAssistantRounds = activeMessages.filter(
    (message) => message.info?.role === "assistant" && isFailedToolCallAssistantMessage(message)
  ).length;
  const emptyAssistantRounds = activeMessages.filter((message) => message.info?.role === "assistant" && isEmptyStopAssistantMessage(message)).length;
  const blankAssistantRounds = activeMessages.filter((message) => message.info?.role === "assistant" && isBlankAssistantPlaceholder(message)).length;
  const zeroProgressAssistantRounds = activeMessages.filter((message) => message.info?.role === "assistant" && isZeroProgressAssistantPlaceholder(message)).length;
  const assistantMessageCount = activeMessages.filter((message) => message.info?.role === "assistant").length;
  const runningToolPartSummaries = collectRunningToolPartSummaries(activeMessages);
  const runningToolParts = runningToolPartSummaries.length;
  const malformedToolPartSummaries = runningToolPartSummaries.filter(isMalformedToolInput);
  const malformedToolParts = malformedToolPartSummaries.filter((part) => part.tool !== "read").length;
  const runningToolCallIds = runningToolPartSummaries.flatMap((part) => (part.callID ? [part.callID] : []));
  const runningReadToolPartSummaries = runningToolPartSummaries.filter((part) => part.tool === "read");
  const runningReadToolParts = runningReadToolPartSummaries.length;
  const malformedReadToolParts = runningReadToolPartSummaries.filter(isMalformedReadToolInput).length;
  const runningReadToolCallIds = runningReadToolPartSummaries.flatMap((part) => (part.callID ? [part.callID] : []));
  const pendingPermissionSummaries = summarizePermissionRequests(pendingPermissions, permissionApprovalContext(meta));
  const pendingExternalDirectoryPermissionSummaries = pendingPermissionSummaries.filter(
    (permission) => permission.permission === "external_directory"
  );
  const lastAssistant = [...activeMessages].reverse().find((message) => message.info?.role === "assistant");
  const incompleteAssistantRound = isIncompleteAssistantMessage(lastAssistant);
  const incompleteAssistantHasReasoningProgress = incompleteAssistantRound && hasNonEmptyReasoningOnlyProgress(lastAssistant);
  const finalizationAfterToolProgressPlaceholder =
    lastAssistant !== undefined && (isZeroProgressAssistantPlaceholder(lastAssistant) || isBlankAssistantPlaceholder(lastAssistant));
  const finalizationAfterToolProgressBlankPlaceholder =
    lastAssistant !== undefined && isBlankAssistantPlaceholder(lastAssistant);
  const finalizationAfterToolProgress =
    toolCallAssistantRounds > 0 && finalizationAfterToolProgressPlaceholder;
  const startedAt = Date.parse(meta.createdAt);
  const durationMs = Number.isFinite(startedAt) ? Date.now() - startedAt : 0;
  const finalizationAfterToolProgressWithinWindow =
    finalizationAfterToolProgress && durationMs < finalizationAfterToolProgressThresholdMs;
  if (
    toolCallAssistantRounds < roundThreshold &&
    failedToolCallAssistantRounds === 0 &&
    emptyAssistantRounds < emptyAssistantThreshold &&
    (blankAssistantRounds === 0 || finalizationAfterToolProgressWithinWindow) &&
    (zeroProgressAssistantRounds === 0 || finalizationAfterToolProgressWithinWindow) &&
    assistantMessageCount > 0 &&
    runningReadToolParts === 0 &&
    pendingExternalDirectoryPermissionSummaries.length === 0 &&
    (!incompleteAssistantRound || incompleteAssistantHasReasoningProgress || finalizationAfterToolProgressWithinWindow)
  ) {
    return undefined;
  }
  const emptyAssistantStalled = emptyAssistantRounds >= emptyAssistantThreshold;
  const blankAssistantStalled =
    blankAssistantRounds > 0 && !finalizationAfterToolProgress && durationMs >= blankAssistantThresholdMs;
  const zeroProgressAssistantStalled =
    zeroProgressAssistantRounds > 0 && !finalizationAfterToolProgress && durationMs >= zeroProgressAssistantThresholdMs;
  const finalizationAfterToolProgressStalled =
    finalizationAfterToolProgress && durationMs >= finalizationAfterToolProgressThresholdMs;
  const noAssistantOutputStalled =
    meta.recoveredFromJobId === undefined &&
    assistantMessageCount === 0 &&
    durationMs >= zeroProgressAssistantThresholdMs;
  const readToolStalled = runningReadToolParts > 0 && durationMs >= readToolThresholdMs;
  const readToolInvalidInputStalled = malformedReadToolParts > 0 && durationMs >= readToolThresholdMs;
  const toolInvalidInputStalled = malformedToolParts > 0 && durationMs >= readToolThresholdMs;
  const externalDirectoryPermissionStalled = pendingExternalDirectoryPermissionSummaries.length > 0;
  const completedToolLoopStalled =
    (toolCallAssistantRounds >= roundThreshold || failedToolCallAssistantRounds > 0) &&
    runningReadToolParts === 0 &&
    !incompleteAssistantRound &&
    durationMs >= completedToolLoopThresholdMs;
  const incompleteAssistantStalled = incompleteAssistantRound && !incompleteAssistantHasReasoningProgress && durationMs >= incompleteThresholdMs;
  if (
    !emptyAssistantStalled &&
    !blankAssistantStalled &&
    !zeroProgressAssistantStalled &&
    !finalizationAfterToolProgressStalled &&
    !noAssistantOutputStalled &&
    !readToolStalled &&
    !toolInvalidInputStalled &&
    !externalDirectoryPermissionStalled &&
    !completedToolLoopStalled &&
    !incompleteAssistantStalled &&
    durationMs < thresholdMs
  ) {
    return undefined;
  }
  const diagnostic = {
    toolCallAssistantRounds,
    failedToolCallAssistantRounds,
    emptyAssistantRounds,
    blankAssistantRounds,
    zeroProgressAssistantRounds,
    runningToolParts,
    runningToolCallIds,
    runningToolPartSummaries,
    malformedToolParts,
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
    finalizationAfterToolProgressStallThresholdMs: finalizationAfterToolProgressThresholdMs,
    stallToolCallRoundThreshold: roundThreshold,
    stallEmptyAssistantRoundThreshold: emptyAssistantThreshold,
    incompleteAssistantRound,
    incompleteAssistantHasReasoningProgress,
    finalizationAfterToolProgress,
    stallReason: selectStallReason({
      emptyAssistantStalled,
      blankAssistantStalled:
        blankAssistantStalled || (finalizationAfterToolProgressStalled && finalizationAfterToolProgressBlankPlaceholder),
      zeroProgressAssistantStalled:
        zeroProgressAssistantStalled ||
        (finalizationAfterToolProgressStalled && !finalizationAfterToolProgressBlankPlaceholder) ||
        noAssistantOutputStalled,
      readToolInvalidInputStalled,
      toolInvalidInputStalled,
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
  const malformedToolParts = diagnostic.malformedToolParts ?? 0;
  const runningReadToolParts = diagnostic.runningReadToolParts ?? 0;
  const malformedReadToolParts = diagnostic.malformedReadToolParts ?? 0;
  const durationMs = diagnostic.noCompletedAssistantDurationMs ?? 0;
  if (diagnostic.stallReason === "tool_invalid_input" && malformedToolParts > 0) {
    const details = formatToolStallDetails(diagnostic);
    return `OpenCode job stalled: observed ${malformedToolParts} non-read tool call(s) with missing or invalid input for ${durationMs}ms.${details}${providerDetails} The OpenCode provider/model emitted a malformed tool call; inspect Retinue trace/job diagnostics for full message summaries.`;
  }
  if (diagnostic.stallReason === "read_tool_invalid_input" && malformedReadToolParts > 0) {
    const details = formatReadToolStallDetails(diagnostic);
    return `OpenCode job stalled: observed ${malformedReadToolParts} read tool call(s) with missing or invalid input for ${durationMs}ms.${details}${providerDetails} The OpenCode provider/model emitted a malformed read tool call; inspect Retinue trace/job diagnostics for full message summaries.`;
  }
  if (diagnostic.stallReason === "external_directory_permission_pending") {
    const permissionDetails = formatPendingPermissionDetails(diagnostic);
    const readDetails = formatReadToolStallDetails(diagnostic);
    return `OpenCode job is waiting for external_directory permission after ${durationMs}ms.${permissionDetails}${readDetails}${providerDetails} Retinue is running headless and did not auto-approve access outside the session directory; inspect Retinue trace/job diagnostics for the pending OpenCode permission request.`;
  }
  if (diagnostic.recoveryStallReason === "read_tool_stalled" && runningReadToolParts > 0) {
    const details = formatReadToolStallDetails(diagnostic);
    return `OpenCode job stalled: fresh attempt reached ${runningReadToolParts} pending/running read tool call(s) with no completed assistant text for ${durationMs}ms.${details}${providerDetails} The OpenCode tool executor may be stuck; inspect Retinue trace/job diagnostics for full message summaries.`;
  }
  if (blankRounds > 0) {
    if (diagnostic.finalizationAfterToolProgress === true) {
      return `OpenCode job stalled: final assistant output made no visible progress after completed tool calls for ${durationMs}ms.${providerDetails} Inspect Retinue trace/job diagnostics for message summaries.`;
    }
    return `OpenCode job stalled: observed ${blankRounds} blank assistant placeholder(s) with no completed assistant text for ${durationMs}ms.${providerDetails} The OpenCode provider or model router may be unavailable; inspect Retinue trace/job diagnostics for message summaries.`;
  }
  if (zeroProgressRounds > 0) {
    if (diagnostic.finalizationAfterToolProgress === true) {
      return `OpenCode job stalled: final assistant output made no visible progress after completed tool calls for ${durationMs}ms.${providerDetails} Inspect Retinue trace/job diagnostics for message summaries.`;
    }
    return `OpenCode job stalled: observed ${zeroProgressRounds} zero-progress assistant placeholder(s) with no completed assistant text for ${durationMs}ms.${providerDetails} The OpenCode provider or model router may be unavailable or stuck after tool calls; inspect Retinue trace/job diagnostics for message summaries.`;
  }
  if (runningReadToolParts > 0) {
    const details = formatReadToolStallDetails(diagnostic);
    return `OpenCode job stalled: observed ${runningReadToolParts} pending/running read tool call(s) with no completed assistant text for ${durationMs}ms.${details}${providerDetails} The OpenCode tool executor may be stuck; inspect Retinue trace/job diagnostics for full message summaries.`;
  }
  return `OpenCode job stalled: observed ${rounds} tool-call assistant round(s) and ${emptyRounds} empty assistant round(s) with no completed assistant text for ${durationMs}ms.${providerDetails} Inspect Retinue trace/job diagnostics for message summaries.`;
}

function isHardStallDiagnostic(diagnostic: Partial<OpenCodeJobDiagnostic>): boolean {
  return (
    diagnostic.stallReason === "provider_error" ||
    diagnostic.stallReason === "external_directory_permission_pending"
  );
}


function selectStallReason(stalled: {
  emptyAssistantStalled: boolean;
  blankAssistantStalled: boolean;
  zeroProgressAssistantStalled: boolean;
  readToolStalled: boolean;
  readToolInvalidInputStalled: boolean;
  toolInvalidInputStalled: boolean;
  externalDirectoryPermissionStalled: boolean;
  completedToolLoopStalled: boolean;
  incompleteAssistantStalled: boolean;
}): OpenCodeStallReason {
  if (stalled.readToolInvalidInputStalled) {
    return "read_tool_invalid_input";
  }
  if (stalled.toolInvalidInputStalled) {
    return "tool_invalid_input";
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
  switch (diagnostic.stallReason) {
    case "provider_error":
      return "OpenCode provider returned an assistant error before final text.";
    case "provider_reasoning_content_error":
      return "OpenCode provider rejected a DeepSeek reasoning_content thinking-mode request.";
    case "provider_blank_assistant":
      if (diagnostic.finalizationAfterToolProgress === true) {
        return `OpenCode final assistant output made no visible progress after completed tool calls for ${durationMs}ms.`;
      }
      return `OpenCode provider/router produced blank assistant output for ${durationMs}ms.`;
    case "provider_zero_progress":
      if (diagnostic.finalizationAfterToolProgress === true) {
        return `OpenCode final assistant output made no visible progress after completed tool calls for ${durationMs}ms.`;
      }
      return `OpenCode provider/router produced zero-progress assistant output for ${durationMs}ms.`;
    case "tool_invalid_input":
      return `OpenCode provider/model emitted non-read tool call(s) with missing or invalid input for ${durationMs}ms.${formatToolStallDetails(diagnostic)}`;
    case "read_tool_invalid_input":
      return `OpenCode provider/model emitted read tool call(s) with missing or invalid input for ${durationMs}ms.${formatReadToolStallDetails(diagnostic)}`;
    case "external_directory_permission_pending":
      return `OpenCode is waiting for external_directory permission for ${durationMs}ms.${formatPendingPermissionDetails(diagnostic)}${formatReadToolStallDetails(diagnostic)}`;
    case "read_tool_stalled":
      return `OpenCode tool executor left read tool call(s) running for ${durationMs}ms.${formatReadToolStallDetails(diagnostic)}`;
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
    value === "provider_error" ||
    value === "provider_reasoning_content_error" ||
    value === "provider_blank_assistant" ||
    value === "provider_zero_progress" ||
    value === "tool_invalid_input" ||
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

function isMalformedReadToolInput(part: OpenCodePartSummary): boolean {
  if (part.tool !== "read") {
    return false;
  }
  if (isMalformedToolInput(part)) {
    return true;
  }
  const preview = part.stateInput?.preview?.trim();
  return !preview;
}

function isMalformedToolInput(part: OpenCodePartSummary): boolean {
  if (part.type !== "tool") {
    return false;
  }
  if (!isActiveToolState(part.stateStatus)) {
    return false;
  }
  const preview = part.stateInput?.preview?.trim();
  return preview === "{}" || preview === "null";
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

function formatToolStallDetails(diagnostic: Partial<OpenCodeJobDiagnostic>): string {
  const summaries = diagnostic.runningToolPartSummaries ?? [];
  const callIds = diagnostic.runningToolCallIds ?? [];
  const stateDetails = summaries
    .map((part) =>
      [part.tool, part.callID, part.stateStatus, part.stateInput ? `input=${part.stateInput.preview}` : undefined].filter(Boolean).join(":")
    )
    .filter((value) => value.length > 0);
  if (stateDetails.length > 0) {
    return ` toolCalls=${stateDetails.join(",")}.`;
  }
  if (callIds.length > 0) {
    return ` toolCallIds=${callIds.join(",")}.`;
  }
  return "";
}

function summarizePermissionRequests(requests: OpenCodePermissionRequest[], context: PermissionApprovalContext = {}): OpenCodePermissionSummary[] {
  return requests.map((request) => ({
    id: request.id,
    sessionID: request.sessionID,
    permission: request.permission,
    patterns: Array.isArray(request.patterns) ? request.patterns.map(String) : [],
    always: Array.isArray(request.always) ? request.always.map(String) : undefined,
    toolCallID: typeof request.tool?.callID === "string" ? request.tool.callID : undefined,
    metadata: diagnosticValuePreview(request.metadata),
    approval: buildPermissionApprovalRequest(request, context)
  }));
}

function buildPermissionApprovalRequest(request: OpenCodePermissionRequest, context: PermissionApprovalContext = {}): OpenCodePermissionSummary["approval"] {
  const patterns = Array.isArray(request.patterns) ? request.patterns.map(String) : [];
  const always = Array.isArray(request.always) ? request.always.map(String) : [];
  const external = request.permission === "external_directory" ? describeExternalDirectoryPermission(request, patterns, context) : undefined;
  const title =
    request.permission === "external_directory"
      ? `Access external directory ${external?.target ?? "(unknown)"}`
      : request.permission === "doom_loop"
        ? "Continue after repeated failures"
        : `Call OpenCode tool ${request.permission}`;
  const lines =
    request.permission === "external_directory"
      ? [
          ...(external?.target ? [`Target: ${external.target}`] : []),
          ...patterns.map((pattern) => `Pattern: ${pattern}`),
          ...(context.cwd ? [`Delegated workspace: ${context.cwd}`] : []),
          ...(external?.sessionDirectory && external.sessionDirectory !== context.cwd
            ? [`OpenCode session directory: ${external.sessionDirectory}`]
            : []),
          ...(external?.relation ? [`Scope: ${formatPermissionScopeRelation(external.relation)}`] : [])
        ]
      : request.permission === "doom_loop"
        ? ["This keeps the OpenCode child session running despite repeated failures."]
        : [`Tool: ${request.permission}`, ...patterns.map((pattern) => `Pattern: ${pattern}`)];
  const alwaysEffect =
    always.length === 1 && always[0] === "*"
      ? `Allow ${request.permission} until OpenCode is restarted.`
      : always.length > 0
        ? `Allow matching patterns until OpenCode is restarted: ${always.join(", ")}`
        : "Allow matching requests until OpenCode is restarted.";
  return {
    kind: "opencode_permission",
    title,
    lines,
    guidance: [
      "Treat this as a supervisor decision for the blocked OpenCode child, not as child review evidence.",
      "Prefer reply=once when the requested scope is needed for the current task.",
      "Use reply=always only when the listed patterns are expected to repeat and remain trusted.",
      "Use reply=reject when the path or tool is outside the delegated task scope."
    ],
    recommendedReply: external?.recommendedReply,
    recommendedMessage: external?.recommendedMessage,
    scope: external
      ? {
          permission: request.permission,
          target: external.target,
          cwd: context.cwd,
          sessionDirectory: external.sessionDirectory,
          relation: external.relation
        }
      : {
          permission: request.permission,
          cwd: context.cwd,
          sessionDirectory: context.sessionDirectory
        },
    options: [
      {
        reply: "once",
        label: "Allow once",
        effect: "Resume this blocked OpenCode tool call only."
      },
      {
        reply: "always",
        label: "Allow always",
        effect: alwaysEffect,
        requiresConfirmation: true
      },
      {
        reply: "reject",
        label: "Reject",
        effect: "Deny this OpenCode tool call; an optional message may be sent back to the child."
      }
    ]
  };
}

function externalDirectoryPermissionTarget(request: OpenCodePermissionRequest, patterns: string[]): string | undefined {
  const metadata = request.metadata && typeof request.metadata === "object" && !Array.isArray(request.metadata) ? request.metadata : {};
  const raw =
    typeof metadata.parentDir === "string"
      ? metadata.parentDir
      : typeof metadata.filepath === "string"
        ? metadata.filepath
        : (patterns[0] ?? "");
  if (!raw) {
    return undefined;
  }
  if (!raw.includes("*")) {
    return raw;
  }
  return raw.slice(0, raw.indexOf("*")).replace(/[\\/]+$/, "");
}

function describeExternalDirectoryPermission(
  request: OpenCodePermissionRequest,
  patterns: string[],
  context: PermissionApprovalContext
): {
  target?: string;
  workspace?: string;
  sessionDirectory?: string;
  relation: "inside_workspace" | "outside_workspace" | "unknown";
  recommendedReply?: "reject";
  recommendedMessage?: string;
} {
  const target = externalDirectoryPermissionTarget(request, patterns);
  const sessionDirectory = context.sessionDirectory ?? context.cwd;
  const workspace = context.cwd ?? sessionDirectory;
  const relation = classifyExternalDirectoryRelation(target, workspace);
  const recommendedMessage =
    relation === "outside_workspace" && target && workspace
      ? `The requested path ${target} is outside the delegated workspace ${workspace}. Do not request external directory access. Retry using cwd-relative paths under ${workspace}.`
      : undefined;
  return {
    target,
    workspace,
    sessionDirectory,
    relation,
    recommendedReply: recommendedMessage ? "reject" : undefined,
    recommendedMessage
  };
}

function classifyExternalDirectoryRelation(target: string | undefined, sessionDirectory: string | undefined): "inside_workspace" | "outside_workspace" | "unknown" {
  if (!target || !sessionDirectory || !path.isAbsolute(target) || !path.isAbsolute(sessionDirectory)) {
    return "unknown";
  }
  const relative = path.relative(path.resolve(sessionDirectory), path.resolve(target));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative)) ? "inside_workspace" : "outside_workspace";
}

function formatPermissionScopeRelation(relation: "inside_workspace" | "outside_workspace" | "unknown"): string {
  if (relation === "inside_workspace") {
    return "inside delegated workspace";
  }
  if (relation === "outside_workspace") {
    return "outside delegated workspace";
  }
  return "unknown";
}

function permissionApprovalContext(meta: JobMeta): PermissionApprovalContext {
  return {
    cwd: meta.cwd,
    sessionDirectory: meta.externalSessionDirectory ?? meta.cwd
  };
}

function permissionAttentionFields(
  diagnostic: OpenCodeJobDiagnostic,
  backend: Extract<AgentBackendKind, "opencode" | "kilo">
): Pick<JobResult, "attentionRequired" | "permissionRequired" | "permissions"> {
  const permissions = diagnostic.pendingExternalDirectoryPermissions ?? [];
  if (diagnostic.stallReason !== "external_directory_permission_pending" || permissions.length === 0) {
    return {};
  }
  const attentionRequired: RetinueAttentionRequired = {
    kind: "permission",
    backend,
    reason: "external_directory_permission_pending",
    permissions,
    replyOptions: ["once", "always", "reject"]
  };
  return {
    attentionRequired,
    permissionRequired: true,
    permissions
  };
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

function resolveTaskAttemptMax(env?: RetinueOptions["env"]): number {
  return parseOptionalNonNegativeInt(env?.RETINUE_OPENCODE_TASK_ATTEMPT_MAX, DEFAULT_TASK_ATTEMPT_MAX);
}

function selectTaskLevelAttemptReason(meta: JobMeta, diagnostic: Partial<OpenCodeJobDiagnostic>): string | undefined {
  void meta;
  if (diagnostic.stallReason === "external_directory_permission_pending") {
    return undefined;
  }
  if (diagnostic.stallReason === "read_tool_invalid_input") {
    return "malformed_read_tool_call";
  }
  if (diagnostic.stallReason === "tool_invalid_input") {
    return "malformed_tool_call";
  }
  if (typeof diagnostic.recoveryStallReason === "string" && diagnostic.recoveryStallReason.length > 0) {
    return diagnostic.recoveryStallReason;
  }
  if (
    diagnostic.stallReason === "provider_zero_progress" ||
    diagnostic.stallReason === "provider_blank_assistant" ||
    diagnostic.stallReason === "incomplete_assistant_round" ||
    diagnostic.stallReason === "backend_no_final_text" ||
    diagnostic.stallReason === "tool_loop_no_completion"
  ) {
    return diagnostic.stallReason;
  }
  return undefined;
}

function createTaskLevelAttemptPrompt(
  originalPrompt: string,
  recoveryReason: string,
  diagnostic: Partial<OpenCodeJobDiagnostic>,
  handoffCapsule?: AttemptHandoffCapsule
): string {
  const stall = diagnostic.stallReason ? `stallReason=${diagnostic.stallReason}` : "stallReason=unknown";
  const recovery = diagnostic.recoveryStallReason ? ` recovery=${diagnostic.recoveryStallReason}` : "";
  const readHint =
    diagnostic.stallReason === "read_tool_invalid_input" || diagnostic.recoveryStallReason === "read_tool_invalid_input"
      ? "The previous attempt emitted a malformed OpenCode read tool call. Prefer grep/glob or read-only shell inspection over the OpenCode read tool when source inspection is needed."
      : diagnostic.stallReason === "tool_invalid_input" || diagnostic.recoveryStallReason === "tool_invalid_input"
        ? "The previous attempt emitted a malformed OpenCode tool call. Use narrower inspection and avoid repeating empty tool input."
      : "Use a smaller inspection path and produce a final answer as soon as enough evidence is available.";
  return [
    "Retinue task-level retry request:",
    `Previous attempt failed as non-evidence (${stall}${recovery}; recoveryReason=${recoveryReason}).`,
    "Start a fresh controlled attempt. Do not rely on the previous stalled output as evidence.",
    readHint,
    "Do not modify files. Return a concise final answer with path evidence when applicable.",
    "",
    formatAttemptHandoffCapsule(handoffCapsule),
    "",
    "Original task:",
    originalPrompt
  ].join("\n");
}

function buildAttemptHandoffCapsule(
  meta: JobMeta,
  recoveryReason: string,
  diagnostic: Partial<OpenCodeJobDiagnostic>
): AttemptHandoffCapsule {
  const completedTools: AttemptHandoffToolEvidence[] = [];
  const fileEvidence = new Set<string>();
  const commandEvidence = new Set<string>();
  const warnings = new Set<string>();

  for (const summary of diagnostic.messageSummaries ?? []) {
    if (summary.role !== "assistant") {
      continue;
    }
    for (const part of summary.partSummaries ?? []) {
      if (part.type !== "tool" || !part.tool) {
        continue;
      }
      const evidence = toolEvidenceFromPart(part);
      collectInputEvidence(evidence.inputPreview, fileEvidence, commandEvidence);
      if (part.stateStatus === "completed" || part.stateStatus === "error") {
        if (completedTools.length < ATTEMPT_HANDOFF_TOOL_EVIDENCE_LIMIT) {
          completedTools.push(evidence);
        }
        continue;
      }
      if (part.stateStatus === "pending" || part.stateStatus === "running") {
        warnings.add(formatToolEvidence(evidence));
      }
    }
  }

  if (diagnostic.stallReason === "read_tool_invalid_input" || diagnostic.recoveryStallReason === "read_tool_invalid_input") {
    warnings.add("Previous attempt emitted a malformed OpenCode read tool call; do not repeat empty read input.");
  }
  if (diagnostic.stallReason === "tool_invalid_input" || diagnostic.recoveryStallReason === "tool_invalid_input") {
    warnings.add("Previous attempt emitted a malformed OpenCode tool call; avoid repeating empty tool input.");
  }
  return {
    sourceJobId: meta.jobId,
    sourceSessionId: meta.externalSessionId,
    cwd: meta.cwd,
    stallReason: diagnostic.stallReason,
    recoveryReason,
    trustedFinalText: false,
    completedTools,
    fileEvidence: [...fileEvidence].slice(0, ATTEMPT_HANDOFF_TOOL_EVIDENCE_LIMIT),
    commandEvidence: [...commandEvidence].slice(0, ATTEMPT_HANDOFF_TOOL_EVIDENCE_LIMIT),
    warnings: [...warnings].slice(0, ATTEMPT_HANDOFF_TOOL_EVIDENCE_LIMIT)
  };
}

function toolEvidenceFromPart(part: OpenCodePartSummary): AttemptHandoffToolEvidence {
  return {
    tool: part.tool ?? "unknown",
    callID: part.callID,
    status: part.stateStatus,
    inputPreview: part.stateInput?.preview ? truncateUtf8(part.stateInput.preview, ATTEMPT_HANDOFF_PREVIEW_BYTES) : undefined
  };
}

function collectInputEvidence(inputPreview: string | undefined, files: Set<string>, commands: Set<string>): void {
  if (!inputPreview) {
    return;
  }
  const parsed = parseJsonObject(inputPreview);
  for (const key of ["filePath", "path", "filepath"]) {
    const value = typeof parsed?.[key] === "string" ? parsed[key] : undefined;
    if (value) {
      files.add(value);
    }
  }
  const command = typeof parsed?.command === "string" ? parsed.command : undefined;
  if (command) {
    commands.add(truncateUtf8(command, ATTEMPT_HANDOFF_PREVIEW_BYTES));
  }
}

function formatAttemptHandoffCapsule(capsule: AttemptHandoffCapsule | undefined): string {
  if (!capsule) {
    return "Attempt handoff capsule: unavailable.";
  }
  const lines = [
    "Attempt handoff capsule:",
    `- sourceJobId=${capsule.sourceJobId}`,
    capsule.sourceSessionId ? `- sourceSessionId=${capsule.sourceSessionId}` : undefined,
    `- cwd=${capsule.cwd}`,
    capsule.stallReason ? `- stallReason=${capsule.stallReason}` : undefined,
    `- recoveryReason=${capsule.recoveryReason}`,
    "- trustedFinalText=false; ignore any previous stalled final answer or assistant conclusion."
  ].filter((line): line is string => Boolean(line));

  if (capsule.completedTools.length > 0) {
    lines.push("- completed tool evidence:");
    lines.push(...capsule.completedTools.map((tool) => `  - ${formatToolEvidence(tool)}`));
  } else {
    lines.push("- completed tool evidence: none captured in bounded diagnostics.");
  }
  if (capsule.fileEvidence.length > 0) {
    lines.push(`- file evidence: ${capsule.fileEvidence.join(", ")}`);
  }
  if (capsule.commandEvidence.length > 0) {
    lines.push(`- command evidence: ${capsule.commandEvidence.join(" | ")}`);
  }
  if (capsule.warnings.length > 0) {
    lines.push("- warnings:");
    lines.push(...capsule.warnings.map((warning) => `  - ${warning}`));
  }
  return lines.join("\n");
}

function formatToolEvidence(evidence: AttemptHandoffToolEvidence): string {
  return [
    `tool=${evidence.tool}`,
    evidence.status ? `status=${evidence.status}` : undefined,
    evidence.callID ? `callID=${evidence.callID}` : undefined,
    evidence.inputPreview ? `input=${evidence.inputPreview}` : undefined
  ]
    .filter((part): part is string => Boolean(part))
    .join(" ");
}

function parseJsonObject(value: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
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

function selectedAttemptChainJobId(root: JobMeta): string | undefined {
  return root.status === "completed" && root.externalSessionId ? root.jobId : root.selectedAttemptJobId;
}

function hasToolPart(message: OpenCodeMessage): boolean {
  return Array.isArray(message.parts) && message.parts.some((part) => part?.type === "tool");
}

function isFailedToolCallAssistantMessage(message: OpenCodeMessage): boolean {
  if (!isToolCallAssistantMessage(message) || extractMessageText(message).length > 0) {
    return false;
  }
  const toolParts = summarizeMessageParts(message)?.filter((part) => part.type === "tool") ?? [];
  return toolParts.length > 0 && toolParts.every((part) => part.stateStatus === "error");
}

function collectRunningToolPartSummaries(messages: OpenCodeMessage[]): OpenCodePartSummary[] {
  return messages.flatMap(
    (message) => summarizeMessageParts(message)?.filter((part) => part.type === "tool" && isActiveToolState(part.stateStatus)) ?? []
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
  return partTypes.length > 0 && partTypes.every((type) => type === "step-start" || type === "reasoning" || type === "step-finish");
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
  if (typeof message.info.finish === "string" && message.info.finish !== "unknown") {
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
  return summaries.every((part) => part.type === "step-start" || part.type === "reasoning" || part.type === "step-finish");
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

function hasNonEmptyReasoningOnlyProgress(message: OpenCodeMessage | undefined): boolean {
  if (message?.info?.role !== "assistant") {
    return false;
  }
  if (!Array.isArray(message.parts) || message.parts.length === 0) {
    return false;
  }
  const hasOnlyReasoningProgressParts = message.parts.every((part) => {
    const type = part?.type ?? "unknown";
    if (type === "step-start" || type === "reasoning" || type === "step-finish") {
      return true;
    }
    return type === "text" && Buffer.byteLength(part.text ?? "", "utf8") === 0;
  });
  if (!hasOnlyReasoningProgressParts) {
    return false;
  }
  return extractReasoningTextBytes(message) > 0;
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

function extractReasoningTextBytes(message: { parts?: Array<{ type?: string; text?: string }> } | undefined): number {
  if (!Array.isArray(message?.parts)) {
    return 0;
  }
  return message.parts
    .filter((part) => part?.type === "reasoning" && typeof part.text === "string")
    .reduce((total, part) => total + Buffer.byteLength(part.text ?? "", "utf8"), 0);
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

function resolveRunnerMode(env: RetinueOptions["env"]): OpenCodeRunnerMode {
  const value = env?.RETINUE_OPENCODE_ROOT_BINDING_MODE?.trim().toLowerCase();
  if (value === undefined || value === "" || value === "shared_root" || value === "shared-root") {
    return "shared-root";
  }
  if (value === "per_spawn" || value === "per-spawn") {
    return "per-spawn";
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

function findOpenCodeAgent(agents: OpenCodeAgentInfo[], name: string): OpenCodeAgentInfo | undefined {
  return agents.find((agent) => agent.name === name);
}

function validateOpenCodeAgent(agents: OpenCodeAgentInfo[], name: string, role: "root" | "child", kind: AgentBackendKind): void {
  if (agents.length === 0 || findOpenCodeAgent(agents, name)) {
    return;
  }
  const available = agents.map((agent) => agent.name).filter(Boolean).sort().join(", ");
  const backend = kind === "kilo" ? "Kilo" : "OpenCode";
  const roleLabel = role === "root" ? "root agent" : "child agent";
  const backendHint = isRetinueBackendName(name)
    ? ` "${name}" is a Retinue backend name; select the backend with RETINUE_BACKEND, and use agent only for one ${backend} agent such as ${available}.`
    : "";
  throw new Error(
    `Unsupported ${backend} ${roleLabel} "${name}". The agent field selects a backend agent name for ${backend}, not a Retinue backend, Codex model, or Codex native subagent.${backendHint} Available ${backend} agents: ${available}.`
  );
}

function isRetinueBackendName(name: string): boolean {
  return name === "opencode" || name === "claude-code" || name === "claude" || name === "kilo";
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
