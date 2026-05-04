import type {
  CleanupOptions,
  CleanupResult,
  ContinueOptions,
  JobMeta,
  JobResult,
  JobStatusResult,
  KillResult,
  PeekOptions,
  PeekResult,
  RunOptions,
  SupervisorApi,
  WaitOptions,
  WaitResult
} from "../core/types.js";

export class DaemonClient implements SupervisorApi {
  private readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  run(options: RunOptions): Promise<JobMeta> {
    return this.post("/v1/jobs/run", options);
  }

  status(jobId: string): Promise<JobStatusResult> {
    return this.post("/v1/jobs/status", { jobId });
  }

  wait(jobId: string, options: WaitOptions = {}): Promise<WaitResult> {
    return this.post("/v1/jobs/wait", { jobId, ...options });
  }

  result(jobId: string): Promise<JobResult> {
    return this.post("/v1/jobs/result", { jobId });
  }

  continueJob(options: ContinueOptions): Promise<JobMeta> {
    return this.post("/v1/jobs/continue", options);
  }

  peek(jobId: string, options: PeekOptions = {}): Promise<PeekResult> {
    return this.post("/v1/jobs/peek", { jobId, ...options });
  }

  kill(jobId: string): Promise<KillResult> {
    return this.post("/v1/jobs/kill", { jobId });
  }

  cleanup(options: CleanupOptions = {}): Promise<CleanupResult> {
    return this.post("/v1/jobs/cleanup", options);
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    const text = await response.text();
    const parsed = text.trim() ? JSON.parse(text) : undefined;
    if (!response.ok) {
      const message =
        typeof parsed === "object" && parsed !== null && "error" in parsed
          ? String(parsed.error)
          : `Daemon request failed with HTTP ${response.status}`;
      throw new Error(message);
    }
    return parsed as T;
  }
}
