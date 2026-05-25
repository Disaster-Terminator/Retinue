import fs from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { query as claudeQuery } from "@anthropic-ai/claude-agent-sdk";
import type { PermissionUpdate } from "@anthropic-ai/claude-agent-sdk";
import { readTextTailIfExists } from "../../core/fileTail.js";
import { getJobPaths, resolveStateDir } from "../../core/paths.js";
import { isCleanupSafeStatus } from "../../core/status.js";
import type {
  AgentBackend,
  AgentBackendResult,
  AgentBackendStatus,
  AgentContinueOptions,
  AgentHandle,
  AgentPermissionListResult,
  AgentPermissionReplyResult,
  AgentRunOptions,
  AgentRunStart
} from "../types.js";
import type {
  CleanupResult,
  ExitStatus,
  JobMeta,
  JobProblem,
  JobResult,
  JobStatus,
  JobStatusResult,
  PermissionReplyOption,
  RetinuePermissionRequest,
  RunOptions,
  WaitResult
} from "../../core/types.js";

type ClaudeSdkQueryParams = {
  prompt: string;
  options?: {
    cwd?: string;
    abortController?: AbortController;
    maxTurns?: number;
    model?: string;
    permissionMode?: RunOptions["permissionMode"];
    resume?: string;
    canUseTool?: ClaudeSdkCanUseTool;
  };
};

type ClaudeSdkQuery = AsyncIterable<unknown> & { close?: () => void };
export type ClaudeSdkQueryFn = (params: ClaudeSdkQueryParams) => ClaudeSdkQuery;
type ClaudeSdkPermissionResult =
  | {
      behavior: "allow";
      toolUseID?: string;
      updatedPermissions?: PermissionUpdate[];
      decisionClassification?: "user_temporary" | "user_permanent";
    }
  | {
      behavior: "deny";
      message: string;
      interrupt?: boolean;
      toolUseID?: string;
      decisionClassification?: "user_reject";
    };
type ClaudeSdkCanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
  hook: {
    signal: AbortSignal;
    toolUseID: string;
    title?: string;
    displayName?: string;
    description?: string;
    blockedPath?: string;
    decisionReason?: string;
    agentID?: string;
    suggestions?: PermissionUpdate[];
  }
) => Promise<ClaudeSdkPermissionResult>;

export type ClaudeCodeSdkJobStore = Map<string, TrackedSdkJob>;

export interface ClaudeCodeSdkBackendOptions {
  stateDir?: string;
  env?: NodeJS.ProcessEnv;
  defaultRuntimeTimeoutMs?: number;
  query?: ClaudeSdkQueryFn;
  jobs?: ClaudeCodeSdkJobStore;
}

interface TrackedSdkJob {
  abortController: AbortController;
  finalized: Promise<void>;
  pending: Map<string, PendingPermission>;
  query?: ClaudeSdkQuery;
}

interface PendingPermission {
  request: RetinuePermissionRequest;
  resolve: (result: ClaudeSdkPermissionResult) => void;
  input: Record<string, unknown>;
  suggestions?: PermissionUpdate[];
  toolUseID: string;
}

export class ClaudeCodeSdkBackend implements AgentBackend {
  readonly kind = "claude-code" as const;

  private readonly stateDir: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly defaultRuntimeTimeoutMs?: number;
  private readonly query: ClaudeSdkQueryFn;
  private readonly jobs: ClaudeCodeSdkJobStore;

  constructor(options: ClaudeCodeSdkBackendOptions = {}) {
    this.stateDir = resolveStateDir({ explicitStateDir: options.stateDir, env: options.env });
    this.env = options.env ?? process.env;
    this.defaultRuntimeTimeoutMs = options.defaultRuntimeTimeoutMs;
    this.query = options.query ?? ((params) => claudeQuery(params as Parameters<typeof claudeQuery>[0]));
    this.jobs = options.jobs ?? new Map();
  }

  async run(options: AgentRunOptions): Promise<AgentRunStart> {
    const jobId = `job_${randomUUID()}`;
    const paths = getJobPaths(this.stateDir, jobId);
    await fs.mkdir(paths.dir, { recursive: true });
    await fs.writeFile(paths.prompt, options.prompt, "utf8");

    const now = new Date().toISOString();
    const runtimeTimeoutMs = options.timeoutMs ?? this.defaultRuntimeTimeoutMs;
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
      resume: options.resume,
      parentJobId: options.parentJobId,
      parentSessionId: options.parentSessionId,
      recoveredFromJobId: options.recoveredFromJobId,
      attempt: options.attempt,
      recoveryReason: options.recoveryReason,
      recoveryPolicy: options.recoveryPolicy,
      originalStallReason: options.originalStallReason,
      recoveryStallReason: options.recoveryStallReason,
      title: options.title,
      runtimeTimeoutMs,
      args: ["sdk"],
      createdAt: now,
      updatedAt: now
    };

    const abortController = new AbortController();
    let timeout: NodeJS.Timeout | undefined;
    let resolveFinalized: () => void = () => undefined;
    const finalized = new Promise<void>((resolve) => {
      resolveFinalized = resolve;
    });
    const tracked: TrackedSdkJob = {
      abortController,
      finalized,
      pending: new Map()
    };
    this.jobs.set(jobId, tracked);

    const finalize = async (status: ExitStatus["status"], exitCode: number | null, signal: NodeJS.Signals | null): Promise<void> => {
      if (!this.jobs.has(jobId)) {
        return;
      }
      if (timeout) {
        clearTimeout(timeout);
      }
      const endedAt = new Date().toISOString();
      await writeJsonAtomic(paths.exitStatus, { status, exitCode, signal, endedAt } satisfies ExitStatus);
      const current = await this.readMeta(jobId);
      const currentMeta = isProblem(current) ? meta : current;
      await this.writeMeta({ ...currentMeta, status, updatedAt: endedAt });
      this.jobs.delete(jobId);
      resolveFinalized();
    };

    if (runtimeTimeoutMs !== undefined) {
      timeout = setTimeout(() => {
        abortController.abort();
        tracked.query?.close?.();
        void finalize("timed_out", null, "SIGTERM");
      }, runtimeTimeoutMs);
      timeout.unref();
    }

    await this.writeMeta(meta);

    void this.runQuery(jobId, options, tracked, finalize).catch(async (error) => {
      await fs.appendFile(paths.stderr, `${String(error instanceof Error ? error.stack ?? error.message : error)}\n`, "utf8");
      await finalize("failed", 1, null);
    });

    return meta;
  }

  continueJob(options: AgentContinueOptions): Promise<AgentRunStart> {
    return this.run({
      ...options,
      resume: options.externalSessionId ?? options.parentSessionId ?? options.resume,
      parentSessionId: options.externalSessionId ?? options.parentSessionId
    });
  }

  async status(handle: AgentHandle): Promise<AgentBackendStatus> {
    return this.statusByJobId(handle.jobId);
  }

  async wait(handle: AgentHandle, timeoutMs = 60000): Promise<WaitResult> {
    const start = Date.now();
    while (Date.now() - start <= timeoutMs) {
      const status = await this.statusByJobId(handle.jobId);
      if (isProblem(status)) {
        return { jobId: handle.jobId, status: status.status };
      }
      const permissions = this.pendingPermissions(handle.jobId);
      if (status.status === "running" && permissions.length > 0) {
        return permissionWaitResult(handle.jobId, this.kind, permissions);
      }
      if (status.status !== "running") {
        const exitStatus = await readJsonIfExists<ExitStatus>(getJobPaths(this.stateDir, handle.jobId).exitStatus);
        return {
          jobId: handle.jobId,
          status: status.status,
          exitCode: exitStatus?.exitCode,
          signal: exitStatus?.signal
        };
      }
      await sleep(100);
    }
    return { jobId: handle.jobId, status: "running" };
  }

  async result(handle: AgentHandle): Promise<AgentBackendResult> {
    const meta = await this.statusByJobId(handle.jobId);
    if (isProblem(meta)) {
      return { jobId: handle.jobId, status: meta.status, error: meta.error };
    }
    const paths = getJobPaths(this.stateDir, handle.jobId);
    const [stdout, stderr, exitStatus] = await Promise.all([
      readTextTailIfExists(paths.stdout, 65536),
      readTextTailIfExists(paths.stderr, 65536),
      readJsonIfExists<ExitStatus>(paths.exitStatus)
    ]);
    const parsedStdout = parseJsonOutput(stdout.text);
    const permissions = this.pendingPermissions(handle.jobId);

    return {
      jobId: handle.jobId,
      status: meta.status,
      stdout: stdout.text,
      stderr: stderr.text,
      stdoutPath: paths.stdout,
      stderrPath: paths.stderr,
      stdoutBytes: stdout.bytes,
      stderrBytes: stderr.bytes,
      stdoutTruncated: stdout.truncated,
      stderrTruncated: stderr.truncated,
      sessionId: meta.sessionId ?? extractSessionId(parsedStdout),
      parsedStdout,
      exitStatus,
      ...(permissions.length > 0 ? permissionWaitResult(handle.jobId, this.kind, permissions) : {})
    };
  }

  async abort(handle: AgentHandle): Promise<void> {
    const tracked = this.jobs.get(handle.jobId);
    if (!tracked) {
      return;
    }
    tracked.abortController.abort();
    tracked.query?.close?.();
    for (const pending of tracked.pending.values()) {
      pending.resolve({
        behavior: "deny",
        message: "Retinue closed this Claude Code SDK job before the permission request was answered.",
        toolUseID: pending.toolUseID,
        decisionClassification: "user_reject"
      });
    }
    await Promise.race([tracked.finalized, sleep(5000)]);
    const status = await this.statusByJobId(handle.jobId);
    if (!isProblem(status) && status.status === "running") {
      const endedAt = new Date().toISOString();
      const paths = getJobPaths(this.stateDir, handle.jobId);
      await writeJsonAtomic(paths.exitStatus, { status: "killed", exitCode: null, signal: "SIGTERM", endedAt } satisfies ExitStatus);
      await this.writeMeta({ ...status, status: "killed", updatedAt: endedAt });
      this.jobs.delete(handle.jobId);
    }
  }

  async cleanup(options: { olderThanMs?: number } = {}): Promise<CleanupResult> {
    const olderThanMs = options.olderThanMs ?? 0;
    const jobsDir = getJobsDir(this.stateDir);
    const removedJobIds: string[] = [];
    const removedTempFiles: string[] = [];
    const now = Date.now();
    for (const entry of await readDirIfExists(jobsDir)) {
      if (!entry.isDirectory()) {
        continue;
      }
      const status = await this.statusByJobId(entry.name);
      if (isProblem(status) || !isCleanupSafeStatus(status.status)) {
        continue;
      }
      const updatedAt = Date.parse(status.updatedAt);
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

  async listPermissions(handle: AgentHandle): Promise<AgentPermissionListResult> {
    const status = await this.statusByJobId(handle.jobId);
    return {
      jobId: handle.jobId,
      backend: this.kind,
      status: isProblem(status) ? status.status : status.status,
      permissions: this.pendingPermissions(handle.jobId)
    };
  }

  async replyPermission(
    handle: AgentHandle,
    options: { requestId: string; reply: PermissionReplyOption; message?: string }
  ): Promise<AgentPermissionReplyResult> {
    const tracked = this.jobs.get(handle.jobId);
    const pending = tracked?.pending.get(options.requestId);
    if (!tracked || !pending) {
      throw new Error(`Claude Code SDK permission request not found: ${options.requestId}`);
    }
    tracked.pending.delete(options.requestId);
    pending.resolve(permissionReplyToSdkResult(options.reply, pending, options.message));
    const list = await this.listPermissions(handle);
    return { ...list, repliedRequestId: options.requestId, reply: options.reply };
  }

  private async runQuery(
    jobId: string,
    options: AgentRunOptions,
    tracked: TrackedSdkJob,
    finalize: (status: ExitStatus["status"], exitCode: number | null, signal: NodeJS.Signals | null) => Promise<void>
  ): Promise<void> {
    const paths = getJobPaths(this.stateDir, jobId);
    let resultSeen = false;
    tracked.query = this.query({
      prompt: options.prompt,
      options: {
        cwd: options.cwd,
        abortController: tracked.abortController,
        maxTurns: options.maxTurns,
        ...(this.env.RETINUE_CLAUDE_MODEL ? { model: this.env.RETINUE_CLAUDE_MODEL } : {}),
        permissionMode: options.permissionMode,
        resume: options.resume,
        canUseTool: (toolName, input, hook) => this.recordPermission(jobId, toolName, input, hook)
      }
    });

    for await (const message of tracked.query) {
      const projected = projectSdkMessage(message);
      const sessionId = projected.session_id ?? projected.sessionId;
      if (typeof sessionId === "string") {
        await this.patchMeta(jobId, { sessionId, externalSessionId: sessionId });
      }
      if (projected.type === "result") {
        resultSeen = true;
        await fs.appendFile(paths.stdout, `${JSON.stringify(projected)}\n`, "utf8");
        await finalize(projected.is_error === true ? "failed" : "completed", projected.is_error === true ? 1 : 0, null);
        return;
      }
    }

    if (!resultSeen) {
      await fs.appendFile(paths.stderr, "Claude Code SDK query ended without a result message.\n", "utf8");
      await finalize("failed", 1, null);
    }
  }

  private recordPermission(
    jobId: string,
    toolName: string,
    input: Record<string, unknown>,
    hook: Parameters<ClaudeSdkCanUseTool>[2]
  ): Promise<ClaudeSdkPermissionResult> {
    const tracked = this.jobs.get(jobId);
    if (!tracked) {
      return Promise.resolve({
        behavior: "deny",
        message: "Retinue no longer tracks this Claude Code SDK job.",
        toolUseID: hook.toolUseID,
        decisionClassification: "user_reject"
      });
    }
    const existing = tracked.pending.get(hook.toolUseID);
    if (existing) {
      return new Promise((resolve) => {
        const originalResolve = existing.resolve;
        existing.resolve = (result) => {
          originalResolve(result);
          resolve(result);
        };
      });
    }
    return new Promise((resolve) => {
      tracked.pending.set(hook.toolUseID, {
        request: permissionRequestFromHook(toolName, input, hook),
        resolve,
        input,
        suggestions: hook.suggestions,
        toolUseID: hook.toolUseID
      });
    });
  }

  private async statusByJobId(jobId: string): Promise<JobStatusResult> {
    const meta = await this.readMeta(jobId);
    if (isProblem(meta)) {
      return meta;
    }
    if (meta.status !== "running") {
      return meta;
    }
    const exitStatus = await readJsonIfExists<ExitStatus>(getJobPaths(this.stateDir, jobId).exitStatus);
    if (exitStatus) {
      return { ...meta, status: exitStatus.status, updatedAt: exitStatus.endedAt };
    }
    return meta;
  }

  private async readMeta(jobId: string): Promise<JobMeta | JobProblem> {
    try {
      return normalizeMeta(JSON.parse(await fs.readFile(getJobPaths(this.stateDir, jobId).meta, "utf8")) as JobMeta);
    } catch (error) {
      if (isMissingFile(error)) {
        return { jobId, status: "not_found" };
      }
      return { jobId, status: "corrupted", error: error instanceof Error ? error.message : String(error) };
    }
  }

  private async writeMeta(meta: JobMeta): Promise<void> {
    await writeJsonAtomic(getJobPaths(this.stateDir, meta.jobId).meta, meta);
  }

  private async patchMeta(jobId: string, patch: Partial<JobMeta>): Promise<void> {
    const meta = await this.readMeta(jobId);
    if (!isProblem(meta)) {
      await this.writeMeta({ ...meta, ...patch, updatedAt: new Date().toISOString() });
    }
  }

  private pendingPermissions(jobId: string): RetinuePermissionRequest[] {
    return [...(this.jobs.get(jobId)?.pending.values() ?? [])].map((pending) => pending.request);
  }
}

function permissionRequestFromHook(
  toolName: string,
  input: Record<string, unknown>,
  hook: Parameters<ClaudeSdkCanUseTool>[2]
): RetinuePermissionRequest {
  const target = firstString(hook.blockedPath, hook.description, input.file_path, input.path, input.command) ?? JSON.stringify(input);
  const title = hook.title ?? hook.displayName ?? toolName;
  return {
    id: hook.toolUseID,
    permission: toolName,
    patterns: target ? [target] : [],
    toolCallID: hook.toolUseID,
    metadata: {
      input,
      agentID: hook.agentID,
      decisionReason: hook.decisionReason
    },
    approval: {
      kind: "claude_code_permission",
      title,
      lines: [
        hook.description ? `${hook.displayName ?? toolName}: ${hook.description}` : `${toolName}: ${target}`,
        ...(hook.decisionReason ? [hook.decisionReason] : [])
      ],
      guidance: [
        "Approve only if this Claude Code SDK tool request is in scope for the delegated Retinue task.",
        "Use once for narrow task-required access; reject out-of-scope tools or paths."
      ],
      recommendedReply: "once",
      scope: {
        permission: toolName,
        target,
        relation: hook.decisionReason?.toLowerCase().includes("outside") ? "outside_workspace" : "unknown"
      },
      options: [
        { reply: "once", label: "Allow once", effect: "Resume this Claude Code tool call only." },
        { reply: "always", label: "Always allow", effect: "Allow this suggested Claude Code permission when the SDK provides a reusable rule.", requiresConfirmation: true },
        { reply: "reject", label: "Reject", effect: "Deny this Claude Code tool call." }
      ]
    }
  };
}

function permissionReplyToSdkResult(reply: PermissionReplyOption, pending: PendingPermission, message?: string): ClaudeSdkPermissionResult {
  if (reply === "reject") {
    return {
      behavior: "deny",
      message: message ?? "Retinue denied this Claude Code SDK permission request.",
      toolUseID: pending.toolUseID,
      decisionClassification: "user_reject"
    };
  }
  const result: ClaudeSdkPermissionResult & { updatedInput: Record<string, unknown> } = {
    behavior: "allow",
    updatedInput: pending.input,
    toolUseID: pending.toolUseID,
    updatedPermissions: reply === "always" ? pending.suggestions : undefined,
    decisionClassification: reply === "always" ? "user_permanent" : "user_temporary"
  };
  return result;
}

function permissionWaitResult(jobId: string, backend: "claude-code", permissions: RetinuePermissionRequest[]): WaitResult {
  return {
    jobId,
    status: "running",
    attentionRequired: {
      kind: "permission",
      backend,
      reason: "claude_code_permission_pending",
      permissions,
      replyOptions: ["once", "always", "reject"]
    },
    permissionRequired: true,
    permissions
  };
}

function projectSdkMessage(message: unknown): Record<string, unknown> {
  if (typeof message !== "object" || message === null) {
    return { type: "unknown", value: message };
  }
  const record = message as Record<string, unknown>;
  return {
    type: record.type,
    subtype: record.subtype,
    is_error: record.is_error,
    result: record.result,
    session_id: record.session_id ?? record.sessionId
  };
}

function normalizeMeta(meta: JobMeta): JobMeta {
  return { ...meta, backend: meta.backend ?? "claude-code" };
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
    if (isMissingFile(error)) {
      return "";
    }
    throw error;
  }
}

async function readJsonIfExists<T>(filePath: string): Promise<T | undefined> {
  const text = await readTextIfExists(filePath);
  if (!text.trim()) {
    return undefined;
  }
  return JSON.parse(text) as T;
}

function parseJsonOutput(stdout: string): unknown {
  const lastLine = stdout.trim().split(/\r?\n/).at(-1);
  if (!lastLine) {
    return undefined;
  }
  try {
    return JSON.parse(lastLine);
  } catch {
    return undefined;
  }
}

function extractSessionId(parsedStdout: unknown): string | undefined {
  return typeof parsedStdout === "object" && parsedStdout !== null && typeof (parsedStdout as { session_id?: unknown }).session_id === "string"
    ? (parsedStdout as { session_id: string }).session_id
    : undefined;
}

function createPromptPreview(prompt: string): string {
  const normalized = prompt.replace(/\s+/g, " ").trim();
  return normalized.length > 120 ? `${normalized.slice(0, 117)}...` : normalized;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isProblem(value: JobStatusResult): value is JobProblem {
  return value.status === "not_found" || value.status === "corrupted" || value.status === "backend_unreachable";
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getJobsDir(stateDir: string): string {
  return getJobPaths(stateDir, "placeholder").dir.replace(/[\\/]placeholder$/, "");
}

async function readDirIfExists(dirPath: string) {
  try {
    return await fs.readdir(dirPath, { withFileTypes: true });
  } catch (error) {
    if (isMissingFile(error)) {
      return [];
    }
    throw error;
  }
}

async function listTempFiles(dirPath: string): Promise<string[]> {
  const entries = await readDirIfExists(dirPath);
  const separator = dirPath.includes("\\") ? "\\" : "/";
  return entries.filter((entry) => entry.isFile() && entry.name.endsWith(".tmp")).map((entry) => `${dirPath}${separator}${entry.name}`);
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.length > 0);
}
