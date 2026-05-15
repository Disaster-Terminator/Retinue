import fs from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { resolveHttpTimeoutMs } from "../../core/http.js";
import { getJobPaths, getRetinueTracePath, resolveStateDir } from "../../core/paths.js";
import { isCleanupSafeStatus } from "../../core/status.js";
import { OpenCodeClient, OpenCodeClientError } from "./client.js";
import { scheduleManagedOpenCodeServerIdleShutdown } from "./serverManager.js";
const OPENCODE_READ_ONLY_TOOLS = {
    bash: false,
    edit: false,
    write: false,
    apply_patch: false,
    task: false
};
const OPENCODE_READ_ONLY_PROMPT_CONTRACT = [
    "Retinue read-only child agent contract:",
    "- Use only OpenCode read, grep, and glob tools plus plain-text reasoning.",
    "- Do not call bash, edit, write, apply_patch, task, or nested agents.",
    "- Do not attempt shell commands, file writes, patches, or interactive approvals.",
    "- For broad audits, start with grep/glob and read only a small set of targeted files; avoid bulk-reading large generated, cache, log, or backup directories.",
    "- Use read serially: do not issue multiple read calls in one assistant turn, and stop reading once you have enough evidence to answer.",
    "- If the task needs shell or write access, say that the read-only boundary prevents that part and provide the best file-based answer you can.",
    "- Always finish with a concise textual result; do not stop after tool calls without a final answer."
].join("\n");
const OPENCODE_READ_ONLY_PERMISSION = [
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
    { permission: "task", pattern: "*", action: "deny" },
    { permission: "external_directory", pattern: "*", action: "deny" },
    { permission: "doom_loop", pattern: "*", action: "deny" },
    { permission: "bash", pattern: "*", action: "deny" },
    { permission: "bash", pattern: "pwd", action: "allow" },
    { permission: "bash", pattern: "ls *", action: "allow" },
    { permission: "bash", pattern: "dir *", action: "allow" },
    { permission: "bash", pattern: "git status*", action: "allow" },
    { permission: "bash", pattern: "git show*", action: "allow" },
    { permission: "bash", pattern: "git diff*", action: "allow" },
    { permission: "bash", pattern: "git log*", action: "allow" },
    { permission: "bash", pattern: "git grep*", action: "allow" },
    { permission: "bash", pattern: "git blame*", action: "allow" },
    { permission: "bash", pattern: "git branch*", action: "allow" },
    { permission: "bash", pattern: "git rev-parse*", action: "allow" },
    { permission: "bash", pattern: "git ls-files*", action: "allow" },
    { permission: "bash", pattern: "git describe*", action: "allow" },
    { permission: "bash", pattern: "git cat-file*", action: "allow" },
    { permission: "bash", pattern: "git merge-base*", action: "allow" }
];
const DEFAULT_WAIT_TIMEOUT_MS = 30_000;
const DEFAULT_WAIT_POLL_MS = 250;
const DEFAULT_STALL_MS = 10 * 60_000;
const DEFAULT_INCOMPLETE_ASSISTANT_STALL_MS = DEFAULT_STALL_MS;
const DEFAULT_SERVER_IDLE_MS = 30_000;
const DEFAULT_BLANK_ASSISTANT_STALL_MS = DEFAULT_STALL_MS;
const DEFAULT_ZERO_PROGRESS_ASSISTANT_STALL_MS = DEFAULT_STALL_MS;
const DEFAULT_READ_TOOL_STALL_MS = 90_000;
const DEFAULT_STALL_TOOL_CALL_ROUNDS = 6;
const DEFAULT_STALL_EMPTY_ASSISTANT_ROUNDS = 2;
const DIAGNOSTIC_VALUE_PREVIEW_BYTES = 1000;
export class OpenCodeBackend {
    kind = "opencode";
    client;
    baseUrl;
    resolveTarget;
    stateDir;
    env;
    httpTimeoutMs;
    onServerIdle;
    constructor(options) {
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
                ((baseUrl, cwd) => scheduleManagedOpenCodeServerIdleShutdown(baseUrl, {
                    stateDir: this.stateDir,
                    cwd,
                    delayMs: resolveServerIdleMs(this.env)
                }));
    }
    async run(options) {
        const jobId = `job_${randomUUID()}`;
        const paths = getJobPaths(this.stateDir, jobId);
        await fs.mkdir(paths.dir, { recursive: true });
        await fs.writeFile(paths.prompt, options.prompt, "utf8");
        const target = await this.resolveTarget(options.cwd);
        const session = await target.client.createSession({
            cwd: options.cwd,
            title: options.title ?? options.name,
            permission: options.readOnly === true ? OPENCODE_READ_ONLY_PERMISSION : undefined
        });
        const baseline = await this.captureMessageBaseline(target.client, session.id);
        const now = new Date().toISOString();
        const meta = {
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
            externalSessionId: session.id,
            externalServerUrl: target.baseUrl,
            externalSessionDirectory: session.directory ?? session.cwd,
            externalMessageBaselineCount: baseline.messageCount,
            externalCompletedAssistantBaselineCount: baseline.completedAssistantCount,
            args: [],
            createdAt: now,
            updatedAt: now
        };
        await writeJsonAtomic(paths.meta, meta);
        const submitted = this.submitPromptAsync(target.client, session.id, meta, options);
        await Promise.race([submitted, sleep(50)]);
        return this.readCurrentMetaOrFallback(jobId, meta);
    }
    async continueJob(options) {
        if (!options.externalSessionId) {
            return this.run(options);
        }
        const jobId = `job_${randomUUID()}`;
        const paths = getJobPaths(this.stateDir, jobId);
        await fs.mkdir(paths.dir, { recursive: true });
        await fs.writeFile(paths.prompt, options.prompt, "utf8");
        const target = await this.targetForContinue(options);
        const baseline = await this.captureMessageBaseline(target.client, options.externalSessionId);
        const now = new Date().toISOString();
        const meta = {
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
            externalSessionId: options.externalSessionId,
            externalServerUrl: target.baseUrl,
            externalSessionDirectory: options.cwd,
            externalMessageBaselineCount: baseline.messageCount,
            externalCompletedAssistantBaselineCount: baseline.completedAssistantCount,
            parentJobId: options.parentJobId,
            parentSessionId: options.parentSessionId,
            args: [],
            createdAt: now,
            updatedAt: now
        };
        await writeJsonAtomic(paths.meta, meta);
        const submitted = this.submitPromptAsync(target.client, options.externalSessionId, meta, options);
        await Promise.race([submitted, sleep(50)]);
        return this.readCurrentMetaOrFallback(jobId, meta);
    }
    async status(handle) {
        const meta = await this.readMeta(handle.jobId);
        if (isProblem(meta)) {
            return meta;
        }
        return this.reconcileStatus(meta);
    }
    async result(handle) {
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
    async abort(handle) {
        const meta = await this.readMeta(handle.jobId);
        if (isProblem(meta) || !meta.externalSessionId) {
            return;
        }
        await this.clientForMeta(meta).abort(meta.externalSessionId);
        const updated = {
            ...meta,
            status: "killed",
            updatedAt: new Date().toISOString()
        };
        await writeJsonAtomic(getJobPaths(this.stateDir, handle.jobId).meta, updated);
        await this.maybeScheduleServerIdleShutdown(updated);
    }
    async wait(handle, timeoutMs = DEFAULT_WAIT_TIMEOUT_MS) {
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
    async cleanup(options = {}) {
        const olderThanMs = options.olderThanMs ?? 0;
        const removedJobIds = [];
        const removedTempFiles = [];
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
    async readMeta(jobId) {
        try {
            return JSON.parse(await fs.readFile(getJobPaths(this.stateDir, jobId).meta, "utf8"));
        }
        catch (error) {
            if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
                return { jobId, status: "not_found" };
            }
            return { jobId, status: "corrupted", error: error instanceof Error ? error.message : String(error) };
        }
    }
    async readCurrentMetaOrFallback(jobId, fallback) {
        const current = await this.readMeta(jobId);
        return isProblem(current) ? fallback : current;
    }
    async reconcileStatus(meta) {
        if (!meta.externalSessionId || (isTerminal(meta.status) && meta.status !== "stalled" && meta.status !== "killed")) {
            return meta;
        }
        try {
            const client = this.clientForMeta(meta);
            const session = await client.getSession(meta.externalSessionId);
            let status = meta.status;
            if (session.state === "completed") {
                status = "completed";
            }
            else if (session.state === "failed") {
                status = "failed";
            }
            else if (await this.hasNewCompletedAssistantMessage(client, meta.externalSessionId, meta)) {
                status = "completed";
            }
            else if (session.aborted === true) {
                status = "killed";
            }
            else if (meta.status === "stalled") {
                status = "stalled";
            }
            else if (await this.isStalledOpenCodeJob(client, meta.externalSessionId, meta)) {
                status = "stalled";
            }
            else {
                status = "running";
            }
            if (status === meta.status) {
                return meta;
            }
            const updated = { ...meta, status, updatedAt: new Date().toISOString() };
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
            if (isTerminal(status)) {
                await this.maybeScheduleServerIdleShutdown(updated);
            }
            return updated;
        }
        catch (error) {
            if (error instanceof OpenCodeClientError && error.status === 404) {
                return { jobId: meta.jobId, status: "not_found", error: "OpenCode session not found" };
            }
            return { jobId: meta.jobId, status: "corrupted", error: error instanceof Error ? error.message : String(error) };
        }
    }
    async captureMessageBaseline(client, sessionId) {
        const messages = await client.messages(sessionId);
        return {
            messageCount: messages.length,
            completedAssistantCount: countCompletedAssistantMessages(messages)
        };
    }
    async hasNewCompletedAssistantMessage(client, sessionId, meta) {
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
    async isStalledOpenCodeJob(client, sessionId, meta) {
        const messages = await client.messages(sessionId);
        const jobMessages = selectMessagesForMeta(messages, meta);
        const stall = computeStallDiagnostic(jobMessages, meta, this.env);
        return stall !== undefined;
    }
    async inspectJob(meta) {
        const diagnostic = {
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
            diagnostic.readOnlyPatchPartCount = meta.readOnly === true ? diagnostic.patchPartCount : 0;
            diagnostic.readOnlyWriteIntent = (diagnostic.readOnlyPatchPartCount ?? 0) > 0;
            diagnostic.messageSummaries = jobMessages.map((message) => ({
                role: message.info?.role,
                finish: stringInfo(message, "finish"),
                partTypes: message.parts?.map((part) => part.type ?? "unknown") ?? [],
                partSummaries: summarizeMessageParts(message),
                textBytes: Buffer.byteLength(extractMessageText(message), "utf8"),
                completed: isCompletedAssistantMessage(message),
                messageError: diagnosticValuePreview(message.info?.error)
            }));
            Object.assign(diagnostic, computeStallDiagnostic(jobMessages, meta, this.env));
        }
        catch (error) {
            diagnostic.error = error instanceof Error ? error.message : String(error);
        }
        return diagnostic;
    }
    async maybeScheduleServerIdleShutdown(meta) {
        if (!meta.externalServerUrl) {
            return;
        }
        if (await this.hasRunningJobsForServer(meta.externalServerUrl)) {
            return;
        }
        this.onServerIdle(meta.externalServerUrl, meta.cwd);
    }
    async hasRunningJobsForServer(baseUrl) {
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
    async writeJobTrace(event, meta, diagnostic, extra = {}) {
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
    async submitPromptAsync(client, sessionId, meta, options) {
        try {
            await client.promptAsync(sessionId, {
                prompt: buildOpenCodePrompt(options.prompt, options.readOnly === true),
                model: options.model,
                agent: options.agent,
                tools: options.readOnly === true ? OPENCODE_READ_ONLY_TOOLS : undefined
            });
            await this.writeJobTrace("opencode_job_prompt_submitted", meta, await this.inspectJob(meta));
        }
        catch (error) {
            const failed = { ...meta, status: "failed", updatedAt: new Date().toISOString() };
            await writeJsonAtomic(getJobPaths(this.stateDir, meta.jobId).meta, failed);
            await appendJobDiagnostic(this.stateDir, meta.jobId, {
                event: "opencode_job_prompt_failed",
                error: error instanceof Error ? error.message : String(error)
            });
            await this.writeJobTrace("opencode_job_prompt_failed", failed, await this.inspectJob(failed));
            await this.maybeScheduleServerIdleShutdown(failed);
        }
    }
    clientForMeta(meta) {
        const baseUrl = meta.externalServerUrl?.replace(/\/+$/, "");
        if (baseUrl && baseUrl !== this.baseUrl) {
            return new OpenCodeClient(baseUrl, { timeoutMs: this.httpTimeoutMs });
        }
        if (!this.client) {
            throw new Error("OpenCode backend client is not configured");
        }
        return this.client;
    }
    async targetForContinue(options) {
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
async function appendJobDiagnostic(stateDir, jobId, value) {
    const paths = getJobPaths(stateDir, jobId);
    try {
        await fs.mkdir(paths.dir, { recursive: true });
        await fs.appendFile(paths.stderr, `${JSON.stringify({ time: new Date().toISOString(), ...asRecord(value) })}\n`, "utf8");
    }
    catch {
        // Diagnostics must never make Retinue tool calls fail.
    }
}
async function writeRetinueTrace(stateDir, value) {
    const tracePath = getRetinueTracePath(stateDir);
    try {
        await fs.mkdir(tracePath.replace(/[\\/][^\\/]+$/, ""), { recursive: true });
        await fs.appendFile(tracePath, `${JSON.stringify({ time: new Date().toISOString(), pid: process.pid, ...asRecord(value) })}\n`, "utf8");
    }
    catch {
        // Diagnostics must never make Retinue tool calls fail.
    }
}
function asRecord(value) {
    return typeof value === "object" && value !== null ? value : { value };
}
function diagnosticValuePreview(value) {
    if (value === undefined) {
        return undefined;
    }
    const type = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
    let text;
    if (typeof value === "string") {
        text = value;
    }
    else {
        try {
            text = JSON.stringify(value);
        }
        catch {
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
function summarizeMessageParts(message) {
    if (!Array.isArray(message?.parts)) {
        return undefined;
    }
    return message.parts.map((part) => {
        const state = typeof part.state === "object" && part.state !== null ? part.state : undefined;
        const summary = {
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
        if (typeof part.text === "string") {
            summary.textBytes = Buffer.byteLength(part.text, "utf8");
        }
        return summary;
    });
}
function redactDiagnosticValue(value) {
    return value
        .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]")
        .replace(/sk-[A-Za-z0-9_-]{16,}/g, "sk-[REDACTED]");
}
function truncateUtf8(value, maxBytes) {
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
function isTerminal(status) {
    return status === "completed" || status === "failed" || status === "killed" || status === "timed_out" || status === "stalled";
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
function isProblem(value) {
    return value.status === "not_found" || value.status === "corrupted";
}
function selectMessagesForMeta(messages, meta) {
    if (meta.externalMessageBaselineCount === undefined) {
        return messages;
    }
    return messages.slice(Math.max(0, meta.externalMessageBaselineCount));
}
function latestAssistantMessageText(messages) {
    return ([...messages]
        .reverse()
        .filter(isFinalAssistantTextMessage)
        .map(extractMessageText)
        .at(0) ?? "");
}
function countCompletedAssistantMessages(messages) {
    return messages.filter(isCompletedAssistantMessage).length;
}
function isCompletedAssistantMessage(message) {
    if (!isFinalAssistantTextMessage(message)) {
        return false;
    }
    const info = message.info;
    const time = typeof info.time === "object" && info.time !== null ? info.time : undefined;
    return Boolean(time && "completed" in time && typeof time.completed === "number");
}
function isFinalAssistantTextMessage(message) {
    if (message.info?.role !== "assistant") {
        return false;
    }
    if (isToolCallAssistantMessage(message)) {
        return false;
    }
    return extractMessageText(message).length > 0;
}
function isToolCallAssistantMessage(message) {
    return message.info?.finish === "tool-calls" || hasToolPart(message);
}
function countPatchParts(messages) {
    return messages.reduce((count, message) => count + (message.parts?.filter((part) => part?.type === "patch").length ?? 0), 0);
}
function computeStallDiagnostic(jobMessages, meta, env) {
    if (jobMessages.some(isCompletedAssistantMessage)) {
        return undefined;
    }
    const patchPartCount = countPatchParts(jobMessages);
    if (meta.readOnly === true && patchPartCount > 0) {
        return {
            patchPartCount,
            readOnlyPatchPartCount: patchPartCount,
            readOnlyWriteIntent: true,
            stallReason: "read_only_write_intent",
            stallSummary: "OpenCode read-only job emitted patch/write intent."
        };
    }
    const thresholdMs = parseOptionalNonNegativeInt(env?.RETINUE_OPENCODE_STALL_MS, DEFAULT_STALL_MS);
    if (thresholdMs <= 0) {
        return undefined;
    }
    const incompleteThresholdMs = parseOptionalNonNegativeInt(env?.RETINUE_OPENCODE_STALL_INCOMPLETE_ASSISTANT_MS, DEFAULT_INCOMPLETE_ASSISTANT_STALL_MS);
    const blankAssistantThresholdMs = parseOptionalNonNegativeInt(env?.RETINUE_OPENCODE_STALL_BLANK_ASSISTANT_MS, DEFAULT_BLANK_ASSISTANT_STALL_MS);
    const zeroProgressAssistantThresholdMs = parseOptionalNonNegativeInt(env?.RETINUE_OPENCODE_STALL_ZERO_PROGRESS_ASSISTANT_MS, DEFAULT_ZERO_PROGRESS_ASSISTANT_STALL_MS);
    const readToolThresholdMs = parseOptionalNonNegativeInt(env?.RETINUE_OPENCODE_STALL_READ_TOOL_MS, DEFAULT_READ_TOOL_STALL_MS);
    const roundThreshold = parseOptionalNonNegativeInt(env?.RETINUE_OPENCODE_STALL_TOOL_CALL_ROUNDS, DEFAULT_STALL_TOOL_CALL_ROUNDS);
    const emptyAssistantThreshold = parseOptionalNonNegativeInt(env?.RETINUE_OPENCODE_STALL_EMPTY_ASSISTANT_ROUNDS, DEFAULT_STALL_EMPTY_ASSISTANT_ROUNDS);
    const toolCallAssistantRounds = jobMessages.filter((message) => message.info?.role === "assistant" && isToolCallAssistantMessage(message)).length;
    const emptyAssistantRounds = jobMessages.filter((message) => message.info?.role === "assistant" && isEmptyStopAssistantMessage(message)).length;
    const blankAssistantRounds = jobMessages.filter((message) => message.info?.role === "assistant" && isBlankAssistantPlaceholder(message)).length;
    const zeroProgressAssistantRounds = jobMessages.filter((message) => message.info?.role === "assistant" && isZeroProgressAssistantPlaceholder(message)).length;
    const runningReadToolParts = jobMessages.reduce((count, message) => count + countRunningReadToolParts(message), 0);
    const lastAssistant = [...jobMessages].reverse().find((message) => message.info?.role === "assistant");
    const incompleteAssistantRound = isIncompleteAssistantMessage(lastAssistant);
    if (toolCallAssistantRounds < roundThreshold &&
        emptyAssistantRounds < emptyAssistantThreshold &&
        blankAssistantRounds === 0 &&
        zeroProgressAssistantRounds === 0 &&
        runningReadToolParts === 0 &&
        !incompleteAssistantRound) {
        return undefined;
    }
    const startedAt = Date.parse(meta.createdAt);
    const durationMs = Number.isFinite(startedAt) ? Date.now() - startedAt : 0;
    const emptyAssistantStalled = emptyAssistantRounds >= emptyAssistantThreshold;
    const blankAssistantStalled = blankAssistantRounds > 0 && durationMs >= blankAssistantThresholdMs;
    const zeroProgressAssistantStalled = zeroProgressAssistantRounds > 0 && durationMs >= zeroProgressAssistantThresholdMs;
    const readToolStalled = runningReadToolParts > 0 && durationMs >= readToolThresholdMs;
    const incompleteAssistantStalled = incompleteAssistantRound && durationMs >= incompleteThresholdMs;
    if (!emptyAssistantStalled &&
        !blankAssistantStalled &&
        !zeroProgressAssistantStalled &&
        !readToolStalled &&
        !incompleteAssistantStalled &&
        durationMs < thresholdMs) {
        return undefined;
    }
    const diagnostic = {
        toolCallAssistantRounds,
        emptyAssistantRounds,
        blankAssistantRounds,
        zeroProgressAssistantRounds,
        runningReadToolParts,
        noCompletedAssistantDurationMs: Math.max(0, durationMs),
        stallThresholdMs: thresholdMs,
        blankAssistantStallThresholdMs: blankAssistantThresholdMs,
        zeroProgressAssistantStallThresholdMs: zeroProgressAssistantThresholdMs,
        readToolStallThresholdMs: readToolThresholdMs,
        incompleteAssistantStallThresholdMs: incompleteThresholdMs,
        stallToolCallRoundThreshold: roundThreshold,
        stallEmptyAssistantRoundThreshold: emptyAssistantThreshold,
        incompleteAssistantRound,
        stallReason: selectStallReason({
            emptyAssistantStalled,
            blankAssistantStalled,
            zeroProgressAssistantStalled,
            readToolStalled,
            incompleteAssistantStalled
        })
    };
    return {
        ...diagnostic,
        stallSummary: createStallSummary(diagnostic)
    };
}
function createStallMessage(diagnostic) {
    if (diagnostic.readOnlyWriteIntent === true) {
        return `OpenCode read-only job emitted patch/write intent; Retinue did not treat the child result as trusted output. Inspect Retinue trace/job diagnostics for message summaries.`;
    }
    const rounds = diagnostic.toolCallAssistantRounds ?? 0;
    const emptyRounds = diagnostic.emptyAssistantRounds ?? 0;
    const blankRounds = diagnostic.blankAssistantRounds ?? 0;
    const zeroProgressRounds = diagnostic.zeroProgressAssistantRounds ?? 0;
    const runningReadToolParts = diagnostic.runningReadToolParts ?? 0;
    const durationMs = diagnostic.noCompletedAssistantDurationMs ?? 0;
    if (blankRounds > 0) {
        return `OpenCode job stalled: observed ${blankRounds} blank assistant placeholder(s) with no completed assistant text for ${durationMs}ms. The OpenCode provider or model router may be unavailable; inspect Retinue trace/job diagnostics for provider, model, and message summaries.`;
    }
    if (zeroProgressRounds > 0) {
        return `OpenCode job stalled: observed ${zeroProgressRounds} zero-progress assistant placeholder(s) with no completed assistant text for ${durationMs}ms. The OpenCode provider or model router may be unavailable or stuck after tool calls; inspect Retinue trace/job diagnostics for provider, model, and message summaries.`;
    }
    if (runningReadToolParts > 0) {
        return `OpenCode job stalled: observed ${runningReadToolParts} pending/running read tool call(s) with no completed assistant text for ${durationMs}ms. The OpenCode tool executor may be stuck; inspect Retinue trace/job diagnostics for call IDs and message summaries.`;
    }
    return `OpenCode job stalled: observed ${rounds} tool-call assistant round(s) and ${emptyRounds} empty assistant round(s) with no completed assistant text for ${durationMs}ms. Inspect Retinue trace/job diagnostics for message summaries.`;
}
function selectStallReason(stalled) {
    if (stalled.blankAssistantStalled) {
        return "provider_blank_assistant";
    }
    if (stalled.zeroProgressAssistantStalled) {
        return "provider_zero_progress";
    }
    if (stalled.readToolStalled) {
        return "read_tool_stalled";
    }
    if (stalled.incompleteAssistantStalled) {
        return "incomplete_assistant_round";
    }
    if (stalled.emptyAssistantStalled) {
        return "backend_no_final_text";
    }
    return "tool_loop_no_completion";
}
function createStallSummary(diagnostic) {
    const durationMs = diagnostic.noCompletedAssistantDurationMs ?? 0;
    switch (diagnostic.stallReason) {
        case "read_only_write_intent":
            return "OpenCode read-only job emitted patch/write intent.";
        case "provider_blank_assistant":
            return `OpenCode provider/router produced blank assistant output for ${durationMs}ms.`;
        case "provider_zero_progress":
            return `OpenCode provider/router produced zero-progress assistant output for ${durationMs}ms.`;
        case "read_tool_stalled":
            return `OpenCode tool executor left read tool call(s) running for ${durationMs}ms.`;
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
function parseOptionalNonNegativeInt(value, fallback) {
    if (!value) {
        return fallback;
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}
function resolveServerIdleMs(env) {
    return parseOptionalNonNegativeInt(env?.RETINUE_OPENCODE_SERVER_IDLE_MS, DEFAULT_SERVER_IDLE_MS);
}
function hasToolPart(message) {
    return Array.isArray(message.parts) && message.parts.some((part) => part?.type === "tool");
}
function countRunningReadToolParts(message) {
    return (summarizeMessageParts(message)?.filter((part) => part.type === "tool" && part.tool === "read" && isActiveToolState(part.stateStatus)).length ?? 0);
}
function isActiveToolState(status) {
    return status === "pending" || status === "running";
}
function isEmptyStopAssistantMessage(message) {
    if (message.info?.finish !== "stop") {
        return false;
    }
    if (extractMessageText(message).length > 0) {
        return false;
    }
    const partTypes = message.parts?.map((part) => part?.type ?? "unknown") ?? [];
    return partTypes.length > 0 && partTypes.every((type) => type === "step-start" || type === "step-finish");
}
function isBlankAssistantPlaceholder(message) {
    if (message.info?.role !== "assistant") {
        return false;
    }
    if (extractMessageText(message).length > 0) {
        return false;
    }
    const partTypes = message.parts?.map((part) => part?.type ?? "unknown") ?? [];
    return partTypes.length === 0;
}
function isZeroProgressAssistantPlaceholder(message) {
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
function isIncompleteAssistantMessage(message) {
    if (message?.info?.role !== "assistant") {
        return false;
    }
    if (typeof message.info.finish === "string") {
        return false;
    }
    const partTypes = message.parts?.map((part) => part?.type ?? "unknown") ?? [];
    return partTypes.length === 0 || !partTypes.includes("step-finish");
}
function extractMessageText(message) {
    if (!Array.isArray(message.parts)) {
        return "";
    }
    return message.parts
        .filter((part) => part?.type === "text" && typeof part.text === "string")
        .map((part) => part.text ?? "")
        .join("");
}
function stringInfo(message, key) {
    const value = message?.info?.[key];
    return typeof value === "string" ? value : undefined;
}
function numberInfo(message, key) {
    const value = message?.info?.[key];
    return typeof value === "number" ? value : undefined;
}
async function writeJsonAtomic(filePath, value) {
    await fs.mkdir(filePath.replace(/[\\/][^\\/]+$/, ""), { recursive: true });
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
    await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await fs.rename(tempPath, filePath);
}
function createPromptPreview(prompt) {
    const normalized = prompt.replace(/\s+/g, " ").trim();
    return normalized.length > 120 ? `${normalized.slice(0, 117)}...` : normalized;
}
function buildOpenCodePrompt(prompt, readOnly) {
    if (!readOnly) {
        return prompt;
    }
    return `${OPENCODE_READ_ONLY_PROMPT_CONTRACT}\n\nUser task:\n${prompt}`;
}
function sha256(value) {
    return createHash("sha256").update(value).digest("hex");
}
function getJobsDir(stateDir) {
    return getJobPaths(stateDir, "placeholder").dir.replace(/[\\/]placeholder$/, "");
}
async function readDirIfExists(dirPath) {
    try {
        return await fs.readdir(dirPath, { withFileTypes: true });
    }
    catch (error) {
        if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
            return [];
        }
        throw error;
    }
}
async function listTempFiles(dirPath) {
    const entries = await readDirIfExists(dirPath);
    return entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".tmp"))
        .map((entry) => `${dirPath}${dirPath.includes("\\") ? "\\" : "/"}${entry.name}`);
}
//# sourceMappingURL=backend.js.map