import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import { OpenCodeClient as LegacyOpenCodeClient, OpenCodeClientError } from "./legacyClient.js";
export { OpenCodeClientError } from "./legacyClient.js";
export class OpenCodeClient {
    implementation;
    legacy;
    sdk;
    timeoutMs;
    modelOverrideFormat;
    constructor(baseUrl, options = {}) {
        this.timeoutMs = options.timeoutMs ?? 30_000;
        this.modelOverrideFormat = options.modelOverrideFormat ?? "provider-model";
        this.implementation = resolveImplementation(options.implementation, this.modelOverrideFormat);
        if (this.implementation === "legacy") {
            this.legacy = new LegacyOpenCodeClient(baseUrl, {
                timeoutMs: this.timeoutMs,
                modelOverrideFormat: this.modelOverrideFormat
            });
            return;
        }
        this.sdk = createOpencodeClient({
            baseUrl,
            fetch: createTimeoutFetch(this.timeoutMs)
        });
    }
    health() {
        if (this.legacy) {
            return this.legacy.health();
        }
        return this.unwrap("/global/health", this.sdk.global.health());
    }
    agents() {
        if (this.legacy) {
            return this.legacy.agents();
        }
        return this.unwrap("/agent", this.sdk.app.agents());
    }
    permissions() {
        if (this.legacy) {
            return this.legacy.permissions();
        }
        return this.unwrap("/permission", this.sdk.permission.list());
    }
    async replyPermission(requestId, reply, message) {
        if (this.legacy) {
            return this.legacy.replyPermission(requestId, reply, message);
        }
        await this.unwrap(`/permission/${encodeURIComponent(requestId)}/reply`, this.sdk.permission.reply({ requestID: requestId, reply, message }));
    }
    createSession(options = {}) {
        if (this.legacy) {
            return this.legacy.createSession(options);
        }
        const model = formatSessionModel(formatModelOverride(options.model, this.modelOverrideFormat));
        return this.unwrap("/session", this.sdk.session.create({
            directory: options.cwd,
            title: options.title,
            parentID: options.parentID,
            agent: options.agent,
            model,
            workspaceID: options.workspaceID,
            permission: options.permission
        }));
    }
    listSessions() {
        if (this.legacy) {
            return this.legacy.listSessions();
        }
        return this.unwrap("/session", this.sdk.session.list());
    }
    getSession(sessionId) {
        if (this.legacy) {
            return this.legacy.getSession(sessionId);
        }
        return this.unwrap(`/session/${encodeURIComponent(sessionId)}`, this.sdk.session.get({ sessionID: sessionId }));
    }
    children(sessionId) {
        if (this.legacy) {
            return this.legacy.children(sessionId);
        }
        return this.unwrap(`/session/${encodeURIComponent(sessionId)}/children`, this.sdk.session.children({ sessionID: sessionId }));
    }
    async promptAsync(sessionId, options) {
        if (this.legacy) {
            return this.legacy.promptAsync(sessionId, options);
        }
        await this.unwrap(`/session/${encodeURIComponent(sessionId)}/prompt_async`, this.sdk.session.promptAsync({
            sessionID: sessionId,
            model: formatSdkPromptModel(formatModelOverride(options.model, this.modelOverrideFormat)),
            agent: options.agent,
            tools: options.tools,
            parts: formatPromptParts(options.parts ?? [{ type: "text", text: options.prompt ?? "" }])
        }));
    }
    messages(sessionId) {
        if (this.legacy) {
            return this.legacy.messages(sessionId);
        }
        return this.unwrap(`/session/${encodeURIComponent(sessionId)}/message`, this.sdk.session.messages({ sessionID: sessionId }));
    }
    abort(sessionId) {
        if (this.legacy) {
            return this.legacy.abort(sessionId);
        }
        return this.unwrap(`/session/${encodeURIComponent(sessionId)}/abort`, this.sdk.session.abort({ sessionID: sessionId }));
    }
    async unwrap(path, promise) {
        try {
            const result = await promise;
            if (result.error !== undefined) {
                throw new OpenCodeClientError(extractErrorMessage(result.error) ?? `OpenCode request failed with HTTP ${result.response.status}`, "http_error", result.response.status, path, result.error);
            }
            return result.data;
        }
        catch (error) {
            if (error instanceof OpenCodeClientError) {
                throw error;
            }
            throw new OpenCodeClientError(error instanceof Error ? error.message : String(error), "transport_error", 0, path, error);
        }
    }
}
function resolveImplementation(explicit, modelOverrideFormat) {
    if (explicit) {
        return explicit;
    }
    const configured = process.env.RETINUE_OPENCODE_CLIENT?.trim().toLowerCase();
    if (configured === "legacy" || configured === "http") {
        return "legacy";
    }
    if (configured === "sdk") {
        return "sdk";
    }
    return modelOverrideFormat === "model-id" ? "legacy" : "sdk";
}
function createTimeoutFetch(timeoutMs) {
    return async (input, init) => {
        if (timeoutMs <= 0) {
            return fetch(input, init);
        }
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
        try {
            return await fetch(input, {
                ...init,
                signal: init?.signal ?? controller.signal
            });
        }
        finally {
            clearTimeout(timeout);
        }
    };
}
function formatPromptParts(parts) {
    return parts.map((part) => {
        if (part.type !== "subtask" || part.model === undefined) {
            return part;
        }
        return {
            ...part,
            model: formatModelOverride(part.model)
        };
    });
}
function formatSessionModel(model) {
    if (model === undefined) {
        return undefined;
    }
    if (!model.providerID) {
        throw new OpenCodeClientError("OpenCode SDK session model override requires provider/model", "invalid_model");
    }
    return {
        providerID: model.providerID,
        id: model.modelID
    };
}
function formatSdkPromptModel(model) {
    if (model === undefined) {
        return undefined;
    }
    if (!model.providerID) {
        throw new OpenCodeClientError("OpenCode SDK prompt model override requires provider/model", "invalid_model");
    }
    return {
        providerID: model.providerID,
        modelID: model.modelID
    };
}
function formatModelOverride(model, format = "provider-model") {
    if (model === undefined) {
        return undefined;
    }
    if (format === "model-id" && !model.includes("/")) {
        return { modelID: model };
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
function extractErrorMessage(value) {
    if (typeof value !== "object" || value === null) {
        return typeof value === "string" ? value : undefined;
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
//# sourceMappingURL=client.js.map