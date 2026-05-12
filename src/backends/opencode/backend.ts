import fs from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { getJobPaths, getRetinueTracePath, resolveStateDir } from "../../core/paths.js";
import type { CleanupOptions, CleanupResult, JobMeta, JobProblem, JobResult, JobStatusResult, RetinueOptions } from "../../core/types.js";
import type { AgentBackend, AgentContinueOptions, AgentHandle, AgentRunOptions } from "../types.js";
import { OpenCodeClient, OpenCodeClientError, type OpenCodeMessage } from "./client.js";

export interface OpenCodeBackendOptions {
  client?: OpenCodeClient;
  baseUrl?: string;
  target?: (cwd: string | undefined) => Promise<OpenCodeBackendTarget>;
  stateDir?: string;
  env?: RetinueOptions["env"];
}
export interface OpenCodeBackendTarget {
  client: OpenCodeClient;
  baseUrl: string;
}
const DEFAULT_WAIT_TIMEOUT_MS = 30_000;
const DEFAULT_WAIT_POLL_MS = 250;
const DEFAULT_STALL_MS = 10 * 60_000;
const DEFAULT_STALL_TOOL_CALL_ROUNDS = 6;

interface OpenCodeJobDiagnostic {
  baseUrl: string;
  sessionId?: string;
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
  lastMessageTextBytes?: number;
  lastAssistantFinish?: string;
  lastAssistantPartTypes?: string[];
  lastAssistantTextBytes?: number;
  lastAssistantProviderID?: string;
  lastAssistantModelID?: string;
  lastAssistantAgent?: string;
  lastAssistantMode?: string;
  lastAssistantCost?: number;
  lastAssistantTokens?: unknown;
  messageSummaries?: Array<{
    role?: string;
    finish?: string;
    partTypes?: string[];
    textBytes: number;
    completed: boolean;
  }>;
  selectedAssistantTextBytes?: number;
  selectedAssistantSha256?: string;
  selectedAssistantPreview?: string;
  toolCallAssistantRounds?: number;
  noCompletedAssistantDurationMs?: number;
  stallThresholdMs?: number;
  stallToolCallRoundThreshold?: number;
  error?: string;
}

export class OpenCodeBackend implements AgentBackend {
  readonly kind = "opencode" as const;
  private readonly client?: OpenCodeClient;
  private readonly baseUrl?: string;
  private readonly resolveTarget: (cwd: string | undefined) => Promise<OpenCodeBackendTarget>;
  private readonly stateDir: string;
  private readonly env?: RetinueOptions["env"];

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
  }

  async run(options: AgentRunOptions): Promise<JobMeta> {
    const jobId = `job_${randomUUID()}`;
    const paths = getJobPaths(this.stateDir, jobId);
    await fs.mkdir(paths.dir, { recursive: true });
    await fs.writeFile(paths.prompt, options.prompt, "utf8");

    const target = await this.resolveTarget(options.cwd);
    const session = await target.client.createSession({ cwd: options.cwd, title: options.title ?? options.name });
    const baseline = await this.captureMessageBaseline(target.client, session.id);
    await target.client.promptAsync(session.id, {
      prompt: options.prompt,
      model: options.model,
      agent: options.agent
    });
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
      externalSessionId: session.id,
      externalServerUrl: target.baseUrl,
      externalMessageBaselineCount: baseline.messageCount,
      externalCompletedAssistantBaselineCount: baseline.completedAssistantCount,
      args: [],
      createdAt: now,
      updatedAt: now
    };
    await writeJsonAtomic(paths.meta, meta);
    await this.writeJobTrace("opencode_job_prompt_submitted", meta, await this.inspectJob(meta));
    return meta;
  }

  async continueJob(options: AgentContinueOptions): Promise<JobMeta> {
    if (!options.externalSessionId) {
      return this.run(options);
    }
    const jobId = `job_${randomUUID()}`;
    const paths = getJobPaths(this.stateDir, jobId);
    await fs.mkdir(paths.dir, { recursive: true });
    await fs.writeFile(paths.prompt, options.prompt, "utf8");
    const target = await this.targetForContinue(options);
    const baseline = await this.captureMessageBaseline(target.client, options.externalSessionId);
    await target.client.promptAsync(options.externalSessionId, {
      prompt: options.prompt,
      model: options.model,
      agent: options.agent
    });
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
      externalSessionId: options.externalSessionId,
      externalServerUrl: target.baseUrl,
      externalMessageBaselineCount: baseline.messageCount,
      externalCompletedAssistantBaselineCount: baseline.completedAssistantCount,
      parentJobId: options.parentJobId,
      parentSessionId: options.parentSessionId,
      args: [],
      createdAt: now,
      updatedAt: now
    };
    await writeJsonAtomic(paths.meta, meta);
    await this.writeJobTrace("opencode_job_prompt_submitted", meta, await this.inspectJob(meta));
    return meta;
  }

  async status(handle: AgentHandle): Promise<JobStatusResult> {
    const meta = await this.readMeta(handle.jobId);
    if (isProblem(meta)) {
      return meta;
    }
    return this.reconcileStatus(meta);
  }

  async result(handle: AgentHandle): Promise<JobResult> {
    const meta = await this.status(handle);
    if (isProblem(meta)) {
      return { jobId: handle.jobId, status: meta.status, error: meta.error };
    }
    if (!meta.externalSessionId) {
      return { jobId: handle.jobId, status: "corrupted", error: "Missing OpenCode session id" };
    }
    const client = this.clientForMeta(meta);
    const messages = await client.messages(meta.externalSessionId);
    const jobMessages = selectMessagesForMeta(messages, meta);
    const paths = getJobPaths(this.stateDir, handle.jobId);
    const diagnostic = await this.inspectJob(meta);
    if (meta.status === "stalled") {
      const stderr = createStallMessage(diagnostic);
      await fs.writeFile(paths.stdout, stderr, "utf8");
      await fs.appendFile(paths.stderr, `${stderr}\n`, "utf8");
      await this.writeJobTrace("opencode_job_result_read", meta, diagnostic);
      await appendJobDiagnostic(this.stateDir, handle.jobId, { event: "opencode_job_result_read", diagnostic });
      return {
        jobId: handle.jobId,
        status: meta.status,
        stdout: stderr,
        stderr,
        stdoutPath: paths.stdout,
        stderrPath: paths.stderr,
        stdoutBytes: Buffer.byteLength(stderr, "utf8"),
        stderrBytes: Buffer.byteLength(stderr, "utf8"),
        stdoutTruncated: false,
        stderrTruncated: false,
        sessionId: meta.externalSessionId,
        parsedStdout: { result: stderr },
        error: stderr
      };
    }
    const text = meta.externalMessageBaselineCount === undefined ? latestAssistantMessageText(messages) : latestAssistantMessageText(jobMessages);
    await fs.writeFile(paths.stdout, text, "utf8");
    diagnostic.selectedAssistantTextBytes = Buffer.byteLength(text, "utf8");
    diagnostic.selectedAssistantSha256 = sha256(text);
    if (process.env.RETINUE_TRACE_TEXT_PREVIEW === "1") {
      diagnostic.selectedAssistantPreview = createPromptPreview(text);
    }
    await this.writeJobTrace("opencode_job_result_read", meta, diagnostic);
    await appendJobDiagnostic(this.stateDir, handle.jobId, { event: "opencode_job_result_read", diagnostic });
    return {
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
    };
  }

  async abort(handle: AgentHandle): Promise<void> {
    const meta = await this.readMeta(handle.jobId);
    if (isProblem(meta) || !meta.externalSessionId) {
      return;
    }
    await this.clientForMeta(meta).abort(meta.externalSessionId);
    await writeJsonAtomic(getJobPaths(this.stateDir, handle.jobId).meta, {
      ...meta,
      status: "killed",
      updatedAt: new Date().toISOString()
    });
  }

  async wait(handle: AgentHandle, timeoutMs = DEFAULT_WAIT_TIMEOUT_MS): Promise<{ jobId: string; status: JobStatusResult["status"] }> {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    for (;;) {
      const status = await this.status(handle);
      if (isProblem(status) || isTerminal(status.status)) {
        return { jobId: handle.jobId, status: status.status };
      }
      if (Date.now() >= deadline) {
        const meta = await this.readMeta(handle.jobId);
        if (!isProblem(meta)) {
          const diagnostic = await this.inspectJob(meta);
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
      if (isProblem(meta) || meta.backend !== "opencode" || meta.status === "running") {
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

  private async reconcileStatus(meta: JobMeta): Promise<JobMeta | JobProblem> {
    if (!meta.externalSessionId || (isTerminal(meta.status) && meta.status !== "stalled")) {
      return meta;
    }
    try {
      const client = this.clientForMeta(meta);
      const session = await client.getSession(meta.externalSessionId);
      let status = meta.status;
      if (session.aborted === true) {
        status = "killed";
      } else if (session.state === "completed") {
        status = "completed";
      } else if (session.state === "failed") {
        status = "failed";
      } else if (await this.hasNewCompletedAssistantMessage(client, meta.externalSessionId, meta)) {
        status = "completed";
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
      const updated: JobMeta = { ...meta, status, updatedAt: new Date().toISOString() };
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
      return updated;
    } catch (error) {
      if (error instanceof OpenCodeClientError && error.status === 404) {
        return { jobId: meta.jobId, status: "not_found", error: "OpenCode session not found" };
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
    if (jobMessages.some(isCompletedAssistantMessage)) {
      return true;
    }
    if (meta.externalMessageBaselineCount !== undefined) {
      return false;
    }
    return countCompletedAssistantMessages(messages) > (meta.externalCompletedAssistantBaselineCount ?? 0);
  }

  private async isStalledOpenCodeJob(client: OpenCodeClient, sessionId: string, meta: JobMeta): Promise<boolean> {
    const messages = await client.messages(sessionId);
    const jobMessages = selectMessagesForMeta(messages, meta);
    const stall = computeStallDiagnostic(jobMessages, meta, this.env);
    return stall !== undefined;
  }

  private async inspectJob(meta: JobMeta): Promise<OpenCodeJobDiagnostic> {
    const diagnostic: OpenCodeJobDiagnostic = {
      baseUrl: meta.externalServerUrl ?? this.baseUrl ?? "",
      sessionId: meta.externalSessionId
    };
    if (!meta.externalSessionId) {
      return diagnostic;
    }
    try {
      const client = this.clientForMeta(meta);
      const [session, messages] = await Promise.all([client.getSession(meta.externalSessionId), client.messages(meta.externalSessionId)]);
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
      diagnostic.lastMessageTextBytes = Buffer.byteLength(extractMessageText(lastMessage ?? {}), "utf8");
      diagnostic.lastAssistantFinish = stringInfo(lastAssistant, "finish");
      diagnostic.lastAssistantPartTypes = lastAssistant?.parts?.map((part) => part.type ?? "unknown");
      diagnostic.lastAssistantTextBytes = Buffer.byteLength(latestAssistantMessageText(jobMessages), "utf8");
      diagnostic.lastAssistantProviderID = stringInfo(lastAssistant, "providerID");
      diagnostic.lastAssistantModelID = stringInfo(lastAssistant, "modelID");
      diagnostic.lastAssistantAgent = stringInfo(lastAssistant, "agent");
      diagnostic.lastAssistantMode = stringInfo(lastAssistant, "mode");
      diagnostic.lastAssistantCost = numberInfo(lastAssistant, "cost");
      diagnostic.lastAssistantTokens = lastAssistant?.info?.tokens;
      diagnostic.messageSummaries = jobMessages.map((message) => ({
        role: message.info?.role,
        finish: stringInfo(message, "finish"),
        partTypes: message.parts?.map((part) => part.type ?? "unknown") ?? [],
        textBytes: Buffer.byteLength(extractMessageText(message), "utf8"),
        completed: isCompletedAssistantMessage(message)
      }));
      Object.assign(diagnostic, computeStallDiagnostic(jobMessages, meta, this.env));
    } catch (error) {
      diagnostic.error = error instanceof Error ? error.message : String(error);
    }
    return diagnostic;
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

  private clientForMeta(meta: JobMeta): OpenCodeClient {
    const baseUrl = meta.externalServerUrl?.replace(/\/+$/, "");
    if (baseUrl && baseUrl !== this.baseUrl) {
      return new OpenCodeClient(baseUrl);
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
        return { client: new OpenCodeClient(baseUrl), baseUrl };
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

function isTerminal(status: JobStatusResult["status"]): boolean {
  return status === "completed" || status === "failed" || status === "killed" || status === "timed_out" || status === "stalled";
}
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isProblem(value: JobStatusResult): value is JobProblem {
  return value.status === "not_found" || value.status === "corrupted";
}

function selectMessagesForMeta(messages: OpenCodeMessage[], meta: JobMeta): OpenCodeMessage[] {
  if (meta.externalMessageBaselineCount === undefined) {
    return messages;
  }
  return messages.slice(Math.max(0, meta.externalMessageBaselineCount));
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

function computeStallDiagnostic(
  jobMessages: OpenCodeMessage[],
  meta: JobMeta,
  env: RetinueOptions["env"] | undefined
): Partial<OpenCodeJobDiagnostic> | undefined {
  if (jobMessages.some(isCompletedAssistantMessage)) {
    return undefined;
  }
  const thresholdMs = parseOptionalNonNegativeInt(env?.RETINUE_OPENCODE_STALL_MS, DEFAULT_STALL_MS);
  if (thresholdMs <= 0) {
    return undefined;
  }
  const roundThreshold = parseOptionalNonNegativeInt(env?.RETINUE_OPENCODE_STALL_TOOL_CALL_ROUNDS, DEFAULT_STALL_TOOL_CALL_ROUNDS);
  const toolCallAssistantRounds = jobMessages.filter((message) => message.info?.role === "assistant" && isToolCallAssistantMessage(message)).length;
  if (toolCallAssistantRounds < roundThreshold) {
    return undefined;
  }
  const startedAt = Date.parse(meta.createdAt);
  const durationMs = Number.isFinite(startedAt) ? Date.now() - startedAt : 0;
  if (durationMs < thresholdMs) {
    return undefined;
  }
  return {
    toolCallAssistantRounds,
    noCompletedAssistantDurationMs: Math.max(0, durationMs),
    stallThresholdMs: thresholdMs,
    stallToolCallRoundThreshold: roundThreshold
  };
}

function createStallMessage(diagnostic: OpenCodeJobDiagnostic): string {
  const rounds = diagnostic.toolCallAssistantRounds ?? 0;
  const durationMs = diagnostic.noCompletedAssistantDurationMs ?? 0;
  return `OpenCode job stalled: observed ${rounds} tool-call assistant round(s) with no completed assistant text for ${durationMs}ms. Inspect Retinue trace/job diagnostics for message summaries.`;
}

function parseOptionalNonNegativeInt(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

function hasToolPart(message: OpenCodeMessage): boolean {
  return Array.isArray(message.parts) && message.parts.some((part) => part?.type === "tool");
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

function createPromptPreview(prompt: string): string {
  const normalized = prompt.replace(/\s+/g, " ").trim();
  return normalized.length > 120 ? `${normalized.slice(0, 117)}...` : normalized;
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
