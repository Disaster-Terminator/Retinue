export declare function resolveHttpTimeoutMs(env?: Partial<Record<"RETINUE_HTTP_TIMEOUT_MS", string | undefined>>): number;
export declare function fetchWithTimeout(url: string, init?: RequestInit, timeoutMs?: number): Promise<Response>;
