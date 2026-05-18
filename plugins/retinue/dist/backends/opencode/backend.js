import fs from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { resolveHttpTimeoutMs } from "../../core/http.js";
import { getJobPaths, getRetinueTracePath, resolveStateDir } from "../../core/paths.js";
import { isCleanupSafeStatus } from "../../core/status.js";
import { OpenCodeClient, OpenCodeClientError } from "./client.js";
import { scheduleManagedOpenCodeServerIdleShutdown } from "./serverManager.js";
const OPENCODE_READ_ONLY_TOOLS_NO_BASH = {
    bash: false,
    edit: false,
    write: false,
    apply_patch: false,
    patch: false,
    task: false
};
const OPENCODE_READ_ONLY_TOOLS_WITH_READONLY_GIT_BASH = {
    edit: false,
    write: false,
    apply_patch: false,
    patch: false,
    task: false
};
const OPENCODE_FINAL_ANSWER_ONLY_TOOLS = {
    read: false,
    glob: false,
    grep: false,
    list: false,
    todoread: false,
    todowrite: false,
    webfetch: false,
    lsp: false,
    bash: false,
    edit: false,
    write: false,
    apply_patch: false,
    patch: false,
    task: false
};
const OPENCODE_SOFT_STALL_RESCUE_PROMPT = [
    "Retinue recovery request:",
    "Stop using tools now and produce the final answer from the information already gathered.",
    "Do not call read, grep, glob, bash, edit, write, patch, apply_patch, task, or any other tool.",
    "If the available information is insufficient, state the limitation clearly instead of inspecting more files.",
    "Return concise plain text only. Do not emit patch blocks, unified diffs, or apply-ready replacement snippets."
].join("\n");
function createReadOnlyPromptContract(bashPolicy) {
    const allowsReadonlyGit = bashPolicy === "readonly_git";
    return [
        "Retinue read-only child agent contract:",
        allowsReadonlyGit
            ? "- Use only OpenCode read, grep, glob, and allowed read-only git bash commands plus plain-text reasoning."
            : "- Use only OpenCode read, grep, and glob tools plus plain-text reasoning.",
        allowsReadonlyGit
            ? "- Allowed bash is limited to read-only git inspection commands: pwd, git status --short, git status --porcelain, git diff --cached, git diff --staged, git diff --name-only --cached, git diff --name-status --cached, git diff --stat --cached, git diff -- <path>, git show --stat, git show --name-only, git ls-files, and git rev-parse --show-toplevel."
            : undefined,
        allowsReadonlyGit
            ? "- For staged diff review, use git diff --cached or git diff --staged; for unstaged file review, use git diff -- <path>."
            : undefined,
        allowsReadonlyGit
            ? "- Do not call bash except for allowed read-only git inspection commands; do not use shell pipes, redirects, command separators, command substitution, or write-capable git commands."
            : "- Do not call bash, edit, write, apply_patch, task, or nested agents.",
        "- Do not attempt non-allowed shell commands, file writes, patches, or interactive approvals.",
        "- Do not enter patch mode. If you identify a change, describe the affected interfaces, functions, tests, and risks in prose only.",
        "- Do not emit unified diffs.",
        "- Do not include patch blocks, edit scripts, or apply-ready replacement snippets.",
        "- For code review, return findings as plain text with severity and file references; describe suggested fixes in prose.",
        "- If the user provides enough facts to answer, answer from those facts without repository inspection.",
        "- Do not use tools just to confirm prompt-provided facts; use tools only when the task names files, symbols, or explicitly asks for repository inspection.",
        "- Use at most six inspection tool calls total before producing a final textual answer.",
        "- Before using any tool, classify whether the user task depends on git-only state such as staged changes, staged diff, uncommitted diff, git history, or the latest commit.",
        allowsReadonlyGit
            ? "- You may inspect staged or unstaged diff only with the allowed read-only git commands. If a requested git state is outside that allowlist or needs shell composition, state the limitation instead of approximating it from repository files."
            : "- If it asks for staged diff, uncommitted diff, git diff, git history, or the latest commit and the prompt did not include the needed diff/content, do not inspect the repository; immediately state that the read-only boundary cannot access that git-only state and ask the caller to provide the diff/content or use profile access.",
        allowsReadonlyGit
            ? "- You cannot inspect git history, commits beyond allowed git show metadata, or shell-composed repository state unless the task provides the relevant content."
            : "- You cannot inspect git history, staged changes, uncommitted diffs, or the latest commit unless the task provides the relevant file paths or content.",
        "- If the task asks for a diff, commit, or git-only state you cannot access, state that limitation instead of approximating it from repository files.",
        "- For broad audits, start with grep/glob and read only a small set of targeted files; avoid bulk-reading large generated, cache, log, or backup directories.",
        "- Use read serially: do not issue multiple read calls in one assistant turn, and stop reading once you have enough evidence to answer.",
        "- If the task needs non-allowed shell or write access, say that the read-only boundary prevents that part and provide the best file-based answer you can.",
        "- Always finish with a concise textual result; do not stop after tool calls without a final answer."
    ]
        .filter((line) => typeof line === "string")
        .join("\n");
}
const OPENCODE_READ_ONLY_BASE_PERMISSION = [
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
    { permission: "apply_patch", pattern: "*", action: "deny" },
    { permission: "patch", pattern: "*", action: "deny" },
    { permission: "task", pattern: "*", action: "deny" },
    { permission: "external_directory", pattern: "*", action: "deny" },
    { permission: "doom_loop", pattern: "*", action: "deny" },
    { permission: "bash", pattern: "*", action: "deny" }
];
const OPENCODE_READONLY_GIT_BASH_PERMISSION = [
    { permission: "bash", pattern: "pwd", action: "allow" },
    { permission: "bash", pattern: "git status --short*", action: "allow" },
    { permission: "bash", pattern: "git status --porcelain*", action: "allow" },
    { permission: "bash", pattern: "git diff --cached*", action: "allow" },
    { permission: "bash", pattern: "git diff --staged*", action: "allow" },
    { permission: "bash", pattern: "git diff --name-only --cached*", action: "allow" },
    { permission: "bash", pattern: "git diff --name-status --cached*", action: "allow" },
    { permission: "bash", pattern: "git diff --stat --cached*", action: "allow" },
    { permission: "bash", pattern: "git diff -- *", action: "allow" },
    { permission: "bash", pattern: "git show --stat*", action: "allow" },
    { permission: "bash", pattern: "git show --name-only*", action: "allow" },
    { permission: "bash", pattern: "git ls-files*", action: "allow" },
    { permission: "bash", pattern: "git rev-parse --show-toplevel", action: "allow" }
];
const DEFAULT_WAIT_TIMEOUT_MS = 30_000;
const DEFAULT_WAIT_POLL_MS = 250;
const DEFAULT_STALL_MS = 10 * 60_000;
const DEFAULT_INCOMPLETE_ASSISTANT_STALL_MS = 45_000;
const DEFAULT_SERVER_IDLE_MS = 30_000;
const DEFAULT_BLANK_ASSISTANT_STALL_MS = 45_000;
const DEFAULT_ZERO_PROGRESS_ASSISTANT_STALL_MS = 45_000;
const DEFAULT_READ_TOOL_STALL_MS = 45_000;
const DEFAULT_COMPLETED_TOOL_LOOP_STALL_MS = 45_000;
const DEFAULT_SOFT_STALL_RESCUE_GRACE_MS = 60_000;
const DEFAULT_STALL_TOOL_CALL_ROUNDS = 6;
const DEFAULT_STALL_EMPTY_ASSISTANT_ROUNDS = 1;
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
        const readOnlyBashPolicy = resolveReadOnlyBashPolicy(options.readOnlyBashPolicy);
        const session = await target.client.createSession({
            cwd: options.cwd,
            title: options.title ?? options.name,
            permission: options.readOnly === true ? buildReadOnlyPermission(readOnlyBashPolicy) : undefined
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
            readOnlyPromptContract: options.readOnlyPromptContract === true,
            readOnlyToolDeny: options.readOnlyToolDeny === true,
            externalSessionId: session.id,
            externalServerUrl: target.baseUrl,
            externalSessionDirectory: session.directory ?? session.cwd,
            externalMessageBaselineCount: baseline.messageCount,
            externalCompletedAssistantBaselineCount: baseline.completedAssistantCount,
            parentJobId: options.parentJobId,
            parentSessionId: options.parentSessionId,
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
        if (options.readOnly === true) {
            return this.run({
                cwd: options.cwd,
                prompt: options.prompt,
                name: options.name,
                title: options.title,
                model: options.model,
                agent: options.agent,
                readOnly: true,
                readOnlyBashPolicy: options.readOnlyBashPolicy,
                parentJobId: options.parentJobId,
                parentSessionId: options.parentSessionId ?? options.externalSessionId,
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
            readOnly: false,
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
    async maybeSubmitSoftStallRescue(meta, diagnostic) {
        const recoverReadOnlyWriteIntent = diagnostic.readOnlyWriteIntent === true;
        if (!meta.externalSessionId ||
            meta.externalRescuePromptSubmittedAt ||
            !isSoftStallRescueEligible(diagnostic)) {
            return;
        }
        const updated = {
            ...meta,
            status: meta.status === "stalled" ? "running" : meta.status,
            externalRescuePromptSubmittedAt: new Date().toISOString(),
            externalReadOnlyWriteIntentRecoveryJobMessageCount: recoverReadOnlyWriteIntent
                ? (diagnostic.jobMessageCount ?? meta.externalReadOnlyWriteIntentRecoveryJobMessageCount)
                : meta.externalReadOnlyWriteIntentRecoveryJobMessageCount,
            updatedAt: new Date().toISOString()
        };
        await writeJsonAtomic(getJobPaths(this.stateDir, meta.jobId).meta, updated);
        try {
            await this.clientForMeta(meta).promptAsync(meta.externalSessionId, {
                prompt: OPENCODE_SOFT_STALL_RESCUE_PROMPT,
                model: meta.model,
                agent: resolveSoftStallRescueAgent(meta.agent, this.env),
                tools: OPENCODE_FINAL_ANSWER_ONLY_TOOLS
            });
            const submittedDiagnostic = await this.inspectJob(updated);
            await this.writeJobTrace("opencode_job_soft_stall_rescue_submitted", updated, submittedDiagnostic);
            await appendJobDiagnostic(this.stateDir, meta.jobId, { event: "opencode_job_soft_stall_rescue_submitted", diagnostic: submittedDiagnostic });
        }
        catch (error) {
            const failedDiagnostic = {
                ...(await this.inspectJob(updated)),
                error: error instanceof Error ? error.message : String(error)
            };
            await this.writeJobTrace("opencode_job_soft_stall_rescue_failed", updated, failedDiagnostic);
            await appendJobDiagnostic(this.stateDir, meta.jobId, {
                event: "opencode_job_soft_stall_rescue_failed",
                error: error instanceof Error ? error.message : String(error),
                diagnostic: failedDiagnostic
            });
        }
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
            const text = diagnostic.readOnlyWriteIntent === true ? latestAssistantVisibleText(selectResultMessagesForMeta(jobMessages, meta)) : "";
            const stdout = text || stderr;
            const textWarning = meta.readOnly === true ? createReadOnlyTextWarning(stdout) : undefined;
            if (textWarning) {
                diagnostic.readOnlyTextWarning = true;
                diagnostic.readOnlyTextWarningSummary = textWarning;
            }
            await fs.writeFile(paths.stdout, stdout, "utf8");
            const stderrText = textWarning ? `${stderr}\n${textWarning}` : stderr;
            await fs.appendFile(paths.stderr, `${stderrText}\n`, "utf8");
            diagnostic.selectedAssistantTextBytes = Buffer.byteLength(stdout, "utf8");
            diagnostic.selectedAssistantSha256 = sha256(stdout);
            if (process.env.RETINUE_TRACE_TEXT_PREVIEW === "1") {
                diagnostic.selectedAssistantPreview = createPromptPreview(stdout);
            }
            await this.writeJobTrace("opencode_job_result_read", meta, diagnostic);
            await appendJobDiagnostic(this.stateDir, handle.jobId, { event: "opencode_job_result_read", diagnostic });
            return {
                jobId: handle.jobId,
                status: meta.status,
                stdout,
                stderr: stderrText,
                stdoutPath: paths.stdout,
                stderrPath: paths.stderr,
                stdoutBytes: Buffer.byteLength(stdout, "utf8"),
                stderrBytes: Buffer.byteLength(stderrText, "utf8"),
                stdoutTruncated: false,
                stderrTruncated: false,
                sessionId: meta.externalSessionId,
                parsedStdout: { result: stdout },
                error: stderrText
            };
        }
        const resultMessages = selectResultMessagesForMeta(jobMessages, meta);
        const text = meta.externalMessageBaselineCount === undefined && resultMessages === jobMessages ? latestAssistantMessageText(messages) : latestAssistantMessageText(resultMessages);
        const textWarning = meta.readOnly === true ? createReadOnlyTextWarning(text) : undefined;
        if (textWarning) {
            diagnostic.readOnlyTextWarning = true;
            diagnostic.readOnlyTextWarningSummary = textWarning;
        }
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
            stderr: textWarning ?? "",
            stdoutPath: paths.stdout,
            stderrPath: paths.stderr,
            stdoutBytes: Buffer.byteLength(text, "utf8"),
            stderrBytes: Buffer.byteLength(textWarning ?? "", "utf8"),
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
        let abortError;
        try {
            await this.clientForMeta(meta).abort(meta.externalSessionId);
        }
        catch (error) {
            abortError = error instanceof Error ? error.message : String(error);
            await appendJobDiagnostic(this.stateDir, handle.jobId, { event: "opencode_job_abort_failed", error: abortError });
        }
        const updated = {
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
    async wait(handle, timeoutMs = DEFAULT_WAIT_TIMEOUT_MS) {
        const deadline = Date.now() + Math.max(0, timeoutMs);
        let deferredSoftStall = false;
        for (;;) {
            const status = await this.status(handle);
            if (isProblem(status)) {
                return { jobId: handle.jobId, status: status.status };
            }
            if (status.status === "stalled") {
                const diagnostic = await this.inspectJob(status);
                const canDeferStall = isSoftStallRescueEligible(diagnostic) ||
                    (diagnostic.readOnlyWriteIntent === true && status.externalRescuePromptSubmittedAt === undefined);
                if (canDeferStall && Date.now() < deadline) {
                    await this.maybeSubmitSoftStallRescue(status, diagnostic);
                    if (!deferredSoftStall) {
                        await this.writeJobTrace("opencode_job_soft_stall_deferred", status, diagnostic);
                        await appendJobDiagnostic(this.stateDir, handle.jobId, { event: "opencode_job_soft_stall_deferred", diagnostic });
                        deferredSoftStall = true;
                    }
                    await sleep(DEFAULT_WAIT_POLL_MS);
                    continue;
                }
                if (this.isSoftStallRescuePending(status, diagnostic)) {
                    await this.writeJobTrace("opencode_job_soft_stall_rescue_pending", status, diagnostic);
                    await appendJobDiagnostic(this.stateDir, handle.jobId, { event: "opencode_job_soft_stall_rescue_pending", diagnostic });
                    return { jobId: handle.jobId, status: "running" };
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
                    if (this.isReadOnlyWriteIntentRecoveryExpired(meta, diagnostic)) {
                        const expiredDiagnostic = {
                            ...diagnostic,
                            stallReason: "read_only_write_intent",
                            stallSummary: "OpenCode read-only job emitted patch/write intent, and recovery did not produce usable final text."
                        };
                        const stalled = { ...meta, status: "stalled", updatedAt: new Date().toISOString() };
                        await writeJsonAtomic(getJobPaths(this.stateDir, handle.jobId).meta, stalled);
                        await this.writeJobTrace("opencode_job_wait_timeout", stalled, expiredDiagnostic);
                        await appendJobDiagnostic(this.stateDir, handle.jobId, { event: "opencode_job_wait_timeout", diagnostic: expiredDiagnostic });
                        await this.writeJobTrace("opencode_job_stalled", stalled, expiredDiagnostic, { fromStatus: meta.status, toStatus: "stalled" });
                        await appendJobDiagnostic(this.stateDir, handle.jobId, {
                            event: "opencode_job_stalled",
                            fromStatus: meta.status,
                            toStatus: "stalled",
                            diagnostic: expiredDiagnostic
                        });
                        return { jobId: handle.jobId, status: "stalled" };
                    }
                    if (diagnostic.stallReason) {
                        if (this.isSoftStallRescuePending(meta, diagnostic)) {
                            await this.writeJobTrace("opencode_job_wait_timeout", meta, diagnostic);
                            await appendJobDiagnostic(this.stateDir, handle.jobId, { event: "opencode_job_wait_timeout", diagnostic });
                            await this.writeJobTrace("opencode_job_soft_stall_rescue_pending", meta, diagnostic);
                            await appendJobDiagnostic(this.stateDir, handle.jobId, { event: "opencode_job_soft_stall_rescue_pending", diagnostic });
                            return { jobId: handle.jobId, status: "running" };
                        }
                        const stalled = { ...meta, status: "stalled", updatedAt: new Date().toISOString() };
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
                        if (isHardStallDiagnostic(diagnostic)) {
                            await this.maybeScheduleServerIdleShutdown(stalled);
                        }
                        return { jobId: handle.jobId, status: "stalled" };
                    }
                    await this.writeJobTrace("opencode_job_wait_timeout", meta, diagnostic);
                    await appendJobDiagnostic(this.stateDir, handle.jobId, { event: "opencode_job_wait_timeout", diagnostic });
                }
                return { jobId: handle.jobId, status: "running" };
            }
            await sleep(DEFAULT_WAIT_POLL_MS);
        }
    }
    isSoftStallRescuePending(meta, diagnostic) {
        if (!meta.externalRescuePromptSubmittedAt ||
            meta.externalReadOnlyWriteIntentRecoveryJobMessageCount === undefined ||
            diagnostic.recoveredFromReadOnlyWriteIntent === true) {
            return false;
        }
        if (isHardStallDiagnostic(diagnostic)) {
            return false;
        }
        const submittedAt = Date.parse(meta.externalRescuePromptSubmittedAt);
        if (!Number.isFinite(submittedAt)) {
            return false;
        }
        return Date.now() - submittedAt < resolveSoftStallRescueGraceMs(this.env);
    }
    isReadOnlyWriteIntentRecoveryExpired(meta, diagnostic) {
        if (!meta.externalRescuePromptSubmittedAt ||
            meta.externalReadOnlyWriteIntentRecoveryJobMessageCount === undefined ||
            diagnostic.recoveredFromReadOnlyWriteIntent === true ||
            diagnostic.readOnlyWriteIntent === true) {
            return false;
        }
        const submittedAt = Date.parse(meta.externalRescuePromptSubmittedAt);
        if (!Number.isFinite(submittedAt)) {
            return false;
        }
        return Date.now() - submittedAt >= resolveSoftStallRescueGraceMs(this.env);
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
            if (await this.hasReadOnlyWriteIntent(client, meta.externalSessionId, meta)) {
                status = "stalled";
            }
            else if (session.state === "completed") {
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
            const updated = {
                ...meta,
                status,
                externalReadOnlyWriteIntentRecoveredAt: status === "completed" && meta.externalReadOnlyWriteIntentRecoveryJobMessageCount !== undefined
                    ? (meta.externalReadOnlyWriteIntentRecoveredAt ?? new Date().toISOString())
                    : meta.externalReadOnlyWriteIntentRecoveredAt,
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
            if (status === "stalled") {
                await this.writeJobTrace("opencode_job_stalled", updated, diagnostic, { fromStatus: meta.status, toStatus: status });
                await appendJobDiagnostic(this.stateDir, meta.jobId, {
                    event: "opencode_job_stalled",
                    fromStatus: meta.status,
                    toStatus: status,
                    diagnostic
                });
            }
            if (isTerminal(status) && (status !== "stalled" || isHardStallDiagnostic(diagnostic))) {
                await this.maybeScheduleServerIdleShutdown(updated);
            }
            return updated;
        }
        catch (error) {
            if (error instanceof OpenCodeClientError && error.status === 404) {
                return { jobId: meta.jobId, status: "not_found", error: "OpenCode session not found" };
            }
            if (meta.status === "killed") {
                return meta;
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
        const completionMessages = selectResultMessagesForMeta(jobMessages, meta);
        if (completionMessages.some(isCompletedAssistantMessage)) {
            return true;
        }
        if (meta.externalMessageBaselineCount !== undefined || meta.externalReadOnlyWriteIntentRecoveryJobMessageCount !== undefined) {
            return false;
        }
        return countCompletedAssistantMessages(messages) > (meta.externalCompletedAssistantBaselineCount ?? 0);
    }
    async hasReadOnlyWriteIntent(client, sessionId, meta) {
        if (meta.readOnly !== true) {
            return false;
        }
        const messages = await client.messages(sessionId);
        const jobMessages = selectMessagesForMeta(messages, meta);
        const writeIntentMessages = selectReadOnlyWriteIntentMessagesForMeta(jobMessages, meta);
        return countPatchParts(writeIntentMessages) > 0 || countWriteIntentToolParts(writeIntentMessages) > 0;
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
            const readOnlyWriteIntentMessages = selectReadOnlyWriteIntentMessagesForMeta(jobMessages, meta);
            diagnostic.readOnlyPatchPartCount = meta.readOnly === true ? countPatchParts(readOnlyWriteIntentMessages) : 0;
            diagnostic.writeIntentToolPartCount = countWriteIntentToolParts(jobMessages);
            diagnostic.readOnlyWriteIntentToolPartCount = meta.readOnly === true ? countWriteIntentToolParts(readOnlyWriteIntentMessages) : 0;
            diagnostic.readOnlyWriteIntent =
                (diagnostic.readOnlyPatchPartCount ?? 0) > 0 || (diagnostic.readOnlyWriteIntentToolPartCount ?? 0) > 0;
            diagnostic.readOnlyWriteIntentRecoveryJobMessageCount = meta.externalReadOnlyWriteIntentRecoveryJobMessageCount;
            diagnostic.recoveredFromReadOnlyWriteIntent =
                meta.readOnly === true &&
                    meta.externalReadOnlyWriteIntentRecoveryJobMessageCount !== undefined &&
                    diagnostic.readOnlyWriteIntent !== true &&
                    selectResultMessagesForMeta(jobMessages, meta).some(isCompletedAssistantMessage);
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
            if (meta.status === "stalled" &&
                meta.readOnly === true &&
                meta.externalReadOnlyWriteIntentRecoveryJobMessageCount !== undefined &&
                diagnostic.recoveredFromReadOnlyWriteIntent !== true &&
                diagnostic.readOnlyWriteIntent !== true &&
                !diagnostic.stallReason) {
                diagnostic.stallReason = "read_only_write_intent";
                diagnostic.stallSummary = "OpenCode read-only job emitted patch/write intent, and recovery did not produce usable final text.";
            }
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
                prompt: buildOpenCodePrompt(options.prompt, options.readOnly === true && options.readOnlyPromptContract === true, resolveReadOnlyBashPolicy(options.readOnlyBashPolicy)),
                model: options.model,
                agent: options.agent,
                tools: options.readOnly === true && options.readOnlyToolDeny === true
                    ? buildReadOnlyTools(resolveReadOnlyBashPolicy(options.readOnlyBashPolicy))
                    : undefined
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
function selectResultMessagesForMeta(jobMessages, meta) {
    if (meta.externalReadOnlyWriteIntentRecoveryJobMessageCount === undefined) {
        return jobMessages;
    }
    return jobMessages.slice(Math.max(0, meta.externalReadOnlyWriteIntentRecoveryJobMessageCount));
}
function selectReadOnlyWriteIntentMessagesForMeta(jobMessages, meta) {
    return selectResultMessagesForMeta(jobMessages, meta);
}
function latestAssistantMessageText(messages) {
    return ([...messages]
        .reverse()
        .filter(isFinalAssistantTextMessage)
        .map(extractMessageText)
        .at(0) ?? "");
}
function latestAssistantVisibleText(messages) {
    return ([...messages]
        .reverse()
        .filter((message) => message.info?.role === "assistant")
        .map(extractMessageText)
        .find((text) => text.length > 0) ?? "");
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
function countWriteIntentToolParts(messages) {
    return messages.reduce((count, message) => count + (message.parts?.filter((part) => part?.type === "tool" && isWriteIntentTool(part.tool)).length ?? 0), 0);
}
function isWriteIntentTool(tool) {
    return tool === "write" || tool === "edit" || tool === "apply_patch";
}
function hasAssistantError(messages) {
    return messages.some((message) => message.info?.role === "assistant" && message.info.error !== undefined);
}
function computeStallDiagnostic(jobMessages, meta, env) {
    const activeMessages = selectResultMessagesForMeta(jobMessages, meta);
    const writeIntentMessages = selectReadOnlyWriteIntentMessagesForMeta(jobMessages, meta);
    const patchPartCount = countPatchParts(writeIntentMessages);
    const writeIntentToolPartCount = countWriteIntentToolParts(writeIntentMessages);
    if (hasAssistantError(activeMessages)) {
        return {
            patchPartCount,
            readOnlyPatchPartCount: meta.readOnly === true ? patchPartCount : 0,
            writeIntentToolPartCount,
            readOnlyWriteIntentToolPartCount: meta.readOnly === true ? writeIntentToolPartCount : 0,
            readOnlyWriteIntent: false,
            stallReason: "provider_error",
            stallSummary: "OpenCode provider returned an assistant error."
        };
    }
    if (meta.readOnly === true && (patchPartCount > 0 || writeIntentToolPartCount > 0)) {
        return {
            patchPartCount,
            readOnlyPatchPartCount: patchPartCount,
            writeIntentToolPartCount,
            readOnlyWriteIntentToolPartCount: writeIntentToolPartCount,
            readOnlyWriteIntent: true,
            stallReason: "read_only_write_intent",
            stallSummary: "OpenCode read-only job emitted patch/write intent."
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
    const zeroProgressAssistantThresholdMs = parseOptionalNonNegativeInt(env?.RETINUE_OPENCODE_STALL_ZERO_PROGRESS_ASSISTANT_MS, DEFAULT_ZERO_PROGRESS_ASSISTANT_STALL_MS);
    const readToolThresholdMs = parseOptionalNonNegativeInt(env?.RETINUE_OPENCODE_STALL_READ_TOOL_MS, DEFAULT_READ_TOOL_STALL_MS);
    const completedToolLoopThresholdMs = parseOptionalNonNegativeInt(env?.RETINUE_OPENCODE_STALL_COMPLETED_TOOL_LOOP_MS, DEFAULT_COMPLETED_TOOL_LOOP_STALL_MS);
    const roundThreshold = parseOptionalNonNegativeInt(env?.RETINUE_OPENCODE_STALL_TOOL_CALL_ROUNDS, DEFAULT_STALL_TOOL_CALL_ROUNDS);
    const emptyAssistantThreshold = parseOptionalNonNegativeInt(env?.RETINUE_OPENCODE_STALL_EMPTY_ASSISTANT_ROUNDS, DEFAULT_STALL_EMPTY_ASSISTANT_ROUNDS);
    const toolCallAssistantRounds = activeMessages.filter((message) => message.info?.role === "assistant" && isToolCallAssistantMessage(message)).length;
    const emptyAssistantRounds = activeMessages.filter((message) => message.info?.role === "assistant" && isEmptyStopAssistantMessage(message)).length;
    const blankAssistantRounds = activeMessages.filter((message) => message.info?.role === "assistant" && isBlankAssistantPlaceholder(message)).length;
    const zeroProgressAssistantRounds = activeMessages.filter((message) => message.info?.role === "assistant" && isZeroProgressAssistantPlaceholder(message)).length;
    const runningReadToolPartSummaries = collectRunningReadToolPartSummaries(activeMessages);
    const runningReadToolParts = runningReadToolPartSummaries.length;
    const runningReadToolCallIds = runningReadToolPartSummaries.flatMap((part) => (part.callID ? [part.callID] : []));
    const lastAssistant = [...activeMessages].reverse().find((message) => message.info?.role === "assistant");
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
    const completedToolLoopStalled = toolCallAssistantRounds >= roundThreshold &&
        runningReadToolParts === 0 &&
        !incompleteAssistantRound &&
        durationMs >= completedToolLoopThresholdMs;
    const incompleteAssistantStalled = incompleteAssistantRound && durationMs >= incompleteThresholdMs;
    if (!emptyAssistantStalled &&
        !blankAssistantStalled &&
        !zeroProgressAssistantStalled &&
        !readToolStalled &&
        !completedToolLoopStalled &&
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
        runningReadToolCallIds,
        runningReadToolPartSummaries,
        noCompletedAssistantDurationMs: Math.max(0, durationMs),
        stallThresholdMs: thresholdMs,
        blankAssistantStallThresholdMs: blankAssistantThresholdMs,
        zeroProgressAssistantStallThresholdMs: zeroProgressAssistantThresholdMs,
        readToolStallThresholdMs: readToolThresholdMs,
        completedToolLoopStallThresholdMs: completedToolLoopThresholdMs,
        incompleteAssistantStallThresholdMs: incompleteThresholdMs,
        stallToolCallRoundThreshold: roundThreshold,
        stallEmptyAssistantRoundThreshold: emptyAssistantThreshold,
        incompleteAssistantRound,
        stallReason: selectStallReason({
            emptyAssistantStalled,
            blankAssistantStalled,
            zeroProgressAssistantStalled,
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
function createStallMessage(diagnostic) {
    if (diagnostic.readOnlyWriteIntent === true) {
        return `OpenCode read-only job emitted patch/write intent; Retinue did not treat the child result as trusted output. Inspect Retinue trace/job diagnostics for message summaries.`;
    }
    if (diagnostic.stallReason === "read_only_write_intent") {
        return `OpenCode read-only job emitted patch/write intent; Retinue requested a no-tools prose-only recovery, but no trusted final text was produced. Inspect Retinue trace/job diagnostics for message summaries.`;
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
    const runningReadToolParts = diagnostic.runningReadToolParts ?? 0;
    const durationMs = diagnostic.noCompletedAssistantDurationMs ?? 0;
    if (blankRounds > 0) {
        return `OpenCode job stalled: observed ${blankRounds} blank assistant placeholder(s) with no completed assistant text for ${durationMs}ms. The OpenCode provider or model router may be unavailable; inspect Retinue trace/job diagnostics for provider, model, and message summaries.`;
    }
    if (zeroProgressRounds > 0) {
        return `OpenCode job stalled: observed ${zeroProgressRounds} zero-progress assistant placeholder(s) with no completed assistant text for ${durationMs}ms. The OpenCode provider or model router may be unavailable or stuck after tool calls; inspect Retinue trace/job diagnostics for provider, model, and message summaries.`;
    }
    if (runningReadToolParts > 0) {
        const details = formatReadToolStallDetails(diagnostic);
        return `OpenCode job stalled: observed ${runningReadToolParts} pending/running read tool call(s) with no completed assistant text for ${durationMs}ms.${details} The OpenCode tool executor may be stuck; inspect Retinue trace/job diagnostics for full message summaries.`;
    }
    return `OpenCode job stalled: observed ${rounds} tool-call assistant round(s) and ${emptyRounds} empty assistant round(s) with no completed assistant text for ${durationMs}ms. Inspect Retinue trace/job diagnostics for message summaries.`;
}
function isHardStallDiagnostic(diagnostic) {
    return diagnostic.readOnlyWriteIntent === true || diagnostic.stallReason === "provider_error";
}
function isSoftStallRescueEligible(diagnostic) {
    if (diagnostic.readOnlyWriteIntent === true) {
        return true;
    }
    return (diagnostic.stallReason === "backend_no_final_text" ||
        diagnostic.stallReason === "tool_loop_no_completion" ||
        diagnostic.stallReason === "incomplete_assistant_round" ||
        diagnostic.stallReason === "provider_blank_assistant" ||
        diagnostic.stallReason === "provider_zero_progress");
}
function createReadOnlyTextWarning(text) {
    if (!text.trim()) {
        return undefined;
    }
    const riskyPatterns = [
        /^```(?:diff|patch)\b/im,
        /^---\s+a\//m,
        /^\+\+\+\s+b\//m,
        /^@@\s+-\d/m,
        /^\s*(?:sudo\s+|rm\s+-rf\b|chmod\s+|cat\s+>|tee\s+)/m
    ];
    if (!riskyPatterns.some((pattern) => pattern.test(text))) {
        return undefined;
    }
    return "Retinue read-only result may contain patch or write-command text; treat stdout as untrusted analysis, not executable instructions.";
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
function createStallSummary(diagnostic) {
    const durationMs = diagnostic.noCompletedAssistantDurationMs ?? 0;
    switch (diagnostic.stallReason) {
        case "read_only_write_intent":
            return "OpenCode read-only job emitted patch/write intent.";
        case "provider_error":
            return "OpenCode provider returned an assistant error before final text.";
        case "provider_blank_assistant":
            return `OpenCode provider/router produced blank assistant output for ${durationMs}ms.`;
        case "provider_zero_progress":
            return `OpenCode provider/router produced zero-progress assistant output for ${durationMs}ms.`;
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
function formatReadToolStallDetails(diagnostic) {
    const summaries = diagnostic.runningReadToolPartSummaries ?? [];
    const callIds = diagnostic.runningReadToolCallIds ?? [];
    const stateDetails = summaries
        .map((part) => [part.callID, part.stateStatus].filter(Boolean).join(":"))
        .filter((value) => value.length > 0);
    if (stateDetails.length > 0) {
        return ` readToolCalls=${stateDetails.join(",")}.`;
    }
    if (callIds.length > 0) {
        return ` readToolCallIds=${callIds.join(",")}.`;
    }
    return "";
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
function resolveSoftStallRescueGraceMs(env) {
    return parseOptionalNonNegativeInt(env?.RETINUE_OPENCODE_SOFT_STALL_RESCUE_GRACE_MS, DEFAULT_SOFT_STALL_RESCUE_GRACE_MS);
}
function resolveSoftStallRescueAgent(currentAgent, env) {
    const configured = env?.RETINUE_OPENCODE_SOFT_STALL_RESCUE_AGENT?.trim();
    if (configured === "0" || configured === "false" || configured === "none") {
        return currentAgent;
    }
    return configured || "build";
}
function hasToolPart(message) {
    return Array.isArray(message.parts) && message.parts.some((part) => part?.type === "tool");
}
function collectRunningReadToolPartSummaries(messages) {
    return messages.flatMap((message) => summarizeMessageParts(message)?.filter((part) => part.type === "tool" && part.tool === "read" && isActiveToolState(part.stateStatus)) ?? []);
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
function resolveReadOnlyBashPolicy(value) {
    return value ?? "readonly_git";
}
function buildReadOnlyPermission(bashPolicy) {
    return bashPolicy === "readonly_git"
        ? [...OPENCODE_READONLY_GIT_BASH_PERMISSION, ...OPENCODE_READ_ONLY_BASE_PERMISSION]
        : OPENCODE_READ_ONLY_BASE_PERMISSION;
}
function buildReadOnlyTools(bashPolicy) {
    return bashPolicy === "readonly_git" ? OPENCODE_READ_ONLY_TOOLS_WITH_READONLY_GIT_BASH : OPENCODE_READ_ONLY_TOOLS_NO_BASH;
}
function buildOpenCodePrompt(prompt, readOnly, bashPolicy) {
    if (!readOnly) {
        return prompt;
    }
    return `${createReadOnlyPromptContract(bashPolicy)}\n\nUser task:\n${prompt}`;
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