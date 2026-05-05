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

export class DaemonClientError extends Error {
  readonly code?: string;
  readonly status: number;
  readonly path: string;

  constructor(message: string, details: { code?: string; status: number; path: string }) {
    super(message);
    this.name = "DaemonClientError";
    this.code = details.code;
    this.status = details.status;
    this.path = details.path;
  }
}

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
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });
    } catch (error) {
      const transport = classifyTransportError(error);
      throw new DaemonClientError(transport.message, { code: transport.code, status: 0, path });
    }
    const text = await response.text();
    const parsed = parseJson(text);
    if (!response.ok) {
      const error = extractDaemonError(parsed);
      const message = error?.message ?? `Daemon request failed with HTTP ${response.status}`;
      throw new DaemonClientError(message, { code: error?.code, status: response.status, path });
    }
    return parsed as T;
  }
}

function classifyTransportError(error: unknown): { message: string; code: string } {
  const maybeError = error as { name?: unknown } | undefined;
  const name = typeof maybeError?.name === "string" ? maybeError.name : "";
  if (name === "AbortError" || name === "TimeoutError") {
    return { message: "Daemon request timed out or was aborted", code: "transport_aborted" };
  }
  return { message: "Unable to reach daemon", code: "transport_unreachable" };
}

function parseJson(text: string): unknown {
  if (!text.trim()) {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function extractDaemonError(value: unknown): { message: string; code?: string } | undefined {
  if (typeof value !== "object" || value === null || !("error" in value)) {
    return undefined;
  }
  const error = value.error;
  if (typeof error === "string") {
    return { message: error };
  }
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = String(error.message);
    const code = "code" in error && typeof error.code === "string" ? error.code : undefined;
    return { message, code };
  }
  return undefined;
}
