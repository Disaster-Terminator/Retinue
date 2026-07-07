import type { CleanupOptions, CleanupResult, ContinueOptions, JobMeta, JobResult, JobStatusResult, KillResult, PeekOptions, PeekResult, RunOptions, RetinueApi, RetinueOptions, WaitOptions, WaitResult } from "./types.js";
export declare const DEFAULT_MAX_CONCURRENT_JOBS = 4;
export declare class ClaudeRetinue implements RetinueApi {
    private readonly stateDir;
    private readonly claudeCommand;
    private readonly claudePrefixArgs;
    private readonly env;
    private readonly defaultRuntimeTimeoutMs?;
    private readonly maxConcurrentJobs;
    private readonly processes;
    private readonly killedJobIds;
    private readonly timedOutJobIds;
    constructor(options?: RetinueOptions);
    getStateDir(): string;
    run(options: RunOptions): Promise<JobMeta>;
    status(jobId: string): Promise<JobStatusResult>;
    wait(jobId: string, options?: WaitOptions): Promise<WaitResult>;
    result(jobId: string): Promise<JobResult>;
    continueJob(options: ContinueOptions): Promise<JobMeta>;
    private resolveSessionId;
    peek(jobId: string, options?: PeekOptions): Promise<PeekResult>;
    kill(jobId: string): Promise<KillResult>;
    cleanup(options?: CleanupOptions): Promise<CleanupResult>;
    private countActiveJobs;
    private readMeta;
    private writeMeta;
    private isOwnProcess;
}
