#!/usr/bin/env node
import { DEFAULT_LOG_AUDIT_MAX_BYTES, DEFAULT_LOG_AUDIT_MAX_LINES, auditRetinueLogs } from "../core/logAudit.js";
export async function main(args = process.argv.slice(2), env = process.env) {
    const options = parseArgs(args);
    const result = await auditRetinueLogs({
        stateDir: options.stateDir ?? env.RETINUE_STATE_DIR,
        tracePath: options.tracePath,
        since: options.since,
        maxBytes: options.maxBytes,
        maxLines: options.maxLines
    });
    process.stdout.write(options.compact ? renderCompactAuditResult(result) : `${JSON.stringify(result, null, 2)}\n`);
}
function parseArgs(args) {
    const options = {
        maxBytes: DEFAULT_LOG_AUDIT_MAX_BYTES,
        maxLines: DEFAULT_LOG_AUDIT_MAX_LINES
    };
    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        const next = () => {
            const value = args[index + 1];
            if (!value) {
                throw new Error(`${arg} requires a value`);
            }
            index += 1;
            return value;
        };
        if (arg === "--state-dir") {
            options.stateDir = next();
        }
        else if (arg === "--trace") {
            options.tracePath = next();
        }
        else if (arg === "--since") {
            const since = new Date(next());
            if (Number.isNaN(since.getTime())) {
                throw new Error("--since must be an ISO timestamp");
            }
            options.since = since;
        }
        else if (arg === "--max-lines") {
            options.maxLines = parsePositiveInt(next(), "--max-lines");
        }
        else if (arg === "--max-bytes") {
            options.maxBytes = parsePositiveInt(next(), "--max-bytes");
        }
        else if (arg === "--compact" || arg === "-c") {
            options.compact = true;
        }
        else if (arg === "--help" || arg === "-h") {
            process.stdout.write(helpText());
            process.exit(0);
        }
        else if (arg === "--") {
            continue;
        }
        else {
            throw new Error(`Unknown argument: ${arg}`);
        }
    }
    return options;
}
function parsePositiveInt(value, label) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`${label} must be a positive integer`);
    }
    return parsed;
}
function helpText() {
    return `Usage: retinue-audit-logs [options]\n\nOptions:\n  --state-dir <dir>    Retinue state directory. Defaults to RETINUE_STATE_DIR or ~/.local/state/retinue.\n  --trace <file>       Explicit Retinue trace JSONL path.\n  --since <iso>        Only include events at or after this timestamp.\n  --max-lines <n>      Maximum recent JSONL lines to inspect. Default: ${DEFAULT_LOG_AUDIT_MAX_LINES}.\n  --max-bytes <n>      Maximum bytes to read from the tail. Default: ${DEFAULT_LOG_AUDIT_MAX_BYTES}.\n  --compact, -c        Print compact agent-facing text instead of full JSON.\n`;
}
export function renderCompactAuditResult(result) {
    const lines = [
        `Retinue log audit: issues=${result.issueCount} scanned=${result.scannedEvents} ignoredCompleted=${result.ignoredCompletedJobIds.length}`,
        `trace=${result.tracePath}`
    ];
    if (result.since) {
        lines.push(`since=${result.since}`);
    }
    for (const [index, issue] of result.issues.entries()) {
        lines.push(renderCompactIssue(issue, index + 1));
    }
    return `${lines.join("\n")}\n`;
}
function renderCompactIssue(issue, index) {
    const sample = issue.sample ?? {};
    const summary = [
        `reason=${stringField(sample.stallReason)}`,
        stringField(sample.softStallRescueSourceReason) ? `source=${stringField(sample.softStallRescueSourceReason)}` : undefined,
        stringField(sample.recoveryStallReason) ? `recovery=${stringField(sample.recoveryStallReason)}` : undefined,
        `provider=${providerModel(issue)}`,
        stringField(sample.sessionDirectory) ? `cwd=${stringField(sample.sessionDirectory)}` : undefined,
        `agent=${agentMode(issue)}`,
        numericField(sample.noCompletedAssistantDurationMs) ? `durationMs=${numericField(sample.noCompletedAssistantDurationMs)}` : undefined,
        stringField(sample.selectedAttemptJobId) ? `selectedAttempt=${stringField(sample.selectedAttemptJobId)}` : undefined,
        sample.attemptChainPresent === true ? "attemptChain=true" : undefined,
        numericField(sample.malformedReadToolParts) ? `malformedRead=${numericField(sample.malformedReadToolParts)}` : undefined,
        numericField(sample.pendingPermissionCount) ? `permissions=${numericField(sample.pendingPermissionCount)}` : undefined,
        sample.readOnlyWriteIntent === true ? "readOnlyWriteIntent=true" : undefined
    ]
        .filter((part) => Boolean(part))
        .join(" ");
    return [
        `#${index} count=${issue.count} jobs=${issue.jobIds.join(",") || "none"}`,
        `  ${summary}`,
        `  title=${issue.title}`,
        `  diagnosis=${issue.description || "No diagnosis available."}`
    ].join("\n");
}
function providerModel(issue) {
    const parts = issue.signature.split("|");
    const offset = parts[0] === "chain" ? 2 : 3;
    return `${parts[offset] ?? "unknown_provider"}/${parts[offset + 1] ?? "unknown_model"}`;
}
function agentMode(issue) {
    const parts = issue.signature.split("|");
    const offset = parts[0] === "chain" ? 4 : 5;
    return `${parts[offset] ?? "unknown_agent"}/${parts[offset + 1] ?? "unknown_mode"}`;
}
function stringField(value) {
    return typeof value === "string" && value.length > 0 ? value : undefined;
}
function numericField(value) {
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}
if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) {
    main().catch((error) => {
        process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
        process.exitCode = 1;
    });
}
//# sourceMappingURL=auditRetinueLogs.js.map