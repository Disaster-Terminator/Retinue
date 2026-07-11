#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ClaudeCodeSdkBackend } from "./backends/claude/sdkBackend.js";
import { OpenCodeBackend } from "./backends/opencode/backend.js";
import { OpenCodeClient } from "./backends/opencode/client.js";
import { ensureOpenCodeServer, resolveKiloServerFromEnv, resolveOpenCodeServerFromEnv, stopManagedOpenCodeServers } from "./backends/opencode/serverManager.js";
import { DaemonClient } from "./daemon/client.js";
import { readDaemonDiscoverySync } from "./daemon/discovery.js";
import { readTextTailIfExists } from "./core/fileTail.js";
import { resolveHttpTimeoutMs } from "./core/http.js";
import { auditRetinueLogs } from "./core/logAudit.js";
import { renderCompactAuditResult } from "./core/logAuditCompact.js";
import { getJobPaths, getRetinueTracePath, resolveStateDir } from "./core/paths.js";
import { ClaudeRetinue } from "./core/retinue.js";
import { isActivePoolStatus } from "./core/status.js";
import { hasPermissionBridge } from "./backends/types.js";
export const CLAUDE_TOOL_NAMES = [
    "claude_run",
    "claude_status",
    "claude_wait",
    "claude_result",
    "claude_continue",
    "claude_peek",
    "claude_kill",
    "claude_cleanup"
];
export const OPENCODE_TOOL_NAMES = [
    "opencode_run",
    "opencode_status",
    "opencode_wait",
    "opencode_result",
    "opencode_continue",
    "opencode_kill",
    "opencode_cleanup"
];
export const RETINUE_TOOL_NAMES = [
    "spawn_agent",
    "wait_agent",
    "close_agent",
    "list_agents",
    "list_permissions",
    "reply_permission",
    "stop_runtime",
    "restart_runtime"
];
export const RETINUE_DIAGNOSTIC_TOOL_NAMES = ["audit_logs"];
const DEFAULT_MCP_WAIT_MAX_MS = 180_000;
const DEFAULT_RESOURCE_BUDGET_LOCK_TIMEOUT_MS = 10_000;
const DEFAULT_RESOURCE_BUDGET_LOCK_STALE_MS = 5_000;
const DEFAULT_GLOBAL_AGENT_BUDGET = 5;
const DEFAULT_MAX_QUEUED_AGENTS = 20;
export const MAX_AGENT_MESSAGE_BYTES = 1024 * 1024;
export function createMcpServer(retinue = createMcpRetinueFromEnv(), options = {}) {
    const agentPool = new RetinueAgentPool();
    const openCodeSharedRootSessions = new Map();
    const claudeSdkJobs = new Map();
    const preferClaudeSdk = options.preferClaudeSdk ?? arguments.length === 0;
    const server = new McpServer({
        name: "retinue",
        version: "0.1.0"
    });
    if (options.exposeBackendTools ?? process.env.RETINUE_EXPOSE_BACKEND_TOOLS === "1") {
        registerBackendTools(server, retinue);
    }
    server.registerTool("spawn_agent", {
        title: "Spawn Retinue Agent",
        description: "Spawn a Retinue child agent using the deployment-selected backend and return a job handle. The optional agent field is the target backend-native child agent/profile, such as OpenCode/Kilo explore or general; it is not a Retinue backend name like opencode, a Codex model, or a Codex native subagent name.",
        inputSchema: {
            message: z.string(),
            task_name: z.string().optional(),
            taskName: z.string().optional(),
            cwd: z.string().optional(),
            title: z.string().optional(),
            agent: z.string().optional()
        }
    }, async (args) => {
        const taskName = normalizeTaskName(args);
        assertAgentMessageWithinLimit(args.message);
        const backend = await createRetinueBackend(retinue, openCodeSharedRootSessions, claudeSdkJobs, preferClaudeSdk, options.claudeSdkQuery);
        const stateDir = resolveStateDir({
            explicitStateDir: process.env.RETINUE_STATE_DIR,
            env: process.env
        });
        const spawned = await agentPool.withSpawnLock(async () => {
            await agentPool.drainQueue(retinue, process.env, openCodeSharedRootSessions, claudeSdkJobs, preferClaudeSdk, options.claudeSdkQuery);
            const strategy = resolveOverflowStrategy(process.env);
            if (strategy === "queue") {
                const queued = await agentPool.queueIfNeeded({
                    backendKind: backend.kind,
                    cwd: args.cwd ?? process.cwd(),
                    env: process.env,
                    agent: args.agent ?? (await resolveConfiguredAgentForBackend(backend.kind, process.env)),
                    prompt: args.message,
                    stateDir,
                    taskName,
                    title: args.title ?? taskName,
                    retinue,
                    sharedRootSessions: openCodeSharedRootSessions,
                    claudeSdkJobs,
                    preferClaudeSdk,
                    claudeSdkQuery: options.claudeSdkQuery
                });
                if (queued) {
                    return queued;
                }
            }
            const evicted = strategy === "evict"
                ? await agentPool.ensureSpawnSlot(retinue, process.env, openCodeSharedRootSessions, claudeSdkJobs, preferClaudeSdk, options.claudeSdkQuery)
                : undefined;
            return withGlobalAgentBudget({
                stateDir,
                env: process.env,
                retinue,
                sharedRootSessions: openCodeSharedRootSessions,
                claudeSdkJobs,
                preferClaudeSdk,
                claudeSdkQuery: options.claudeSdkQuery
            }, async () => {
                const agent = args.agent ?? (await resolveConfiguredAgentForBackend(backend.kind, process.env));
                const started = await backend.run({
                    cwd: args.cwd ?? process.cwd(),
                    prompt: args.message,
                    name: taskName,
                    title: args.title ?? taskName,
                    ...(backend.kind === "opencode"
                        ? {
                            model: process.env.RETINUE_OPENCODE_MODEL,
                            agent,
                            readOnly: false
                        }
                        : backend.kind === "kilo"
                            ? {
                                model: process.env.RETINUE_KILO_MODEL,
                                agent,
                                readOnly: false
                            }
                            : backend.kind === "claude-code"
                                ? {
                                    agent
                                }
                                : {})
                });
                agentPool.add({
                    jobId: started.jobId,
                    backend: started.backend ?? backend.kind,
                    taskName,
                    createdAt: Date.now()
                });
                return { evicted, started };
            });
        });
        if ("resourceExhausted" in spawned) {
            const exhausted = spawned.resourceExhausted;
            const isQueueFull = exhausted.reason === "queue_full";
            return jsonToolResult({
                task_name: taskName,
                status: "resource_exhausted",
                reason: exhausted.reason,
                backend: backend.kind,
                cwd: args.cwd ?? process.cwd(),
                message: isQueueFull
                    ? `Retinue queued-agent budget exhausted: ${exhausted.queuedAgents}/${exhausted.maxQueuedAgents}`
                    : `Retinue global active-agent budget exhausted: ${exhausted.activeAgents}/${exhausted.globalAgentBudget}`,
                ...(exhausted.globalAgentBudget !== undefined ? { globalAgentBudget: exhausted.globalAgentBudget } : {}),
                ...(exhausted.activeAgents !== undefined ? { activeGlobalAgents: exhausted.activeAgents } : {}),
                ...(exhausted.activeSessionAgents !== undefined ? { activeSessionAgents: exhausted.activeSessionAgents } : {}),
                ...(exhausted.activeJobIds !== undefined ? { activeJobIds: exhausted.activeJobIds } : {}),
                ...(exhausted.maxQueuedAgents !== undefined ? { maxQueuedAgents: exhausted.maxQueuedAgents } : {}),
                ...(exhausted.queuedAgents !== undefined ? { queuedAgents: exhausted.queuedAgents } : {}),
                tracePath: getRetinueTracePath(stateDir)
            });
        }
        if ("queued" in spawned) {
            const queued = spawned.queued;
            return jsonToolResult({
                task_name: taskName,
                jobId: queued.jobId,
                status: "queued",
                backend: queued.backend,
                cwd: queued.cwd,
                agent: queued.agent,
                jobDir: getJobPaths(stateDir, queued.jobId).dir,
                queuePosition: queued.queuePosition,
                maxQueuedAgents: queued.maxQueuedAgents,
                tracePath: getRetinueTracePath(stateDir)
            });
        }
        const { evicted, started } = spawned;
        return jsonToolResult({
            task_name: taskName,
            jobId: started.jobId,
            status: started.status,
            backend: started.backend,
            cwd: started.cwd,
            agent: started.agent,
            jobDir: getJobPaths(stateDir, started.jobId).dir,
            sessionId: started.sessionId,
            externalSessionId: started.externalSessionId,
            externalRunnerMode: started.externalRunnerMode,
            externalRootSessionId: started.externalRootSessionId,
            externalParentSessionId: started.externalParentSessionId,
            externalServerUrl: started.externalServerUrl,
            externalSessionDirectory: started.externalSessionDirectory,
            evictedJobId: evicted?.jobId
        });
    });
    server.registerTool("wait_agent", {
        title: "Wait For Retinue Agent",
        description: "Wait for a Retinue child agent and include its result when it reaches a terminal state.",
        inputSchema: {
            jobId: z.string(),
            timeoutMs: z.number().int().nonnegative().optional()
        }
    }, async ({ jobId, timeoutMs }) => {
        const backend = await createRetinueBackendForJob(retinue, jobId, openCodeSharedRootSessions, claudeSdkJobs, preferClaudeSdk, options.claudeSdkQuery);
        const effectiveTimeoutMs = resolveMcpWaitTimeoutMs(timeoutMs, process.env);
        const stateDir = resolveStateDir({
            explicitStateDir: process.env.RETINUE_STATE_DIR,
            env: process.env
        });
        await agentPool.drainQueue(retinue, process.env, openCodeSharedRootSessions, claudeSdkJobs, preferClaudeSdk, options.claudeSdkQuery);
        const queuedMeta = await readRetinueJobMeta(stateDir, jobId);
        if (queuedMeta?.status === "queued") {
            return jsonToolResult({
                task_name: queuedMeta.name,
                jobId,
                status: "queued",
                backend: queuedMeta.backend,
                cwd: queuedMeta.cwd,
                createdAt: queuedMeta.createdAt,
                updatedAt: queuedMeta.updatedAt,
                stateDir,
                jobDir: getJobPaths(stateDir, jobId).dir,
                queuePosition: await agentPool.queuePosition(jobId),
                tracePath: getRetinueTracePath(stateDir),
                requestedTimeoutMs: timeoutMs,
                effectiveTimeoutMs
            });
        }
        const waited = await backend.wait({ jobId }, effectiveTimeoutMs);
        const responseJobId = waited.jobId;
        if (responseJobId !== jobId) {
            agentPool.replace(jobId, responseJobId);
        }
        const status = waited.status === "running" ? await readRetinueJobMeta(stateDir, responseJobId) : await backend.status({ jobId: responseJobId });
        const responseStatus = waited.status === "running" ? "running" : isJobMeta(status) ? status.status : waited.status;
        if (responseStatus === "running") {
            const paths = getJobPaths(stateDir, responseJobId);
            const [stdoutTail, stderrTail, diagnostic] = await Promise.all([
                readTextTailIfExists(paths.stdout, 4096),
                readTextTailIfExists(paths.stderr, 4096),
                readLatestJobDiagnostic(paths.stderr)
            ]);
            return jsonToolResult({
                task_name: isJobMeta(status) ? status.name : undefined,
                jobId: responseJobId,
                requestedJobId: responseJobId === jobId ? undefined : jobId,
                selectedAttemptJobId: waited.selectedAttemptJobId,
                attemptChain: waited.attemptChain,
                status: responseStatus,
                backend: isJobMeta(status) ? status.backend : undefined,
                cwd: isJobMeta(status) ? status.cwd : undefined,
                createdAt: isJobMeta(status) ? status.createdAt : undefined,
                updatedAt: isJobMeta(status) ? status.updatedAt : undefined,
                externalSessionId: isJobMeta(status) ? status.externalSessionId : undefined,
                externalServerUrl: isJobMeta(status) ? status.externalServerUrl : undefined,
                stateDir,
                jobDir: paths.dir,
                promptPath: paths.prompt,
                stdoutPath: paths.stdout,
                stderrPath: paths.stderr,
                stdoutTail: stdoutTail.text,
                stderrTail: stderrTail.text,
                stdoutTailBytes: stdoutTail.bytes,
                stderrTailBytes: stderrTail.bytes,
                stdoutTailTruncated: stdoutTail.truncated,
                stderrTailTruncated: stderrTail.truncated,
                diagnostic,
                ...attentionFields(diagnostic, waited),
                tracePath: getRetinueTracePath(stateDir),
                requestedTimeoutMs: timeoutMs,
                effectiveTimeoutMs
            });
        }
        const paths = getJobPaths(stateDir, responseJobId);
        const result = await backend.result({ jobId: responseJobId });
        const diagnostic = await readLatestJobDiagnostic(paths.stderr);
        const attention = attentionFields(diagnostic, result);
        const responseDiagnostic = compactAttentionDiagnosticForMcp(diagnostic, attention);
        return jsonToolResult({
            task_name: isJobMeta(status) ? status.name : undefined,
            jobId: responseJobId,
            requestedJobId: responseJobId === jobId ? undefined : jobId,
            selectedAttemptJobId: result.attemptChain ? result.selectedAttemptJobId : result.selectedAttemptJobId ?? waited.selectedAttemptJobId,
            attemptChain: result.attemptChain ?? waited.attemptChain,
            status: responseStatus,
            ...attention,
            result: compactAttentionResultForMcp(result, attention),
            diagnostic: responseDiagnostic,
        });
    });
    server.registerTool("close_agent", {
        title: "Close Retinue Agent",
        description: "Close a Retinue child agent and its backend session.",
        inputSchema: {
            jobId: z.string()
        }
    }, async ({ jobId }) => {
        const backend = await createRetinueBackendForJob(retinue, jobId, openCodeSharedRootSessions, claudeSdkJobs, preferClaudeSdk, options.claudeSdkQuery);
        const stateDir = resolveStateDir({
            explicitStateDir: process.env.RETINUE_STATE_DIR,
            env: process.env
        });
        const meta = await readRetinueJobMeta(stateDir, jobId);
        if (meta?.status === "queued") {
            const killed = { ...meta, status: "killed", updatedAt: new Date().toISOString() };
            await writeJobMeta(stateDir, killed);
            agentPool.remove(jobId);
            await writeMcpTrace(process.env, { event: "retinue_queued_agent_cancelled", jobId, taskName: meta.name, backend: meta.backend });
            return jsonToolResult({ jobId, status: "killed" });
        }
        if (meta?.selectedAttemptJobId) {
            const selectedBackend = await createRetinueBackendForJob(retinue, meta.selectedAttemptJobId, openCodeSharedRootSessions, claudeSdkJobs, preferClaudeSdk, options.claudeSdkQuery);
            const selectedStatus = await selectedBackend.status({ jobId: meta.selectedAttemptJobId });
            if (isJobMeta(selectedStatus) && (selectedStatus.status === "running" || selectedStatus.status === "stalled")) {
                await selectedBackend.abort({ jobId: meta.selectedAttemptJobId });
                agentPool.remove(meta.selectedAttemptJobId);
                await writeJobMeta(stateDir, { ...meta, status: "killed", updatedAt: new Date().toISOString() });
                agentPool.remove(jobId);
                return jsonToolResult({ jobId, status: "killed", selectedAttemptJobId: meta.selectedAttemptJobId });
            }
            if (selectedStatus.status === "backend_unreachable") {
                const selectedMeta = await readRetinueJobMeta(stateDir, meta.selectedAttemptJobId);
                if (selectedMeta) {
                    await writeJobMeta(stateDir, { ...selectedMeta, status: "killed", updatedAt: new Date().toISOString() });
                }
                agentPool.remove(meta.selectedAttemptJobId);
                await writeJobMeta(stateDir, { ...meta, status: "killed", updatedAt: new Date().toISOString() });
                agentPool.remove(jobId);
                return jsonToolResult({ jobId, status: "killed", selectedAttemptJobId: meta.selectedAttemptJobId });
            }
        }
        const status = await backend.status({ jobId });
        if (isJobMeta(status) && status.status === "running") {
            await backend.abort({ jobId });
            agentPool.remove(jobId);
            return jsonToolResult({ jobId, status: "killed" });
        }
        if (isJobMeta(status) && status.status === "stalled") {
            await backend.abort({ jobId });
            agentPool.remove(jobId);
            return jsonToolResult({ jobId, status: "killed" });
        }
        if (status.status === "backend_unreachable" && meta) {
            await writeJobMeta(stateDir, { ...meta, status: "killed", updatedAt: new Date().toISOString() });
            agentPool.remove(jobId);
            return jsonToolResult({ jobId, status: "killed" });
        }
        agentPool.remove(jobId);
        return jsonToolResult({ jobId, status: "status" in status ? status.status : "unknown" });
    });
    server.registerTool("list_agents", {
        title: "List Retinue Agents",
        description: "List live Retinue child agents tracked by this MCP server session.",
        inputSchema: {}
    }, async () => {
        await agentPool.drainQueue(retinue, process.env, openCodeSharedRootSessions, claudeSdkJobs, preferClaudeSdk, options.claudeSdkQuery);
        return jsonToolResult({
            maxAgents: await resolveMaxConcurrentAgents(process.env),
            agents: await agentPool.list(retinue, openCodeSharedRootSessions, claudeSdkJobs, preferClaudeSdk, options.claudeSdkQuery)
        });
    });
    server.registerTool("list_permissions", {
        title: "List Retinue Permissions",
        description: "List pending backend permission requests for one Retinue child job, or all known jobs when jobId is omitted.",
        inputSchema: {
            jobId: z.string().optional()
        }
    }, async ({ jobId }) => {
        if (jobId === undefined) {
            const agents = await agentPool.listKnown(retinue, openCodeSharedRootSessions, claudeSdkJobs, preferClaudeSdk, options.claudeSdkQuery);
            const results = [];
            for (const agent of agents) {
                const backend = await createRetinueBackendForJob(retinue, agent.jobId, openCodeSharedRootSessions, claudeSdkJobs, preferClaudeSdk, options.claudeSdkQuery);
                if (!hasPermissionBridge(backend)) {
                    continue;
                }
                const list = await backend.listPermissions({ jobId: agent.jobId });
                results.push({
                    jobId: agent.jobId,
                    backend: agent.backend,
                    status: agent.status,
                    task_name: agent.task_name,
                    permissions: list.permissions
                });
            }
            return jsonToolResult({
                scope: "known_jobs",
                agents: results,
                permissions: results.flatMap((result) => result.permissions.map((permission) => ({
                    ...permission,
                    jobId: result.jobId,
                    backend: result.backend,
                    status: result.status,
                    task_name: result.task_name
                })))
            });
        }
        const backend = await createRetinueBackendForJob(retinue, jobId, openCodeSharedRootSessions, claudeSdkJobs, preferClaudeSdk, options.claudeSdkQuery);
        if (!hasPermissionBridge(backend)) {
            throw new Error(`Retinue backend ${backend.kind} does not expose permission requests`);
        }
        return jsonToolResult(await backend.listPermissions({ jobId }));
    });
    server.registerTool("reply_permission", {
        title: "Reply To Retinue Permission",
        description: "Reply to a pending backend permission request for a Retinue child job.",
        inputSchema: {
            jobId: z.string(),
            requestId: z.string(),
            reply: z.enum(["once", "always", "reject"]),
            message: z.string().optional()
        }
    }, async ({ jobId, requestId, reply, message }) => {
        const backend = await createRetinueBackendForJob(retinue, jobId, openCodeSharedRootSessions, claudeSdkJobs, preferClaudeSdk, options.claudeSdkQuery);
        if (!hasPermissionBridge(backend)) {
            throw new Error(`Retinue backend ${backend.kind} does not expose permission requests`);
        }
        return jsonToolResult(await backend.replyPermission({ jobId }, { requestId, reply, message }));
    });
    server.registerTool("stop_runtime", {
        title: "Stop Retinue Runtime",
        description: "Stop Retinue-managed local runtime servers. Only OpenCode auto-serve servers started by Retinue are managed.",
        inputSchema: {
            runtime: z.enum(["opencode"]).optional(),
            cwd: z.string().optional(),
            all: z.boolean().optional(),
            force: z.boolean().optional()
        }
    }, async ({ runtime, cwd, all, force }) => {
        const selectedRuntime = runtime ?? "opencode";
        if (selectedRuntime !== "opencode") {
            return jsonToolResult({ runtime: selectedRuntime, status: "unsupported" });
        }
        if (all !== true && !cwd?.trim()) {
            return jsonToolResult({
                runtime: selectedRuntime,
                status: "invalid_request",
                error: "stop_runtime requires cwd or all=true"
            });
        }
        const stateDir = resolveStateDir({
            explicitStateDir: process.env.RETINUE_STATE_DIR,
            env: process.env
        });
        return jsonToolResult(await stopManagedOpenCodeServers({ stateDir, cwd, all, force, reason: "manual" }));
    });
    server.registerTool("restart_runtime", {
        title: "Restart Retinue Runtime",
        description: "Restart a Retinue-managed local runtime server for one cwd. Only OpenCode auto-serve servers started by Retinue are managed.",
        inputSchema: {
            runtime: z.enum(["opencode"]).optional(),
            cwd: z.string(),
            force: z.boolean().optional()
        }
    }, async ({ runtime, cwd, force }) => {
        const selectedRuntime = runtime ?? "opencode";
        if (selectedRuntime !== "opencode") {
            return jsonToolResult({ runtime: selectedRuntime, status: "unsupported" });
        }
        const resolution = resolveOpenCodeServerFromEnv(process.env);
        if (resolution.mode === "attach") {
            return jsonToolResult({
                backend: selectedRuntime,
                status: "not_managed",
                error: "restart_runtime only manages Retinue auto-served OpenCode servers; RETINUE_OPENCODE_BASE_URL is external."
            });
        }
        const stateDir = resolveStateDir({
            explicitStateDir: process.env.RETINUE_STATE_DIR,
            env: process.env
        });
        const stopped = await stopManagedOpenCodeServers({ stateDir, cwd, force, reason: "restart" });
        if (stopped.status === "blocked") {
            return jsonToolResult(stopped);
        }
        const started = await ensureOpenCodeServer(resolution, { stateDir, cwd });
        return jsonToolResult({
            backend: selectedRuntime,
            status: "restarted",
            stopped: stopped.stopped,
            started: {
                baseUrl: started.baseUrl,
                cwd,
                reusedExisting: started.started !== true
            }
        });
    });
    if (options.exposeDiagnosticTools ?? process.env.RETINUE_EXPOSE_DIAGNOSTIC_TOOLS === "1") {
        registerDiagnosticTools(server);
    }
    return server;
}
function registerDiagnosticTools(server) {
    server.registerTool("audit_logs", {
        title: "Audit Retinue Logs",
        description: "Developer diagnostic tool for summarizing recent Retinue/OpenCode stall logs. Hidden from the default product tool surface.",
        inputSchema: {
            since: z.string().optional(),
            maxLines: z.number().int().positive().optional(),
            maxBytes: z.number().int().positive().optional(),
            stateDir: z.string().optional(),
            tracePath: z.string().optional(),
            compact: z.boolean().optional()
        }
    }, async ({ since, maxLines, maxBytes, stateDir, tracePath, compact }) => {
        const parsedSince = since ? new Date(since) : undefined;
        if (parsedSince && Number.isNaN(parsedSince.getTime())) {
            throw new Error("since must be an ISO timestamp");
        }
        const audit = await auditRetinueLogs({
            stateDir: stateDir ??
                resolveStateDir({
                    explicitStateDir: process.env.RETINUE_STATE_DIR,
                    env: process.env
                }),
            tracePath,
            since: parsedSince,
            maxLines,
            maxBytes
        });
        if (compact === false) {
            return jsonToolResult(audit);
        }
        return jsonToolResult({
            format: "compact",
            issueCount: audit.issueCount,
            attentionCount: audit.attentionCount,
            scannedEvents: audit.scannedEvents,
            ignoredCompletedJobIds: audit.ignoredCompletedJobIds,
            tracePath: audit.tracePath,
            since: audit.since,
            text: renderCompactAuditResult(audit)
        });
    });
}
export function assertAgentMessageWithinLimit(message) {
    const byteLength = Buffer.byteLength(message, "utf8");
    if (byteLength > MAX_AGENT_MESSAGE_BYTES) {
        throw new Error(`Retinue agent message is too large: ${byteLength} bytes exceeds ${MAX_AGENT_MESSAGE_BYTES} bytes`);
    }
}
function registerBackendTools(server, retinue) {
    server.registerTool("claude_run", {
        title: "Run Claude Code Job",
        description: "Start a Claude Code background job and return a job handle.",
        inputSchema: {
            cwd: z.string(),
            prompt: z.string(),
            name: z.string().optional(),
            resume: z.string().optional(),
            maxTurns: z.number().int().positive().optional(),
            permissionMode: z.enum(["default", "acceptEdits", "plan", "auto", "dontAsk"]).optional(),
            timeoutMs: z.number().int().positive().optional()
        }
    }, async (args) => jsonToolResult(await retinue.run(args)));
    server.registerTool("claude_status", {
        title: "Get Claude Code Job Status",
        description: "Read current status metadata for a Claude Code job.",
        inputSchema: { jobId: z.string() }
    }, async ({ jobId }) => jsonToolResult(await retinue.status(jobId)));
    server.registerTool("claude_wait", {
        title: "Wait For Claude Code Job",
        description: "Wait briefly for a Claude Code job to reach a terminal state.",
        inputSchema: {
            jobId: z.string(),
            timeoutMs: z.number().int().positive().optional()
        }
    }, async ({ jobId, timeoutMs }) => jsonToolResult(await retinue.wait(jobId, { timeoutMs })));
    server.registerTool("claude_result", {
        title: "Read Claude Code Job Result",
        description: "Read stdout, stderr, parsed JSON, and exit status for a Claude Code job.",
        inputSchema: { jobId: z.string() }
    }, async ({ jobId }) => jsonToolResult(await retinue.result(jobId)));
    server.registerTool("claude_continue", {
        title: "Continue Claude Code Session",
        description: "Start a new Claude Code job using a prior job session id or an explicit session id.",
        inputSchema: {
            cwd: z.string(),
            prompt: z.string(),
            jobId: z.string().optional(),
            sessionId: z.string().optional(),
            name: z.string().optional(),
            maxTurns: z.number().int().positive().optional(),
            permissionMode: z.enum(["default", "acceptEdits", "plan", "auto", "dontAsk"]).optional(),
            timeoutMs: z.number().int().positive().optional()
        }
    }, async (args) => jsonToolResult(await retinue.continueJob(args)));
    server.registerTool("claude_peek", {
        title: "Peek Claude Code Job Output",
        description: "Read bounded stdout/stderr tails for a running or completed Claude Code job.",
        inputSchema: {
            jobId: z.string(),
            stdoutTailBytes: z.number().int().positive().optional(),
            stderrTailBytes: z.number().int().positive().optional()
        }
    }, async ({ jobId, stdoutTailBytes, stderrTailBytes }) => jsonToolResult(await retinue.peek(jobId, { stdoutTailBytes, stderrTailBytes })));
    server.registerTool("claude_kill", {
        title: "Kill Claude Code Job",
        description: "Kill a running Claude Code job process tree.",
        inputSchema: { jobId: z.string() }
    }, async ({ jobId }) => jsonToolResult(await retinue.kill(jobId)));
    server.registerTool("claude_cleanup", {
        title: "Cleanup Claude Code Jobs",
        description: "Remove terminal job directories while preserving running jobs.",
        inputSchema: { olderThanMs: z.number().int().nonnegative().optional() }
    }, async ({ olderThanMs }) => jsonToolResult(await retinue.cleanup({ olderThanMs })));
    server.registerTool("opencode_run", {
        title: "Run OpenCode Job",
        description: "Start an OpenCode background job through an attached OpenCode server.",
        inputSchema: opencodeRunSchema()
    }, async (args) => jsonToolResult(await (await createOpenCodeBackend(args)).run(await withOpenCodeDefaults(args))));
    server.registerTool("opencode_status", {
        title: "Get OpenCode Job Status",
        description: "Read current status metadata for an OpenCode job.",
        inputSchema: { jobId: z.string(), opencodeBaseUrl: z.string().optional() }
    }, async ({ jobId, opencodeBaseUrl }) => jsonToolResult(await (await createOpenCodeBackend({ opencodeBaseUrl })).status({ jobId })));
    server.registerTool("opencode_wait", {
        title: "Wait For OpenCode Job",
        description: "Wait for an OpenCode job result through the attached OpenCode server.",
        inputSchema: { jobId: z.string(), timeoutMs: z.number().int().nonnegative().optional(), opencodeBaseUrl: z.string().optional() }
    }, async ({ jobId, timeoutMs, opencodeBaseUrl }) => {
        const result = await (await createOpenCodeBackend({ opencodeBaseUrl })).wait({ jobId }, resolveMcpWaitTimeoutMs(timeoutMs, process.env));
        return jsonToolResult(result);
    });
    server.registerTool("opencode_result", {
        title: "Read OpenCode Job Result",
        description: "Read the latest OpenCode message result for a retinue job.",
        inputSchema: { jobId: z.string(), opencodeBaseUrl: z.string().optional() }
    }, async ({ jobId, opencodeBaseUrl }) => jsonToolResult(await (await createOpenCodeBackend({ opencodeBaseUrl })).result({ jobId })));
    server.registerTool("opencode_continue", {
        title: "Continue OpenCode Session",
        description: "Send a prompt to an existing OpenCode session.",
        inputSchema: {
            ...opencodeRunSchema(),
            externalSessionId: z.string(),
            jobId: z.string().optional()
        }
    }, async (args) => jsonToolResult(await (await createOpenCodeBackend(args)).continueJob({
        ...(await withOpenCodeDefaults(args)),
        parentJobId: args.jobId,
        parentSessionId: args.externalSessionId
    })));
    server.registerTool("opencode_kill", {
        title: "Abort OpenCode Job",
        description: "Abort the OpenCode session associated with a retinue job.",
        inputSchema: { jobId: z.string(), opencodeBaseUrl: z.string().optional() }
    }, async ({ jobId, opencodeBaseUrl }) => {
        await (await createOpenCodeBackend({ opencodeBaseUrl })).abort({ jobId });
        return jsonToolResult({ jobId, status: "killed" });
    });
    server.registerTool("opencode_cleanup", {
        title: "Cleanup OpenCode Jobs",
        description: "Placeholder cleanup surface for OpenCode job artifacts.",
        inputSchema: { olderThanMs: z.number().int().nonnegative().optional() }
    }, async ({ olderThanMs }) => jsonToolResult(await (await createOpenCodeBackend({})).cleanup({ olderThanMs })));
}
function opencodeRunSchema() {
    return {
        cwd: z.string(),
        prompt: z.string(),
        name: z.string().optional(),
        title: z.string().optional(),
        model: z.string().optional(),
        agent: z.string().optional(),
        opencodeBaseUrl: z.string().optional()
    };
}
async function createOpenCodeBackend(args) {
    const env = {
        ...process.env,
        RETINUE_OPENCODE_BASE_URL: args.opencodeBaseUrl ?? process.env.RETINUE_OPENCODE_BASE_URL
    };
    const stateDir = resolveStateDir({ explicitStateDir: process.env.RETINUE_STATE_DIR, env: process.env });
    return new OpenCodeBackend({
        kind: "opencode",
        target: async (cwd) => {
            const resolution = resolveOpenCodeServerFromEnv(env);
            const target = await ensureOpenCodeServer(resolution, { stateDir, cwd });
            return { client: new OpenCodeClient(target.baseUrl, { timeoutMs: resolveHttpTimeoutMs(env) }), baseUrl: target.baseUrl };
        },
        stateDir,
        env: process.env,
        sharedRootSessions: args.sharedRootSessions
    });
}
async function createKiloBackend(args) {
    const env = {
        ...process.env,
        RETINUE_KILO_BASE_URL: args.kiloBaseUrl ?? process.env.RETINUE_KILO_BASE_URL
    };
    const stateDir = resolveStateDir({ explicitStateDir: process.env.RETINUE_STATE_DIR, env: process.env });
    return new OpenCodeBackend({
        kind: "kilo",
        target: async (cwd) => {
            const resolution = resolveKiloServerFromEnv(env);
            const target = await ensureOpenCodeServer(resolution, { stateDir, cwd });
            return {
                client: new OpenCodeClient(target.baseUrl, { timeoutMs: resolveHttpTimeoutMs(env) }),
                baseUrl: target.baseUrl
            };
        },
        stateDir,
        env: process.env,
        sharedRootSessions: args.sharedRootSessions
    });
}
async function withOpenCodeDefaults(args) {
    return {
        ...args,
        model: args.model ?? process.env.RETINUE_OPENCODE_MODEL,
        agent: args.agent ?? (await resolveConfiguredOpenCodeAgent(process.env))
    };
}
async function resolveConfiguredAgentForBackend(kind, env) {
    if (kind === "opencode") {
        return resolveConfiguredOpenCodeAgent(env);
    }
    if (kind === "kilo") {
        return env.RETINUE_KILO_AGENT ?? "explore";
    }
    if (kind === "claude-code") {
        return env.RETINUE_CLAUDE_AGENT?.trim() || undefined;
    }
    return undefined;
}
class RetinueAgentPool {
    entries = new Map();
    spawnQueue = Promise.resolve();
    async withSpawnLock(operation) {
        const previous = this.spawnQueue;
        let release = () => undefined;
        this.spawnQueue = new Promise((resolve) => {
            release = resolve;
        });
        await previous;
        try {
            return await operation();
        }
        finally {
            release();
        }
    }
    async queueIfNeeded(options) {
        const [activeEntries, hasGlobalSlot] = await Promise.all([
            this.activeEntries(options.retinue, options.sharedRootSessions, options.claudeSdkJobs, options.preferClaudeSdk, options.claudeSdkQuery),
            hasGlobalAgentBudgetSlot({
                stateDir: options.stateDir,
                env: options.env,
                retinue: options.retinue,
                sharedRootSessions: options.sharedRootSessions,
                claudeSdkJobs: options.claudeSdkJobs,
                preferClaudeSdk: options.preferClaudeSdk,
                claudeSdkQuery: options.claudeSdkQuery
            })
        ]);
        const hasSessionSlot = activeEntries.length < (await resolveMaxConcurrentAgents(options.env));
        if (hasSessionSlot && hasGlobalSlot) {
            return undefined;
        }
        const queuedEntries = await this.queuedEntries();
        const maxQueuedAgents = resolveMaxQueuedAgents(options.env);
        if (queuedEntries.length >= maxQueuedAgents) {
            const activeJobIds = activeEntries.map((entry) => entry.jobId);
            await writeMcpTrace(options.env, {
                event: "retinue_agent_queue_exhausted",
                taskName: options.taskName,
                backend: options.backendKind,
                maxQueuedAgents,
                activeAgents: activeEntries.length,
                activeJobIds
            });
            return {
                resourceExhausted: {
                    reason: "queue_full",
                    maxQueuedAgents,
                    queuedAgents: queuedEntries.length,
                    activeSessionAgents: activeEntries.length,
                    activeJobIds
                }
            };
        }
        const meta = await createQueuedJobMeta(options);
        this.add({
            jobId: meta.jobId,
            backend: options.backendKind,
            taskName: options.taskName,
            createdAt: Date.parse(meta.createdAt)
        });
        await writeMcpTrace(options.env, {
            event: "retinue_agent_queued",
            jobId: meta.jobId,
            taskName: options.taskName,
            backend: options.backendKind,
            queuePosition: queuedEntries.length + 1,
            maxQueuedAgents,
            hasSessionSlot,
            hasGlobalSlot
        });
        return {
            queued: {
                jobId: meta.jobId,
                backend: options.backendKind,
                cwd: options.cwd,
                agent: meta.agent,
                queuePosition: queuedEntries.length + 1,
                maxQueuedAgents
            }
        };
    }
    async drainQueue(retinue, env, sharedRootSessions, claudeSdkJobs, preferClaudeSdk, claudeSdkQuery) {
        const stateDir = resolveStateDir({ explicitStateDir: env.RETINUE_STATE_DIR, env });
        for (;;) {
            const queued = (await this.queuedEntries())[0];
            if (!queued) {
                return;
            }
            if (!(await this.hasSessionSpawnSlot(retinue, env, sharedRootSessions, claudeSdkJobs, preferClaudeSdk, claudeSdkQuery))) {
                return;
            }
            const meta = await readRetinueJobMeta(stateDir, queued.jobId);
            if (!meta || meta.status !== "queued" || !meta.backend) {
                this.entries.delete(queued.jobId);
                continue;
            }
            const started = await withGlobalAgentBudget({ stateDir, env, retinue, sharedRootSessions, claudeSdkJobs, preferClaudeSdk, claudeSdkQuery }, async () => {
                const backend = await createRetinueBackendByKind(meta.backend, retinue, sharedRootSessions, claudeSdkJobs, preferClaudeSdk, claudeSdkQuery);
                return backend.run({
                    cwd: meta.cwd,
                    prompt: meta.prompt ?? "",
                    name: meta.name,
                    title: meta.title ?? meta.name,
                    ...(meta.backend === "opencode"
                        ? { model: env.RETINUE_OPENCODE_MODEL, agent: meta.agent, readOnly: false }
                        : meta.backend === "kilo"
                            ? { model: env.RETINUE_KILO_MODEL, agent: meta.agent, readOnly: false }
                            : meta.backend === "claude-code"
                                ? { agent: meta.agent }
                                : {})
                });
            });
            if ("resourceExhausted" in started) {
                return;
            }
            const now = new Date().toISOString();
            await writeJobMeta(stateDir, {
                ...meta,
                status: "running",
                selectedAttemptJobId: started.jobId,
                attemptJobIds: [...(meta.attemptJobIds ?? []), started.jobId],
                updatedAt: now
            });
            this.entries.delete(queued.jobId);
            this.add({
                jobId: started.jobId,
                backend: started.backend ?? meta.backend,
                taskName: meta.name,
                createdAt: Date.parse(started.createdAt ?? now)
            });
            await writeMcpTrace(env, {
                event: "retinue_queued_agent_promoted",
                jobId: meta.jobId,
                startedJobId: started.jobId,
                taskName: meta.name,
                backend: started.backend ?? meta.backend
            });
        }
    }
    async queuePosition(jobId) {
        const index = (await this.queuedEntries()).findIndex((entry) => entry.jobId === jobId);
        return index >= 0 ? index + 1 : undefined;
    }
    async hasSessionSpawnSlot(retinue, env, sharedRootSessions, claudeSdkJobs, preferClaudeSdk, claudeSdkQuery) {
        const maxAgents = await resolveMaxConcurrentAgents(env);
        const activeEntries = await this.activeEntries(retinue, sharedRootSessions, claudeSdkJobs, preferClaudeSdk, claudeSdkQuery);
        return activeEntries.length < maxAgents;
    }
    async activeEntries(retinue, sharedRootSessions, claudeSdkJobs, preferClaudeSdk, claudeSdkQuery) {
        const activeEntries = [];
        for (const entry of [...this.entries.values()]) {
            const status = await this.statusForEntry(entry, retinue, sharedRootSessions, claudeSdkJobs, preferClaudeSdk, claudeSdkQuery);
            if (!status || status.status === "queued") {
                continue;
            }
            if (!isActivePoolStatus(status.status)) {
                this.entries.delete(entry.jobId);
                continue;
            }
            activeEntries.push(entry);
        }
        return activeEntries;
    }
    async queuedEntries() {
        const stateDir = resolveStateDir({ explicitStateDir: process.env.RETINUE_STATE_DIR, env: process.env });
        const queued = [];
        for (const entry of [...this.entries.values()].sort((left, right) => left.createdAt - right.createdAt)) {
            const meta = await readRetinueJobMeta(stateDir, entry.jobId);
            if (meta?.status === "queued") {
                queued.push(entry);
                continue;
            }
            if (meta) {
                continue;
            }
            if (!meta) {
                this.entries.delete(entry.jobId);
            }
        }
        return queued;
    }
    async statusForEntry(entry, retinue, sharedRootSessions, claudeSdkJobs, preferClaudeSdk, claudeSdkQuery) {
        const stateDir = resolveStateDir({ explicitStateDir: process.env.RETINUE_STATE_DIR, env: process.env });
        const meta = await readRetinueJobMeta(stateDir, entry.jobId);
        if (meta?.status === "queued") {
            return meta;
        }
        const backend = await createRetinueBackendByKind(entry.backend, retinue, sharedRootSessions, claudeSdkJobs, preferClaudeSdk, claudeSdkQuery);
        const status = await backend.status({ jobId: entry.jobId });
        return isJobMeta(status) ? status : undefined;
    }
    async ensureSpawnSlot(retinue, env, sharedRootSessions, claudeSdkJobs, preferClaudeSdk, claudeSdkQuery) {
        const maxAgents = await resolveMaxConcurrentAgents(env);
        const activeEntries = await this.activeEntries(retinue, sharedRootSessions, claudeSdkJobs, preferClaudeSdk, claudeSdkQuery);
        if (activeEntries.length < maxAgents) {
            return undefined;
        }
        activeEntries.sort((left, right) => left.createdAt - right.createdAt);
        const evicted = activeEntries[0];
        if (!evicted) {
            return undefined;
        }
        const backend = await createRetinueBackendByKind(evicted.backend, retinue, sharedRootSessions, claudeSdkJobs, preferClaudeSdk, claudeSdkQuery);
        await backend.abort({ jobId: evicted.jobId });
        this.entries.delete(evicted.jobId);
        await writeMcpTrace(env, {
            event: "retinue_agent_evicted",
            evictedJobId: evicted.jobId,
            taskName: evicted.taskName,
            backend: evicted.backend,
            maxAgents
        });
        return evicted;
    }
    add(entry) {
        this.entries.set(entry.jobId, entry);
    }
    replace(fromJobId, toJobId) {
        const entry = this.entries.get(fromJobId);
        if (!entry || fromJobId === toJobId) {
            return;
        }
        this.entries.delete(fromJobId);
        this.entries.set(toJobId, { ...entry, jobId: toJobId });
    }
    remove(jobId) {
        this.entries.delete(jobId);
    }
    async list(retinue, sharedRootSessions, claudeSdkJobs, preferClaudeSdk, claudeSdkQuery) {
        const agents = [];
        const queued = await this.queuedEntries();
        for (const entry of [...this.entries.values()].sort((left, right) => left.createdAt - right.createdAt)) {
            const status = await this.statusForEntry(entry, retinue, sharedRootSessions, claudeSdkJobs, preferClaudeSdk, claudeSdkQuery);
            if (!status) {
                this.entries.delete(entry.jobId);
                continue;
            }
            if (status.status !== "queued" && !isActivePoolStatus(status.status)) {
                this.entries.delete(entry.jobId);
                continue;
            }
            const queueIndex = queued.findIndex((queuedEntry) => queuedEntry.jobId === entry.jobId);
            agents.push({
                jobId: entry.jobId,
                task_name: entry.taskName,
                backend: entry.backend,
                status: status.status,
                createdAt: new Date(entry.createdAt).toISOString(),
                queuePosition: queueIndex >= 0 ? queueIndex + 1 : undefined
            });
        }
        return agents;
    }
    async listKnown(retinue, sharedRootSessions, claudeSdkJobs, preferClaudeSdk, claudeSdkQuery) {
        const agents = [];
        const queued = await this.queuedEntries();
        for (const entry of [...this.entries.values()].sort((left, right) => left.createdAt - right.createdAt)) {
            const status = await this.statusForEntry(entry, retinue, sharedRootSessions, claudeSdkJobs, preferClaudeSdk, claudeSdkQuery);
            if (!status) {
                this.entries.delete(entry.jobId);
                continue;
            }
            const queueIndex = queued.findIndex((queuedEntry) => queuedEntry.jobId === entry.jobId);
            agents.push({
                jobId: entry.jobId,
                task_name: entry.taskName,
                backend: entry.backend,
                status: status.status,
                createdAt: new Date(entry.createdAt).toISOString(),
                queuePosition: queueIndex >= 0 ? queueIndex + 1 : undefined
            });
        }
        return agents;
    }
}
async function withGlobalAgentBudget(options, operation) {
    return withGlobalAgentBudgetLock(options.stateDir, options.env, async () => {
        const globalAgentBudget = await resolveGlobalAgentBudget(options.env);
        const activeAgents = await listGlobalRunningAgents(options);
        if (activeAgents.length >= globalAgentBudget) {
            const activeJobIds = activeAgents.map((agent) => agent.jobId);
            await writeMcpTrace(options.env, {
                event: "retinue_global_agent_budget_exhausted",
                globalAgentBudget,
                activeGlobalAgents: activeAgents.length,
                activeJobIds
            });
            return {
                resourceExhausted: {
                    reason: "global_agent_budget_exhausted",
                    globalAgentBudget,
                    activeAgents: activeAgents.length,
                    activeJobIds
                }
            };
        }
        return operation();
    });
}
async function hasGlobalAgentBudgetSlot(options) {
    return withGlobalAgentBudgetLock(options.stateDir, options.env, async () => {
        const globalAgentBudget = await resolveGlobalAgentBudget(options.env);
        const activeAgents = await listGlobalRunningAgents(options);
        return activeAgents.length < globalAgentBudget;
    });
}
async function listGlobalRunningAgents(options) {
    const jobsDir = path.join(options.stateDir, "jobs");
    const entries = await readDirIfExists(jobsDir);
    const active = [];
    for (const entry of entries) {
        if (!entry.isDirectory()) {
            continue;
        }
        const meta = await readRetinueJobMeta(options.stateDir, entry.name);
        if (!meta?.backend || !isActivePoolStatus(meta.status)) {
            continue;
        }
        if (meta.selectedAttemptJobId) {
            const selectedMeta = await readRetinueJobMeta(options.stateDir, meta.selectedAttemptJobId);
            if (selectedMeta?.backend && isActivePoolStatus(selectedMeta.status)) {
                continue;
            }
        }
        try {
            const backend = await createRetinueBackendByKind(meta.backend, options.retinue, options.sharedRootSessions, options.claudeSdkJobs, options.preferClaudeSdk, options.claudeSdkQuery);
            const status = await backend.status({ jobId: meta.jobId });
            if (isJobMeta(status) && status.status === "running") {
                active.push(status);
            }
        }
        catch (error) {
            await writeMcpTrace(options.env, {
                event: "retinue_global_agent_budget_status_failed",
                jobId: meta.jobId,
                backend: meta.backend,
                error: error instanceof Error ? error.message : String(error)
            });
        }
    }
    return active.sort((left, right) => Date.parse(left.createdAt ?? "") - Date.parse(right.createdAt ?? ""));
}
async function withGlobalAgentBudgetLock(stateDir, env, operation) {
    const timeoutMs = parseOptionalNumber(env.RETINUE_GLOBAL_AGENT_BUDGET_LOCK_TIMEOUT_MS) ?? DEFAULT_RESOURCE_BUDGET_LOCK_TIMEOUT_MS;
    const lockPath = path.join(stateDir, "retinue-global-agent-budget.lock");
    const deadline = Date.now() + timeoutMs;
    await fs.mkdir(path.dirname(lockPath), { recursive: true });
    for (;;) {
        try {
            const handle = await fs.open(lockPath, "wx");
            await handle.writeFile(`${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`, "utf8");
            await handle.close();
            try {
                return await operation();
            }
            finally {
                await fs.rm(lockPath, { force: true });
            }
        }
        catch (error) {
            if (!isFileExistsError(error)) {
                throw error;
            }
            await removeStaleGlobalAgentBudgetLock(lockPath);
            if (Date.now() >= deadline) {
                throw new Error(`Timed out waiting for Retinue global agent budget lock at ${lockPath}`);
            }
            await sleep(100);
        }
    }
}
async function removeStaleGlobalAgentBudgetLock(lockPath) {
    try {
        const parsed = JSON.parse(await fs.readFile(lockPath, "utf8"));
        if (typeof parsed.pid === "number" && Number.isInteger(parsed.pid) && !isPidAlive(parsed.pid)) {
            await fs.rm(lockPath, { force: true });
            return;
        }
    }
    catch {
        // Fall back to mtime-based stale lock cleanup below.
    }
    try {
        const stat = await fs.stat(lockPath);
        if (Date.now() - stat.mtimeMs > DEFAULT_RESOURCE_BUDGET_LOCK_STALE_MS) {
            await fs.rm(lockPath, { force: true });
        }
    }
    catch {
        // Best-effort cleanup only.
    }
}
function isFileExistsError(error) {
    return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}
function isPidAlive(pid) {
    if (pid <= 0) {
        return false;
    }
    try {
        process.kill(pid, 0);
        return true;
    }
    catch {
        return false;
    }
}
async function readDirIfExists(dirPath) {
    try {
        return await fs.readdir(dirPath, { withFileTypes: true });
    }
    catch (error) {
        if (isMissingFile(error)) {
            return [];
        }
        throw error;
    }
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
async function resolveMaxConcurrentAgents(env) {
    const configured = parseOptionalNumber(env.RETINUE_MAX_CONCURRENT_AGENTS) ?? (await readConfiguredMaxConcurrentAgents(env));
    const maxAgents = configured ?? 3;
    if (!Number.isFinite(maxAgents)) {
        return 3;
    }
    return Math.max(1, Math.floor(maxAgents));
}
async function resolveGlobalAgentBudget(env) {
    const configured = parseOptionalNumber(env.RETINUE_GLOBAL_AGENT_BUDGET);
    if (configured !== undefined) {
        return Math.max(1, Math.floor(configured));
    }
    return Math.max(DEFAULT_GLOBAL_AGENT_BUDGET, await resolveMaxConcurrentAgents(env));
}
function resolveMaxQueuedAgents(env) {
    const configured = parseOptionalNumber(env.RETINUE_MAX_QUEUED_AGENTS);
    const maxQueuedAgents = configured ?? DEFAULT_MAX_QUEUED_AGENTS;
    if (!Number.isFinite(maxQueuedAgents)) {
        return DEFAULT_MAX_QUEUED_AGENTS;
    }
    return Math.max(0, Math.floor(maxQueuedAgents));
}
function resolveOverflowStrategy(env) {
    const value = env.RETINUE_OVERFLOW_STRATEGY?.trim().toLowerCase();
    return value === "evict" ? "evict" : "queue";
}
async function resolveConfiguredOpenCodeAgent(env) {
    const envAgent = env.RETINUE_OPENCODE_AGENT?.trim();
    if (envAgent) {
        return envAgent;
    }
    const config = await readRetinueConfig(env);
    const value = readNestedConfigValue(config, ["opencode", "agent"]);
    if (value === undefined || value === "") {
        return undefined;
    }
    if (typeof value === "string") {
        return value;
    }
    throw new Error(`Unsupported opencode.agent in Retinue config ${env.RETINUE_CONFIG_FILE}: ${String(value)}`);
}
async function readConfiguredMaxConcurrentAgents(env) {
    const config = await readRetinueConfig(env);
    const value = readNestedConfigValue(config, ["maxConcurrentAgents"]);
    if (value === undefined || value === "") {
        return undefined;
    }
    if (typeof value === "number") {
        return value;
    }
    throw new Error(`Unsupported maxConcurrentAgents in Retinue config ${env.RETINUE_CONFIG_FILE}: ${String(value)}`);
}
async function readRetinueConfig(env) {
    const configPath = env.RETINUE_CONFIG_FILE?.trim();
    if (!configPath) {
        return undefined;
    }
    try {
        return JSON.parse(await fs.readFile(configPath, "utf8"));
    }
    catch (error) {
        if (isMissingFile(error)) {
            return undefined;
        }
        throw new Error(`Failed to read Retinue config ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
}
function readNestedConfigValue(config, pathSegments) {
    let current = config;
    for (const segment of pathSegments) {
        if (typeof current !== "object" || current === null || Array.isArray(current) || !(segment in current)) {
            return undefined;
        }
        current = current[segment];
    }
    return current;
}
function isMissingFile(error) {
    return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
async function writeMcpTrace(env, value) {
    const stateDir = resolveStateDir({ explicitStateDir: env.RETINUE_STATE_DIR, env });
    const tracePath = getRetinueTracePath(stateDir);
    await fs.mkdir(path.dirname(tracePath), { recursive: true });
    await fs.appendFile(tracePath, `${JSON.stringify({ timestamp: new Date().toISOString(), ...value })}\n`, "utf8");
}
async function readLatestJobDiagnostic(filePath) {
    const tail = await readTextTailIfExists(filePath, 64 * 1024);
    if (!tail.text) {
        return undefined;
    }
    const lines = tail.text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .reverse();
    for (const line of lines) {
        try {
            const parsed = JSON.parse(line);
            const summary = summarizeJobDiagnostic(parsed);
            if (summary) {
                return summary;
            }
        }
        catch {
            continue;
        }
    }
    return undefined;
}
function summarizeJobDiagnostic(value) {
    if (!isRecord(value)) {
        return undefined;
    }
    const diagnostic = isRecord(value.diagnostic) ? value.diagnostic : undefined;
    if (!diagnostic) {
        return undefined;
    }
    const event = typeof value.event === "string" ? value.event : undefined;
    const patchPartSummary = createPatchPartSummary(diagnostic);
    const patchPartsWithoutWriteIntent = patchPartSummary !== undefined;
    const pendingExternalDirectoryPermissions = permissionRequestsFromDiagnostic(diagnostic.pendingExternalDirectoryPermissions);
    const pendingPermissions = permissionRequestsFromDiagnostic(diagnostic.pendingPermissions);
    const permissionActions = permissionActionSummaries(pendingExternalDirectoryPermissions.length > 0 ? pendingExternalDirectoryPermissions : pendingPermissions);
    return compactRecord({
        event,
        backend: "opencode",
        status: resolveDiagnosticStatus(event, diagnostic),
        message: createDiagnosticSummaryMessage(event, diagnostic),
        sessionId: stringValue(diagnostic.sessionId),
        sessionDirectory: stringValue(diagnostic.sessionDirectory),
        sessionPath: stringValue(diagnostic.sessionPath),
        sessionAborted: booleanValue(diagnostic.sessionAborted),
        baselineMessageCount: numberValue(diagnostic.baselineMessageCount),
        baselineCompletedAssistantCount: numberValue(diagnostic.baselineCompletedAssistantCount),
        messageCount: numberValue(diagnostic.messageCount),
        jobMessageCount: numberValue(diagnostic.jobMessageCount),
        completedAssistantCount: numberValue(diagnostic.completedAssistantCount),
        jobCompletedAssistantCount: numberValue(diagnostic.jobCompletedAssistantCount),
        lastMessageRole: stringValue(diagnostic.lastMessageRole),
        lastMessageFinish: stringValue(diagnostic.lastMessageFinish),
        lastMessagePartTypes: stringArrayValue(diagnostic.lastMessagePartTypes),
        lastMessagePartSummaries: arrayValue(diagnostic.lastMessagePartSummaries),
        lastMessageReasoningTextBytes: numberValue(diagnostic.lastMessageReasoningTextBytes),
        lastAssistantFinish: stringValue(diagnostic.lastAssistantFinish),
        lastAssistantPartTypes: stringArrayValue(diagnostic.lastAssistantPartTypes),
        lastAssistantPartSummaries: arrayValue(diagnostic.lastAssistantPartSummaries),
        lastAssistantReasoningTextBytes: numberValue(diagnostic.lastAssistantReasoningTextBytes),
        lastAssistantProviderID: stringValue(diagnostic.lastAssistantProviderID),
        lastAssistantModelID: stringValue(diagnostic.lastAssistantModelID),
        lastAssistantAgent: stringValue(diagnostic.lastAssistantAgent),
        lastAssistantMode: stringValue(diagnostic.lastAssistantMode),
        patchPartCount: patchPartsWithoutWriteIntent ? undefined : numberValue(diagnostic.patchPartCount),
        writeIntentToolPartCount: numberValue(diagnostic.writeIntentToolPartCount),
        patchPartSummary,
        selectedAssistantTextBytes: numberValue(diagnostic.selectedAssistantTextBytes),
        selectedAssistantSha256: stringValue(diagnostic.selectedAssistantSha256),
        stallReason: stringValue(diagnostic.stallReason),
        stallSummary: stringValue(diagnostic.stallSummary),
        toolCallAssistantRounds: numberValue(diagnostic.toolCallAssistantRounds),
        failedToolCallAssistantRounds: numberValue(diagnostic.failedToolCallAssistantRounds),
        emptyAssistantRounds: numberValue(diagnostic.emptyAssistantRounds),
        blankAssistantRounds: numberValue(diagnostic.blankAssistantRounds),
        zeroProgressAssistantRounds: numberValue(diagnostic.zeroProgressAssistantRounds),
        runningReadToolParts: numberValue(diagnostic.runningReadToolParts),
        runningReadToolCallIds: stringArrayValue(diagnostic.runningReadToolCallIds),
        runningReadToolPartSummaries: arrayValue(diagnostic.runningReadToolPartSummaries),
        pendingPermissionCount: numberValue(diagnostic.pendingPermissionCount),
        pendingPermissions,
        pendingExternalDirectoryPermissionCount: numberValue(diagnostic.pendingExternalDirectoryPermissionCount),
        pendingExternalDirectoryPermissions,
        permissionActions: permissionActions.length > 0 ? permissionActions : undefined,
        incompleteAssistantRound: booleanValue(diagnostic.incompleteAssistantRound),
        incompleteAssistantHasReasoningProgress: booleanValue(diagnostic.incompleteAssistantHasReasoningProgress),
        noCompletedAssistantDurationMs: numberValue(diagnostic.noCompletedAssistantDurationMs),
        stateStatus: stringValue(diagnostic.stateStatus),
        sessionState: diagnostic.sessionState
    });
}
function attentionFields(diagnostic, fallback) {
    if (fallback?.attentionRequired) {
        const permissions = fallback.permissions ?? [];
        return {
            attentionRequired: fallback.attentionRequired,
            permissionRequired: fallback.permissionRequired,
            permissions,
            permissionActions: permissionActionSummaries(permissions)
        };
    }
    if (!diagnostic || diagnostic.stallReason !== "external_directory_permission_pending") {
        return {};
    }
    const permissions = permissionRequestsFromDiagnostic(diagnostic.pendingExternalDirectoryPermissions);
    if (permissions.length === 0) {
        return {};
    }
    return {
        attentionRequired: {
            kind: "permission",
            backend: "opencode",
            reason: "external_directory_permission_pending",
            permissions,
            replyOptions: ["once", "always", "reject"]
        },
        permissionRequired: true,
        permissions,
        permissionActions: permissionActionSummaries(permissions)
    };
}
function permissionRequestsFromDiagnostic(value) {
    if (!Array.isArray(value)) {
        return [];
    }
    return value.filter(isPermissionRequest);
}
function compactAttentionResultForMcp(result, attention) {
    if (!attention.attentionRequired && !attention.permissionRequired) {
        return result;
    }
    if (typeof result.stderr !== "string" || result.stderr.length === 0) {
        return result;
    }
    const { stderr, ...compactResult } = result;
    const stderrTail = tailString(stderr, 4096);
    return {
        ...compactResult,
        stderrTail,
        stderrTailBytes: Buffer.byteLength(stderrTail, "utf8"),
        stderrOmitted: true
    };
}
function compactAttentionDiagnosticForMcp(diagnostic, attention) {
    if (!diagnostic || (!attention.attentionRequired && !attention.permissionRequired)) {
        return diagnostic;
    }
    const { pendingPermissions, pendingExternalDirectoryPermissions, ...compactDiagnostic } = diagnostic;
    return compactDiagnostic;
}
function permissionActionSummaries(permissions) {
    return permissions.map((permission) => {
        const approval = isRecord(permission.approval) ? permission.approval : undefined;
        const scope = isRecord(approval?.scope) ? approval.scope : undefined;
        return compactRecord({
            id: permission.id,
            permission: permission.permission,
            target: stringValue(scope?.target),
            patterns: permission.patterns,
            toolCallID: stringValue(permission.toolCallID),
            recommendedReply: stringValue(approval?.recommendedReply),
            recommendedMessage: stringValue(approval?.recommendedMessage),
            relation: stringValue(scope?.relation)
        });
    });
}
function tailString(value, maxBytes) {
    const buffer = Buffer.from(value, "utf8");
    if (buffer.length <= maxBytes) {
        return value;
    }
    return buffer.subarray(buffer.length - maxBytes).toString("utf8").replace(/^\uFFFD+/, "");
}
function isPermissionRequest(value) {
    return (isRecord(value) &&
        typeof value.id === "string" &&
        typeof value.permission === "string" &&
        Array.isArray(value.patterns) &&
        value.patterns.every((pattern) => typeof pattern === "string"));
}
function resolveDiagnosticStatus(event, diagnostic) {
    if (event === "opencode_job_soft_stall_deferred") {
        return "running";
    }
    if (event === "opencode_job_stalled" || typeof diagnostic.stallReason === "string") {
        return "stalled";
    }
    if (event === "opencode_job_prompt_failed") {
        return "failed";
    }
    if (event === "opencode_job_result_read") {
        return "completed";
    }
    return "running";
}
function createDiagnosticSummaryMessage(event, diagnostic) {
    const stallSummary = stringValue(diagnostic.stallSummary);
    if (stallSummary) {
        return stallSummary;
    }
    const patchPartSummary = createPatchPartSummary(diagnostic);
    if (event === "opencode_job_stalled") {
        return "OpenCode job was classified as stalled by Retinue stall rules.";
    }
    if (event === "opencode_job_prompt_failed") {
        return "OpenCode prompt submission failed before the child job became usable.";
    }
    if (event === "opencode_job_result_read") {
        if (patchPartSummary) {
            return `OpenCode job result was read successfully. ${patchPartSummary}`;
        }
        return "OpenCode job result was read successfully.";
    }
    const rounds = numberValue(diagnostic.toolCallAssistantRounds) ?? 0;
    const emptyRounds = numberValue(diagnostic.emptyAssistantRounds) ?? 0;
    const blankRounds = numberValue(diagnostic.blankAssistantRounds) ?? 0;
    const zeroProgressRounds = numberValue(diagnostic.zeroProgressAssistantRounds) ?? 0;
    const runningReadToolParts = numberValue(diagnostic.runningReadToolParts) ?? 0;
    const incomplete = diagnostic.incompleteAssistantRound === true;
    return `OpenCode job is still running after wait timeout; toolCallAssistantRounds=${rounds}, emptyAssistantRounds=${emptyRounds}, blankAssistantRounds=${blankRounds}, zeroProgressAssistantRounds=${zeroProgressRounds}, runningReadToolParts=${runningReadToolParts}, incompleteAssistantRound=${incomplete}.`;
}
function createPatchPartSummary(diagnostic) {
    const patchPartCount = numberValue(diagnostic.patchPartCount) ?? 0;
    if (patchPartCount <= 0) {
        return undefined;
    }
    return "OpenCode patch part(s) were observed in the backend stream.";
}
function compactRecord(record) {
    return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}
function isRecord(value) {
    return typeof value === "object" && value !== null;
}
function stringValue(value) {
    return typeof value === "string" ? value : undefined;
}
function numberValue(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
function booleanValue(value) {
    return typeof value === "boolean" ? value : undefined;
}
function arrayValue(value) {
    return Array.isArray(value) ? value : undefined;
}
function stringArrayValue(value) {
    return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : undefined;
}
async function createRetinueBackend(retinue, sharedRootSessions, claudeSdkJobs, preferClaudeSdk, claudeSdkQuery) {
    return createRetinueBackendByKind(readRetinueBackendKindFromEnv(), retinue, sharedRootSessions, claudeSdkJobs, preferClaudeSdk, claudeSdkQuery);
}
async function createRetinueBackendForJob(retinue, jobId, sharedRootSessions, claudeSdkJobs, preferClaudeSdk, claudeSdkQuery) {
    const recordedKind = await readRetinueJobBackendKind(jobId);
    if (recordedKind) {
        return createRetinueBackendByKind(recordedKind, retinue, sharedRootSessions, claudeSdkJobs, preferClaudeSdk, claudeSdkQuery);
    }
    return createRetinueBackend(retinue, sharedRootSessions, claudeSdkJobs, preferClaudeSdk, claudeSdkQuery);
}
async function createRetinueBackendByKind(kind, retinue, sharedRootSessions, claudeSdkJobs, preferClaudeSdk = false, claudeSdkQuery) {
    if (kind === "opencode") {
        return createOpenCodeBackend({ sharedRootSessions });
    }
    if (kind === "kilo") {
        return createKiloBackend({ sharedRootSessions });
    }
    if (kind === "claude-code") {
        if (shouldUseClaudeSdk(process.env, preferClaudeSdk)) {
            return new ClaudeCodeSdkBackend({
                stateDir: process.env.RETINUE_STATE_DIR,
                env: process.env,
                defaultRuntimeTimeoutMs: parseOptionalNumber(process.env.RETINUE_DEFAULT_RUNTIME_TIMEOUT_MS),
                jobs: claudeSdkJobs,
                query: claudeSdkQuery
            });
        }
        return new RetinueAgentBackend(retinue);
    }
    throw new Error(`Unsupported Retinue backend: ${kind}`);
}
function readRetinueBackendKindFromEnv() {
    const backend = (process.env.RETINUE_BACKEND ?? "opencode").trim().toLowerCase();
    if (backend === "opencode") {
        return "opencode";
    }
    if (backend === "kilo") {
        return "kilo";
    }
    if (backend === "claude-code" || backend === "claude") {
        return "claude-code";
    }
    throw new Error(`Unsupported RETINUE_BACKEND: ${backend}`);
}
function shouldUseClaudeSdk(env, preferClaudeSdk) {
    const runtime = env.RETINUE_CLAUDE_RUNTIME?.trim().toLowerCase();
    if (runtime === "sdk") {
        return true;
    }
    if (runtime === "cli") {
        return false;
    }
    if (env.RETINUE_CLAUDE_USE_SDK === "1") {
        return true;
    }
    if (env.RETINUE_CLAUDE_USE_SDK === "0") {
        return false;
    }
    if (env.RETINUE_CLAUDE_COMMAND || env.RETINUE_CLAUDE_PREFIX_ARGS) {
        return false;
    }
    return preferClaudeSdk;
}
async function readRetinueJobBackendKind(jobId) {
    const stateDir = resolveStateDir({
        explicitStateDir: process.env.RETINUE_STATE_DIR,
        env: process.env
    });
    try {
        const meta = JSON.parse(await fs.readFile(getJobPaths(stateDir, jobId).meta, "utf8"));
        return meta.backend === "opencode" || meta.backend === "kilo" || meta.backend === "claude-code" ? meta.backend : undefined;
    }
    catch {
        return undefined;
    }
}
async function readRetinueJobMeta(stateDir, jobId) {
    try {
        return JSON.parse(await fs.readFile(getJobPaths(stateDir, jobId).meta, "utf8"));
    }
    catch {
        return undefined;
    }
}
async function createQueuedJobMeta(options) {
    const jobId = `job_${randomUUID()}`;
    const paths = getJobPaths(options.stateDir, jobId);
    const now = new Date().toISOString();
    await fs.mkdir(paths.dir, { recursive: true });
    await fs.writeFile(paths.prompt, options.prompt, "utf8");
    const meta = {
        schemaVersion: 1,
        backend: options.backendKind,
        jobId,
        pid: process.pid,
        status: "queued",
        cwd: options.cwd,
        prompt: options.prompt,
        promptPath: paths.prompt,
        promptPreview: createPromptPreview(options.prompt),
        promptSha256: sha256(options.prompt),
        name: options.taskName,
        agent: options.agent,
        readOnly: false,
        title: options.title,
        args: [],
        createdAt: now,
        updatedAt: now
    };
    await writeJobMeta(options.stateDir, meta);
    return meta;
}
async function writeJobMeta(stateDir, meta) {
    const metaPath = getJobPaths(stateDir, meta.jobId).meta;
    const tempPath = `${metaPath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
    await fs.mkdir(path.dirname(metaPath), { recursive: true });
    await fs.writeFile(tempPath, JSON.stringify(meta, null, 2), "utf8");
    await fs.rename(tempPath, metaPath);
}
function sha256(value) {
    return createHash("sha256").update(value).digest("hex");
}
function createPromptPreview(prompt) {
    return prompt.replace(/\s+/g, " ").trim().slice(0, 120);
}
class RetinueAgentBackend {
    retinue;
    kind = "claude-code";
    constructor(retinue) {
        this.retinue = retinue;
    }
    run(options) {
        return this.retinue.run(options);
    }
    continueJob(options) {
        return this.retinue.run(options);
    }
    status(handle) {
        return this.retinue.status(handle.jobId);
    }
    result(handle) {
        return this.retinue.result(handle.jobId);
    }
    async abort(handle) {
        await this.retinue.kill(handle.jobId);
    }
    async wait(handle, timeoutMs) {
        const result = await this.retinue.wait(handle.jobId, { timeoutMs });
        return { jobId: result.jobId, status: result.status };
    }
}
function normalizeTaskName(args) {
    return args.task_name?.trim() || args.taskName?.trim() || "retinue-agent";
}
function isJobMeta(value) {
    return typeof value === "object" && value !== null && "jobId" in value;
}
export function createMcpRetinueFromEnv(env = process.env) {
    if (env.RETINUE_DAEMON_URL) {
        return new DaemonClient(env.RETINUE_DAEMON_URL, { timeoutMs: resolveHttpTimeoutMs(env), token: env.RETINUE_DAEMON_TOKEN });
    }
    if (env.RETINUE_DAEMON_DISCOVERY === "1") {
        const stateDir = resolveStateDir({
            explicitStateDir: env.RETINUE_STATE_DIR,
            env
        });
        const discovery = readDaemonDiscoverySync(stateDir);
        return new DaemonClient(discovery.url, { timeoutMs: resolveHttpTimeoutMs(env), token: discovery.token });
    }
    return new ClaudeRetinue({
        stateDir: env.RETINUE_STATE_DIR,
        claudeCommand: env.RETINUE_CLAUDE_COMMAND,
        claudePrefixArgs: parsePrefixArgs(env.RETINUE_CLAUDE_PREFIX_ARGS),
        env,
        defaultRuntimeTimeoutMs: parseOptionalNumber(env.RETINUE_DEFAULT_RUNTIME_TIMEOUT_MS),
        maxConcurrentJobs: parseOptionalNumber(env.RETINUE_MAX_CONCURRENT_JOBS)
    });
}
function parsePrefixArgs(value) {
    if (!value) {
        return [];
    }
    const trimmed = value.trim();
    if (trimmed.startsWith("[")) {
        return JSON.parse(trimmed);
    }
    return [value];
}
function parseOptionalNumber(value) {
    if (!value) {
        return undefined;
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
}
export function resolveMcpWaitTimeoutMs(timeoutMs, env) {
    const maxMs = parseOptionalNumber(env.RETINUE_MCP_WAIT_MAX_MS) ?? DEFAULT_MCP_WAIT_MAX_MS;
    if (!Number.isFinite(maxMs) || maxMs <= 0) {
        return timeoutMs;
    }
    if (timeoutMs === undefined) {
        return undefined;
    }
    return Math.min(timeoutMs, Math.floor(maxMs));
}
function jsonToolResult(value) {
    return {
        content: [
            {
                type: "text",
                text: JSON.stringify(value, null, 2)
            }
        ]
    };
}
async function main() {
    const server = createMcpServer();
    await server.connect(new StdioServerTransport());
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    main().catch((error) => {
        process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
        process.exitCode = 1;
    });
}
//# sourceMappingURL=mcp.js.map