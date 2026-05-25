import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk/v2/client";
import type { AgentPartInput, FilePartInput, SubtaskPartInput, TextPartInput } from "@opencode-ai/sdk/v2/client";
import type {
  OpenCodeAgentInfo,
  OpenCodeMessage,
  OpenCodePermissionReply,
  OpenCodePermissionRequest,
  OpenCodePermissionRule,
  OpenCodePromptPart,
  OpenCodeSession
} from "./legacyClient.js";
import { OpenCodeClient as LegacyOpenCodeClient, OpenCodeClientError } from "./legacyClient.js";

export type {
  OpenCodeAgentInfo,
  OpenCodeMessage,
  OpenCodePermissionReply,
  OpenCodePermissionRequest,
  OpenCodePermissionRule,
  OpenCodePromptPart,
  OpenCodeSession
} from "./legacyClient.js";
export { OpenCodeClientError } from "./legacyClient.js";

type OpenCodeClientImplementation = "sdk" | "legacy";
type ModelOverrideFormat = "provider-model" | "model-id";
type SdkPromptPart = TextPartInput | FilePartInput | AgentPartInput | SubtaskPartInput;
type SdkRequestResult<T> =
  | {
      data: T;
      error: undefined;
      request: Request;
      response: Response;
    }
  | {
      data: undefined;
      error: unknown;
      request: Request;
      response?: Response;
    };

export class OpenCodeClient {
  private readonly implementation: OpenCodeClientImplementation;
  private readonly legacy?: LegacyOpenCodeClient;
  private readonly sdk?: OpencodeClient;
  private readonly timeoutMs: number;
  private readonly modelOverrideFormat: ModelOverrideFormat;

  constructor(
    baseUrl: string,
    options: {
      timeoutMs?: number;
      modelOverrideFormat?: ModelOverrideFormat;
      implementation?: OpenCodeClientImplementation;
    } = {}
  ) {
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

  health(): Promise<unknown> {
    if (this.legacy) {
      return this.legacy.health();
    }
    return this.unwrap("/global/health", this.sdk!.global.health());
  }

  agents(): Promise<OpenCodeAgentInfo[]> {
    if (this.legacy) {
      return this.legacy.agents();
    }
    return this.unwrap("/agent", this.sdk!.app.agents()) as Promise<OpenCodeAgentInfo[]>;
  }

  permissions(): Promise<OpenCodePermissionRequest[]> {
    if (this.legacy) {
      return this.legacy.permissions();
    }
    return this.unwrap("/permission", this.sdk!.permission.list()) as Promise<OpenCodePermissionRequest[]>;
  }

  async replyPermission(requestId: string, reply: OpenCodePermissionReply, message?: string): Promise<void> {
    if (this.legacy) {
      return this.legacy.replyPermission(requestId, reply, message);
    }
    await this.unwrap(`/permission/${encodeURIComponent(requestId)}/reply`, this.sdk!.permission.reply({ requestID: requestId, reply, message }));
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
    if (this.legacy) {
      return this.legacy.createSession(options);
    }
    const model = formatSessionModel(formatModelOverride(options.model, this.modelOverrideFormat));
    return this.unwrap(
      "/session",
      this.sdk!.session.create({
        directory: options.cwd,
        title: options.title,
        parentID: options.parentID,
        agent: options.agent,
        model,
        workspaceID: options.workspaceID,
        permission: options.permission
      })
    ) as Promise<OpenCodeSession>;
  }

  listSessions(): Promise<OpenCodeSession[]> {
    if (this.legacy) {
      return this.legacy.listSessions();
    }
    return this.unwrap("/session", this.sdk!.session.list()) as Promise<OpenCodeSession[]>;
  }

  getSession(sessionId: string): Promise<OpenCodeSession> {
    if (this.legacy) {
      return this.legacy.getSession(sessionId);
    }
    return this.unwrap(`/session/${encodeURIComponent(sessionId)}`, this.sdk!.session.get({ sessionID: sessionId })) as Promise<OpenCodeSession>;
  }

  children(sessionId: string): Promise<OpenCodeSession[]> {
    if (this.legacy) {
      return this.legacy.children(sessionId);
    }
    return this.unwrap(`/session/${encodeURIComponent(sessionId)}/children`, this.sdk!.session.children({ sessionID: sessionId })) as Promise<
      OpenCodeSession[]
    >;
  }

  async promptAsync(
    sessionId: string,
    options: { prompt?: string; parts?: OpenCodePromptPart[]; model?: string; agent?: string; tools?: Record<string, boolean> }
  ): Promise<void> {
    if (this.legacy) {
      return this.legacy.promptAsync(sessionId, options);
    }
    await this.unwrap(
      `/session/${encodeURIComponent(sessionId)}/prompt_async`,
      this.sdk!.session.promptAsync({
        sessionID: sessionId,
        model: formatSdkPromptModel(formatModelOverride(options.model, this.modelOverrideFormat)),
        agent: options.agent,
        tools: options.tools,
        parts: formatPromptParts(options.parts ?? [{ type: "text", text: options.prompt ?? "" }])
      })
    );
  }

  messages(sessionId: string): Promise<OpenCodeMessage[]> {
    if (this.legacy) {
      return this.legacy.messages(sessionId);
    }
    return this.unwrap(`/session/${encodeURIComponent(sessionId)}/message`, this.sdk!.session.messages({ sessionID: sessionId })) as Promise<
      OpenCodeMessage[]
    >;
  }

  abort(sessionId: string): Promise<unknown> {
    if (this.legacy) {
      return this.legacy.abort(sessionId);
    }
    return this.unwrap(`/session/${encodeURIComponent(sessionId)}/abort`, this.sdk!.session.abort({ sessionID: sessionId }));
  }

  private async unwrap<T>(path: string, promise: Promise<SdkRequestResult<T>>): Promise<T> {
    try {
      const result = await promise;
      if (result.error !== undefined) {
        const status = result.response?.status ?? 0;
        throw new OpenCodeClientError(
          extractErrorMessage(result.error) ?? (status > 0 ? `OpenCode request failed with HTTP ${status}` : "OpenCode request failed"),
          status > 0 ? "http_error" : "transport_error",
          status,
          path,
          result.error
        );
      }
      return result.data as T;
    } catch (error) {
      if (error instanceof OpenCodeClientError) {
        throw error;
      }
      throw new OpenCodeClientError(error instanceof Error ? error.message : String(error), "transport_error", 0, path, error);
    }
  }
}

function resolveImplementation(explicit: OpenCodeClientImplementation | undefined, modelOverrideFormat: ModelOverrideFormat): OpenCodeClientImplementation {
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

function createTimeoutFetch(timeoutMs: number): typeof fetch {
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
    } finally {
      clearTimeout(timeout);
    }
  };
}

function formatPromptParts(parts: OpenCodePromptPart[]): SdkPromptPart[] {
  return parts.map((part) => {
    if (part.type !== "subtask" || part.model === undefined) {
      return part as SdkPromptPart;
    }
    return {
      ...part,
      model: formatModelOverride(part.model)
    } as SdkPromptPart;
  });
}

function formatSessionModel(model: { providerID?: string; modelID: string } | undefined): { providerID: string; id: string } | undefined {
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

function formatSdkPromptModel(model: { providerID?: string; modelID: string } | undefined): { providerID: string; modelID: string } | undefined {
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

function formatModelOverride(
  model: string | undefined,
  format: ModelOverrideFormat = "provider-model"
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

function extractErrorMessage(value: unknown): string | undefined {
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
