import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { finished } from "node:stream/promises";
import { buildClaudeArgs } from "./claudeArgs.js";
import { getJobPaths, resolveStateDir } from "./paths.js";
import { killProcessTree } from "./processTree.js";
export class ClaudeRetinue {
    stateDir;
    claudeCommand;
    claudePrefixArgs;
    env;
    defaultRuntimeTimeoutMs;
    maxConcurrentJobs;
    processes = new Map();
    killedJobIds = new Set();
    timedOutJobIds = new Set();
    constructor(options = {}) {
        this.stateDir = resolveStateDir({ explicitStateDir: options.stateDir, env: options.env });
        this.claudeCommand = options.claudeCommand ?? "claude";
        this.claudePrefixArgs = options.claudePrefixArgs ?? [];
        this.env = options.env ?? process.env;
        this.defaultRuntimeTimeoutMs = options.defaultRuntimeTimeoutMs;
        this.maxConcurrentJobs = options.maxConcurrentJobs ?? Number.POSITIVE_INFINITY;
    }
    getStateDir() {
        return this.stateDir;
    }
    async run(options) {
        if ((await this.countActiveJobs()) >= this.maxConcurrentJobs) {
            throw new Error(`Claude job concurrency limit reached: ${this.maxConcurrentJobs}`);
        }
        const jobId = `job_${randomUUID()}`;
        const paths = getJobPaths(this.stateDir, jobId);
        await fs.mkdir(paths.dir, { recursive: true });
        await fs.writeFile(paths.prompt, options.prompt, "utf8");
        const claudeArgs = buildClaudeArgs(options);
        const args = [...this.claudePrefixArgs, ...claudeArgs];
        const stdout = createWriteStream(paths.stdout, { flags: "a" });
        const stderr = createWriteStream(paths.stderr, { flags: "a" });
        const child = spawn(this.claudeCommand, args, {
            cwd: options.cwd,
            env: this.env,
            stdio: ["pipe", "pipe", "pipe"],
            detached: process.platform !== "win32"
        });
        child.stdout?.pipe(stdout);
        child.stderr?.pipe(stderr);
        child.stdin?.end(options.prompt);
        const now = new Date().toISOString();
        const runtimeTimeoutMs = options.timeoutMs ?? this.defaultRuntimeTimeoutMs;
        const meta = {
            schemaVersion: 1,
            backend: "claude-code",
            jobId,
            pid: child.pid ?? -1,
            status: "running",
            cwd: options.cwd,
            promptPath: paths.prompt,
            promptPreview: createPromptPreview(options.prompt),
            promptSha256: sha256(options.prompt),
            name: options.name,
            resume: options.resume,
            parentJobId: options.parentJobId,
            parentSessionId: options.parentSessionId,
            runtimeTimeoutMs,
            args: claudeArgs,
            createdAt: now,
            updatedAt: now
        };
        let resolveFinalized = () => { };
        const finalizedPromise = new Promise((resolve) => {
            resolveFinalized = resolve;
        });
        const tracked = { child, finalized: finalizedPromise };
        if (runtimeTimeoutMs !== undefined) {
            tracked.timeout = setTimeout(() => {
                this.timedOutJobIds.add(jobId);
                void killProcessTree(child.pid ?? -1);
            }, runtimeTimeoutMs);
            tracked.timeout.unref();
        }
        this.processes.set(jobId, tracked);
        let finalized = false;
        const finalize = async (exitCode, signal, forcedStatus) => {
            if (finalized) {
                return;
            }
            finalized = true;
            if (tracked.timeout) {
                clearTimeout(tracked.timeout);
            }
            await Promise.allSettled([finished(stdout), finished(stderr)]);
            const wasKilled = this.killedJobIds.has(jobId);
            const wasTimedOut = this.timedOutJobIds.has(jobId);
            const parsedStdout = parseJsonOutput(await readTextIfExists(paths.stdout));
            const sessionId = extractSessionId(parsedStdout);
            const status = {
                status: forcedStatus ?? (wasTimedOut ? "timed_out" : wasKilled ? "killed" : exitCode === 0 ? "completed" : "failed"),
                exitCode,
                signal,
                endedAt: new Date().toISOString()
            };
            await writeJsonAtomic(paths.exitStatus, status);
            await this.writeMeta({ ...meta, sessionId, status: status.status, updatedAt: status.endedAt });
            this.processes.delete(jobId);
            this.killedJobIds.delete(jobId);
            this.timedOutJobIds.delete(jobId);
            resolveFinalized();
        };
        child.once("close", (exitCode, signal) => {
            void finalize(exitCode, signal);
        });
        child.once("error", () => {
            void finalize(null, null, "failed");
        });
        await this.writeMeta(meta);
        return meta;
    }
    async status(jobId) {
        const meta = await this.readMeta(jobId);
        if (isProblem(meta)) {
            return meta;
        }
        if (meta.status !== "running") {
            return meta;
        }
        const paths = getJobPaths(this.stateDir, jobId);
        const exitStatus = await readJsonIfExists(paths.exitStatus);
        if (!exitStatus) {
            if (this.processes.has(jobId)) {
                return meta;
            }
            const updatedAt = new Date().toISOString();
            if (!isPidAlive(meta.pid)) {
                const orphaned = { ...meta, status: "orphaned", updatedAt };
                await this.writeMeta(orphaned);
                return orphaned;
            }
            if (!this.isOwnProcess(meta.pid)) {
                const abandoned = { ...meta, status: "abandoned", updatedAt };
                await this.writeMeta(abandoned);
                return abandoned;
            }
            return meta;
        }
        return { ...meta, status: exitStatus.status, updatedAt: exitStatus.endedAt };
    }
    async wait(jobId, options = {}) {
        const timeoutMs = options.timeoutMs ?? 60000;
        const pollIntervalMs = options.pollIntervalMs ?? 100;
        const start = Date.now();
        while (Date.now() - start <= timeoutMs) {
            const status = await this.status(jobId);
            if (status.status !== "running") {
                const exitStatus = await readJsonIfExists(getJobPaths(this.stateDir, jobId).exitStatus);
                return {
                    jobId,
                    status: status.status,
                    exitCode: exitStatus?.exitCode,
                    signal: exitStatus?.signal
                };
            }
            await sleep(pollIntervalMs);
        }
        return { jobId, status: "running" };
    }
    async result(jobId) {
        const meta = await this.status(jobId);
        if (isProblem(meta)) {
            return {
                jobId,
                status: meta.status,
                error: meta.error
            };
        }
        const paths = getJobPaths(this.stateDir, jobId);
        const [fullStdout, fullStderr, exitStatus] = await Promise.all([
            readTextIfExists(paths.stdout),
            readTextIfExists(paths.stderr),
            readJsonIfExists(paths.exitStatus)
        ]);
        const stdout = limitText(fullStdout, 65536);
        const stderr = limitText(fullStderr, 65536);
        const parsedStdout = parseJsonOutput(fullStdout);
        return {
            jobId,
            status: meta.status,
            stdout: stdout.text,
            stderr: stderr.text,
            stdoutPath: paths.stdout,
            stderrPath: paths.stderr,
            stdoutBytes: Buffer.byteLength(fullStdout, "utf8"),
            stderrBytes: Buffer.byteLength(fullStderr, "utf8"),
            stdoutTruncated: stdout.truncated,
            stderrTruncated: stderr.truncated,
            sessionId: meta.sessionId ?? extractSessionId(parsedStdout),
            parsedStdout,
            exitStatus
        };
    }
    async continueJob(options) {
        const parentSessionId = options.sessionId ?? (options.jobId ? await this.resolveSessionId(options.jobId) : undefined);
        if (!parentSessionId) {
            throw new Error("continueJob requires a sessionId or a jobId with a persisted sessionId");
        }
        return this.run({
            cwd: options.cwd,
            prompt: options.prompt,
            name: options.name,
            resume: parentSessionId,
            parentJobId: options.jobId,
            parentSessionId,
            maxTurns: options.maxTurns,
            permissionMode: options.permissionMode,
            timeoutMs: options.timeoutMs
        });
    }
    async resolveSessionId(jobId) {
        const meta = await this.status(jobId);
        if (!isProblem(meta) && meta.sessionId) {
            return meta.sessionId;
        }
        const result = await this.result(jobId);
        return result.sessionId;
    }
    async peek(jobId, options = {}) {
        const meta = await this.status(jobId);
        if (isProblem(meta)) {
            return { jobId, status: meta.status, error: meta.error };
        }
        const paths = getJobPaths(this.stateDir, jobId);
        const [stdout, stderr] = await Promise.all([
            readTextIfExists(paths.stdout),
            readTextIfExists(paths.stderr)
        ]);
        return {
            jobId,
            status: meta.status,
            stdoutTail: limitText(stdout, options.stdoutTailBytes ?? 4096).text,
            stderrTail: limitText(stderr, options.stderrTailBytes ?? 4096).text,
            stdoutPath: paths.stdout,
            stderrPath: paths.stderr
        };
    }
    async kill(jobId) {
        const meta = await this.status(jobId);
        if (isProblem(meta)) {
            return { jobId, status: meta.status };
        }
        if (meta.status !== "running") {
            return { jobId, status: meta.status };
        }
        const tracked = this.processes.get(jobId);
        this.killedJobIds.add(jobId);
        if (tracked?.child.pid) {
            await killProcessTree(tracked.child.pid);
            await waitWithTimeout(tracked.finalized, 5000);
            const afterKill = await this.status(jobId);
            return { jobId, status: afterKill.status === "running" ? "killed" : afterKill.status };
        }
        else {
            await killProcessTree(meta.pid);
        }
        const endedAt = new Date().toISOString();
        const exitStatus = {
            status: "killed",
            exitCode: null,
            signal: "SIGTERM",
            endedAt
        };
        const paths = getJobPaths(this.stateDir, jobId);
        await writeJsonAtomic(paths.exitStatus, exitStatus);
        await this.writeMeta({ ...meta, status: "killed", updatedAt: endedAt });
        this.processes.delete(jobId);
        this.killedJobIds.delete(jobId);
        return { jobId, status: "killed" };
    }
    async cleanup(options = {}) {
        const olderThanMs = options.olderThanMs ?? 0;
        const jobsDir = getJobsDir(this.stateDir);
        const removedJobIds = [];
        const removedTempFiles = [];
        const entries = await readDirIfExists(jobsDir);
        const now = Date.now();
        for (const entry of entries) {
            if (!entry.isDirectory()) {
                continue;
            }
            const jobId = entry.name;
            const meta = await this.status(jobId);
            if (isProblem(meta)) {
                continue;
            }
            if (meta.status === "running") {
                continue;
            }
            const updatedAt = Date.parse(meta.updatedAt);
            if (Number.isFinite(updatedAt) && now - updatedAt < olderThanMs) {
                continue;
            }
            const paths = getJobPaths(this.stateDir, jobId);
            removedTempFiles.push(...(await listTempFiles(paths.dir)));
            await fs.rm(paths.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
            removedJobIds.push(jobId);
        }
        return { removedJobIds, removedTempFiles };
    }
    async countActiveJobs() {
        if (!Number.isFinite(this.maxConcurrentJobs)) {
            return this.processes.size;
        }
        const jobsDir = getJobsDir(this.stateDir);
        const entries = await readDirIfExists(jobsDir);
        const activeJobIds = new Set();
        for (const entry of entries) {
            if (!entry.isDirectory()) {
                continue;
            }
            const status = await this.status(entry.name);
            if (status.status === "running") {
                activeJobIds.add(entry.name);
            }
        }
        for (const jobId of this.processes.keys()) {
            activeJobIds.add(jobId);
        }
        return activeJobIds.size;
    }
    async readMeta(jobId) {
        const paths = getJobPaths(this.stateDir, jobId);
        try {
            return normalizeMeta(JSON.parse(await fs.readFile(paths.meta, "utf8")));
        }
        catch (error) {
            if (isMissingFile(error)) {
                return { jobId, status: "not_found" };
            }
            return {
                jobId,
                status: "corrupted",
                error: error instanceof Error ? error.message : String(error)
            };
        }
    }
    async writeMeta(meta) {
        const paths = getJobPaths(this.stateDir, meta.jobId);
        await writeJsonAtomic(paths.meta, meta);
    }
    isOwnProcess(pid) {
        for (const tracked of this.processes.values()) {
            if (tracked.child.pid === pid) {
                return true;
            }
        }
        return false;
    }
}
function normalizeMeta(meta) {
    return {
        ...meta,
        backend: meta.backend ?? "claude-code"
    };
}
async function writeJsonAtomic(filePath, value) {
    await fs.mkdir(filePath.replace(/[\\/][^\\/]+$/, ""), { recursive: true });
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
    await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await fs.rename(tempPath, filePath);
}
async function readTextIfExists(filePath) {
    try {
        return await fs.readFile(filePath, "utf8");
    }
    catch (error) {
        if (isMissingFile(error)) {
            return "";
        }
        throw error;
    }
}
async function readJsonIfExists(filePath) {
    const text = await readTextIfExists(filePath);
    if (!text.trim()) {
        return undefined;
    }
    return JSON.parse(text);
}
function parseJsonOutput(stdout) {
    const trimmed = stdout.trim();
    if (!trimmed) {
        return undefined;
    }
    const lastLine = trimmed.split(/\r?\n/).at(-1);
    if (!lastLine) {
        return undefined;
    }
    try {
        return JSON.parse(lastLine);
    }
    catch {
        return undefined;
    }
}
function extractSessionId(parsedStdout) {
    if (typeof parsedStdout !== "object" || parsedStdout === null || !("session_id" in parsedStdout)) {
        return undefined;
    }
    const sessionId = parsedStdout.session_id;
    return typeof sessionId === "string" ? sessionId : undefined;
}
function createPromptPreview(prompt) {
    const normalized = prompt.replace(/\s+/g, " ").trim();
    return normalized.length > 120 ? `${normalized.slice(0, 117)}...` : normalized;
}
function sha256(value) {
    return createHash("sha256").update(value).digest("hex");
}
function limitText(text, maxBytes) {
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes <= maxBytes) {
        return { text, truncated: false };
    }
    const suffix = text.slice(-maxBytes);
    return { text: suffix, truncated: true };
}
function isPidAlive(pid) {
    if (pid <= 0) {
        return false;
    }
    try {
        process.kill(pid, 0);
        return true;
    }
    catch {
        return false;
    }
}
function isProblem(value) {
    return value.status === "not_found" || value.status === "corrupted";
}
function isMissingFile(error) {
    return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
function getJobsDir(stateDir) {
    return getJobPaths(stateDir, "placeholder").dir.replace(/[\\/]placeholder$/, "");
}
async function readDirIfExists(dirPath) {
    try {
        return await fs.readdir(dirPath, { withFileTypes: true });
    }
    catch (error) {
        if (isMissingFile(error)) {
            return [];
        }
        throw error;
    }
}
async function listTempFiles(dirPath) {
    const entries = await readDirIfExists(dirPath);
    return entries.filter((entry) => entry.isFile() && entry.name.endsWith(".tmp")).map((entry) => `${dirPath}${dirPath.includes("\\") ? "\\" : "/"}${entry.name}`);
}
function waitWithTimeout(promise, timeoutMs) {
    if (!promise) {
        return Promise.resolve();
    }
    return Promise.race([promise, sleep(timeoutMs)]);
}
//# sourceMappingURL=retinue.js.map