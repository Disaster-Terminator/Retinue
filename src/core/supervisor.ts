import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { finished } from "node:stream/promises";
import { buildClaudeArgs } from "./claudeArgs.js";
import { getJobPaths, resolveStateDir } from "./paths.js";
import { killProcessTree } from "./processTree.js";
import type {
  CleanupOptions,
  CleanupResult,
  ContinueOptions,
  ExitStatus,
  JobMeta,
  JobProblem,
  JobResult,
  JobStatusResult,
  KillResult,
  RunOptions,
  SupervisorOptions,
  WaitOptions,
  WaitResult
} from "./types.js";

interface TrackedProcess {
  child: ChildProcess;
  timeout?: NodeJS.Timeout;
  finalized?: Promise<void>;
}

export class ClaudeSupervisor {
  private readonly stateDir: string;
  private readonly claudeCommand: string;
  private readonly claudePrefixArgs: string[];
  private readonly env: NodeJS.ProcessEnv;
  private readonly defaultRuntimeTimeoutMs?: number;
  private readonly maxConcurrentJobs: number;
  private readonly processes = new Map<string, TrackedProcess>();
  private readonly killedJobIds = new Set<string>();
  private readonly timedOutJobIds = new Set<string>();

  constructor(options: SupervisorOptions = {}) {
    this.stateDir = resolveStateDir({ explicitStateDir: options.stateDir, env: options.env });
    this.claudeCommand = options.claudeCommand ?? "claude";
    this.claudePrefixArgs = options.claudePrefixArgs ?? [];
    this.env = options.env ?? process.env;
    this.defaultRuntimeTimeoutMs = options.defaultRuntimeTimeoutMs;
    this.maxConcurrentJobs = options.maxConcurrentJobs ?? Number.POSITIVE_INFINITY;
  }

  async run(options: RunOptions): Promise<JobMeta> {
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
    const meta: JobMeta = {
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
    let resolveFinalized: () => void = () => {};
    const finalizedPromise = new Promise<void>((resolve) => {
      resolveFinalized = resolve;
    });
    const tracked: TrackedProcess = { child, finalized: finalizedPromise };
    if (runtimeTimeoutMs !== undefined) {
      tracked.timeout = setTimeout(() => {
        this.timedOutJobIds.add(jobId);
        void killProcessTree(child.pid ?? -1);
      }, runtimeTimeoutMs);
      tracked.timeout.unref();
    }
    this.processes.set(jobId, tracked);
    let finalized = false;
    const finalize = async (
      exitCode: number | null,
      signal: NodeJS.Signals | null,
      forcedStatus?: ExitStatus["status"]
    ): Promise<void> => {
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
      const status: ExitStatus = {
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

  async status(jobId: string): Promise<JobStatusResult> {
    const meta = await this.readMeta(jobId);
    if (isProblem(meta)) {
      return meta;
    }
    if (meta.status !== "running") {
      return meta;
    }

    const paths = getJobPaths(this.stateDir, jobId);
    const exitStatus = await readJsonIfExists<ExitStatus>(paths.exitStatus);
    if (!exitStatus) {
      if (!this.processes.has(jobId) && !isPidAlive(meta.pid)) {
        const updatedAt = new Date().toISOString();
        const orphaned = { ...meta, status: "orphaned" as const, updatedAt };
        await this.writeMeta(orphaned);
        return orphaned;
      }
      return meta;
    }

    return { ...meta, status: exitStatus.status, updatedAt: exitStatus.endedAt };
  }

  async wait(jobId: string, options: WaitOptions = {}): Promise<WaitResult> {
    const timeoutMs = options.timeoutMs ?? 60000;
    const pollIntervalMs = options.pollIntervalMs ?? 100;
    const start = Date.now();

    while (Date.now() - start <= timeoutMs) {
      const status = await this.status(jobId);
      if (status.status !== "running") {
        const exitStatus = await readJsonIfExists<ExitStatus>(getJobPaths(this.stateDir, jobId).exitStatus);
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

  async result(jobId: string): Promise<JobResult> {
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
      readJsonIfExists<ExitStatus>(paths.exitStatus)
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

  async continueJob(options: ContinueOptions): Promise<JobMeta> {
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

  private async resolveSessionId(jobId: string): Promise<string | undefined> {
    const meta = await this.status(jobId);
    if (!isProblem(meta) && meta.sessionId) {
      return meta.sessionId;
    }
    const result = await this.result(jobId);
    return result.sessionId;
  }

  async kill(jobId: string): Promise<KillResult> {
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
    } else {
      await killProcessTree(meta.pid);
    }

    const endedAt = new Date().toISOString();
    const exitStatus: ExitStatus = {
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

  async cleanup(options: CleanupOptions = {}): Promise<CleanupResult> {
    const olderThanMs = options.olderThanMs ?? 0;
    const jobsDir = getJobsDir(this.stateDir);
    const removedJobIds: string[] = [];
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

      await fs.rm(getJobPaths(this.stateDir, jobId).dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      removedJobIds.push(jobId);
    }

    return { removedJobIds };
  }

  private async countActiveJobs(): Promise<number> {
    if (!Number.isFinite(this.maxConcurrentJobs)) {
      return this.processes.size;
    }

    const jobsDir = getJobsDir(this.stateDir);
    const entries = await readDirIfExists(jobsDir);
    const activeJobIds = new Set<string>();

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

  private async readMeta(jobId: string): Promise<JobMeta | JobProblem> {
    const paths = getJobPaths(this.stateDir, jobId);
    try {
      return JSON.parse(await fs.readFile(paths.meta, "utf8")) as JobMeta;
    } catch (error) {
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

  private async writeMeta(meta: JobMeta): Promise<void> {
    const paths = getJobPaths(this.stateDir, meta.jobId);
    await writeJsonAtomic(paths.meta, meta);
  }
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(filePath.replace(/[\\/][^\\/]+$/, ""), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(tempPath, filePath);
}

async function readTextIfExists(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (isMissingFile(error)) {
      return "";
    }
    throw error;
  }
}

async function readJsonIfExists<T>(filePath: string): Promise<T | undefined> {
  const text = await readTextIfExists(filePath);
  if (!text.trim()) {
    return undefined;
  }
  return JSON.parse(text) as T;
}

function parseJsonOutput(stdout: string): unknown {
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
  } catch {
    return undefined;
  }
}

function extractSessionId(parsedStdout: unknown): string | undefined {
  if (typeof parsedStdout !== "object" || parsedStdout === null || !("session_id" in parsedStdout)) {
    return undefined;
  }
  const sessionId = parsedStdout.session_id;
  return typeof sessionId === "string" ? sessionId : undefined;
}

function createPromptPreview(prompt: string): string {
  const normalized = prompt.replace(/\s+/g, " ").trim();
  return normalized.length > 120 ? `${normalized.slice(0, 117)}...` : normalized;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function limitText(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= maxBytes) {
    return { text, truncated: false };
  }
  const suffix = text.slice(-maxBytes);
  return { text: suffix, truncated: true };
}

function isPidAlive(pid: number): boolean {
  if (pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isProblem(value: JobStatusResult): value is JobProblem {
  return value.status === "not_found" || value.status === "corrupted";
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getJobsDir(stateDir: string): string {
  return getJobPaths(stateDir, "placeholder").dir.replace(/[\\/]placeholder$/, "");
}

async function readDirIfExists(dirPath: string) {
  try {
    return await fs.readdir(dirPath, { withFileTypes: true });
  } catch (error) {
    if (isMissingFile(error)) {
      return [];
    }
    throw error;
  }
}

function waitWithTimeout(promise: Promise<void> | undefined, timeoutMs: number): Promise<void> {
  if (!promise) {
    return Promise.resolve();
  }
  return Promise.race([promise, sleep(timeoutMs)]);
}
