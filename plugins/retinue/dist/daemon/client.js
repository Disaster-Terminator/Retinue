import { fetchWithTimeout, resolveHttpTimeoutMs } from "../core/http.js";
import { validateLoopbackHttpUrl } from "./discovery.js";
export class DaemonClientError extends Error {
    code;
    status;
    path;
    details;
    constructor(message, details) {
        super(message);
        this.name = "DaemonClientError";
        this.code = details.code;
        this.status = details.status;
        this.path = details.path;
        this.details = details.details;
    }
}
export class DaemonClient {
    baseUrl;
    timeoutMs;
    token;
    constructor(baseUrl, options = {}) {
        this.baseUrl = validateLoopbackHttpUrl(baseUrl);
        this.timeoutMs = options.timeoutMs ?? resolveHttpTimeoutMs();
        this.token = options.token;
    }
    run(options) {
        return this.post("/v1/jobs/run", options);
    }
    status(jobId) {
        return this.post("/v1/jobs/status", { jobId });
    }
    wait(jobId, options = {}) {
        return this.post("/v1/jobs/wait", { jobId, ...options });
    }
    result(jobId) {
        return this.post("/v1/jobs/result", { jobId });
    }
    continueJob(options) {
        return this.post("/v1/jobs/continue", options);
    }
    peek(jobId, options = {}) {
        return this.post("/v1/jobs/peek", { jobId, ...options });
    }
    kill(jobId) {
        return this.post("/v1/jobs/kill", { jobId });
    }
    cleanup(options = {}) {
        return this.post("/v1/jobs/cleanup", options);
    }
    async post(path, body) {
        let response;
        try {
            response = await fetchWithTimeout(`${this.baseUrl}${path}`, {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    ...(this.token ? { authorization: `Bearer ${this.token}` } : {})
                },
                body: JSON.stringify(body)
            }, this.timeoutMs);
        }
        catch (error) {
            const transport = classifyTransportError(error);
            throw new DaemonClientError(transport.message, { code: transport.code, status: 0, path });
        }
        const text = await response.text();
        const parsed = parseJson(text);
        if (!response.ok) {
            const error = parsed.ok ? extractDaemonError(parsed.value) : undefined;
            const message = error?.message ?? `Daemon request failed with HTTP ${response.status}`;
            throw new DaemonClientError(message, {
                code: error?.code,
                status: response.status,
                path,
                details: parsed.ok ? parsed.value : text
            });
        }
        if (!parsed.ok) {
            throw new DaemonClientError("Daemon response was not valid JSON", {
                code: "invalid_json",
                status: response.status,
                path,
                details: text
            });
        }
        return parsed.value;
    }
}
function classifyTransportError(error) {
    const maybeError = error;
    const name = typeof maybeError?.name === "string" ? maybeError.name : "";
    if (name === "AbortError" || name === "TimeoutError") {
        return { message: "Daemon request timed out or was aborted", code: "transport_aborted" };
    }
    return { message: "Unable to reach daemon", code: "transport_unreachable" };
}
function parseJson(text) {
    if (!text.trim()) {
        return { ok: false };
    }
    try {
        return { ok: true, value: JSON.parse(text) };
    }
    catch {
        return { ok: false };
    }
}
function extractDaemonError(value) {
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
//# sourceMappingURL=client.js.map