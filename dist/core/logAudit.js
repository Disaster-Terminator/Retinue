import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
export const DEFAULT_LOG_AUDIT_MAX_BYTES = 1024 * 1024;
export const DEFAULT_LOG_AUDIT_MAX_LINES = 500;
export async function auditRetinueLogs(options = {}) {
    const stateDir = options.stateDir ?? path.join(os.homedir(), ".local/state/retinue");
    const tracePath = options.tracePath ?? path.join(stateDir, "logs", "retinue.jsonl");
    const events = await readRecentJsonl(tracePath, {
        maxBytes: options.maxBytes ?? DEFAULT_LOG_AUDIT_MAX_BYTES,
        maxLines: options.maxLines ?? DEFAULT_LOG_AUDIT_MAX_LINES,
        since: options.since
    });
    const latestStatusByJobId = await collectLatestStatusByJobId(events, stateDir, options.reconcileStatus);
    const latestEventByJobId = collectLatestEventByJobId(events);
    const attemptRootByJobId = await collectAttemptRoots(events, stateDir);
    const { issues, attentions } = summarizeIssues(events, latestStatusByJobId, latestEventByJobId, attemptRootByJobId);
    return {
        ok: true,
        tracePath,
        since: options.since?.toISOString(),
        scannedEvents: events.length,
        ignoredCompletedJobIds: completedJobIds(latestStatusByJobId),
        issueCount: issues.length,
        issues,
        attentionCount: attentions.length,
        attentions
    };
}
async function readRecentJsonl(filePath, options) {
    const text = await readTail(filePath, options.maxBytes);
    const lines = text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(-options.maxLines);
    const events = [];
    for (const line of lines) {
        try {
            const event = JSON.parse(line);
            if (!isRecord(event)) {
                continue;
            }
            const timestamp = eventTime(event);
            if (options.since && timestamp && timestamp < options.since) {
                continue;
            }
            events.push(event);
        }
        catch {
            // Ignore partial or malformed tail lines.
        }
    }
    return events;
}
async function readTail(filePath, maxBytes) {
    const handle = await fs.open(filePath, "r");
    try {
        const stats = await handle.stat();
        const length = Math.min(stats.size, maxBytes);
        const buffer = Buffer.alloc(length);
        await handle.read(buffer, 0, length, stats.size - length);
        return buffer.toString("utf8").replace(/^\uFFFD+/, "");
    }
    finally {
        await handle.close();
    }
}
function summarizeIssues(events, latestStatusByJobId, latestEventByJobId, attemptRootByJobId) {
    const issuesBySignature = new Map();
    const attentionsBySignature = new Map();
    for (const event of events) {
        const diagnostic = isRecord(event.diagnostic) ? event.diagnostic : undefined;
        if (!diagnostic) {
            continue;
        }
        if (typeof event.jobId === "string") {
            if (latestStatusByJobId.get(event.jobId) === "completed") {
                continue;
            }
            if (isNonTerminalSoftStallEvent(latestEventByJobId.get(event.jobId))) {
                continue;
            }
        }
        const status = event.event === "opencode_job_stalled" || typeof diagnostic.stallReason === "string" ? "stalled" : undefined;
        if (status !== "stalled") {
            continue;
        }
        const chainRootJobId = typeof event.jobId === "string" ? attemptRootByJobId.get(event.jobId) : undefined;
        if (chainRootJobId && latestStatusByJobId.get(chainRootJobId) === "completed") {
            continue;
        }
        const chainSignature = chainRootJobId ? createChainSignature(chainRootJobId, diagnostic) : undefined;
        const signature = chainSignature ?? createDiagnosticSignature(diagnostic);
        const attention = isAttentionDiagnostic(diagnostic);
        const summaries = attention ? attentionsBySignature : issuesBySignature;
        const current = summaries.get(signature) ?? {
            signature,
            ...(attention ? { kind: "permission" } : {}),
            title: attention ? createAttentionTitle(diagnostic) : createIssueTitle(diagnostic),
            description: attention ? createAttentionDescription(diagnostic) : createIssueDescription(diagnostic),
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
            readOnlyWriteIntent: diagnostic.readOnlyWriteIntent
        });
        const selectedSample = chooseSample(current.sample, nextSample);
        if (selectedSample === nextSample) {
            current.title = attention ? createAttentionTitle(diagnostic) : createIssueTitle(diagnostic);
            current.description = attention ? createAttentionDescription(diagnostic) : createIssueDescription(diagnostic);
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
async function readJobMeta(stateDir, jobId) {
    try {
        const text = await fs.readFile(path.join(stateDir, "jobs", jobId, "meta.json"), "utf8");
        const parsed = JSON.parse(text);
        return isRecord(parsed) ? parsed : undefined;
    }
    catch {
        return undefined;
    }
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
function createDiagnosticSignature(diagnostic) {
    return [
        diagnostic.stallReason ?? "unknown_stall",
        diagnostic.softStallRescueSourceReason ?? "no_rescue_source",
        diagnostic.recoveryStallReason ?? "no_recovery_stall",
        diagnostic.lastAssistantProviderID ?? "unknown_provider",
        diagnostic.lastAssistantModelID ?? "unknown_model",
        diagnostic.lastAssistantAgent ?? "unknown_agent",
        diagnostic.lastAssistantMode ?? "unknown_mode"
    ].join("|");
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
function completedJobIds(latestStatusByJobId) {
    return [...latestStatusByJobId.entries()]
        .filter(([, status]) => status === "completed")
        .map(([jobId]) => jobId)
        .sort();
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
        if (!current || status === "completed" || timestamp >= current.timestamp) {
            statuses.set(jobId, { status, timestamp });
        }
    }
    return new Map([...statuses].map(([jobId, value]) => [jobId, value.status]));
}
function collectLatestEventByJobId(events) {
    const latest = new Map();
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
function isNonTerminalSoftStallEvent(event) {
    return (event === "opencode_job_soft_stall_deferred" ||
        event === "opencode_job_soft_stall_rescue_submitted" ||
        event === "opencode_job_soft_stall_rescue_pending");
}
function createIssueTitle(diagnostic) {
    const reason = diagnostic.stallReason ?? "unknown_stall";
    const provider = diagnostic.lastAssistantProviderID ?? "unknown_provider";
    const model = diagnostic.lastAssistantModelID ?? "unknown_model";
    if (diagnostic.recoveryStallReason) {
        const source = diagnostic.softStallRescueSourceReason ?? "unknown_rescue_source";
        return `Investigate Retinue recovery ${String(diagnostic.recoveryStallReason)} after ${String(source)} on ${String(provider)}/${String(model)}`;
    }
    return `Investigate Retinue ${String(reason)} on ${String(provider)}/${String(model)}`;
}
function createAttentionTitle(diagnostic) {
    const provider = diagnostic.lastAssistantProviderID ?? "unknown_provider";
    const model = diagnostic.lastAssistantModelID ?? "unknown_model";
    return `Resolve Retinue external_directory permission on ${String(provider)}/${String(model)}`;
}
function createAttentionDescription(diagnostic) {
    const parts = [
        "OpenCode is waiting for a supervising-agent permission decision.",
        typeof diagnostic.pendingPermissionCount === "number" ? `permissions=${diagnostic.pendingPermissionCount}` : undefined,
        diagnostic.sessionDirectory ? `cwd=${String(diagnostic.sessionDirectory)}` : undefined,
        diagnostic.lastAssistantAgent ? `agent=${String(diagnostic.lastAssistantAgent)}` : undefined,
        diagnostic.lastAssistantMode ? `mode=${String(diagnostic.lastAssistantMode)}` : undefined,
        typeof diagnostic.noCompletedAssistantDurationMs === "number" && Number.isFinite(diagnostic.noCompletedAssistantDurationMs)
            ? `durationMs=${diagnostic.noCompletedAssistantDurationMs}`
            : undefined,
        "Use retinue_list_permissions or the wait response permissions, then retinue_reply_permission."
    ].filter(Boolean);
    return parts.join("; ");
}
function createIssueDescription(diagnostic) {
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