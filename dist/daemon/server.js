import http from "node:http";
import { timingSafeEqual } from "node:crypto";
const version = "0.1.0";
class DaemonHttpError extends Error {
    statusCode;
    code;
    constructor(statusCode, code, message) {
        super(message);
        this.statusCode = statusCode;
        this.code = code;
    }
}
export function createDaemonServer(retinue, options = {}) {
    const maxBodyBytes = options.maxBodyBytes ?? 1024 * 1024;
    if (!options.authToken && !options.allowUnauthenticated) {
        throw new Error("Retinue daemon requires an auth token. Pass authToken or explicitly set allowUnauthenticated for tests.");
    }
    const routes = new Map([
        ["POST /v1/jobs/run", (body) => retinue.run(body)],
        ["POST /v1/jobs/status", (body) => retinue.status(requiredJobId(body))],
        ["POST /v1/jobs/wait", (body) => {
                const input = requiredObject(body);
                return retinue.wait(requiredJobId(input), {
                    timeoutMs: optionalNumber(input.timeoutMs)
                });
            }],
        ["POST /v1/jobs/result", (body) => retinue.result(requiredJobId(body))],
        ["POST /v1/jobs/continue", (body) => retinue.continueJob(body)],
        ["POST /v1/jobs/peek", (body) => {
                const input = requiredObject(body);
                return retinue.peek(requiredJobId(input), {
                    stdoutTailBytes: optionalNumber(input.stdoutTailBytes),
                    stderrTailBytes: optionalNumber(input.stderrTailBytes)
                });
            }],
        ["POST /v1/jobs/kill", (body) => retinue.kill(requiredJobId(body))],
        ["POST /v1/jobs/cleanup", (body) => retinue.cleanup((body ?? {}))]
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
        }
        catch (error) {
            writeError(response, normalizeDaemonError(error));
        }
    });
}
function authenticateRequest(request, authToken) {
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
function isSameSecret(actual, expected) {
    const actualBytes = Buffer.from(actual);
    const expectedBytes = Buffer.from(expected);
    return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}
function requiredJobId(body) {
    const input = requiredObject(body);
    if (typeof input.jobId !== "string" || !input.jobId) {
        throw new Error("Missing required jobId");
    }
    return input.jobId;
}
function requiredObject(value) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error("Expected JSON object body");
    }
    return value;
}
function optionalNumber(value) {
    if (value === undefined) {
        return undefined;
    }
    if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error(`Expected number, got ${typeof value}`);
    }
    return value;
}
async function readJsonBody(request, maxBodyBytes) {
    const chunks = [];
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
    }
    catch (error) {
        throw new DaemonHttpError(400, "bad_json", error instanceof Error ? error.message : String(error));
    }
}
function writeJson(response, statusCode, value) {
    response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
    response.end(`${JSON.stringify(value, null, 2)}\n`);
}
function writeError(response, error) {
    writeJson(response, error.statusCode, {
        error: {
            code: error.code,
            message: error.message
        }
    });
}
function normalizeDaemonError(error) {
    if (error instanceof DaemonHttpError) {
        return error;
    }
    if (error instanceof Error) {
        return new DaemonHttpError(400, "invalid_request", error.message);
    }
    return new DaemonHttpError(500, "internal_error", String(error));
}
//# sourceMappingURL=server.js.map