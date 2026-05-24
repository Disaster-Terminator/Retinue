import type { JobMeta, JobResult, JobStatusResult, PermissionReplyOption, RetinuePermissionRequest, RunOptions } from "../core/types.js";

export interface AgentHandle {
  jobId: string;
}

export interface AgentRunOptions extends RunOptions {
  title?: string;
  model?: string;
  agent?: string;
  readOnly?: boolean;
  readOnlyBashPolicy?: "none" | "readonly_git";
  readOnlyPromptContract?: boolean;
  readOnlyToolDeny?: boolean;
}

export interface AgentContinueOptions extends AgentRunOptions {
  externalSessionId?: string;
}

export type AgentRunStart = JobMeta;
export type AgentBackendStatus = JobStatusResult;
export type AgentBackendResult = JobResult;
export type AgentPermissionReply = PermissionReplyOption;
export type AgentPermissionRequest = RetinuePermissionRequest;

export interface AgentPermissionListResult {
  jobId: string;
  backend: "claude-code" | "opencode" | "kilo";
  status: JobMeta["status"];
  permissions: AgentPermissionRequest[];
}

export interface AgentPermissionReplyResult extends AgentPermissionListResult {
  repliedRequestId: string;
  reply: AgentPermissionReply;
}

export interface AgentPermissionBridge {
  listPermissions(handle: AgentHandle): Promise<AgentPermissionListResult>;
  replyPermission(
    handle: AgentHandle,
    options: { requestId: string; reply: AgentPermissionReply; message?: string }
  ): Promise<AgentPermissionReplyResult>;
}

export interface AgentBackend {
  readonly kind: "claude-code" | "opencode" | "kilo";
  run(options: AgentRunOptions): Promise<AgentRunStart>;
  continueJob(options: AgentContinueOptions): Promise<AgentRunStart>;
  status(handle: AgentHandle): Promise<AgentBackendStatus>;
  result(handle: AgentHandle): Promise<AgentBackendResult>;
  abort(handle: AgentHandle): Promise<void>;
}

export type AgentBackendWithPermissions = AgentBackend & AgentPermissionBridge;

export function hasPermissionBridge(backend: AgentBackend): backend is AgentBackendWithPermissions {
  return "listPermissions" in backend && "replyPermission" in backend;
}
