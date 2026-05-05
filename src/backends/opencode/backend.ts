import fs from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { getJobPaths, resolveStateDir } from "../../core/paths.js";
import type { CleanupOptions, CleanupResult, JobMeta, JobProblem, JobResult, JobStatusResult, SupervisorOptions } from "../../core/types.js";
import type { AgentBackend, AgentContinueOptions, AgentHandle, AgentRunOptions } from "../types.js";
import { OpenCodeClient, OpenCodeClientError } from "./client.js";

export interface OpenCodeBackendOptions {
  client: OpenCodeClient;
  baseUrl: string;
  stateDir?: string;
  env?: SupervisorOptions["env"];
}

export class OpenCodeBackend implements AgentBackend {
  readonly kind = "opencode" as const;
  private readonly client: OpenCodeClient;
  private readonly baseUrl: string;
  private readonly stateDir: string;

  constructor(options: OpenCodeBackendOptions) {
    this.client = options.client;
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.stateDir = resolveStateDir({ explicitStateDir: options.stateDir, env: options.env });
  }

  async run(options: AgentRunOptions): Promise<JobMeta> { /* unchanged */
    const jobId = `job_${randomUUID()}`;
    const paths = getJobPaths(this.stateDir, jobId);
    await fs.mkdir(paths.dir, { recursive: true });
    await fs.writeFile(paths.prompt, options.prompt, "utf8");
    const session = await this.client.createSession({ cwd: options.cwd, title: options.title ?? options.name });
    await this.client.promptAsync(session.id, { prompt: options.prompt, model: options.model, agent: options.agent });
    const now = new Date().toISOString();
    const meta: JobMeta = { schemaVersion: 1, backend: "opencode", jobId, pid: -1, status: "running", cwd: options.cwd, promptPath: paths.prompt, promptPreview: createPromptPreview(options.prompt), promptSha256: sha256(options.prompt), name: options.name, title: options.title, model: options.model, agent: options.agent, externalSessionId: session.id, externalServerUrl: this.baseUrl, args: [], createdAt: now, updatedAt: now };
    await writeJsonAtomic(paths.meta, meta);
    return meta;
  }

  async continueJob(options: AgentContinueOptions): Promise<JobMeta> { /* unchanged */
    if (!options.externalSessionId) return this.run(options);
    const jobId = `job_${randomUUID()}`;
    const paths = getJobPaths(this.stateDir, jobId);
    await fs.mkdir(paths.dir, { recursive: true });
    await fs.writeFile(paths.prompt, options.prompt, "utf8");
    await this.client.promptAsync(options.externalSessionId, { prompt: options.prompt, model: options.model, agent: options.agent });
    const now = new Date().toISOString();
    const meta: JobMeta = { schemaVersion: 1, backend: "opencode", jobId, pid: -1, status: "running", cwd: options.cwd, promptPath: paths.prompt, promptPreview: createPromptPreview(options.prompt), promptSha256: sha256(options.prompt), name: options.name, title: options.title, model: options.model, agent: options.agent, externalSessionId: options.externalSessionId, externalServerUrl: this.baseUrl, parentJobId: options.parentJobId, parentSessionId: options.parentSessionId, args: [], createdAt: now, updatedAt: now };
    await writeJsonAtomic(paths.meta, meta);
    return meta;
  }

  async status(handle: AgentHandle): Promise<JobStatusResult> {
    const meta = await this.readMeta(handle.jobId);
    if (isProblem(meta) || !meta.externalSessionId) return meta;
    return this.reconcileMeta(meta);
  }

  async result(handle: AgentHandle): Promise<JobResult> {
    const status = await this.status(handle);
    if (isProblem(status)) return { jobId: handle.jobId, status: status.status, error: status.error };
    if (!status.externalSessionId) return { jobId: handle.jobId, status: "corrupted", error: "Missing OpenCode session id" };
    const messages = await this.client.messages(status.externalSessionId);
    const text = [...messages].reverse().map(extractMessageText).find((t) => t.length > 0) ?? "";
    return { jobId: handle.jobId, status: status.status, stdout: text, stderr: "", stdoutPath: getJobPaths(this.stateDir, handle.jobId).stdout, stderrPath: getJobPaths(this.stateDir, handle.jobId).stderr, stdoutBytes: Buffer.byteLength(text, "utf8"), stderrBytes: 0, stdoutTruncated: false, stderrTruncated: false, sessionId: status.externalSessionId, parsedStdout: { result: text } };
  }

  async abort(handle: AgentHandle): Promise<void> { const meta = await this.readMeta(handle.jobId); if (isProblem(meta) || !meta.externalSessionId) return; await this.client.abort(meta.externalSessionId); await writeJsonAtomic(getJobPaths(this.stateDir, handle.jobId).meta, { ...meta, status: "killed", updatedAt: new Date().toISOString() }); }

  async cleanup(options: CleanupOptions = {}): Promise<CleanupResult> { const olderThanMs = options.olderThanMs ?? 0; const removedJobIds: string[] = []; const removedTempFiles: string[] = []; const now = Date.now(); for (const entry of await readDirIfExists(getJobsDir(this.stateDir))) { if (!entry.isDirectory()) continue; const meta = await this.readMeta(entry.name); if (isProblem(meta) || meta.backend !== "opencode" || meta.status === "running") continue; const updatedAt = Date.parse(meta.updatedAt); if (Number.isFinite(updatedAt) && now - updatedAt < olderThanMs) continue; const paths = getJobPaths(this.stateDir, entry.name); removedTempFiles.push(...(await listTempFiles(paths.dir))); await fs.rm(paths.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); removedJobIds.push(entry.name);} return { removedJobIds, removedTempFiles }; }

  private async reconcileMeta(meta: JobMeta): Promise<JobMeta> {
    const live = await this.resolveLiveStatus(meta.externalSessionId!);
    if (live === meta.status) return meta;
    const updated = { ...meta, status: live, updatedAt: new Date().toISOString() };
    await writeJsonAtomic(getJobPaths(this.stateDir, meta.jobId).meta, updated);
    return updated;
  }

  private async resolveLiveStatus(sessionId: string): Promise<JobMeta["status"]> {
    try {
      const session = await this.client.getSession(sessionId) as { state?: string; aborted?: boolean; failed?: boolean };
      if (session.aborted) return "killed";
      if (session.failed || session.state === "failed") return "failed";
      if (session.state === "completed") return "completed";
      return "running";
    } catch (error) {
      if (error instanceof OpenCodeClientError && error.status === 404) return "not_found";
      return "corrupted";
    }
  }

  private async readMeta(jobId: string): Promise<JobMeta | JobProblem> { try { return JSON.parse(await fs.readFile(getJobPaths(this.stateDir, jobId).meta, "utf8")) as JobMeta; } catch (error) { if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return { jobId, status: "not_found" }; return { jobId, status: "corrupted", error: error instanceof Error ? error.message : String(error) }; } }
}
function isProblem(value: JobStatusResult): value is JobProblem { return value.status === "not_found" || value.status === "corrupted"; }
function extractMessageText(message: { parts?: Array<{ type?: string; text?: string }> }): string { if (!Array.isArray(message.parts)) return ""; return message.parts.filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => part.text ?? "").join(""); }
async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> { await fs.mkdir(filePath.replace(/[\\/][^\\/]+$/, ""), { recursive: true }); const tempPath = `${filePath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`; await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8"); await fs.rename(tempPath, filePath);} 
function createPromptPreview(prompt: string): string { const normalized = prompt.replace(/\s+/g, " ").trim(); return normalized.length > 120 ? `${normalized.slice(0, 117)}...` : normalized; }
function sha256(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function getJobsDir(stateDir: string): string { return getJobPaths(stateDir, "placeholder").dir.replace(/[\\/]placeholder$/, ""); }
async function readDirIfExists(dirPath: string) { try { return await fs.readdir(dirPath, { withFileTypes: true }); } catch (error) { if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return []; throw error; } }
async function listTempFiles(dirPath: string): Promise<string[]> { const entries = await readDirIfExists(dirPath); return entries.filter((entry) => entry.isFile() && entry.name.endsWith(".tmp")).map((entry) => `${dirPath}${dirPath.includes("\\") ? "\\" : "/"}${entry.name}`); }
