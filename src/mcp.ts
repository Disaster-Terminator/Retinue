#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { OpenCodeBackend } from "./backends/opencode/backend.js";
import type { OpenCodeSharedRootSessionStore } from "./backends/opencode/backend.js";
import { OpenCodeClient } from "./backends/opencode/client.js";
import { ensureOpenCodeServer, resolveOpenCodeServerFromEnv } from "./backends/opencode/serverManager.js";
import { DaemonClient } from "./daemon/client.js";
import { readDaemonDiscoverySync } from "./daemon/discovery.js";
import { readTextTailIfExists } from "./core/fileTail.js";
import { resolveHttpTimeoutMs } from "./core/http.js";
import { auditRetinueLogs } from "./core/logAudit.js";
import { getJobPaths, getRetinueTracePath, resolveStateDir } from "./core/paths.js";
import { ClaudeRetinue } from "./core/retinue.js";
import { isActivePoolStatus } from "./core/status.js";
import type {
  AgentBackendKind,
  JobMeta,
  JobProblemStatus,
  JobStatusResult,
  RetinueApi,
  RetinueAttentionRequired,
  RetinuePermissionRequest,
  WaitResult
} from "./core/types.js";
import type {
  AgentBackend,
  AgentContinueOptions,
  AgentHandle,
  AgentPermissionListResult,
  AgentPermissionReply,
  AgentPermissionReplyResult,
  AgentRunOptions
} from "./backends/types.js";

export const CLAUDE_TOOL_NAMES = [
  "claude_run",
  "claude_status",
  "claude_wait",
  "claude_result",
  "claude_continue",
  "claude_peek",
  "claude_kill",
  "claude_cleanup"
] as const;

export const OPENCODE_TOOL_NAMES = [
  "opencode_run",
  "opencode_status",
  "opencode_wait",
  "opencode_result",
  "opencode_continue",
  "opencode_kill",
  "opencode_cleanup"
] as const;

export const RETINUE_TOOL_NAMES = [
  "retinue_spawn_agent",
  "retinue_wait_agent",
  "retinue_close_agent",
  "retinue_list_agents",
  "retinue_list_permissions",
  "retinue_reply_permission"
] as const;

export const RETINUE_DIAGNOSTIC_TOOL_NAMES = ["retinue_audit_logs"] as const;

const DEFAULT_MCP_WAIT_MAX_MS = 180_000;

export interface CreateMcpServerOptions {
  exposeBackendTools?: boolean;
  exposeDiagnosticTools?: boolean;
}

export function createMcpServer(retinue: RetinueApi = createMcpRetinueFromEnv(), options: CreateMcpServerOptions = {}): McpServer {
  const agentPool = new RetinueAgentPool();
  const openCodeSharedRootSessions: OpenCodeSharedRootSessionStore = new Map();
  const server = new McpServer({
    name: "retinue",
    version: "0.1.0"
  });

  if (options.exposeBackendTools ?? process.env.RETINUE_EXPOSE_BACKEND_TOOLS === "1") {
    registerBackendTools(server, retinue);
  }

  server.registerTool(
    "retinue_spawn_agent",
    {
      title: "Spawn Retinue Agent",
      description: "Spawn a Retinue child agent using the deployment-selected backend and return a job handle.",
      inputSchema: {
        message: z.string(),
        task_name: z.string().optional(),
        taskName: z.string().optional(),
        cwd: z.string().optional(),
        title: z.string().optional(),
        agent: z.string().optional()
      }
    },
    async (args) => {
      const taskName = normalizeTaskName(args);
      const backend = await createRetinueBackend(retinue, openCodeSharedRootSessions);
      const { evicted, started } = await agentPool.withSpawnLock(async () => {
        const evicted = await agentPool.ensureSpawnSlot(retinue, process.env);
        const agent = args.agent ?? (await resolveConfiguredOpenCodeAgent(process.env));
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
      return jsonToolResult({
        task_name: taskName,
        jobId: started.jobId,
        status: started.status,
        backend: started.backend,
        cwd: started.cwd,
        jobDir: getJobPaths(
          resolveStateDir({
            explicitStateDir: process.env.RETINUE_STATE_DIR,
            env: process.env
          }),
          started.jobId
        ).dir,
        sessionId: started.sessionId,
        externalSessionId: started.externalSessionId,
        externalRunnerMode: started.externalRunnerMode,
        externalRootAgent: started.externalRootAgent,
        externalRootSessionId: started.externalRootSessionId,
        externalParentSessionId: started.externalParentSessionId,
        externalServerUrl: started.externalServerUrl,
        externalSessionDirectory: started.externalSessionDirectory,
        evictedJobId: evicted?.jobId
      });
    }
  );

  server.registerTool(
    "retinue_wait_agent",
    {
      title: "Wait For Retinue Agent",
      description: "Wait for a Retinue child agent and include its result when it reaches a terminal state.",
      inputSchema: {
        jobId: z.string(),
        timeoutMs: z.number().int().nonnegative().optional()
      }
    },
    async ({ jobId, timeoutMs }) => {
      const backend = await createRetinueBackendForJob(retinue, jobId, openCodeSharedRootSessions);
      const effectiveTimeoutMs = resolveMcpWaitTimeoutMs(timeoutMs, process.env);
      const waited = await backend.wait({ jobId }, effectiveTimeoutMs);
      const responseJobId = waited.jobId;
      if (responseJobId !== jobId) {
        agentPool.replace(jobId, responseJobId);
      }
      const stateDir = resolveStateDir({
        explicitStateDir: process.env.RETINUE_STATE_DIR,
        env: process.env
      });
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
          status: waited.status,
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
          ...attentionFields(diagnostic),
          tracePath: getRetinueTracePath(stateDir),
          requestedTimeoutMs: timeoutMs,
          effectiveTimeoutMs
        });
      }
      const paths = getJobPaths(stateDir, responseJobId);
      const result = await backend.result({ jobId: responseJobId });
      const diagnostic = await readLatestJobDiagnostic(paths.stderr);
      return jsonToolResult({
        task_name: isJobMeta(status) ? status.name : undefined,
        jobId: responseJobId,
        requestedJobId: responseJobId === jobId ? undefined : jobId,
        selectedAttemptJobId: result.selectedAttemptJobId ?? waited.selectedAttemptJobId,
        attemptChain: result.attemptChain ?? waited.attemptChain,
        status: responseStatus,
        result,
        diagnostic,
        ...attentionFields(diagnostic, result)
      });
    }
  );

  server.registerTool(
    "retinue_close_agent",
    {
      title: "Close Retinue Agent",
      description: "Close a Retinue child agent and its backend session.",
      inputSchema: {
        jobId: z.string()
      }
    },
    async ({ jobId }) => {
      const backend = await createRetinueBackendForJob(retinue, jobId, openCodeSharedRootSessions);
      const status = await backend.status({ jobId });
      if (isJobMeta(status) && status.status === "running") {
        await backend.abort({ jobId });
        agentPool.remove(jobId);
        return jsonToolResult({ jobId, status: "killed" });
      }
      agentPool.remove(jobId);
      return jsonToolResult({ jobId, status: "status" in status ? status.status : "unknown" });
    }
  );

  server.registerTool(
    "retinue_list_agents",
    {
      title: "List Retinue Agents",
      description: "List live Retinue child agents tracked by this MCP server session.",
      inputSchema: {}
    },
    async () =>
      jsonToolResult({
        maxAgents: await resolveMaxConcurrentAgents(process.env),
        agents: await agentPool.list(retinue)
      })
  );

  server.registerTool(
    "retinue_list_permissions",
    {
      title: "List Retinue Permissions",
      description: "List pending OpenCode permission requests for a Retinue child job.",
      inputSchema: {
        jobId: z.string()
      }
    },
    async ({ jobId }) => {
      const backend = await createRetinueBackendForJob(retinue, jobId, openCodeSharedRootSessions);
      if (!isPermissionBridgeBackend(backend)) {
        throw new Error(`Retinue backend ${backend.kind} does not expose OpenCode permissions`);
      }
      return jsonToolResult(await backend.listPermissions({ jobId }));
    }
  );

  server.registerTool(
    "retinue_reply_permission",
    {
      title: "Reply To Retinue Permission",
      description: "Reply to a pending OpenCode permission request for a Retinue child job.",
      inputSchema: {
        jobId: z.string(),
        requestId: z.string(),
        reply: z.enum(["once", "always", "reject"]),
        message: z.string().optional()
      }
    },
    async ({ jobId, requestId, reply, message }) => {
      const backend = await createRetinueBackendForJob(retinue, jobId, openCodeSharedRootSessions);
      if (!isPermissionBridgeBackend(backend)) {
        throw new Error(`Retinue backend ${backend.kind} does not expose OpenCode permissions`);
      }
      return jsonToolResult(await backend.replyPermission({ jobId }, { requestId, reply, message }));
    }
  );

  if (options.exposeDiagnosticTools ?? process.env.RETINUE_EXPOSE_DIAGNOSTIC_TOOLS === "1") {
    registerDiagnosticTools(server);
  }

  return server;
}

function registerDiagnosticTools(server: McpServer): void {
  server.registerTool(
    "retinue_audit_logs",
    {
      title: "Audit Retinue Logs",
      description: "Developer diagnostic tool for summarizing recent Retinue/OpenCode stall logs. Hidden from the default product tool surface.",
      inputSchema: {
        since: z.string().optional(),
        maxLines: z.number().int().positive().optional(),
        maxBytes: z.number().int().positive().optional(),
        stateDir: z.string().optional(),
        tracePath: z.string().optional()
      }
    },
    async ({ since, maxLines, maxBytes, stateDir, tracePath }) => {
      const parsedSince = since ? new Date(since) : undefined;
      if (parsedSince && Number.isNaN(parsedSince.getTime())) {
        throw new Error("since must be an ISO timestamp");
      }
      return jsonToolResult(
        await auditRetinueLogs({
          stateDir:
            stateDir ??
            resolveStateDir({
              explicitStateDir: process.env.RETINUE_STATE_DIR,
              env: process.env
            }),
          tracePath,
          since: parsedSince,
          maxLines,
          maxBytes
        })
      );
    }
  );
}

function registerBackendTools(server: McpServer, retinue: RetinueApi): void {
  server.registerTool(
    "claude_run",
    {
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
    },
    async (args) => jsonToolResult(await retinue.run(args))
  );

  server.registerTool(
    "claude_status",
    {
      title: "Get Claude Code Job Status",
      description: "Read current status metadata for a Claude Code job.",
      inputSchema: { jobId: z.string() }
    },
    async ({ jobId }) => jsonToolResult(await retinue.status(jobId))
  );

  server.registerTool(
    "claude_wait",
    {
      title: "Wait For Claude Code Job",
      description: "Wait briefly for a Claude Code job to reach a terminal state.",
      inputSchema: {
        jobId: z.string(),
        timeoutMs: z.number().int().positive().optional()
      }
    },
    async ({ jobId, timeoutMs }) => jsonToolResult(await retinue.wait(jobId, { timeoutMs }))
  );

  server.registerTool(
    "claude_result",
    {
      title: "Read Claude Code Job Result",
      description: "Read stdout, stderr, parsed JSON, and exit status for a Claude Code job.",
      inputSchema: { jobId: z.string() }
    },
    async ({ jobId }) => jsonToolResult(await retinue.result(jobId))
  );

  server.registerTool(
    "claude_continue",
    {
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
    },
    async (args) => jsonToolResult(await retinue.continueJob(args))
  );

  server.registerTool(
    "claude_peek",
    {
      title: "Peek Claude Code Job Output",
      description: "Read bounded stdout/stderr tails for a running or completed Claude Code job.",
      inputSchema: {
        jobId: z.string(),
        stdoutTailBytes: z.number().int().positive().optional(),
        stderrTailBytes: z.number().int().positive().optional()
      }
    },
    async ({ jobId, stdoutTailBytes, stderrTailBytes }) =>
      jsonToolResult(await retinue.peek(jobId, { stdoutTailBytes, stderrTailBytes }))
  );

  server.registerTool(
    "claude_kill",
    {
      title: "Kill Claude Code Job",
      description: "Kill a running Claude Code job process tree.",
      inputSchema: { jobId: z.string() }
    },
    async ({ jobId }) => jsonToolResult(await retinue.kill(jobId))
  );

  server.registerTool(
    "claude_cleanup",
    {
      title: "Cleanup Claude Code Jobs",
      description: "Remove terminal job directories while preserving running jobs.",
      inputSchema: { olderThanMs: z.number().int().nonnegative().optional() }
    },
    async ({ olderThanMs }) => jsonToolResult(await retinue.cleanup({ olderThanMs }))
  );

  server.registerTool(
    "opencode_run",
    {
      title: "Run OpenCode Job",
      description: "Start an OpenCode background job through an attached OpenCode server.",
      inputSchema: opencodeRunSchema()
    },
    async (args) => jsonToolResult(await (await createOpenCodeBackend(args)).run(await withOpenCodeDefaults(args)))
  );

  server.registerTool(
    "opencode_status",
    {
      title: "Get OpenCode Job Status",
      description: "Read current status metadata for an OpenCode job.",
      inputSchema: { jobId: z.string(), opencodeBaseUrl: z.string().optional() }
    },
    async ({ jobId, opencodeBaseUrl }) => jsonToolResult(await (await createOpenCodeBackend({ opencodeBaseUrl })).status({ jobId }))
  );

  server.registerTool(
    "opencode_wait",
    {
      title: "Wait For OpenCode Job",
      description: "Wait for an OpenCode job result through the attached OpenCode server.",
      inputSchema: { jobId: z.string(), timeoutMs: z.number().int().nonnegative().optional(), opencodeBaseUrl: z.string().optional() }
    },
    async ({ jobId, timeoutMs, opencodeBaseUrl }) => {
      const result = await (await createOpenCodeBackend({ opencodeBaseUrl })).wait({ jobId }, resolveMcpWaitTimeoutMs(timeoutMs, process.env));
      return jsonToolResult(result);
    }
  );

  server.registerTool(
    "opencode_result",
    {
      title: "Read OpenCode Job Result",
      description: "Read the latest OpenCode message result for a retinue job.",
      inputSchema: { jobId: z.string(), opencodeBaseUrl: z.string().optional() }
    },
    async ({ jobId, opencodeBaseUrl }) => jsonToolResult(await (await createOpenCodeBackend({ opencodeBaseUrl })).result({ jobId }))
  );

  server.registerTool(
    "opencode_continue",
    {
      title: "Continue OpenCode Session",
      description: "Send a prompt to an existing OpenCode session.",
      inputSchema: {
        ...opencodeRunSchema(),
        externalSessionId: z.string(),
        jobId: z.string().optional()
      }
    },
    async (args) =>
      jsonToolResult(
        await (await createOpenCodeBackend(args)).continueJob({
          ...(await withOpenCodeDefaults(args)),
          parentJobId: args.jobId,
          parentSessionId: args.externalSessionId
        })
      )
  );

  server.registerTool(
    "opencode_kill",
    {
      title: "Abort OpenCode Job",
      description: "Abort the OpenCode session associated with a retinue job.",
      inputSchema: { jobId: z.string(), opencodeBaseUrl: z.string().optional() }
    },
    async ({ jobId, opencodeBaseUrl }) => {
      await (await createOpenCodeBackend({ opencodeBaseUrl })).abort({ jobId });
      return jsonToolResult({ jobId, status: "killed" });
    }
  );

  server.registerTool(
    "opencode_cleanup",
    {
      title: "Cleanup OpenCode Jobs",
      description: "Placeholder cleanup surface for OpenCode job artifacts.",
      inputSchema: { olderThanMs: z.number().int().nonnegative().optional() }
    },
    async ({ olderThanMs }) => jsonToolResult(await (await createOpenCodeBackend({})).cleanup({ olderThanMs }))
  );
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

async function createOpenCodeBackend(args: { opencodeBaseUrl?: string; sharedRootSessions?: OpenCodeSharedRootSessionStore }): Promise<OpenCodeBackend> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    RETINUE_OPENCODE_BASE_URL: args.opencodeBaseUrl ?? process.env.RETINUE_OPENCODE_BASE_URL
  };
  const resolution = resolveOpenCodeServerFromEnv(env);
  const stateDir = resolveStateDir({ explicitStateDir: process.env.RETINUE_STATE_DIR, env: process.env });
  return new OpenCodeBackend({
    target: async (cwd) => {
      const target = await ensureOpenCodeServer(resolution, { stateDir, cwd });
      return { client: new OpenCodeClient(target.baseUrl, { timeoutMs: resolveHttpTimeoutMs(env) }), baseUrl: target.baseUrl };
    },
    stateDir,
    env: process.env,
    sharedRootSessions: args.sharedRootSessions
  });
}

async function withOpenCodeDefaults<T extends { model?: string; agent?: string }>(args: T): Promise<T> {
  return {
    ...args,
    model: args.model ?? process.env.RETINUE_OPENCODE_MODEL,
    agent: args.agent ?? (await resolveConfiguredOpenCodeAgent(process.env))
  };
}

type RetinueBackend = AgentBackend & {
  wait(handle: AgentHandle, timeoutMs?: number): Promise<WaitResult>;
};

type RetinuePermissionBridgeBackend = RetinueBackend & {
  listPermissions(handle: AgentHandle): Promise<AgentPermissionListResult>;
  replyPermission(
    handle: AgentHandle,
    options: { requestId: string; reply: AgentPermissionReply; message?: string }
  ): Promise<AgentPermissionReplyResult>;
};

function isPermissionBridgeBackend(backend: RetinueBackend): backend is RetinuePermissionBridgeBackend {
  return "listPermissions" in backend && "replyPermission" in backend;
}

interface RetinueAgentPoolEntry {
  jobId: string;
  backend: AgentBackendKind;
  taskName?: string;
  createdAt: number;
}

interface ListedRetinueAgent {
  jobId: string;
  task_name?: string;
  backend: AgentBackendKind;
  status: JobMeta["status"] | JobProblemStatus;
  createdAt: string;
}

class RetinueAgentPool {
  private readonly entries = new Map<string, RetinueAgentPoolEntry>();
  private spawnQueue: Promise<void> = Promise.resolve();

  async withSpawnLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.spawnQueue;
    let release: () => void = () => undefined;
    this.spawnQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async ensureSpawnSlot(retinue: RetinueApi, env: NodeJS.ProcessEnv): Promise<RetinueAgentPoolEntry | undefined> {
    const maxAgents = await resolveMaxConcurrentAgents(env);

    const activeEntries: RetinueAgentPoolEntry[] = [];
    for (const entry of [...this.entries.values()]) {
      const backend = await createRetinueBackendByKind(entry.backend, retinue);
      const status = await backend.status({ jobId: entry.jobId });
      if (!isJobMeta(status) || !isActivePoolStatus(status.status)) {
        this.entries.delete(entry.jobId);
        continue;
      }
      activeEntries.push(entry);
    }

    if (activeEntries.length < maxAgents) {
      return undefined;
    }

    activeEntries.sort((left, right) => left.createdAt - right.createdAt);
    const evicted = activeEntries[0];
    if (!evicted) {
      return undefined;
    }

    const backend = await createRetinueBackendByKind(evicted.backend, retinue);
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

  add(entry: RetinueAgentPoolEntry): void {
    this.entries.set(entry.jobId, entry);
  }

  replace(fromJobId: string, toJobId: string): void {
    const entry = this.entries.get(fromJobId);
    if (!entry || fromJobId === toJobId) {
      return;
    }
    this.entries.delete(fromJobId);
    this.entries.set(toJobId, { ...entry, jobId: toJobId });
  }

  remove(jobId: string): void {
    this.entries.delete(jobId);
  }

  async list(retinue: RetinueApi): Promise<ListedRetinueAgent[]> {
    const agents: ListedRetinueAgent[] = [];
    for (const entry of [...this.entries.values()].sort((left, right) => left.createdAt - right.createdAt)) {
      const backend = await createRetinueBackendByKind(entry.backend, retinue);
      const status = await backend.status({ jobId: entry.jobId });
      if (!isJobMeta(status)) {
        this.entries.delete(entry.jobId);
        continue;
      }
      if (!isActivePoolStatus(status.status)) {
        this.entries.delete(entry.jobId);
        continue;
      }
      agents.push({
        jobId: entry.jobId,
        task_name: entry.taskName,
        backend: entry.backend,
        status: status.status,
        createdAt: new Date(entry.createdAt).toISOString()
      });
    }
    return agents;
  }
}

async function resolveMaxConcurrentAgents(env: NodeJS.ProcessEnv): Promise<number> {
  const configured = parseOptionalNumber(env.RETINUE_MAX_CONCURRENT_AGENTS) ?? (await readConfiguredMaxConcurrentAgents(env));
  const maxAgents = configured ?? 3;
  if (!Number.isFinite(maxAgents)) {
    return 3;
  }
  return Math.max(1, Math.floor(maxAgents));
}

async function resolveConfiguredOpenCodeAgent(env: NodeJS.ProcessEnv): Promise<string | undefined> {
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

async function readConfiguredMaxConcurrentAgents(env: NodeJS.ProcessEnv): Promise<number | undefined> {
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

async function readRetinueConfig(env: NodeJS.ProcessEnv): Promise<unknown | undefined> {
  const configPath = env.RETINUE_CONFIG_FILE?.trim();
  if (!configPath) {
    return undefined;
  }
  try {
    return JSON.parse(await fs.readFile(configPath, "utf8")) as unknown;
  } catch (error) {
    if (isMissingFile(error)) {
      return undefined;
    }
    throw new Error(`Failed to read Retinue config ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function readNestedConfigValue(config: unknown, pathSegments: string[]): unknown {
  let current = config;
  for (const segment of pathSegments) {
    if (typeof current !== "object" || current === null || Array.isArray(current) || !(segment in current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

async function writeMcpTrace(env: NodeJS.ProcessEnv, value: Record<string, unknown>): Promise<void> {
  const stateDir = resolveStateDir({ explicitStateDir: env.RETINUE_STATE_DIR, env });
  const tracePath = getRetinueTracePath(stateDir);
  await fs.mkdir(path.dirname(tracePath), { recursive: true });
  await fs.appendFile(tracePath, `${JSON.stringify({ timestamp: new Date().toISOString(), ...value })}\n`, "utf8");
}

async function readLatestJobDiagnostic(filePath: string): Promise<Record<string, unknown> | undefined> {
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
      const parsed = JSON.parse(line) as unknown;
      const summary = summarizeJobDiagnostic(parsed);
      if (summary) {
        return summary;
      }
    } catch {
      continue;
    }
  }
  return undefined;
}

function summarizeJobDiagnostic(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const diagnostic = isRecord(value.diagnostic) ? value.diagnostic : undefined;
  if (!diagnostic) {
    return undefined;
  }
  const event = typeof value.event === "string" ? value.event : undefined;
  const readOnlyWriteIntent = diagnostic.readOnlyWriteIntent === true;
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
    lastAssistantFinish: stringValue(diagnostic.lastAssistantFinish),
    lastAssistantPartTypes: stringArrayValue(diagnostic.lastAssistantPartTypes),
    lastAssistantPartSummaries: arrayValue(diagnostic.lastAssistantPartSummaries),
    lastAssistantProviderID: stringValue(diagnostic.lastAssistantProviderID),
    lastAssistantModelID: stringValue(diagnostic.lastAssistantModelID),
    lastAssistantAgent: stringValue(diagnostic.lastAssistantAgent),
    lastAssistantMode: stringValue(diagnostic.lastAssistantMode),
    patchPartCount: numberValue(diagnostic.patchPartCount),
    readOnlyPatchPartCount: numberValue(diagnostic.readOnlyPatchPartCount),
    readOnlyWriteIntent,
    readOnlyWriteIntentRecoveryJobMessageCount: numberValue(diagnostic.readOnlyWriteIntentRecoveryJobMessageCount),
    recoveredFromReadOnlyWriteIntent: booleanValue(diagnostic.recoveredFromReadOnlyWriteIntent),
    readOnlyTextWarning: booleanValue(diagnostic.readOnlyTextWarning),
    readOnlyTextWarningSummary: stringValue(diagnostic.readOnlyTextWarningSummary),
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
    pendingPermissions: arrayValue(diagnostic.pendingPermissions),
    pendingExternalDirectoryPermissionCount: numberValue(diagnostic.pendingExternalDirectoryPermissionCount),
    pendingExternalDirectoryPermissions: arrayValue(diagnostic.pendingExternalDirectoryPermissions),
    incompleteAssistantRound: booleanValue(diagnostic.incompleteAssistantRound),
    noCompletedAssistantDurationMs: numberValue(diagnostic.noCompletedAssistantDurationMs),
    stateStatus: stringValue(diagnostic.stateStatus),
    sessionState: diagnostic.sessionState
  });
}

function attentionFields(
  diagnostic: Record<string, unknown> | undefined,
  fallback?: { attentionRequired?: RetinueAttentionRequired; permissionRequired?: boolean; permissions?: RetinuePermissionRequest[] }
): {
  attentionRequired?: RetinueAttentionRequired;
  permissionRequired?: boolean;
  permissions?: RetinuePermissionRequest[];
} {
  if (fallback?.attentionRequired) {
    return {
      attentionRequired: fallback.attentionRequired,
      permissionRequired: fallback.permissionRequired,
      permissions: fallback.permissions
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
    permissions
  };
}

function permissionRequestsFromDiagnostic(value: unknown): RetinuePermissionRequest[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(isPermissionRequest);
}

function isPermissionRequest(value: unknown): value is RetinuePermissionRequest {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.permission === "string" &&
    Array.isArray(value.patterns) &&
    value.patterns.every((pattern) => typeof pattern === "string")
  );
}

function resolveDiagnosticStatus(event: string | undefined, diagnostic: Record<string, unknown>): "running" | "completed" | "failed" | "stalled" {
  if (event === "opencode_job_soft_stall_deferred") {
    return "running";
  }
  if (event === "opencode_job_stalled" || typeof diagnostic.stallReason === "string" || diagnostic.readOnlyWriteIntent === true) {
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

function createDiagnosticSummaryMessage(event: string | undefined, diagnostic: Record<string, unknown>): string {
  const stallSummary = stringValue(diagnostic.stallSummary);
  if (stallSummary) {
    return stallSummary;
  }
  if (diagnostic.readOnlyWriteIntent === true) {
    return "OpenCode read-only job emitted patch/write intent; treat the child output as untrusted and inspect diagnostics.";
  }
  if (event === "opencode_job_stalled") {
    return "OpenCode job was classified as stalled by Retinue stall rules.";
  }
  if (event === "opencode_job_soft_stall_deferred") {
    return "OpenCode job matched recoverable stall rules; Retinue is still waiting within the caller timeout.";
  }
  if (event === "opencode_job_prompt_failed") {
    return "OpenCode prompt submission failed before the child job became usable.";
  }
  if (event === "opencode_job_result_read") {
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

function compactRecord(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function arrayValue(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function stringArrayValue(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : undefined;
}

async function createRetinueBackend(retinue: RetinueApi, sharedRootSessions: OpenCodeSharedRootSessionStore): Promise<RetinueBackend> {
  return createRetinueBackendByKind(readRetinueBackendKindFromEnv(), retinue, sharedRootSessions);
}

async function createRetinueBackendForJob(
  retinue: RetinueApi,
  jobId: string,
  sharedRootSessions: OpenCodeSharedRootSessionStore
): Promise<RetinueBackend> {
  const recordedKind = await readRetinueJobBackendKind(jobId);
  if (recordedKind) {
    return createRetinueBackendByKind(recordedKind, retinue, sharedRootSessions);
  }
  return createRetinueBackend(retinue, sharedRootSessions);
}

async function createRetinueBackendByKind(
  kind: AgentBackendKind,
  retinue: RetinueApi,
  sharedRootSessions?: OpenCodeSharedRootSessionStore
): Promise<RetinueBackend> {
  if (kind === "opencode") {
    return createOpenCodeBackend({ sharedRootSessions });
  }
  if (kind === "claude-code") {
    return new RetinueAgentBackend(retinue);
  }
  throw new Error(`Unsupported Retinue backend: ${kind satisfies never}`);
}

function readRetinueBackendKindFromEnv(): AgentBackendKind {
  const backend = (process.env.RETINUE_BACKEND ?? "opencode").trim().toLowerCase();
  if (backend === "opencode") {
    return "opencode";
  }
  if (backend === "claude-code" || backend === "claude") {
    return "claude-code";
  }
  throw new Error(`Unsupported RETINUE_BACKEND: ${backend}`);
}

async function readRetinueJobBackendKind(jobId: string): Promise<AgentBackendKind | undefined> {
  const stateDir = resolveStateDir({
    explicitStateDir: process.env.RETINUE_STATE_DIR,
    env: process.env
  });
  try {
    const meta = JSON.parse(await fs.readFile(getJobPaths(stateDir, jobId).meta, "utf8")) as Partial<JobMeta>;
    return meta.backend === "opencode" || meta.backend === "claude-code" ? meta.backend : undefined;
  } catch {
    return undefined;
  }
}

async function readRetinueJobMeta(stateDir: string, jobId: string): Promise<JobMeta | undefined> {
  try {
    return JSON.parse(await fs.readFile(getJobPaths(stateDir, jobId).meta, "utf8")) as JobMeta;
  } catch {
    return undefined;
  }
}

class RetinueAgentBackend implements RetinueBackend {
  readonly kind = "claude-code" as const;

  constructor(private readonly retinue: RetinueApi) {}

  run(options: AgentRunOptions) {
    return this.retinue.run(options);
  }

  continueJob(options: AgentContinueOptions) {
    return this.retinue.run(options);
  }

  status(handle: AgentHandle): Promise<JobStatusResult> {
    return this.retinue.status(handle.jobId);
  }

  result(handle: AgentHandle) {
    return this.retinue.result(handle.jobId);
  }

  async abort(handle: AgentHandle): Promise<void> {
    await this.retinue.kill(handle.jobId);
  }

  async wait(handle: AgentHandle, timeoutMs?: number): Promise<Pick<WaitResult, "jobId" | "status">> {
    const result = await this.retinue.wait(handle.jobId, { timeoutMs });
    return { jobId: result.jobId, status: result.status };
  }
}

function normalizeTaskName(args: { task_name?: string; taskName?: string }): string {
  return args.task_name?.trim() || args.taskName?.trim() || "retinue-agent";
}

function isJobMeta(value: unknown): value is { name?: string } {
  return typeof value === "object" && value !== null && "jobId" in value;
}


export function createMcpRetinueFromEnv(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env
): RetinueApi {
  if (env.RETINUE_DAEMON_URL) {
    return new DaemonClient(env.RETINUE_DAEMON_URL, { timeoutMs: resolveHttpTimeoutMs(env) });
  }
  if (env.RETINUE_DAEMON_DISCOVERY === "1") {
    const stateDir = resolveStateDir({
      explicitStateDir: env.RETINUE_STATE_DIR,
      env
    });
    return new DaemonClient(readDaemonDiscoverySync(stateDir).url, { timeoutMs: resolveHttpTimeoutMs(env) });
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

function parsePrefixArgs(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  const trimmed = value.trim();
  if (trimmed.startsWith("[")) {
    return JSON.parse(trimmed) as string[];
  }
  return [value];
}

function parseOptionalNumber(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function resolveMcpWaitTimeoutMs(timeoutMs: number | undefined, env: NodeJS.ProcessEnv): number | undefined {
  const maxMs = parseOptionalNumber(env.RETINUE_MCP_WAIT_MAX_MS) ?? DEFAULT_MCP_WAIT_MAX_MS;
  if (!Number.isFinite(maxMs) || maxMs <= 0) {
    return timeoutMs;
  }
  if (timeoutMs === undefined) {
    return undefined;
  }
  return Math.min(timeoutMs, Math.floor(maxMs));
}

function jsonToolResult(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value, null, 2)
      }
    ]
  };
}

async function main(): Promise<void> {
  const server = createMcpServer();
  await server.connect(new StdioServerTransport());
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
