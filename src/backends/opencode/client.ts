export interface OpenCodeSession {
  id: string;
  title?: string;
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

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  health(): Promise<unknown> {
    return this.request("GET", "/global/health");
  }

  createSession(options: { cwd?: string; title?: string } = {}): Promise<OpenCodeSession> {
    return this.request("POST", "/session", options);
  }

  listSessions(): Promise<OpenCodeSession[]> {
    return this.request("GET", "/session");
  }

  getSession(sessionId: string): Promise<OpenCodeSession> {
    return this.request("GET", `/session/${encodeURIComponent(sessionId)}`);
  }

  promptAsync(sessionId: string, options: { prompt: string; model?: string; agent?: string }): Promise<void> {
    return this.requestVoid("POST", `/session/${encodeURIComponent(sessionId)}/prompt_async`, {
      model: formatModelOverride(options.model),
      agent: options.agent,
      parts: [{ type: "text", text: options.prompt }]
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
    const parsed = parseJson(text);
    if (!parsed.ok) {
      throw new OpenCodeClientError("OpenCode response was not valid JSON", "invalid_json", response.status, path, text);
    }
    if (!response.ok) {
      const message = extractErrorMessage(parsed.value) ?? `OpenCode request failed with HTTP ${response.status}`;
      throw new OpenCodeClientError(message, "http_error", response.status, path, parsed.value);
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
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: method === "POST" ? { "content-type": "application/json" } : undefined,
        body: method === "POST" ? JSON.stringify(body ?? {}) : undefined
      });
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

function formatModelOverride(model: string | undefined): { providerID: string; modelID: string } | undefined {
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
