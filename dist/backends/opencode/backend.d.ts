import type { CleanupOptions, CleanupResult, JobMeta, JobResult, JobStatusResult, SupervisorOptions } from "../../core/types.js";
import type { AgentBackend, AgentContinueOptions, AgentHandle, AgentRunOptions } from "../types.js";
import { OpenCodeClient } from "./client.js";
export interface OpenCodeBackendOptions {
    client?: OpenCodeClient;
    baseUrl?: string;
    target?: (cwd: string | undefined) => Promise<OpenCodeBackendTarget>;
    stateDir?: string;
    env?: SupervisorOptions["env"];
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
    constructor(options: OpenCodeBackendOptions);
    run(options: AgentRunOptions): Promise<JobMeta>;
    continueJob(options: AgentContinueOptions): Promise<JobMeta>;
    status(handle: AgentHandle): Promise<JobStatusResult>;
    result(handle: AgentHandle): Promise<JobResult>;
    abort(handle: AgentHandle): Promise<void>;
    wait(handle: AgentHandle, timeoutMs?: number): Promise<{
        jobId: string;
        status: JobStatusResult["status"];
    }>;
    cleanup(options?: CleanupOptions): Promise<CleanupResult>;
    private readMeta;
    private reconcileStatus;
    private captureMessageBaseline;
    private hasNewCompletedAssistantMessage;
    private inspectJob;
    private writeJobTrace;
    private clientForMeta;
    private targetForContinue;
}
