import { type ChildProcess } from "node:child_process";
export interface OpenCodeServerConfig {
    baseUrl?: string;
    command?: string;
    prefixArgs?: string[];
    autoServe?: boolean;
    host?: string;
    port?: number;
    fallbackPorts?: number[];
}
export type OpenCodeServerResolution = {
    mode: "attach";
    baseUrl: string;
} | {
    mode: "serve";
    command: string;
    args: string[];
    host: string;
    port: number;
    fallbackPorts: number[];
};
export interface OpenCodeServerTarget {
    baseUrl: string;
    started: boolean;
    child?: ChildProcess;
}
export declare function resolveOpenCodeServer(config: OpenCodeServerConfig): OpenCodeServerResolution;
export declare function resolveOpenCodeServerFromEnv(env: NodeJS.ProcessEnv | Record<string, string | undefined>): OpenCodeServerResolution;
export declare function buildServeArgs(options: {
    host: string;
    port: number;
}): string[];
export declare function ensureOpenCodeServer(resolution: OpenCodeServerResolution, options?: {
    stateDir?: string;
    healthTimeoutMs?: number;
    healthPollMs?: number;
    lockTimeoutMs?: number;
}): Promise<OpenCodeServerTarget>;
