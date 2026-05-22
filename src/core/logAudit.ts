import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const DEFAULT_LOG_AUDIT_MAX_BYTES = 1024 * 1024;
export const DEFAULT_LOG_AUDIT_MAX_LINES = 500;

export interface AuditRetinueLogsOptions {
  stateDir?: string;
  tracePath?: string;
  since?: Date;
  maxBytes?: number;
  maxLines?: number;
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

export interface RetinueLogAuditResult {
  ok: true;
  tracePath: string;
  since?: string;
  scannedEvents: number;
  ignoredCompletedJobIds: string[];
  issueCount: number;
  issues: RetinueLogAuditIssue[];
}

export async function auditRetinueLogs(options: AuditRetinueLogsOptions = {}): Promise<RetinueLogAuditResult> {
  const stateDir = options.stateDir ?? path.join(os.homedir(), ".local/state/retinue");
  const tracePath = options.tracePath ?? path.join(stateDir, "logs", "retinue.jsonl");
  const events = await readRecentJsonl(tracePath, {
    maxBytes: options.maxBytes ?? DEFAULT_LOG_AUDIT_MAX_BYTES,
    maxLines: options.maxLines ?? DEFAULT_LOG_AUDIT_MAX_LINES,
    since: options.since
  });
  const latestStatusByJobId = collectLatestStatusByJobId(events);
  const issues = summarizeIssues(events, latestStatusByJobId);
  return {
    ok: true,
    tracePath,
    since: options.since?.toISOString(),
    scannedEvents: events.length,
    ignoredCompletedJobIds: completedJobIds(latestStatusByJobId),
    issueCount: issues.length,
    issues
  };
}

interface ReadRecentJsonlOptions {
  maxBytes: number;
  maxLines: number;
  since?: Date;
}

async function readRecentJsonl(filePath: string, options: ReadRecentJsonlOptions): Promise<Record<string, unknown>[]> {
  const text = await readTail(filePath, options.maxBytes);
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-options.maxLines);
  const events: Record<string, unknown>[] = [];
  for (const line of lines) {
    try {
      const event = JSON.parse(line) as unknown;
      if (!isRecord(event)) {
        continue;
      }
      const timestamp = eventTime(event);
      if (options.since && timestamp && timestamp < options.since) {
        continue;
      }
      events.push(event);
    } catch {
      // Ignore partial or malformed tail lines.
    }
  }
  return events;
}

async function readTail(filePath: string, maxBytes: number): Promise<string> {
  const handle = await fs.open(filePath, "r");
  try {
    const stats = await handle.stat();
    const length = Math.min(stats.size, maxBytes);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, stats.size - length);
    return buffer.toString("utf8").replace(/^\uFFFD+/, "");
  } finally {
    await handle.close();
  }
}

function summarizeIssues(events: Record<string, unknown>[], latestStatusByJobId: Map<string, string>): RetinueLogAuditIssue[] {
  const issuesBySignature = new Map<string, RetinueLogAuditIssue>();
  for (const event of events) {
    const diagnostic = isRecord(event.diagnostic) ? event.diagnostic : undefined;
    if (!diagnostic) {
      continue;
    }
    if (typeof event.jobId === "string" && latestStatusByJobId.get(event.jobId) === "completed") {
      continue;
    }
    const status = event.event === "opencode_job_stalled" || typeof diagnostic.stallReason === "string" ? "stalled" : undefined;
    if (status !== "stalled") {
      continue;
    }
    const signature = [
      diagnostic.stallReason ?? "unknown_stall",
      diagnostic.softStallRescueSourceReason ?? "no_rescue_source",
      diagnostic.recoveryStallReason ?? "no_recovery_stall",
      diagnostic.lastAssistantProviderID ?? "unknown_provider",
      diagnostic.lastAssistantModelID ?? "unknown_model",
      diagnostic.lastAssistantAgent ?? "unknown_agent",
      diagnostic.lastAssistantMode ?? "unknown_mode"
    ].join("|");
    const current = issuesBySignature.get(signature) ?? {
      signature,
      title: createIssueTitle(diagnostic),
      description: createIssueDescription(diagnostic),
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
    current.sample ??= compact({
      jobId: event.jobId,
      event: event.event,
      sessionId: diagnostic.sessionId,
      parentSessionId: diagnostic.parentSessionId,
      childSessionIds: diagnostic.childSessionIds,
      sessionDirectory: diagnostic.sessionDirectory,
      stallReason: diagnostic.stallReason,
      stallSummary: diagnostic.stallSummary,
      softStallRescueSourceReason: diagnostic.softStallRescueSourceReason,
      softStallRescueSourceSummary: diagnostic.softStallRescueSourceSummary,
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
      readOnlyWriteIntent: diagnostic.readOnlyWriteIntent
    });
    issuesBySignature.set(signature, current);
  }
  return [...issuesBySignature.values()].sort(
    (left, right) => right.count - left.count || String(right.lastSeen).localeCompare(String(left.lastSeen))
  );
}

function completedJobIds(latestStatusByJobId: Map<string, string>): string[] {
  return [...latestStatusByJobId.entries()]
    .filter(([, status]) => status === "completed")
    .map(([jobId]) => jobId)
    .sort();
}

function collectLatestStatusByJobId(events: Record<string, unknown>[]): Map<string, string> {
  const statuses = new Map<string, { status: string; timestamp: string }>();
  for (const event of events) {
    if (typeof event.jobId !== "string" || typeof event.status !== "string") {
      continue;
    }
    const timestamp = eventTime(event)?.toISOString() ?? "";
    const current = statuses.get(event.jobId);
    if (!current || timestamp >= current.timestamp) {
      statuses.set(event.jobId, { status: event.status, timestamp });
    }
  }
  return new Map([...statuses].map(([jobId, value]) => [jobId, value.status]));
}

function createIssueTitle(diagnostic: Record<string, unknown>): string {
  const reason = diagnostic.stallReason ?? "unknown_stall";
  const provider = diagnostic.lastAssistantProviderID ?? "unknown_provider";
  const model = diagnostic.lastAssistantModelID ?? "unknown_model";
  if (diagnostic.recoveryStallReason) {
    const source = diagnostic.softStallRescueSourceReason ?? "unknown_rescue_source";
    return `Investigate Retinue recovery ${String(diagnostic.recoveryStallReason)} after ${String(source)} on ${String(provider)}/${String(model)}`;
  }
  return `Investigate Retinue ${String(reason)} on ${String(provider)}/${String(model)}`;
}

function createIssueDescription(diagnostic: Record<string, unknown>): string {
  const parts = [
    diagnostic.stallSummary,
    diagnostic.softStallRescueSourceReason ? `rescueSource=${String(diagnostic.softStallRescueSourceReason)}` : undefined,
    diagnostic.recoveryStallReason ? `recovery=${String(diagnostic.recoveryStallReason)}` : undefined,
    diagnostic.sessionDirectory ? `cwd=${String(diagnostic.sessionDirectory)}` : undefined,
    diagnostic.lastAssistantAgent ? `agent=${String(diagnostic.lastAssistantAgent)}` : undefined,
    diagnostic.lastAssistantMode ? `mode=${String(diagnostic.lastAssistantMode)}` : undefined,
    typeof diagnostic.noCompletedAssistantDurationMs === "number" && Number.isFinite(diagnostic.noCompletedAssistantDurationMs)
      ? `durationMs=${diagnostic.noCompletedAssistantDurationMs}`
      : undefined
  ].filter(Boolean);
  return parts.join("; ");
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

function compact(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
