#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SupervisorApi } from "./core/types.js";
export declare const CLAUDE_TOOL_NAMES: readonly ["claude_run", "claude_status", "claude_wait", "claude_result", "claude_continue", "claude_peek", "claude_kill", "claude_cleanup"];
export declare const OPENCODE_TOOL_NAMES: readonly ["opencode_run", "opencode_status", "opencode_wait", "opencode_result", "opencode_continue", "opencode_kill", "opencode_cleanup"];
export declare const RETINUE_TOOL_NAMES: readonly ["retinue_spawn_agent", "retinue_wait_agent", "retinue_close_agent"];
export declare function createMcpServer(supervisor?: SupervisorApi): McpServer;
export declare function createMcpSupervisorFromEnv(env?: NodeJS.ProcessEnv | Record<string, string | undefined>): SupervisorApi;
