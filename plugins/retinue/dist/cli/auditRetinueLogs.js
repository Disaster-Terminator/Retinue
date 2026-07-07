#!/usr/bin/env node
import { DEFAULT_LOG_AUDIT_MAX_BYTES, DEFAULT_LOG_AUDIT_MAX_LINES, DEFAULT_LOG_AUDIT_SINCE_MAX_BYTES, DEFAULT_LOG_AUDIT_SINCE_MAX_LINES, auditRetinueLogs } from "../core/logAudit.js";
export { renderCompactAuditResult } from "../core/logAuditCompact.js";
import { renderCompactAuditResult } from "../core/logAuditCompact.js";
import { OpenCodeBackend } from "../backends/opencode/backend.js";
import { OpenCodeClient } from "../backends/opencode/client.js";
import { normalizeOpenCodeBaseUrl } from "../backends/opencode/serverManager.js";
export async function main(args = process.argv.slice(2), env = process.env) {
    const options = parseArgs(args);
    const result = await auditRetinueLogs({
        stateDir: options.stateDir ?? env.RETINUE_STATE_DIR,
        tracePath: options.tracePath,
        since: options.since,
        maxBytes: options.maxBytes,
        maxLines: options.maxLines,
        includeTerminal: options.includeTerminal,
        reconcileStatus: options.liveReconcile === false ? undefined : createOpenCodeStatusReconciler(options.stateDir ?? env.RETINUE_STATE_DIR, env)
    });
    process.stdout.write(options.format === "json" ? `${JSON.stringify(result, null, 2)}\n` : renderCompactAuditResult(result));
}
function parseArgs(args) {
    const options = {};
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
            options.format = "compact";
        }
        else if (arg === "--json" || arg === "--full") {
            options.format = "json";
        }
        else if (arg === "--no-live-reconcile") {
            options.liveReconcile = false;
        }
        else if (arg === "--include-terminal") {
            options.includeTerminal = true;
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
    return `Usage: retinue-audit-logs [options]\n\nOptions:\n  --state-dir <dir>    Retinue state directory. Defaults to RETINUE_STATE_DIR or ~/.local/state/retinue.\n  --trace <file>       Explicit Retinue trace JSONL path.\n  --since <iso>        Only include events at or after this timestamp. Uses a larger default scan window.\n  --max-lines <n>      Maximum recent JSONL lines to inspect. Default: ${DEFAULT_LOG_AUDIT_MAX_LINES}; with --since: ${DEFAULT_LOG_AUDIT_SINCE_MAX_LINES}.\n  --max-bytes <n>      Maximum bytes to read from the tail. Default: ${DEFAULT_LOG_AUDIT_MAX_BYTES}; with --since: ${DEFAULT_LOG_AUDIT_SINCE_MAX_BYTES}.\n  --compact, -c        Print compact agent-facing text. This is the default.\n  --json, --full       Print the full JSON payload.\n  --include-terminal   Include latest failed, killed, and timed_out jobs. This is the default when --since is set.\n  --no-live-reconcile  Skip live OpenCode status reconciliation for stale stalled jobs.\n`;
}
function createOpenCodeStatusReconciler(stateDir, env) {
    const backendsByBaseUrl = new Map();
    return async (jobId, meta) => {
        if (meta.backend !== "opencode" && meta.backend !== "kilo") {
            return undefined;
        }
        if (meta.status === "completed" || typeof meta.externalServerUrl !== "string" || typeof meta.externalSessionId !== "string") {
            return undefined;
        }
        let baseUrl;
        try {
            baseUrl = normalizeOpenCodeBaseUrl(meta.externalServerUrl);
        }
        catch {
            return undefined;
        }
        const existing = backendsByBaseUrl.get(baseUrl);
        const backend = existing ??
            new OpenCodeBackend({
                kind: meta.backend,
                baseUrl,
                client: new OpenCodeClient(baseUrl),
                stateDir,
                env,
                onServerIdle: () => { }
            });
        if (!existing) {
            backendsByBaseUrl.set(baseUrl, backend);
        }
        try {
            const status = await backend.status({ jobId });
            return "status" in status ? status.status : undefined;
        }
        catch {
            return undefined;
        }
    };
}
if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) {
    main().catch((error) => {
        process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
        process.exitCode = 1;
    });
}
//# sourceMappingURL=auditRetinueLogs.js.map