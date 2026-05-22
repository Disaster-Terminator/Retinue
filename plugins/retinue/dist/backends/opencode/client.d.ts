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
export type OpenCodePromptPart = {
    type: "text";
    text: string;
} | {
    type: "subtask";
    description: string;
    agent: string;
    prompt: string;
    model?: string;
    command?: string;
};
export declare class OpenCodeClientError extends Error {
    readonly code: string;
    readonly status?: number | undefined;
    readonly path?: string | undefined;
    readonly details?: unknown | undefined;
    constructor(message: string, code: string, status?: number | undefined, path?: string | undefined, details?: unknown | undefined);
}
export declare class OpenCodeClient {
    private readonly baseUrl;
    private readonly timeoutMs;
    constructor(baseUrl: string, options?: {
        timeoutMs?: number;
    });
    health(): Promise<unknown>;
    agents(): Promise<OpenCodeAgentInfo[]>;
    permissions(): Promise<OpenCodePermissionRequest[]>;
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
    private request;
    private requestVoid;
    private fetch;
}
