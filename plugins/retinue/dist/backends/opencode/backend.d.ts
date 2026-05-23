import type { CleanupOptions, CleanupResult, JobMeta, JobResult, JobStatusResult, RetinueOptions, WaitResult } from "../../core/types.js";
import type { AgentBackend, AgentContinueOptions, AgentHandle, AgentPermissionListResult, AgentPermissionReply, AgentPermissionReplyResult, AgentRunOptions } from "../types.js";
import { OpenCodeClient } from "./client.js";
export interface OpenCodeBackendOptions {
    client?: OpenCodeClient;
    baseUrl?: string;
    target?: (cwd: string | undefined) => Promise<OpenCodeBackendTarget>;
    stateDir?: string;
    env?: RetinueOptions["env"];
    onServerIdle?: (baseUrl: string, cwd: string | undefined) => void;
    sharedRootSessions?: OpenCodeSharedRootSessionStore;
}
export interface OpenCodeBackendTarget {
    client: OpenCodeClient;
    baseUrl: string;
}
interface SharedRootSession {
    id: string;
    baseUrl: string;
    cwd?: string;
    agent: string;
}
export type OpenCodeSharedRootSessionStore = Map<string, SharedRootSession>;
export declare class OpenCodeBackend implements AgentBackend {
    readonly kind: "opencode";
    private readonly client?;
    private readonly baseUrl?;
    private readonly resolveTarget;
    private readonly stateDir;
    private readonly env?;
    private readonly httpTimeoutMs;
    private readonly onServerIdle;
    private readonly sharedRootSessions;
    constructor(options: OpenCodeBackendOptions);
    run(options: AgentRunOptions): Promise<JobMeta>;
    continueJob(options: AgentContinueOptions): Promise<JobMeta>;
    status(handle: AgentHandle): Promise<JobStatusResult>;
    listPermissions(handle: AgentHandle): Promise<AgentPermissionListResult>;
    replyPermission(handle: AgentHandle, options: {
        requestId: string;
        reply: AgentPermissionReply;
        message?: string;
    }): Promise<AgentPermissionReplyResult>;
    private maybeSubmitSoftStallRescue;
    private maybeStartTaskLevelAttempt;
    private selectedAttemptFor;
    private buildAttemptChain;
    private findAttemptRoot;
    private decorateResultWithAttemptChain;
    result(handle: AgentHandle): Promise<JobResult>;
    abort(handle: AgentHandle): Promise<void>;
    wait(handle: AgentHandle, timeoutMs?: number): Promise<WaitResult>;
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
    private pendingPermissionsForJob;
    private reopenExternalPermissionStall;
    private inspectJob;
    private maybeScheduleServerIdleShutdown;
    private hasRunningJobsForServer;
    private writeJobTrace;
    private submitPromptAsync;
    private refreshNativeChildSessions;
    private getOrCreateSharedRootSession;
    private listAgents;
    private buildChildSessionPermission;
    private clientForMeta;
    private targetForContinue;
}
export {};
