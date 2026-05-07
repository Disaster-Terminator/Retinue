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
export declare class OpenCodeClientError extends Error {
    readonly code: string;
    readonly status?: number | undefined;
    readonly path?: string | undefined;
    readonly details?: unknown | undefined;
    constructor(message: string, code: string, status?: number | undefined, path?: string | undefined, details?: unknown | undefined);
}
export declare class OpenCodeClient {
    private readonly baseUrl;
    constructor(baseUrl: string);
    health(): Promise<unknown>;
    createSession(options?: {
        cwd?: string;
        title?: string;
    }): Promise<OpenCodeSession>;
    listSessions(): Promise<OpenCodeSession[]>;
    getSession(sessionId: string): Promise<OpenCodeSession>;
    promptAsync(sessionId: string, options: {
        prompt: string;
        model?: string;
        agent?: string;
    }): Promise<void>;
    messages(sessionId: string): Promise<OpenCodeMessage[]>;
    abort(sessionId: string): Promise<unknown>;
    private request;
    private requestVoid;
    private fetch;
}
