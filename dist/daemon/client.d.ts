import type { CleanupOptions, CleanupResult, ContinueOptions, JobMeta, JobResult, JobStatusResult, KillResult, PeekOptions, PeekResult, RunOptions, RetinueApi, WaitOptions, WaitResult } from "../core/types.js";
export declare class DaemonClientError extends Error {
    readonly code?: string;
    readonly status: number;
    readonly path: string;
    constructor(message: string, details: {
        code?: string;
        status: number;
        path: string;
    });
}
export declare class DaemonClient implements RetinueApi {
    private readonly baseUrl;
    private readonly timeoutMs;
    constructor(baseUrl: string, options?: {
        timeoutMs?: number;
    });
    run(options: RunOptions): Promise<JobMeta>;
    status(jobId: string): Promise<JobStatusResult>;
    wait(jobId: string, options?: WaitOptions): Promise<WaitResult>;
    result(jobId: string): Promise<JobResult>;
    continueJob(options: ContinueOptions): Promise<JobMeta>;
    peek(jobId: string, options?: PeekOptions): Promise<PeekResult>;
    kill(jobId: string): Promise<KillResult>;
    cleanup(options?: CleanupOptions): Promise<CleanupResult>;
    private post;
}
