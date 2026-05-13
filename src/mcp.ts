#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { OpenCodeBackend } from "./backends/opencode/backend.js";
import { OpenCodeClient } from "./backends/opencode/client.js";
import { ensureOpenCodeServer, resolveOpenCodeServerFromEnv } from "./backends/opencode/serverManager.js";
import { DaemonClient } from "./daemon/client.js";
import { readDaemonDiscoverySync } from "./daemon/discovery.js";
import { readTextTailIfExists } from "./core/fileTail.js";
import { resolveHttpTimeoutMs } from "./core/http.js";
import { getJobPaths, getRetinueTracePath, resolveStateDir } from "./core/paths.js";
import { ClaudeRetinue } from "./core/retinue.js";
import { isActivePoolStatus } from "./core/status.js";
import type { AgentBackendKind, JobMeta, JobProblemStatus, JobStatusResult, RetinueApi, WaitResult } from "./core/types.js";
import type { AgentBackend, AgentContinueOptions, AgentHandle, AgentRunOptions } from "./backends/types.js";

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

export const RETINUE_TOOL_NAMES = ["retinue_spawn_agent", "retinue_wait_agent", "retinue_close_agent", "retinue_list_agents"] as const;

const DEFAULT_MCP_WAIT_MAX_MS = 90_000;
const ACCESS_MODES = ["read_only", "profile"] as const;

type AccessMode = (typeof ACCESS_MODES)[number];

export interface CreateMcpServerOptions {
  exposeBackendTools?: boolean;
}

export function createMcpServer(retinue: RetinueApi = createMcpRetinueFromEnv(), options: CreateMcpServerOptions = {}): McpServer {
  const agentPool = new RetinueAgentPool();
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
        access_mode: z.enum(ACCESS_MODES).optional()
      }
    },
    async (args) => {
      const taskName = normalizeTaskName(args);
      const backend = await createRetinueBackend(retinue);
      const { evicted, started } = await agentPool.withSpawnLock(async () => {
        const evicted = await agentPool.ensureSpawnSlot(retinue, process.env);
        const started = await backend.run({
          cwd: args.cwd ?? process.cwd(),
          prompt: args.message,
          name: taskName,
          title: args.title ?? taskName,
          ...(backend.kind === "opencode"
            ? {
                model: process.env.RETINUE_OPENCODE_MODEL,
                agent: process.env.RETINUE_OPENCODE_AGENT,
                readOnly: (await resolveOpenCodeAccessMode(args.access_mode, process.env)) === "read_only"
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
      const backend = await createRetinueBackendForJob(retinue, jobId);
      const effectiveTimeoutMs = clampMcpWaitTimeoutMs(timeoutMs, process.env);
      const waited = await backend.wait({ jobId }, effectiveTimeoutMs);
      const status = await backend.status({ jobId });
      const responseStatus = isJobMeta(status) ? status.status : waited.status;
      if (responseStatus === "running") {
        const stateDir = resolveStateDir({
          explicitStateDir: process.env.RETINUE_STATE_DIR,
          env: process.env
        });
        const paths = getJobPaths(stateDir, jobId);
        const [stdoutTail, stderrTail, diagnostic] = await Promise.all([
          readTextTailIfExists(paths.stdout, 4096),
          readTextTailIfExists(paths.stderr, 4096),
          readLatestJobDiagnostic(paths.stderr)
        ]);
        return jsonToolResult({
          task_name: isJobMeta(status) ? status.name : undefined,
          jobId,
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
          tracePath: getRetinueTracePath(stateDir),
          requestedTimeoutMs: timeoutMs,
          effectiveTimeoutMs
        });
      }
      const result = await backend.result({ jobId });
      return jsonToolResult({
        task_name: isJobMeta(status) ? status.name : undefined,
        jobId,
        status: responseStatus,
        result
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
      const backend = await createRetinueBackendForJob(retinue, jobId);
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
        maxAgents: parseMaxConcurrentAgents(process.env),
        agents: await agentPool.list(retinue)
      })
  );

  return server;
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
    async (args) => jsonToolResult(await (await createOpenCodeBackend(args)).run(withOpenCodeDefaults(args)))
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
      const result = await (await createOpenCodeBackend({ opencodeBaseUrl })).wait({ jobId }, clampMcpWaitTimeoutMs(timeoutMs, process.env));
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
          ...withOpenCodeDefaults(args),
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

async function createOpenCodeBackend(args: { opencodeBaseUrl?: string }): Promise<OpenCodeBackend> {
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
    env: process.env
  });
}

function withOpenCodeDefaults<T extends { model?: string; agent?: string }>(args: T): T {
  return {
    ...args,
    model: args.model ?? process.env.RETINUE_OPENCODE_MODEL,
    agent: args.agent ?? process.env.RETINUE_OPENCODE_AGENT
  };
}

type RetinueBackend = AgentBackend & {
  wait(handle: AgentHandle, timeoutMs?: number): Promise<Pick<WaitResult, "jobId" | "status">>;
};

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
    const maxAgents = parseMaxConcurrentAgents(env);
    if (maxAgents === undefined) {
      return undefined;
    }

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

function parseMaxConcurrentAgents(env: NodeJS.ProcessEnv): number | undefined {
  const configured = parseOptionalNumber(env.RETINUE_MAX_CONCURRENT_AGENTS);
  const maxAgents = configured ?? 3;
  if (!Number.isFinite(maxAgents)) {
    return 3;
  }
  return Math.max(1, Math.floor(maxAgents));
}

async function resolveOpenCodeAccessMode(requested: AccessMode | undefined, env: NodeJS.ProcessEnv): Promise<AccessMode> {
  if (requested) {
    return requested;
  }

  const configMode = await readConfiguredOpenCodeAccessMode(env);
  if (configMode) {
    return configMode;
  }

  return readOpenCodeAccessModeFromEnv(env);
}

async function readConfiguredOpenCodeAccessMode(env: NodeJS.ProcessEnv): Promise<AccessMode | undefined> {
  const configPath = env.RETINUE_CONFIG_FILE?.trim();
  if (!configPath) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(configPath, "utf8"));
  } catch (error) {
    if (isMissingFile(error)) {
      return undefined;
    }
    throw new Error(`Failed to read Retinue config ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
  }

  const value =
    typeof parsed === "object" && parsed !== null && "opencode" in parsed
      ? (parsed.opencode as { defaultAccessMode?: unknown }).defaultAccessMode
      : undefined;
  if (value === undefined || value === "") {
    return undefined;
  }
  if (value === "read_only" || value === "profile") {
    return value;
  }
  throw new Error(`Unsupported opencode.defaultAccessMode in Retinue config ${configPath}: ${String(value)}`);
}

function readOpenCodeAccessModeFromEnv(env: NodeJS.ProcessEnv): AccessMode {
  const accessMode = env.RETINUE_OPENCODE_ACCESS_MODE?.trim().toLowerCase();
  if (accessMode === "read_only" || accessMode === "profile") {
    return accessMode;
  }
  if (accessMode) {
    throw new Error(`Unsupported RETINUE_OPENCODE_ACCESS_MODE: ${accessMode}`);
  }

  const configured = env.RETINUE_OPENCODE_READ_ONLY?.trim().toLowerCase();
  if (configured === undefined || configured === "") {
    return "read_only";
  }
  return configured === "0" || configured === "false" || configured === "no" || configured === "off" ? "profile" : "read_only";
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
    status: event === "opencode_job_stalled" ? "stalled" : event === "opencode_job_prompt_failed" ? "failed" : "running",
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
    toolCallAssistantRounds: numberValue(diagnostic.toolCallAssistantRounds),
    emptyAssistantRounds: numberValue(diagnostic.emptyAssistantRounds),
    incompleteAssistantRound: booleanValue(diagnostic.incompleteAssistantRound),
    noCompletedAssistantDurationMs: numberValue(diagnostic.noCompletedAssistantDurationMs),
    stateStatus: stringValue(diagnostic.stateStatus),
    sessionState: diagnostic.sessionState
  });
}

function createDiagnosticSummaryMessage(event: string | undefined, diagnostic: Record<string, unknown>): string {
  if (diagnostic.readOnlyWriteIntent === true) {
    return "OpenCode read-only job emitted patch/write intent; treat the child output as untrusted and inspect diagnostics.";
  }
  if (event === "opencode_job_stalled") {
    return "OpenCode job was classified as stalled by Retinue stall rules.";
  }
  if (event === "opencode_job_prompt_failed") {
    return "OpenCode prompt submission failed before the child job became usable.";
  }
  const rounds = numberValue(diagnostic.toolCallAssistantRounds) ?? 0;
  const emptyRounds = numberValue(diagnostic.emptyAssistantRounds) ?? 0;
  const incomplete = diagnostic.incompleteAssistantRound === true;
  return `OpenCode job is still running after wait timeout; toolCallAssistantRounds=${rounds}, emptyAssistantRounds=${emptyRounds}, incompleteAssistantRound=${incomplete}.`;
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

async function createRetinueBackend(retinue: RetinueApi): Promise<RetinueBackend> {
  return createRetinueBackendByKind(readRetinueBackendKindFromEnv(), retinue);
}

async function createRetinueBackendForJob(retinue: RetinueApi, jobId: string): Promise<RetinueBackend> {
  const recordedKind = await readRetinueJobBackendKind(jobId);
  if (recordedKind) {
    return createRetinueBackendByKind(recordedKind, retinue);
  }
  return createRetinueBackend(retinue);
}

async function createRetinueBackendByKind(kind: AgentBackendKind, retinue: RetinueApi): Promise<RetinueBackend> {
  if (kind === "opencode") {
    return createOpenCodeBackend({});
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

function clampMcpWaitTimeoutMs(timeoutMs: number | undefined, env: NodeJS.ProcessEnv): number | undefined {
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
