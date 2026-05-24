import { fetchWithTimeout } from "../../core/http.js";

export interface OpenCodeSession {
  id: string;
  title?: string;
  parentID?: string;
  agent?: string;
  permission?: OpenCodePermissionRule[];
  directory?: string;
  cwd?: string;
  [key: string]: unknown;
}

export interface OpenCodeMessage {
  info?: {
    id?: string;
    sessionID?: string;
    role?: string;
    [key: string]: unknown;
  };
  parts?: Array<{
    type?: string;
    text?: string;
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
}

export interface OpenCodePermissionRule {
  permission: string;
  pattern: string;
  action: "allow" | "deny" | "ask";
}

export interface OpenCodePermissionRequest {
  id: string;
  sessionID: string;
  permission: string;
  patterns: string[];
  metadata?: Record<string, unknown>;
  always?: string[];
  tool?: {
    messageID?: string;
    callID?: string;
  };
  [key: string]: unknown;
}

export type OpenCodePermissionReply = "once" | "always" | "reject";

export interface OpenCodeAgentInfo {
  name: string;
  mode?: "subagent" | "primary" | "all";
  permission?: OpenCodePermissionRule[];
  model?: {
    providerID?: string;
    modelID?: string;
  };
  [key: string]: unknown;
}

export type OpenCodePromptPart =
  | { type: "text"; text: string }
  | { type: "subtask"; description: string; agent: string; prompt: string; model?: string; command?: string };

export class OpenCodeClientError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status?: number,
    readonly path?: string,
    readonly details?: unknown
  ) {
    super(message);
    this.name = "OpenCodeClientError";
  }
}

export class OpenCodeClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly modelOverrideFormat: "provider-model" | "model-id";

  constructor(baseUrl: string, options: { timeoutMs?: number; modelOverrideFormat?: "provider-model" | "model-id" } = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.modelOverrideFormat = options.modelOverrideFormat ?? "provider-model";
  }

  health(): Promise<unknown> {
    return this.request("GET", "/global/health");
  }

  agents(): Promise<OpenCodeAgentInfo[]> {
    return this.request("GET", "/agent");
  }

  permissions(): Promise<OpenCodePermissionRequest[]> {
    return this.request("GET", "/permission");
  }

  replyPermission(requestId: string, reply: OpenCodePermissionReply, message?: string): Promise<void> {
    return this.requestVoid("POST", `/permission/${encodeURIComponent(requestId)}/reply`, {
      reply,
      message
    });
  }

  createSession(
    options: {
      cwd?: string;
      title?: string;
      parentID?: string;
      agent?: string;
      model?: string;
      workspaceID?: string;
      permission?: OpenCodePermissionRule[];
    } = {}
  ): Promise<OpenCodeSession> {
    return this.request("POST", "/session", {
      title: options.title,
      parentID: options.parentID,
      agent: options.agent,
      model: formatModelOverride(options.model, this.modelOverrideFormat),
      workspaceID: options.workspaceID,
      permission: options.permission,
      directory: options.cwd
    });
  }

  listSessions(): Promise<OpenCodeSession[]> {
    return this.request("GET", "/session");
  }

  getSession(sessionId: string): Promise<OpenCodeSession> {
    return this.request("GET", `/session/${encodeURIComponent(sessionId)}`);
  }

  children(sessionId: string): Promise<OpenCodeSession[]> {
    return this.request("GET", `/session/${encodeURIComponent(sessionId)}/children`);
  }

  promptAsync(
    sessionId: string,
    options: { prompt?: string; parts?: OpenCodePromptPart[]; model?: string; agent?: string; tools?: Record<string, boolean> }
  ): Promise<void> {
    return this.requestVoid("POST", `/session/${encodeURIComponent(sessionId)}/prompt_async`, {
      model: formatModelOverride(options.model, this.modelOverrideFormat),
      agent: options.agent,
      tools: options.tools,
      parts: options.parts ?? [{ type: "text", text: options.prompt ?? "" }]
    });
  }

  messages(sessionId: string): Promise<OpenCodeMessage[]> {
    return this.request("GET", `/session/${encodeURIComponent(sessionId)}/message`);
  }

  abort(sessionId: string): Promise<unknown> {
    return this.request("POST", `/session/${encodeURIComponent(sessionId)}/abort`, {});
  }

  private async request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
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
    return parsed.value as T;
  }

  private async requestVoid(method: "GET" | "POST", path: string, body?: unknown): Promise<void> {
    const response = await this.fetch(method, path, body);
    if (!response.ok) {
      const text = await response.text();
      const parsed = parseJson(text);
      const details = parsed.ok ? parsed.value : text;
      const message = parsed.ok ? extractErrorMessage(parsed.value) : undefined;
      throw new OpenCodeClientError(message ?? `OpenCode request failed with HTTP ${response.status}`, "http_error", response.status, path, details);
    }
  }

  private async fetch(method: "GET" | "POST", path: string, body?: unknown): Promise<Response> {
    let response: Response;
    try {
      response = await fetchWithTimeout(`${this.baseUrl}${path}`, {
        method,
        headers: method === "POST" ? { "content-type": "application/json" } : undefined,
        body: method === "POST" ? JSON.stringify(body ?? {}) : undefined
      }, this.timeoutMs);
    } catch (error) {
      throw new OpenCodeClientError(error instanceof Error ? error.message : String(error), "transport_error", 0, path);
    }
    return response;
  }
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  if (!text.trim()) {
    return { ok: true, value: null };
  }
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

function extractErrorMessage(value: unknown): string | undefined {
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

function formatModelOverride(
  model: string | undefined,
  format: "provider-model" | "model-id" = "provider-model"
): { providerID?: string; modelID: string } | undefined {
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
