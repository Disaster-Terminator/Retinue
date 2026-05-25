import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { ClaudeRetinue } from "../core/retinue.js";
import type {
  CleanupOptions,
  ContinueOptions,
  PeekOptions,
  RunOptions,
  WaitOptions
} from "../core/types.js";

const version = "0.1.0";

type RouteHandler = (body: unknown) => Promise<unknown>;
type DaemonErrorCode = "not_found" | "bad_json" | "body_too_large" | "invalid_request" | "unauthorized" | "internal_error";

export interface DaemonServerOptions {
  maxBodyBytes?: number;
  authToken?: string;
  allowUnauthenticated?: boolean;
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

export function createDaemonServer(retinue: ClaudeRetinue, options: DaemonServerOptions = {}): http.Server {
  const maxBodyBytes = options.maxBodyBytes ?? 1024 * 1024;
  if (!options.authToken && !options.allowUnauthenticated) {
    throw new Error("Retinue daemon requires an auth token. Pass authToken or explicitly set allowUnauthenticated for tests.");
  }
  const routes = new Map<string, RouteHandler>([
    ["POST /v1/jobs/run", (body) => retinue.run(body as RunOptions)],
    ["POST /v1/jobs/status", (body) => retinue.status(requiredJobId(body))],
    ["POST /v1/jobs/wait", (body) => {
      const input = requiredObject(body);
      return retinue.wait(requiredJobId(input), {
        timeoutMs: optionalNumber(input.timeoutMs)
      } satisfies WaitOptions);
    }],
    ["POST /v1/jobs/result", (body) => retinue.result(requiredJobId(body))],
    ["POST /v1/jobs/continue", (body) => retinue.continueJob(body as ContinueOptions)],
    ["POST /v1/jobs/peek", (body) => {
      const input = requiredObject(body);
      return retinue.peek(requiredJobId(input), {
        stdoutTailBytes: optionalNumber(input.stdoutTailBytes),
        stderrTailBytes: optionalNumber(input.stderrTailBytes)
      } satisfies PeekOptions);
    }],
    ["POST /v1/jobs/kill", (body) => retinue.kill(requiredJobId(body))],
    ["POST /v1/jobs/cleanup", (body) => retinue.cleanup((body ?? {}) as CleanupOptions)]
  ]);

  return http.createServer(async (request, response) => {
    try {
      authenticateRequest(request, options.authToken);
      if (request.method === "GET" && request.url === "/health") {
        writeJson(response, 200, {
          status: "ok",
          version,
          pid: process.pid,
          stateDir: retinue.getStateDir()
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

function authenticateRequest(request: http.IncomingMessage, authToken: string | undefined): void {
  if (!authToken) {
    return;
  }
  const authorization = request.headers.authorization;
  const bearer = typeof authorization === "string" && authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : undefined;
  const headerToken = typeof request.headers["x-retinue-daemon-token"] === "string" ? request.headers["x-retinue-daemon-token"] : undefined;
  if (!isSameSecret(bearer ?? headerToken ?? "", authToken)) {
    throw new DaemonHttpError(401, "unauthorized", "Missing or invalid Retinue daemon token");
  }
}

function isSameSecret(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
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
