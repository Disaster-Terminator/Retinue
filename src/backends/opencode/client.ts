export interface OpenCodeSession {
  id: string;
  title?: string;
  cwd?: string;
  [key: string]: unknown;
}

export interface OpenCodeMessage {
  id: string;
  sessionId: string;
  role?: string;
  text?: string;
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

  promptAsync(sessionId: string, options: { prompt: string; model?: string; agent?: string }): Promise<{ messageId: string }> {
    return this.request("POST", `/session/${encodeURIComponent(sessionId)}/prompt_async`, options);
  }

  messages(sessionId: string): Promise<OpenCodeMessage[]> {
    return this.request("GET", `/session/${encodeURIComponent(sessionId)}/message`);
  }

  abort(sessionId: string): Promise<unknown> {
    return this.request("POST", `/session/${encodeURIComponent(sessionId)}/abort`, {});
  }

  private async request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
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
