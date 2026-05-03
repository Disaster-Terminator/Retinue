import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { buildClaudeArgs } from "./claudeArgs.js";
import { getJobPaths, resolveStateDir } from "./paths.js";
import { killProcessTree } from "./processTree.js";
import type {
  CleanupOptions,
  CleanupResult,
  ExitStatus,
  JobMeta,
  JobResult,
  JobStatus,
  KillResult,
  RunOptions,
  SupervisorOptions,
  WaitOptions,
  WaitResult
} from "./types.js";

interface TrackedProcess {
  child: ChildProcess;
}

export class ClaudeSupervisor {
  private readonly stateDir: string;
  private readonly claudeCommand: string;
  private readonly claudePrefixArgs: string[];
  private readonly env: NodeJS.ProcessEnv;
  private readonly processes = new Map<string, TrackedProcess>();
  private readonly killedJobIds = new Set<string>();

  constructor(options: SupervisorOptions = {}) {
    this.stateDir = resolveStateDir({ explicitStateDir: options.stateDir, env: options.env });
    this.claudeCommand = options.claudeCommand ?? "claude";
    this.claudePrefixArgs = options.claudePrefixArgs ?? [];
    this.env = options.env ?? process.env;
  }

  async run(options: RunOptions): Promise<JobMeta> {
    const jobId = `job_${randomUUID()}`;
    const paths = getJobPaths(this.stateDir, jobId);
    await fs.mkdir(paths.dir, { recursive: true });

    const claudeArgs = buildClaudeArgs(options);
    const args = [...this.claudePrefixArgs, ...claudeArgs];
    const stdout = createWriteStream(paths.stdout, { flags: "a" });
    const stderr = createWriteStream(paths.stderr, { flags: "a" });
    const child = spawn(this.claudeCommand, args, {
      cwd: options.cwd,
      env: this.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32"
    });

    child.stdout?.pipe(stdout);
    child.stderr?.pipe(stderr);

    const now = new Date().toISOString();
    const meta: JobMeta = {
      jobId,
      pid: child.pid ?? -1,
      status: "running",
      cwd: options.cwd,
      prompt: options.prompt,
      name: options.name,
      resume: options.resume,
      args: claudeArgs,
      createdAt: now,
      updatedAt: now
    };
    await this.writeMeta(meta);
    this.processes.set(jobId, { child });

    child.once("exit", async (exitCode, signal) => {
      stdout.end();
      stderr.end();
      const wasKilled = this.killedJobIds.has(jobId);
      const status: ExitStatus = {
        status: wasKilled ? "killed" : exitCode === 0 ? "completed" : "failed",
        exitCode,
        signal,
        endedAt: new Date().toISOString()
      };
      await fs.writeFile(paths.exitStatus, `${JSON.stringify(status, null, 2)}\n`, "utf8");
      await this.writeMeta({ ...meta, status: status.status, updatedAt: status.endedAt });
      this.processes.delete(jobId);
      this.killedJobIds.delete(jobId);
    });

    child.once("error", async () => {
      stdout.end();
      stderr.end();
      const endedAt = new Date().toISOString();
      const status: ExitStatus = { status: "failed", exitCode: null, signal: null, endedAt };
      await fs.writeFile(paths.exitStatus, `${JSON.stringify(status, null, 2)}\n`, "utf8");
      await this.writeMeta({ ...meta, status: "failed", updatedAt: endedAt });
      this.processes.delete(jobId);
    });

    return meta;
  }

  async status(jobId: string): Promise<JobMeta> {
    const meta = await this.readMeta(jobId);
    if (meta.status !== "running") {
      return meta;
    }

    const paths = getJobPaths(this.stateDir, jobId);
    const exitStatus = await readJsonIfExists<ExitStatus>(paths.exitStatus);
    if (!exitStatus) {
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
    const paths = getJobPaths(this.stateDir, jobId);
    const [stdout, stderr, exitStatus] = await Promise.all([
      readTextIfExists(paths.stdout),
      readTextIfExists(paths.stderr),
      readJsonIfExists<ExitStatus>(paths.exitStatus)
    ]);

    return {
      jobId,
      status: meta.status,
      stdout,
      stderr,
      parsedStdout: parseJsonOutput(stdout),
      exitStatus
    };
  }

  async kill(jobId: string): Promise<KillResult> {
    const meta = await this.status(jobId);
    if (meta.status !== "running") {
      return { jobId, status: meta.status };
    }

    const tracked = this.processes.get(jobId);
    this.killedJobIds.add(jobId);
    if (tracked?.child.pid) {
      await killProcessTree(tracked.child.pid);
      await waitForProcessClose(tracked.child, 5000);
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
    await fs.writeFile(paths.exitStatus, `${JSON.stringify(exitStatus, null, 2)}\n`, "utf8");
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
      if (meta.status === "running") {
        continue;
      }

      const updatedAt = Date.parse(meta.updatedAt);
      if (Number.isFinite(updatedAt) && now - updatedAt < olderThanMs) {
        continue;
      }

      await fs.rm(getJobPaths(this.stateDir, jobId).dir, { recursive: true, force: true });
      removedJobIds.push(jobId);
    }

    return { removedJobIds };
  }

  private async readMeta(jobId: string): Promise<JobMeta> {
    const paths = getJobPaths(this.stateDir, jobId);
    return JSON.parse(await fs.readFile(paths.meta, "utf8")) as JobMeta;
  }

  private async writeMeta(meta: JobMeta): Promise<void> {
    const paths = getJobPaths(this.stateDir, meta.jobId);
    await fs.writeFile(paths.meta, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
  }
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

function waitForProcessClose(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    child.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
