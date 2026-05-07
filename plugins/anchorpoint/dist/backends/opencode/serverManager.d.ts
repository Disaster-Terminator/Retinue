export interface OpenCodeServerConfig {
    baseUrl?: string;
    command?: string;
    autoServe?: boolean;
    host?: string;
    port?: number;
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
};
export declare function resolveOpenCodeServer(config: OpenCodeServerConfig): OpenCodeServerResolution;
export declare function resolveOpenCodeServerFromEnv(env: NodeJS.ProcessEnv | Record<string, string | undefined>): OpenCodeServerResolution;
export declare function buildServeArgs(options: {
    host: string;
    port: number;
}): string[];
