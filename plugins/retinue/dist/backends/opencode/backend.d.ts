import type { CleanupOptions, CleanupResult, JobMeta, JobResult, JobStatusResult, RetinueOptions } from "../../core/types.js";
import type { AgentBackend, AgentContinueOptions, AgentHandle, AgentRunOptions } from "../types.js";
import { OpenCodeClient } from "./client.js";
export interface OpenCodeBackendOptions {
    client?: OpenCodeClient;
    baseUrl?: string;
    target?: (cwd: string | undefined) => Promise<OpenCodeBackendTarget>;
    stateDir?: string;
    env?: RetinueOptions["env"];
    onServerIdle?: (baseUrl: string, cwd: string | undefined) => void;
}
export interface OpenCodeBackendTarget {
    client: OpenCodeClient;
    baseUrl: string;
}
export declare class OpenCodeBackend implements AgentBackend {
    readonly kind: "opencode";
    private readonly client?;
    private readonly baseUrl?;
    private readonly resolveTarget;
    private readonly stateDir;
    private readonly env?;
    private readonly httpTimeoutMs;
    private readonly onServerIdle;
    constructor(options: OpenCodeBackendOptions);
    run(options: AgentRunOptions): Promise<JobMeta>;
    continueJob(options: AgentContinueOptions): Promise<JobMeta>;
    status(handle: AgentHandle): Promise<JobStatusResult>;
    private maybeSubmitSoftStallRescue;
    result(handle: AgentHandle): Promise<JobResult>;
    abort(handle: AgentHandle): Promise<void>;
    wait(handle: AgentHandle, timeoutMs?: number): Promise<{
        jobId: string;
        status: JobStatusResult["status"];
    }>;
    private isSoftStallRescuePending;
    private isReadOnlyWriteIntentRecoveryExpired;
    cleanup(options?: CleanupOptions): Promise<CleanupResult>;
    private readMeta;
    private readCurrentMetaOrFallback;
    private reconcileStatus;
    private captureMessageBaseline;
    private hasNewCompletedAssistantMessage;
    private hasReadOnlyWriteIntent;
    private isStalledOpenCodeJob;
    private inspectJob;
    private maybeScheduleServerIdleShutdown;
    private hasRunningJobsForServer;
    private writeJobTrace;
    private submitPromptAsync;
    private clientForMeta;
    private targetForContinue;
}
