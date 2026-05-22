import type { JobMeta, JobResult, JobStatusResult, RunOptions } from "../core/types.js";

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
export type AgentPermissionReply = "once" | "always" | "reject";

export interface AgentPermissionRequest {
  id: string;
  sessionID?: string;
  permission: string;
  patterns: string[];
  always?: string[];
  toolCallID?: string;
  metadata?: unknown;
}

export interface AgentPermissionListResult {
  jobId: string;
  backend: "opencode";
  status: JobMeta["status"];
  permissions: AgentPermissionRequest[];
}

export interface AgentPermissionReplyResult extends AgentPermissionListResult {
  repliedRequestId: string;
  reply: AgentPermissionReply;
}

export interface AgentBackend {
  readonly kind: "claude-code" | "opencode";
  run(options: AgentRunOptions): Promise<AgentRunStart>;
  continueJob(options: AgentContinueOptions): Promise<AgentRunStart>;
  status(handle: AgentHandle): Promise<AgentBackendStatus>;
  result(handle: AgentHandle): Promise<AgentBackendResult>;
  abort(handle: AgentHandle): Promise<void>;
}
