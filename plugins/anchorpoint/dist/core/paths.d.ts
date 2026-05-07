export interface ResolveStateDirOptions {
    explicitStateDir?: string;
    env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
    platform?: NodeJS.Platform;
    homeDir?: string;
}
export interface JobPaths {
    dir: string;
    meta: string;
    stdout: string;
    stderr: string;
    exitStatus: string;
    prompt: string;
}
export declare function resolveStateDir(options?: ResolveStateDirOptions): string;
export declare function getJobPaths(stateDir: string, jobId: string): JobPaths;
export declare function getDaemonDiscoveryPath(stateDir: string): string;
export declare function getOpenCodeServerDiscoveryPath(stateDir: string): string;
export declare function getOpenCodeServerLockPath(stateDir: string): string;
