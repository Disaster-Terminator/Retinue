import type { OpenCodeAgentInfo, OpenCodeMessage, OpenCodePermissionReply, OpenCodePermissionRequest, OpenCodePermissionRule, OpenCodePromptPart, OpenCodeSession } from "./legacyClient.js";
export type { OpenCodeAgentInfo, OpenCodeMessage, OpenCodePermissionReply, OpenCodePermissionRequest, OpenCodePermissionRule, OpenCodePromptPart, OpenCodeSession } from "./legacyClient.js";
export { OpenCodeClientError } from "./legacyClient.js";
type OpenCodeClientImplementation = "sdk" | "legacy";
type ModelOverrideFormat = "provider-model" | "model-id";
export declare class OpenCodeClient {
    private readonly implementation;
    private readonly legacy?;
    private readonly sdk?;
    private readonly timeoutMs;
    private readonly modelOverrideFormat;
    constructor(baseUrl: string, options?: {
        timeoutMs?: number;
        modelOverrideFormat?: ModelOverrideFormat;
        implementation?: OpenCodeClientImplementation;
    });
    health(): Promise<unknown>;
    agents(): Promise<OpenCodeAgentInfo[]>;
    permissions(): Promise<OpenCodePermissionRequest[]>;
    replyPermission(requestId: string, reply: OpenCodePermissionReply, message?: string): Promise<void>;
    createSession(options?: {
        cwd?: string;
        title?: string;
        parentID?: string;
        agent?: string;
        model?: string;
        workspaceID?: string;
        permission?: OpenCodePermissionRule[];
    }): Promise<OpenCodeSession>;
    listSessions(): Promise<OpenCodeSession[]>;
    getSession(sessionId: string): Promise<OpenCodeSession>;
    children(sessionId: string): Promise<OpenCodeSession[]>;
    promptAsync(sessionId: string, options: {
        prompt?: string;
        parts?: OpenCodePromptPart[];
        model?: string;
        agent?: string;
        tools?: Record<string, boolean>;
    }): Promise<void>;
    messages(sessionId: string): Promise<OpenCodeMessage[]>;
    abort(sessionId: string): Promise<unknown>;
    private unwrap;
}
