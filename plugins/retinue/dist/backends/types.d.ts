import type { JobMeta, JobResult, JobStatusResult, RunOptions } from "../core/types.js";
export interface AgentHandle {
    jobId: string;
}
export interface AgentRunOptions extends RunOptions {
    title?: string;
    model?: string;
    agent?: string;
}
export interface AgentContinueOptions extends AgentRunOptions {
    externalSessionId?: string;
}
export type AgentRunStart = JobMeta;
export type AgentBackendStatus = JobStatusResult;
export type AgentBackendResult = JobResult;
export interface AgentBackend {
    readonly kind: "claude-code" | "opencode";
    run(options: AgentRunOptions): Promise<AgentRunStart>;
    continueJob(options: AgentContinueOptions): Promise<AgentRunStart>;
    status(handle: AgentHandle): Promise<AgentBackendStatus>;
    result(handle: AgentHandle): Promise<AgentBackendResult>;
    abort(handle: AgentHandle): Promise<void>;
}
