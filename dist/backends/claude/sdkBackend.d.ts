import type { PermissionUpdate } from "@anthropic-ai/claude-agent-sdk";
import type { AgentBackend, AgentBackendResult, AgentBackendStatus, AgentContinueOptions, AgentHandle, AgentPermissionListResult, AgentPermissionReplyResult, AgentRunOptions, AgentRunStart } from "../types.js";
import type { CleanupResult, PermissionReplyOption, RetinuePermissionRequest, RunOptions, WaitResult } from "../../core/types.js";
type ClaudeSdkQueryParams = {
    prompt: string;
    options?: {
        cwd?: string;
        abortController?: AbortController;
        maxTurns?: number;
        model?: string;
        permissionMode?: RunOptions["permissionMode"];
        resume?: string;
        agent?: string;
        canUseTool?: ClaudeSdkCanUseTool;
    };
};
type ClaudeSdkQuery = AsyncIterable<unknown> & {
    close?: () => void;
};
export type ClaudeSdkQueryFn = (params: ClaudeSdkQueryParams) => ClaudeSdkQuery;
type ClaudeSdkPermissionResult = {
    behavior: "allow";
    toolUseID?: string;
    updatedPermissions?: PermissionUpdate[];
    decisionClassification?: "user_temporary" | "user_permanent";
} | {
    behavior: "deny";
    message: string;
    interrupt?: boolean;
    toolUseID?: string;
    decisionClassification?: "user_reject";
};
type ClaudeSdkCanUseTool = (toolName: string, input: Record<string, unknown>, hook: {
    signal: AbortSignal;
    toolUseID: string;
    title?: string;
    displayName?: string;
    description?: string;
    blockedPath?: string;
    decisionReason?: string;
    agentID?: string;
    suggestions?: PermissionUpdate[];
}) => Promise<ClaudeSdkPermissionResult>;
export type ClaudeCodeSdkJobStore = Map<string, TrackedSdkJob>;
export interface ClaudeCodeSdkBackendOptions {
    stateDir?: string;
    env?: NodeJS.ProcessEnv;
    defaultRuntimeTimeoutMs?: number;
    query?: ClaudeSdkQueryFn;
    jobs?: ClaudeCodeSdkJobStore;
}
interface TrackedSdkJob {
    abortController: AbortController;
    finalized: Promise<void>;
    pending: Map<string, PendingPermission>;
    query?: ClaudeSdkQuery;
}
interface PendingPermission {
    request: RetinuePermissionRequest;
    resolve: (result: ClaudeSdkPermissionResult) => void;
    input: Record<string, unknown>;
    suggestions?: PermissionUpdate[];
    toolUseID: string;
}
export declare class ClaudeCodeSdkBackend implements AgentBackend {
    readonly kind: "claude-code";
    private readonly stateDir;
    private readonly env;
    private readonly defaultRuntimeTimeoutMs?;
    private readonly query;
    private readonly jobs;
    constructor(options?: ClaudeCodeSdkBackendOptions);
    run(options: AgentRunOptions): Promise<AgentRunStart>;
    continueJob(options: AgentContinueOptions): Promise<AgentRunStart>;
    status(handle: AgentHandle): Promise<AgentBackendStatus>;
    wait(handle: AgentHandle, timeoutMs?: number): Promise<WaitResult>;
    result(handle: AgentHandle): Promise<AgentBackendResult>;
    abort(handle: AgentHandle): Promise<void>;
    cleanup(options?: {
        olderThanMs?: number;
    }): Promise<CleanupResult>;
    listPermissions(handle: AgentHandle): Promise<AgentPermissionListResult>;
    replyPermission(handle: AgentHandle, options: {
        requestId: string;
        reply: PermissionReplyOption;
        message?: string;
    }): Promise<AgentPermissionReplyResult>;
    private runQuery;
    private recordPermission;
    private statusByJobId;
    private readMeta;
    private writeMeta;
    private patchMeta;
    private pendingPermissions;
}
export {};
