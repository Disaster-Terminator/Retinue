import { fetchWithTimeout } from "../../core/http.js";
export class OpenCodeClientError extends Error {
    code;
    status;
    path;
    details;
    constructor(message, code, status, path, details) {
        super(message);
        this.code = code;
        this.status = status;
        this.path = path;
        this.details = details;
        this.name = "OpenCodeClientError";
    }
}
export class OpenCodeClient {
    baseUrl;
    timeoutMs;
    constructor(baseUrl, options = {}) {
        this.baseUrl = baseUrl.replace(/\/+$/, "");
        this.timeoutMs = options.timeoutMs ?? 30_000;
    }
    health() {
        return this.request("GET", "/global/health");
    }
    agents() {
        return this.request("GET", "/agent");
    }
    permissions() {
        return this.request("GET", "/permission");
    }
    createSession(options = {}) {
        return this.request("POST", "/session", {
            title: options.title,
            parentID: options.parentID,
            agent: options.agent,
            model: formatModelOverride(options.model),
            workspaceID: options.workspaceID,
            permission: options.permission,
            directory: options.cwd
        });
    }
    listSessions() {
        return this.request("GET", "/session");
    }
    getSession(sessionId) {
        return this.request("GET", `/session/${encodeURIComponent(sessionId)}`);
    }
    children(sessionId) {
        return this.request("GET", `/session/${encodeURIComponent(sessionId)}/children`);
    }
    promptAsync(sessionId, options) {
        return this.requestVoid("POST", `/session/${encodeURIComponent(sessionId)}/prompt_async`, {
            model: formatModelOverride(options.model),
            agent: options.agent,
            tools: options.tools,
            parts: options.parts ?? [{ type: "text", text: options.prompt ?? "" }]
        });
    }
    messages(sessionId) {
        return this.request("GET", `/session/${encodeURIComponent(sessionId)}/message`);
    }
    abort(sessionId) {
        return this.request("POST", `/session/${encodeURIComponent(sessionId)}/abort`, {});
    }
    async request(method, path, body) {
        const response = await this.fetch(method, path, body);
        const text = await response.text();
        if (!response.ok) {
            const parsed = parseJson(text);
            const details = parsed.ok ? parsed.value : text;
            const message = parsed.ok ? extractErrorMessage(parsed.value) : undefined;
            throw new OpenCodeClientError(message ?? `OpenCode request failed with HTTP ${response.status}`, "http_error", response.status, path, details);
        }
        const parsed = parseJson(text);
        if (!parsed.ok) {
            throw new OpenCodeClientError("OpenCode response was not valid JSON", "invalid_json", response.status, path, text);
        }
        return parsed.value;
    }
    async requestVoid(method, path, body) {
        const response = await this.fetch(method, path, body);
        if (!response.ok) {
            const text = await response.text();
            const parsed = parseJson(text);
            const details = parsed.ok ? parsed.value : text;
            const message = parsed.ok ? extractErrorMessage(parsed.value) : undefined;
            throw new OpenCodeClientError(message ?? `OpenCode request failed with HTTP ${response.status}`, "http_error", response.status, path, details);
        }
    }
    async fetch(method, path, body) {
        let response;
        try {
            response = await fetchWithTimeout(`${this.baseUrl}${path}`, {
                method,
                headers: method === "POST" ? { "content-type": "application/json" } : undefined,
                body: method === "POST" ? JSON.stringify(body ?? {}) : undefined
            }, this.timeoutMs);
        }
        catch (error) {
            throw new OpenCodeClientError(error instanceof Error ? error.message : String(error), "transport_error", 0, path);
        }
        return response;
    }
}
function parseJson(text) {
    if (!text.trim()) {
        return { ok: true, value: null };
    }
    try {
        return { ok: true, value: JSON.parse(text) };
    }
    catch {
        return { ok: false };
    }
}
function extractErrorMessage(value) {
    if (typeof value !== "object" || value === null) {
        return undefined;
    }
    if ("message" in value) {
        return String(value.message);
    }
    if ("error" in value) {
        const error = value.error;
        if (typeof error === "string") {
            return error;
        }
        if (typeof error === "object" && error !== null && "message" in error) {
            return String(error.message);
        }
    }
    return undefined;
}
function formatModelOverride(model) {
    if (model === undefined) {
        return undefined;
    }
    const separator = model.indexOf("/");
    if (separator <= 0 || separator === model.length - 1) {
        throw new OpenCodeClientError(`Invalid OpenCode model override: expected provider/model, got ${model}`, "invalid_model");
    }
    return {
        providerID: model.slice(0, separator),
        modelID: model.slice(separator + 1)
    };
}
//# sourceMappingURL=client.js.map