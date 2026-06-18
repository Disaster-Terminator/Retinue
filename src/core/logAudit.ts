import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const DEFAULT_LOG_AUDIT_MAX_BYTES = 64 * 1024 * 1024;
export const DEFAULT_LOG_AUDIT_MAX_LINES = 50_000;
export const DEFAULT_LOG_AUDIT_SINCE_MAX_BYTES = 256 * 1024 * 1024;
export const DEFAULT_LOG_AUDIT_SINCE_MAX_LINES = 200_000;

export interface AuditRetinueLogsOptions {
  stateDir?: string;
  tracePath?: string;
  since?: Date;
  maxBytes?: number;
  maxLines?: number;
  reconcileStatus?: (jobId: string, meta: Record<string, unknown>) => Promise<string | undefined>;
  includeTerminal?: boolean;
}

export interface RetinueLogAuditIssue {
  signature: string;
  title: string;
  description: string;
  count: number;
  firstSeen?: string;
  lastSeen?: string;
  jobIds: string[];
  sample?: Record<string, unknown>;
}

export interface RetinueLogAuditAttention extends RetinueLogAuditIssue {
  kind: "permission";
}

export interface RetinueLogAuditResult {
  ok: true;
  tracePath: string;
  since?: string;
  inputTruncated: boolean;
  truncatedBeforeSince: boolean;
  oldestScannedEvent?: string;
  newestScannedEvent?: string;
  scannedEvents: number;
  ignoredCompletedJobIds: string[];
  ignoredTerminalJobIds: string[];
  issueCount: number;
  issues: RetinueLogAuditIssue[];
  attentionCount: number;
  attentions: RetinueLogAuditAttention[];
}

export async function auditRetinueLogs(options: AuditRetinueLogsOptions = {}): Promise<RetinueLogAuditResult> {
  const stateDir = options.stateDir ?? path.join(os.homedir(), ".local/state/retinue");
  const tracePath = options.tracePath ?? path.join(stateDir, "logs", "retinue.jsonl");
  const input = await readRecentJsonl(tracePath, {
    maxBytes: options.maxBytes ?? (options.since ? DEFAULT_LOG_AUDIT_SINCE_MAX_BYTES : DEFAULT_LOG_AUDIT_MAX_BYTES),
    maxLines: options.maxLines ?? (options.since ? DEFAULT_LOG_AUDIT_SINCE_MAX_LINES : DEFAULT_LOG_AUDIT_MAX_LINES),
    since: options.since
  });
  const events = input.events;
  const jobMetaByJobId = await collectJobMetaByJobId(events, stateDir);
  const latestStatusByJobId = await collectLatestStatusByJobId(events, stateDir, options.reconcileStatus);
  const latestEventByJobId = collectLatestEventByJobId(events);
  const attemptRootByJobId = await collectAttemptRoots(events, stateDir);
  const { issues, attentions } = summarizeIssues(events, latestStatusByJobId, latestEventByJobId, attemptRootByJobId, jobMetaByJobId, {
    includeTerminal: options.includeTerminal === true || options.since !== undefined
  });
  return {
    ok: true,
    tracePath,
    since: options.since?.toISOString(),
    inputTruncated: input.inputTruncated,
    truncatedBeforeSince: input.truncatedBeforeSince,
    oldestScannedEvent: input.oldestScannedEvent?.toISOString(),
    newestScannedEvent: input.newestScannedEvent?.toISOString(),
    scannedEvents: events.length,
    ignoredCompletedJobIds: completedJobIds(latestStatusByJobId),
    ignoredTerminalJobIds: terminalJobIds(latestStatusByJobId),
    issueCount: issues.length,
    issues,
    attentionCount: attentions.length,
    attentions
  };
}

interface ReadRecentJsonlOptions {
  maxBytes: number;
  maxLines: number;
  since?: Date;
}

interface ReadRecentJsonlResult {
  events: Record<string, unknown>[];
  inputTruncated: boolean;
  truncatedBeforeSince: boolean;
  oldestScannedEvent?: Date;
  newestScannedEvent?: Date;
}

async function readRecentJsonl(filePath: string, options: ReadRecentJsonlOptions): Promise<ReadRecentJsonlResult> {
  const tail = await readTail(filePath, options.maxBytes);
  const allLines = tail.text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const lineTruncated = allLines.length > options.maxLines;
  const lines = allLines.slice(-options.maxLines);
  const events: Record<string, unknown>[] = [];
  let oldestScannedEvent: Date | undefined;
  let newestScannedEvent: Date | undefined;
  for (const line of lines) {
    try {
      const event = JSON.parse(line) as unknown;
      if (!isRecord(event)) {
        continue;
      }
      const timestamp = eventTime(event);
      oldestScannedEvent = earlierDate(oldestScannedEvent, timestamp);
      newestScannedEvent = laterDate(newestScannedEvent, timestamp);
      if (options.since && timestamp && timestamp < options.since) {
        continue;
      }
      events.push(event);
    } catch {
      // Ignore partial or malformed tail lines.
    }
  }
  const inputTruncated = tail.truncated || lineTruncated;
  return {
    events,
    inputTruncated,
    truncatedBeforeSince: inputTruncated && options.since !== undefined && (oldestScannedEvent === undefined || oldestScannedEvent > options.since),
    oldestScannedEvent,
    newestScannedEvent
  };
}

async function readTail(filePath: string, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(filePath, "r");
  } catch (error) {
    if (isMissingFile(error)) {
      return { text: "", truncated: false };
    }
    throw error;
  }
  try {
    const stats = await handle.stat();
    const length = Math.min(stats.size, maxBytes);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, stats.size - length);
    return {
      text: buffer.toString("utf8").replace(/^\uFFFD+/, ""),
      truncated: stats.size > length
    };
  } finally {
    await handle.close();
  }
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function summarizeIssues(
  events: Record<string, unknown>[],
  latestStatusByJobId: Map<string, string>,
  latestEventByJobId: Map<string, string>,
  attemptRootByJobId: Map<string, string>,
  jobMetaByJobId: Map<string, Record<string, unknown>>,
  options: { includeTerminal?: boolean } = {}
): { issues: RetinueLogAuditIssue[]; attentions: RetinueLogAuditAttention[] } {
  const issuesBySignature = new Map<string, RetinueLogAuditIssue>();
  const attentionsBySignature = new Map<string, RetinueLogAuditAttention>();
  const latestStatusByChainRootJobId = collectLatestStatusByChainRootJobId(latestStatusByJobId, attemptRootByJobId);
  for (const event of events) {
    const diagnostic = isRecord(event.diagnostic) ? event.diagnostic : undefined;
    if (!diagnostic) {
      continue;
    }
    if (typeof event.jobId === "string") {
      const latestStatus = latestStatusByJobId.get(event.jobId);
      if (latestStatus === "completed") {
        continue;
      }
      if (options.includeTerminal !== true && isTerminalNonCompletedStatus(latestStatus)) {
        continue;
      }
      if (!isBackendUnreachableEvent(event) && isNonTerminalSoftStallEvent(latestEventByJobId.get(event.jobId))) {
        continue;
      }
    }
    const status = issueStatusForEvent(event, diagnostic);
    if (!status) {
      continue;
    }
    const chainRootJobId = typeof event.jobId === "string" ? attemptRootByJobId.get(event.jobId) : undefined;
    const latestChainStatus = chainRootJobId ? latestStatusByChainRootJobId.get(chainRootJobId) : undefined;
    if (latestChainStatus === "completed") {
      continue;
    }
    if (options.includeTerminal !== true && isTerminalNonCompletedStatus(latestChainStatus)) {
      continue;
    }
    const chainSignature = chainRootJobId ? createChainSignature(chainRootJobId, diagnostic) : undefined;
    const signature = chainSignature ?? createDiagnosticSignature(event, diagnostic);
    const attention = isAttentionDiagnostic(diagnostic);
    const summaries = attention ? attentionsBySignature : issuesBySignature;
    const jobMeta = typeof event.jobId === "string" ? jobMetaByJobId.get(event.jobId) : undefined;
    const current = summaries.get(signature) ?? {
      signature,
      ...(attention ? { kind: "permission" as const } : {}),
      title: attention ? createAttentionTitle(diagnostic) : createIssueTitle(event, diagnostic),
      description: attention ? createAttentionDescription(diagnostic, jobMeta) : createIssueDescription(event, diagnostic, jobMeta),
      count: 0,
      firstSeen: undefined,
      lastSeen: undefined,
      jobIds: [],
      sample: undefined
    };
    current.count += 1;
    const timestamp = eventTime(event)?.toISOString();
    current.firstSeen = earlier(current.firstSeen, timestamp);
    current.lastSeen = later(current.lastSeen, timestamp);
    if (typeof event.jobId === "string" && !current.jobIds.includes(event.jobId)) {
      current.jobIds.push(event.jobId);
    }
    const nextSample = compact({
      jobId: event.jobId,
      event: event.event,
      chainRootJobId,
      sessionId: diagnostic.sessionId,
      parentSessionId: diagnostic.parentSessionId,
      childSessionIds: diagnostic.childSessionIds,
      sessionDirectory: diagnostic.sessionDirectory,
      stallReason: diagnostic.stallReason,
      stallSummary: diagnostic.stallSummary,
      softStallRescueSourceReason: diagnostic.softStallRescueSourceReason,
      softStallRescueSourceSummary: diagnostic.softStallRescueSourceSummary,
      softStallRescueStrategy: diagnostic.softStallRescueStrategy,
      softStallRescueAgent: diagnostic.softStallRescueAgent,
      softStallRescueModel: diagnostic.softStallRescueModel,
      softStallRescueTools: diagnostic.softStallRescueTools,
      softStallRescueSubmittedAt: diagnostic.softStallRescueSubmittedAt,
      recoveryStallReason: diagnostic.recoveryStallReason,
      recoveryStallSummary: diagnostic.recoveryStallSummary,
      noCompletedAssistantDurationMs: diagnostic.noCompletedAssistantDurationMs,
      selectedAttemptJobId: event.selectedAttemptJobId,
      attemptChainPresent: Array.isArray(event.attemptChain),
      toolCallAssistantRounds: diagnostic.toolCallAssistantRounds,
      blankAssistantRounds: diagnostic.blankAssistantRounds,
      runningReadToolParts: diagnostic.runningReadToolParts,
      malformedReadToolParts: diagnostic.malformedReadToolParts,
      runningReadToolPartSummaries: diagnostic.runningReadToolPartSummaries,
      pendingPermissionCount: diagnostic.pendingPermissionCount,
      pendingExternalDirectoryPermissionCount: diagnostic.pendingExternalDirectoryPermissionCount,
      permissionActions: compactPermissionActions(diagnostic.pendingExternalDirectoryPermissions ?? diagnostic.pendingPermissions),
      readOnlyWriteIntent: diagnostic.readOnlyWriteIntent,
      problemStatus: status === "backend_unreachable" ? "backend_unreachable" : undefined,
      requestedAgent: requestedAgentFromMeta(jobMeta),
      baseUrl: diagnostic.baseUrl,
      error: diagnostic.error
    });
    const selectedSample = chooseSample(current.sample, nextSample);
    if (selectedSample === nextSample) {
      current.title = attention ? createAttentionTitle(diagnostic) : createIssueTitle(event, diagnostic);
      current.description = attention ? createAttentionDescription(diagnostic, jobMeta) : createIssueDescription(event, diagnostic, jobMeta);
    }
    current.sample = selectedSample;
    summaries.set(signature, current);
  }
  return {
    issues: sortSummaries([...issuesBySignature.values()]),
    attentions: sortSummaries([...attentionsBySignature.values()])
  };
}

function sortSummaries<T extends RetinueLogAuditIssue>(summaries: T[]): T[] {
  return summaries.sort((left, right) => right.count - left.count || String(right.lastSeen).localeCompare(String(left.lastSeen)));
}

function isAttentionDiagnostic(diagnostic: Record<string, unknown>): boolean {
  return (
    diagnostic.stallReason === "external_directory_permission_pending" &&
    typeof diagnostic.pendingPermissionCount === "number" &&
    diagnostic.pendingPermissionCount > 0
  );
}

function issueStatusForEvent(event: Record<string, unknown>, diagnostic: Record<string, unknown>): "stalled" | "backend_unreachable" | undefined {
  if (isBackendUnreachableEvent(event)) {
    return "backend_unreachable";
  }
  if (event.event === "opencode_job_stalled" || typeof diagnostic.stallReason === "string") {
    return "stalled";
  }
  return undefined;
}

function isBackendUnreachableEvent(event: Record<string, unknown>): boolean {
  return event.event === "opencode_job_backend_unreachable" || (event.event !== "opencode_job_stalled" && event.status === "backend_unreachable");
}

async function collectAttemptRoots(events: Record<string, unknown>[], stateDir: string): Promise<Map<string, string>> {
  const attemptRootByJobId = new Map<string, string>();
  const eventJobIds = new Set<string>();
  for (const event of events) {
    if (typeof event.jobId !== "string") {
      continue;
    }
    eventJobIds.add(event.jobId);
    const rootJobId = attemptRootByJobId.get(event.jobId) ?? event.jobId;
    const participatesInChain = typeof event.selectedAttemptJobId === "string" || Array.isArray(event.attemptChain);
    if (participatesInChain) {
      attemptRootByJobId.set(event.jobId, rootJobId);
    }
    if (typeof event.selectedAttemptJobId === "string") {
      attemptRootByJobId.set(event.selectedAttemptJobId, rootJobId);
    }
    if (typeof event.attemptJobId === "string") {
      attemptRootByJobId.set(event.jobId, rootJobId);
      attemptRootByJobId.set(event.attemptJobId, rootJobId);
    }
    if (Array.isArray(event.attemptChain)) {
      for (const attempt of event.attemptChain) {
        if (isRecord(attempt) && typeof attempt.jobId === "string") {
          attemptRootByJobId.set(attempt.jobId, rootJobId);
        }
      }
    }
  }
  for (const jobId of eventJobIds) {
    const meta = await readJobMeta(stateDir, jobId);
    if (!meta) {
      continue;
    }
    const rootJobId = typeof meta.recoveredFromJobId === "string" ? (attemptRootByJobId.get(meta.recoveredFromJobId) ?? meta.recoveredFromJobId) : jobId;
    if (typeof meta.recoveredFromJobId === "string") {
      attemptRootByJobId.set(meta.recoveredFromJobId, rootJobId);
      attemptRootByJobId.set(jobId, rootJobId);
    }
    if (typeof meta.selectedAttemptJobId === "string") {
      attemptRootByJobId.set(jobId, rootJobId);
      attemptRootByJobId.set(meta.selectedAttemptJobId, rootJobId);
    }
    if (Array.isArray(meta.attemptJobIds)) {
      attemptRootByJobId.set(jobId, rootJobId);
      for (const attemptJobId of meta.attemptJobIds) {
        if (typeof attemptJobId === "string") {
          attemptRootByJobId.set(attemptJobId, rootJobId);
        }
      }
    }
  }
  return attemptRootByJobId;
}

function collectLatestStatusByChainRootJobId(
  latestStatusByJobId: Map<string, string>,
  attemptRootByJobId: Map<string, string>
): Map<string, string> {
  const statuses = new Map<string, string>();
  for (const [jobId, status] of latestStatusByJobId) {
    const rootJobId = attemptRootByJobId.get(jobId);
    if (!rootJobId) {
      continue;
    }
    const current = statuses.get(rootJobId);
    if (status === "completed" || (current !== "completed" && isTerminalNonCompletedStatus(status))) {
      statuses.set(rootJobId, status);
    } else if (!current) {
      statuses.set(rootJobId, status);
    }
  }
  return statuses;
}

async function readJobMeta(stateDir: string, jobId: string): Promise<Record<string, unknown> | undefined> {
  try {
    const text = await fs.readFile(path.join(stateDir, "jobs", jobId, "meta.json"), "utf8");
    const parsed = JSON.parse(text) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

async function collectJobMetaByJobId(events: Record<string, unknown>[], stateDir: string): Promise<Map<string, Record<string, unknown>>> {
  const metas = new Map<string, Record<string, unknown>>();
  const jobIds = new Set<string>();
  for (const event of events) {
    if (typeof event.jobId === "string") {
      jobIds.add(event.jobId);
    }
  }
  for (const jobId of jobIds) {
    const meta = await readJobMeta(stateDir, jobId);
    if (meta) {
      metas.set(jobId, meta);
    }
  }
  return metas;
}

function createChainSignature(rootJobId: string, diagnostic: Record<string, unknown>): string {
  return [
    "chain",
    rootJobId,
    diagnostic.lastAssistantProviderID ?? "unknown_provider",
    diagnostic.lastAssistantModelID ?? "unknown_model",
    diagnostic.lastAssistantAgent ?? "unknown_agent",
    diagnostic.lastAssistantMode ?? "unknown_mode"
  ].join("|");
}

function createDiagnosticSignature(event: Record<string, unknown>, diagnostic: Record<string, unknown>): string {
  return [
    diagnostic.stallReason ?? "unknown_stall",
    diagnostic.softStallRescueSourceReason ?? "no_rescue_source",
    diagnostic.recoveryStallReason ?? "no_recovery_stall",
    diagnostic.lastAssistantProviderID ?? "unknown_provider",
    diagnostic.lastAssistantModelID ?? "unknown_model",
    diagnostic.lastAssistantAgent ?? "unknown_agent",
    diagnostic.lastAssistantMode ?? "unknown_mode",
    isBackendUnreachableEvent(event) ? (diagnostic.baseUrl ?? "unknown_base_url") : undefined
  ]
    .filter((part) => part !== undefined)
    .join("|");
}

function chooseSample(current: Record<string, unknown> | undefined, next: Record<string, unknown>): Record<string, unknown> {
  if (!current) {
    return next;
  }
  const currentScore = sampleSpecificityScore(current);
  const nextScore = sampleSpecificityScore(next);
  return nextScore >= currentScore ? next : current;
}

function sampleSpecificityScore(sample: Record<string, unknown>): number {
  let score = 0;
  if (sample.recoveryStallReason) {
    score += 4;
  }
  if (sample.stallReason === "read_tool_invalid_input") {
    score += 3;
  }
  if (sample.selectedAttemptJobId) {
    score += 2;
  }
  if (sample.attemptChainPresent === true) {
    score += 2;
  }
  if (sample.malformedReadToolParts) {
    score += 1;
  }
  return score;
}

function completedJobIds(latestStatusByJobId: Map<string, string>): string[] {
  return [...latestStatusByJobId.entries()]
    .filter(([, status]) => status === "completed")
    .map(([jobId]) => jobId)
    .sort();
}

function terminalJobIds(latestStatusByJobId: Map<string, string>): string[] {
  return [...latestStatusByJobId.entries()]
    .filter(([, status]) => isTerminalNonCompletedStatus(status))
    .map(([jobId]) => jobId)
    .sort();
}

function isTerminalNonCompletedStatus(status: string | undefined): boolean {
  return status === "failed" || status === "killed" || status === "timed_out";
}

async function collectLatestStatusByJobId(
  events: Record<string, unknown>[],
  stateDir: string,
  reconcileStatus?: (jobId: string, meta: Record<string, unknown>) => Promise<string | undefined>
): Promise<Map<string, string>> {
  const statuses = new Map<string, { status: string; timestamp: string }>();
  const eventJobIds = new Set<string>();
  for (const event of events) {
    if (typeof event.jobId !== "string") {
      continue;
    }
    eventJobIds.add(event.jobId);
    if (typeof event.status !== "string") {
      continue;
    }
    const timestamp = eventTime(event)?.toISOString() ?? "";
    const current = statuses.get(event.jobId);
    if (!current || timestamp >= current.timestamp) {
      statuses.set(event.jobId, { status: event.status, timestamp });
    }
  }
  for (const jobId of eventJobIds) {
    const meta = await readJobMeta(stateDir, jobId);
    if (!meta || typeof meta.status !== "string") {
      continue;
    }
    const reconciledStatus = await reconcileStatus?.(jobId, meta);
    const status = reconciledStatus ?? meta.status;
    if (typeof status !== "string") {
      continue;
    }
    const timestamp = typeof meta.updatedAt === "string" ? meta.updatedAt : "";
    const current = statuses.get(jobId);
    if (!current || status === "completed" || isTerminalNonCompletedStatus(status) || timestamp >= current.timestamp) {
      statuses.set(jobId, { status, timestamp });
    }
  }
  return new Map([...statuses].map(([jobId, value]) => [jobId, value.status]));
}

function collectLatestEventByJobId(events: Record<string, unknown>[]): Map<string, string> {
  const latest = new Map<string, { event: string; timestamp: string }>();
  for (const event of events) {
    if (typeof event.jobId !== "string" || typeof event.event !== "string") {
      continue;
    }
    const timestamp = eventTime(event)?.toISOString() ?? "";
    const current = latest.get(event.jobId);
    if (!current || timestamp >= current.timestamp) {
      latest.set(event.jobId, { event: event.event, timestamp });
    }
  }
  return new Map([...latest].map(([jobId, value]) => [jobId, value.event]));
}

function isNonTerminalSoftStallEvent(event: string | undefined): boolean {
  return (
    event === "opencode_job_soft_stall_deferred" ||
    event === "opencode_job_soft_stall_rescue_submitted" ||
    event === "opencode_job_soft_stall_rescue_pending"
  );
}

function createIssueTitle(event: Record<string, unknown>, diagnostic: Record<string, unknown>): string {
  if (isBackendUnreachableEvent(event)) {
    return "Investigate Retinue backend_unreachable for OpenCode server";
  }
  const reason = diagnostic.stallReason ?? "unknown_stall";
  const provider = diagnostic.lastAssistantProviderID ?? "unknown_provider";
  const model = diagnostic.lastAssistantModelID ?? "unknown_model";
  if (diagnostic.recoveryStallReason) {
    const source = diagnostic.softStallRescueSourceReason ?? "unknown_rescue_source";
    return `Investigate Retinue recovery ${String(diagnostic.recoveryStallReason)} after ${String(source)} on ${String(provider)}/${String(model)}`;
  }
  return `Investigate Retinue ${String(reason)} on ${String(provider)}/${String(model)}`;
}

function createAttentionTitle(diagnostic: Record<string, unknown>): string {
  const provider = diagnostic.lastAssistantProviderID ?? "unknown_provider";
  const model = diagnostic.lastAssistantModelID ?? "unknown_model";
  return `Resolve Retinue external_directory permission on ${String(provider)}/${String(model)}`;
}

function createAttentionDescription(diagnostic: Record<string, unknown>, jobMeta?: Record<string, unknown>): string {
  const parts = [
    "OpenCode is waiting for a supervising-agent permission decision.",
    typeof diagnostic.pendingPermissionCount === "number" ? `permissions=${diagnostic.pendingPermissionCount}` : undefined,
    diagnostic.sessionDirectory ? `cwd=${String(diagnostic.sessionDirectory)}` : undefined,
    diagnostic.lastAssistantAgent ? `agent=${String(diagnostic.lastAssistantAgent)}` : undefined,
    requestedAgentFromMeta(jobMeta) ? `requestedAgent=${requestedAgentFromMeta(jobMeta)}` : undefined,
    diagnostic.lastAssistantMode ? `mode=${String(diagnostic.lastAssistantMode)}` : undefined,
    typeof diagnostic.noCompletedAssistantDurationMs === "number" && Number.isFinite(diagnostic.noCompletedAssistantDurationMs)
      ? `durationMs=${diagnostic.noCompletedAssistantDurationMs}`
      : undefined,
    "Use list_permissions or the wait response permissions, then reply_permission."
  ].filter(Boolean);
  return parts.join("; ");
}

function createIssueDescription(event: Record<string, unknown>, diagnostic: Record<string, unknown>, jobMeta?: Record<string, unknown>): string {
  if (isBackendUnreachableEvent(event)) {
    const parts = [
      "OpenCode server became unreachable while Retinue job metadata was still active.",
      diagnostic.error ? `error=${String(diagnostic.error)}` : undefined,
      diagnostic.baseUrl ? `baseUrl=${String(diagnostic.baseUrl)}` : undefined,
      diagnostic.sessionId ? `sessionId=${String(diagnostic.sessionId)}` : undefined,
      diagnostic.sessionDirectory ? `cwd=${String(diagnostic.sessionDirectory)}` : undefined,
      requestedAgentFromMeta(jobMeta) ? `requestedAgent=${requestedAgentFromMeta(jobMeta)}` : undefined
    ].filter(Boolean);
    return parts.join("; ");
  }
  const parts = [
    diagnostic.stallSummary,
    diagnostic.softStallRescueSourceReason ? `rescueSource=${String(diagnostic.softStallRescueSourceReason)}` : undefined,
    diagnostic.recoveryStallReason ? `recovery=${String(diagnostic.recoveryStallReason)}` : undefined,
    diagnostic.sessionDirectory ? `cwd=${String(diagnostic.sessionDirectory)}` : undefined,
    diagnostic.lastAssistantAgent ? `agent=${String(diagnostic.lastAssistantAgent)}` : undefined,
    requestedAgentFromMeta(jobMeta) ? `requestedAgent=${requestedAgentFromMeta(jobMeta)}` : undefined,
    diagnostic.lastAssistantMode ? `mode=${String(diagnostic.lastAssistantMode)}` : undefined,
    typeof diagnostic.noCompletedAssistantDurationMs === "number" && Number.isFinite(diagnostic.noCompletedAssistantDurationMs)
      ? `durationMs=${diagnostic.noCompletedAssistantDurationMs}`
      : undefined
  ].filter(Boolean);
  return parts.join("; ");
}

function requestedAgentFromMeta(meta: Record<string, unknown> | undefined): string | undefined {
  return typeof meta?.agent === "string" && meta.agent.length > 0 ? meta.agent : undefined;
}

function eventTime(event: Record<string, unknown>): Date | undefined {
  const raw = typeof event.time === "string" ? event.time : typeof event.timestamp === "string" ? event.timestamp : undefined;
  if (!raw) {
    return undefined;
  }
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function earlier(left: string | undefined, right: string | undefined): string | undefined {
  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }
  return left < right ? left : right;
}

function later(left: string | undefined, right: string | undefined): string | undefined {
  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }
  return left > right ? left : right;
}

function earlierDate(left: Date | undefined, right: Date | undefined): Date | undefined {
  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }
  return left < right ? left : right;
}

function laterDate(left: Date | undefined, right: Date | undefined): Date | undefined {
  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }
  return left > right ? left : right;
}

function compact(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

function compactPermissionActions(value: unknown): Record<string, unknown>[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const actions = value.filter(isRecord).map((permission) => {
    const approval = isRecord(permission.approval) ? permission.approval : undefined;
    const scope = isRecord(approval?.scope) ? approval.scope : undefined;
    return compact({
      id: permission.id,
      permission: permission.permission,
      target: scope?.target,
      patterns: permission.patterns,
      toolCallID: permission.toolCallID,
      recommendedReply: approval?.recommendedReply,
      recommendedMessage: approval?.recommendedMessage,
      relation: scope?.relation
    });
  });
  return actions.length > 0 ? actions : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
