import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getJobPaths } from "./paths.js";
export const DEFAULT_LOG_AUDIT_MAX_BYTES = 64 * 1024 * 1024;
export const DEFAULT_LOG_AUDIT_MAX_LINES = 50_000;
export const DEFAULT_LOG_AUDIT_SINCE_MAX_BYTES = 256 * 1024 * 1024;
export const DEFAULT_LOG_AUDIT_SINCE_MAX_LINES = 200_000;
export const MAX_LOG_AUDIT_BYTES = DEFAULT_LOG_AUDIT_SINCE_MAX_BYTES;
export const MAX_LOG_AUDIT_LINES = DEFAULT_LOG_AUDIT_SINCE_MAX_LINES;
export async function auditRetinueLogs(options = {}) {
    const stateDir = options.stateDir ?? path.join(os.homedir(), ".local/state/retinue");
    const tracePath = options.tracePath ?? path.join(stateDir, "logs", "retinue.jsonl");
    const effectiveMaxBytes = clampPositiveInt(options.maxBytes ?? (options.since ? DEFAULT_LOG_AUDIT_SINCE_MAX_BYTES : DEFAULT_LOG_AUDIT_MAX_BYTES), MAX_LOG_AUDIT_BYTES);
    const effectiveMaxLines = clampPositiveInt(options.maxLines ?? (options.since ? DEFAULT_LOG_AUDIT_SINCE_MAX_LINES : DEFAULT_LOG_AUDIT_MAX_LINES), MAX_LOG_AUDIT_LINES);
    const input = await readRecentJsonl(tracePath, {
        maxBytes: effectiveMaxBytes,
        maxLines: effectiveMaxLines,
        since: options.since
    });
    const events = input.events;
    const jobMetaByJobId = await collectJobMetaByJobId(events, stateDir);
    const latestStatusByJobId = await collectLatestStatusByJobId(events, stateDir, options.reconcileStatus);
    const attemptRootByJobId = await collectAttemptRoots(events, stateDir);
    const { issues, attentions } = summarizeIssues(events, latestStatusByJobId, attemptRootByJobId, jobMetaByJobId, {
        includeTerminal: options.includeTerminal === true || options.since !== undefined
    });
    return {
        ok: true,
        tracePath,
        since: options.since?.toISOString(),
        effectiveMaxBytes,
        effectiveMaxLines,
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
async function readRecentJsonl(filePath, options) {
    const tail = await readTail(filePath, options.maxBytes);
    const allLines = tail.text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
    const lineTruncated = allLines.length > options.maxLines;
    const lines = allLines.slice(-options.maxLines);
    const events = [];
    let oldestScannedEvent;
    let newestScannedEvent;
    for (const line of lines) {
        try {
            const event = JSON.parse(line);
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
        }
        catch {
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
async function readTail(filePath, maxBytes) {
    let handle;
    try {
        handle = await fs.open(filePath, "r");
    }
    catch (error) {
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
    }
    finally {
        await handle.close();
    }
}
function clampPositiveInt(value, max) {
    if (!Number.isFinite(value) || value <= 0) {
        return max;
    }
    return Math.min(max, Math.max(1, Math.floor(value)));
}
function isMissingFile(error) {
    return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
function summarizeIssues(events, latestStatusByJobId, attemptRootByJobId, jobMetaByJobId, options = {}) {
    const issuesBySignature = new Map();
    const attentionsBySignature = new Map();
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
            ...(attention ? { kind: "permission" } : {}),
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
function sortSummaries(summaries) {
    return summaries.sort((left, right) => right.count - left.count || String(right.lastSeen).localeCompare(String(left.lastSeen)));
}
function isAttentionDiagnostic(diagnostic) {
    return (diagnostic.stallReason === "external_directory_permission_pending" &&
        typeof diagnostic.pendingPermissionCount === "number" &&
        diagnostic.pendingPermissionCount > 0);
}
function issueStatusForEvent(event, diagnostic) {
    if (isBackendUnreachableEvent(event)) {
        return "backend_unreachable";
    }
    if (event.event === "opencode_job_stalled" || typeof diagnostic.stallReason === "string") {
        return "stalled";
    }
    return undefined;
}
function isBackendUnreachableEvent(event) {
    return event.event === "opencode_job_backend_unreachable" || (event.event !== "opencode_job_stalled" && event.status === "backend_unreachable");
}
async function collectAttemptRoots(events, stateDir) {
    const attemptRootByJobId = new Map();
    const eventJobIds = new Set();
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
function collectLatestStatusByChainRootJobId(latestStatusByJobId, attemptRootByJobId) {
    const statuses = new Map();
    for (const [jobId, status] of latestStatusByJobId) {
        const rootJobId = attemptRootByJobId.get(jobId);
        if (!rootJobId) {
            continue;
        }
        const current = statuses.get(rootJobId);
        if (status === "completed" || (current !== "completed" && isTerminalNonCompletedStatus(status))) {
            statuses.set(rootJobId, status);
        }
        else if (!current) {
            statuses.set(rootJobId, status);
        }
    }
    return statuses;
}
async function readJobMeta(stateDir, jobId) {
    try {
        const text = await fs.readFile(getJobPaths(stateDir, jobId).meta, "utf8");
        const parsed = JSON.parse(text);
        return isRecord(parsed) ? parsed : undefined;
    }
    catch {
        return undefined;
    }
}
async function collectJobMetaByJobId(events, stateDir) {
    const metas = new Map();
    const jobIds = new Set();
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
function createChainSignature(rootJobId, diagnostic) {
    return [
        "chain",
        rootJobId,
        diagnostic.lastAssistantProviderID ?? "unknown_provider",
        diagnostic.lastAssistantModelID ?? "unknown_model",
        diagnostic.lastAssistantAgent ?? "unknown_agent",
        diagnostic.lastAssistantMode ?? "unknown_mode"
    ].join("|");
}
function createDiagnosticSignature(event, diagnostic) {
    return [
        diagnostic.stallReason ?? "unknown_stall",
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
function chooseSample(current, next) {
    if (!current) {
        return next;
    }
    const currentScore = sampleSpecificityScore(current);
    const nextScore = sampleSpecificityScore(next);
    return nextScore >= currentScore ? next : current;
}
function sampleSpecificityScore(sample) {
    let score = 0;
    if (sample.recoveryStallReason) {
        score += 4;
    }
    if (sample.stallReason === "read_tool_invalid_input" || sample.stallReason === "tool_invalid_input") {
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
function completedJobIds(latestStatusByJobId) {
    return [...latestStatusByJobId.entries()]
        .filter(([, status]) => status === "completed")
        .map(([jobId]) => jobId)
        .sort();
}
function terminalJobIds(latestStatusByJobId) {
    return [...latestStatusByJobId.entries()]
        .filter(([, status]) => isTerminalNonCompletedStatus(status))
        .map(([jobId]) => jobId)
        .sort();
}
function isTerminalNonCompletedStatus(status) {
    return status === "failed" || status === "killed" || status === "timed_out";
}
async function collectLatestStatusByJobId(events, stateDir, reconcileStatus) {
    const statuses = new Map();
    const eventJobIds = new Set();
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
function createIssueTitle(event, diagnostic) {
    if (isBackendUnreachableEvent(event)) {
        return "Investigate Retinue backend_unreachable for OpenCode server";
    }
    const reason = diagnostic.stallReason ?? "unknown_stall";
    const provider = diagnostic.lastAssistantProviderID ?? "unknown_provider";
    const model = diagnostic.lastAssistantModelID ?? "unknown_model";
    if (diagnostic.recoveryStallReason) {
        return `Investigate Retinue recovery ${String(diagnostic.recoveryStallReason)} on ${String(provider)}/${String(model)}`;
    }
    return `Investigate Retinue ${String(reason)} on ${String(provider)}/${String(model)}`;
}
function createAttentionTitle(diagnostic) {
    const provider = diagnostic.lastAssistantProviderID ?? "unknown_provider";
    const model = diagnostic.lastAssistantModelID ?? "unknown_model";
    return `Resolve Retinue external_directory permission on ${String(provider)}/${String(model)}`;
}
function createAttentionDescription(diagnostic, jobMeta) {
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
function createIssueDescription(event, diagnostic, jobMeta) {
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
function requestedAgentFromMeta(meta) {
    return typeof meta?.agent === "string" && meta.agent.length > 0 ? meta.agent : undefined;
}
function eventTime(event) {
    const raw = typeof event.time === "string" ? event.time : typeof event.timestamp === "string" ? event.timestamp : undefined;
    if (!raw) {
        return undefined;
    }
    const parsed = new Date(raw);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}
function earlier(left, right) {
    if (!left) {
        return right;
    }
    if (!right) {
        return left;
    }
    return left < right ? left : right;
}
function later(left, right) {
    if (!left) {
        return right;
    }
    if (!right) {
        return left;
    }
    return left > right ? left : right;
}
function earlierDate(left, right) {
    if (!left) {
        return right;
    }
    if (!right) {
        return left;
    }
    return left < right ? left : right;
}
function laterDate(left, right) {
    if (!left) {
        return right;
    }
    if (!right) {
        return left;
    }
    return left > right ? left : right;
}
function compact(record) {
    return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}
function compactPermissionActions(value) {
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
function isRecord(value) {
    return typeof value === "object" && value !== null;
}
//# sourceMappingURL=logAudit.js.map