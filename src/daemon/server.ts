import http from "node:http";
import type { ClaudeSupervisor } from "../core/supervisor.js";
import { parseDaemonBackend } from "./backend.js";
import type {
  CleanupOptions,
  ContinueOptions,
  PeekOptions,
  RunOptions,
  WaitOptions
} from "../core/types.js";

const version = "0.1.0";

type RouteHandler = (body: unknown) => Promise<unknown>;
type DaemonErrorCode = "not_found" | "bad_json" | "body_too_large" | "invalid_request" | "internal_error";

export interface DaemonServerOptions {
  maxBodyBytes?: number;
}

class DaemonHttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: DaemonErrorCode,
    message: string
  ) {
    super(message);
  }
}

export function createDaemonServer(supervisor: ClaudeSupervisor, options: DaemonServerOptions = {}): http.Server {
  const maxBodyBytes = options.maxBodyBytes ?? 1024 * 1024;
  const routes = new Map<string, RouteHandler>([
    ["POST /v1/jobs/run", (body) => {
      const input = requiredObject(body);
      const backend = parseDaemonBackend(input.backend);
      if (backend !== "claude-code") {
        throw new Error(`Backend not yet supported by daemon: ${backend}`);
      }
      return supervisor.run(input as unknown as RunOptions);
    }],
    ["POST /v1/jobs/status", (body) => supervisor.status(requiredJobId(body))],
    ["POST /v1/jobs/wait", (body) => {
      const input = requiredObject(body);
      return supervisor.wait(requiredJobId(input), {
        timeoutMs: optionalNumber(input.timeoutMs)
      } satisfies WaitOptions);
    }],
    ["POST /v1/jobs/result", (body) => supervisor.result(requiredJobId(body))],
    ["POST /v1/jobs/continue", (body) => supervisor.continueJob(body as ContinueOptions)],
    ["POST /v1/jobs/peek", (body) => {
      const input = requiredObject(body);
      return supervisor.peek(requiredJobId(input), {
        stdoutTailBytes: optionalNumber(input.stdoutTailBytes),
        stderrTailBytes: optionalNumber(input.stderrTailBytes)
      } satisfies PeekOptions);
    }],
    ["POST /v1/jobs/kill", (body) => supervisor.kill(requiredJobId(body))],
    ["POST /v1/jobs/cleanup", (body) => supervisor.cleanup((body ?? {}) as CleanupOptions)]
  ]);

  return http.createServer(async (request, response) => {
    try {
      if (request.method === "GET" && request.url === "/health") {
        writeJson(response, 200, {
          status: "ok",
          version,
          pid: process.pid,
          stateDir: supervisor.getStateDir()
        });
        return;
      }

      const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      const handler = routes.get(`${request.method ?? "GET"} ${path}`);
      if (!handler) {
        writeError(response, new DaemonHttpError(404, "not_found", `Route not found: ${request.method ?? "GET"} ${path}`));
        return;
      }

      const body = await readJsonBody(request, maxBodyBytes);
      writeJson(response, 200, await handler(body));
    } catch (error) {
      writeError(response, normalizeDaemonError(error));
    }
  });
}

function requiredJobId(body: unknown): string {
  const input = requiredObject(body);
  if (typeof input.jobId !== "string" || !input.jobId) {
    throw new Error("Missing required jobId");
  }
  return input.jobId;
}

function requiredObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Expected JSON object body");
  }
  return value as Record<string, unknown>;
}

function optionalNumber(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Expected number, got ${typeof value}`);
  }
  return value;
}

async function readJsonBody(request: http.IncomingMessage, maxBodyBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.byteLength;
    if (totalBytes > maxBodyBytes) {
      throw new DaemonHttpError(413, "body_too_large", `JSON body exceeds ${maxBodyBytes} bytes`);
    }
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new DaemonHttpError(400, "bad_json", error instanceof Error ? error.message : String(error));
  }
}

function writeJson(response: http.ServerResponse, statusCode: number, value: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(`${JSON.stringify(value, null, 2)}\n`);
}

function writeError(response: http.ServerResponse, error: DaemonHttpError): void {
  writeJson(response, error.statusCode, {
    error: {
      code: error.code,
      message: error.message
    }
  });
}

function normalizeDaemonError(error: unknown): DaemonHttpError {
  if (error instanceof DaemonHttpError) {
    return error;
  }
  if (error instanceof Error) {
    return new DaemonHttpError(400, "invalid_request", error.message);
  }
  return new DaemonHttpError(500, "internal_error", String(error));
}
