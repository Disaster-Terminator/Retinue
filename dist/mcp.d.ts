#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type ClaudeSdkQueryFn } from "./backends/claude/sdkBackend.js";
import type { RetinueApi } from "./core/types.js";
export declare const CLAUDE_TOOL_NAMES: readonly ["claude_run", "claude_status", "claude_wait", "claude_result", "claude_continue", "claude_peek", "claude_kill", "claude_cleanup"];
export declare const OPENCODE_TOOL_NAMES: readonly ["opencode_run", "opencode_status", "opencode_wait", "opencode_result", "opencode_continue", "opencode_kill", "opencode_cleanup"];
export declare const RETINUE_TOOL_NAMES: readonly ["retinue_spawn_agent", "retinue_wait_agent", "retinue_close_agent", "retinue_list_agents", "retinue_list_permissions", "retinue_reply_permission", "retinue_stop_runtime", "retinue_restart_runtime"];
export declare const RETINUE_DIAGNOSTIC_TOOL_NAMES: readonly ["retinue_audit_logs"];
export interface CreateMcpServerOptions {
    exposeBackendTools?: boolean;
    exposeDiagnosticTools?: boolean;
    claudeSdkQuery?: ClaudeSdkQueryFn;
    preferClaudeSdk?: boolean;
}
export declare function createMcpServer(retinue?: RetinueApi, options?: CreateMcpServerOptions): McpServer;
export declare function createMcpRetinueFromEnv(env?: NodeJS.ProcessEnv | Record<string, string | undefined>): RetinueApi;
export declare function resolveMcpWaitTimeoutMs(timeoutMs: number | undefined, env: NodeJS.ProcessEnv): number | undefined;
