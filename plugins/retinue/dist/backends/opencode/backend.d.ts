import type { AgentBackendKind, CleanupOptions, CleanupResult, JobMeta, JobResult, JobStatusResult, RetinueOptions, WaitResult } from "../../core/types.js";
import type { AgentBackend, AgentContinueOptions, AgentHandle, AgentPermissionListResult, AgentPermissionReply, AgentPermissionReplyResult, AgentRunOptions } from "../types.js";
import { OpenCodeClient } from "./client.js";
export interface OpenCodeBackendOptions {
    kind?: Extract<AgentBackendKind, "opencode" | "kilo">;
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
}
export type OpenCodeSharedRootSessionStore = Map<string, SharedRootSession>;
export declare class OpenCodeBackend implements AgentBackend {
    readonly kind: Extract<AgentBackendKind, "opencode" | "kilo">;
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
    private statusForWait;
    listPermissions(handle: AgentHandle): Promise<AgentPermissionListResult>;
    replyPermission(handle: AgentHandle, options: {
        requestId: string;
        reply: AgentPermissionReply;
        message?: string;
    }): Promise<AgentPermissionReplyResult>;
    private maybeStartTaskLevelAttempt;
    private selectedAttemptFor;
    private buildAttemptChain;
    private findAttemptRoot;
    private decorateResultWithAttemptChain;
    private createTaskAttemptExhaustedMessage;
    result(handle: AgentHandle): Promise<JobResult>;
    private completedResultBackendUnavailable;
    private completedCachedResult;
    private persistCompletedResultSnapshot;
    abort(handle: AgentHandle): Promise<void>;
    wait(handle: AgentHandle, timeoutMs?: number): Promise<WaitResult>;
    cleanup(options?: CleanupOptions): Promise<CleanupResult>;
    private readMeta;
    private readCurrentMetaOrFallback;
    private reconcileStatus;
    private markBackendUnreachable;
    private reconcileVirtualSelectedAttemptStatus;
    private captureMessageBaseline;
    private hasNewCompletedAssistantMessage;
    private stallDiagnosticForOpenCodeJob;
    private pendingPermissionsForJob;
    private reopenExternalPermissionStall;
    private inspectJob;
    private maybeScheduleServerIdleShutdown;
    private hasOpenJobsForServer;
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
