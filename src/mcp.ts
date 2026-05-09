#!/usr/bin/env node

import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { OpenCodeBackend } from "./backends/opencode/backend.js";
import { OpenCodeClient } from "./backends/opencode/client.js";
import { ensureOpenCodeServer, resolveOpenCodeServerFromEnv } from "./backends/opencode/serverManager.js";
import { DaemonClient } from "./daemon/client.js";
import { readDaemonDiscoverySync } from "./daemon/discovery.js";
import { getJobPaths, getRetinueTracePath, resolveStateDir } from "./core/paths.js";
import { ClaudeSupervisor } from "./core/supervisor.js";
import type { AgentBackendKind, JobMeta, JobStatusResult, SupervisorApi, WaitResult } from "./core/types.js";
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

export const RETINUE_TOOL_NAMES = ["retinue_spawn_agent", "retinue_wait_agent", "retinue_close_agent"] as const;

export interface CreateMcpServerOptions {
  exposeBackendTools?: boolean;
}

export function createMcpServer(supervisor: SupervisorApi = createMcpSupervisorFromEnv(), options: CreateMcpServerOptions = {}): McpServer {
  const server = new McpServer({
    name: "supervisor",
    version: "0.1.0"
  });

  if (options.exposeBackendTools ?? process.env.SUPERVISOR_EXPOSE_BACKEND_TOOLS === "1") {
    registerBackendTools(server, supervisor);
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
        title: z.string().optional()
      }
    },
    async (args) => {
      const taskName = normalizeTaskName(args);
      const started = await (await createRetinueBackend(supervisor)).run({
        cwd: args.cwd ?? process.cwd(),
        prompt: args.message,
        name: taskName,
        title: args.title ?? taskName
      });
      return jsonToolResult({
        task_name: taskName,
        jobId: started.jobId,
        status: started.status,
        backend: started.backend,
        sessionId: started.sessionId,
        externalSessionId: started.externalSessionId
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
      const backend = await createRetinueBackendForJob(supervisor, jobId);
      const waited = await backend.wait({ jobId }, timeoutMs);
      const status = await backend.status({ jobId });
      if (waited.status === "running") {
        const stateDir = resolveStateDir({
          explicitStateDir: process.env.SUPERVISOR_STATE_DIR,
          env: process.env
        });
        return jsonToolResult({
          task_name: isJobMeta(status) ? status.name : undefined,
          jobId,
          status: waited.status,
          backend: isJobMeta(status) ? status.backend : undefined,
          externalSessionId: isJobMeta(status) ? status.externalSessionId : undefined,
          externalServerUrl: isJobMeta(status) ? status.externalServerUrl : undefined,
          stateDir,
          tracePath: getRetinueTracePath(stateDir)
        });
      }
      const result = await backend.result({ jobId });
      return jsonToolResult({
        task_name: isJobMeta(status) ? status.name : undefined,
        jobId,
        status: waited.status,
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
      const backend = await createRetinueBackendForJob(supervisor, jobId);
      const status = await backend.status({ jobId });
      if (isJobMeta(status) && status.status === "running") {
        await backend.abort({ jobId });
        return jsonToolResult({ jobId, status: "killed" });
      }
      return jsonToolResult({ jobId, status: "status" in status ? status.status : "unknown" });
    }
  );

  return server;
}

function registerBackendTools(server: McpServer, supervisor: SupervisorApi): void {
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
    async (args) => jsonToolResult(await supervisor.run(args))
  );

  server.registerTool(
    "claude_status",
    {
      title: "Get Claude Code Job Status",
      description: "Read current status metadata for a Claude Code job.",
      inputSchema: { jobId: z.string() }
    },
    async ({ jobId }) => jsonToolResult(await supervisor.status(jobId))
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
    async ({ jobId, timeoutMs }) => jsonToolResult(await supervisor.wait(jobId, { timeoutMs }))
  );

  server.registerTool(
    "claude_result",
    {
      title: "Read Claude Code Job Result",
      description: "Read stdout, stderr, parsed JSON, and exit status for a Claude Code job.",
      inputSchema: { jobId: z.string() }
    },
    async ({ jobId }) => jsonToolResult(await supervisor.result(jobId))
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
    async (args) => jsonToolResult(await supervisor.continueJob(args))
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
      jsonToolResult(await supervisor.peek(jobId, { stdoutTailBytes, stderrTailBytes }))
  );

  server.registerTool(
    "claude_kill",
    {
      title: "Kill Claude Code Job",
      description: "Kill a running Claude Code job process tree.",
      inputSchema: { jobId: z.string() }
    },
    async ({ jobId }) => jsonToolResult(await supervisor.kill(jobId))
  );

  server.registerTool(
    "claude_cleanup",
    {
      title: "Cleanup Claude Code Jobs",
      description: "Remove terminal job directories while preserving running jobs.",
      inputSchema: { olderThanMs: z.number().int().nonnegative().optional() }
    },
    async ({ olderThanMs }) => jsonToolResult(await supervisor.cleanup({ olderThanMs }))
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
      const result = await (await createOpenCodeBackend({ opencodeBaseUrl })).wait({ jobId }, timeoutMs);
      return jsonToolResult(result);
    }
  );

  server.registerTool(
    "opencode_result",
    {
      title: "Read OpenCode Job Result",
      description: "Read the latest OpenCode message result for a supervisor job.",
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
      description: "Abort the OpenCode session associated with a supervisor job.",
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
  const env = {
    ...process.env,
    SUPERVISOR_OPENCODE_BASE_URL: args.opencodeBaseUrl ?? process.env.SUPERVISOR_OPENCODE_BASE_URL
  };
  const resolution = resolveOpenCodeServerFromEnv(env);
  const stateDir = resolveStateDir({ explicitStateDir: process.env.SUPERVISOR_STATE_DIR, env: process.env });
  const target = await ensureOpenCodeServer(resolution, { stateDir });
  return new OpenCodeBackend({
    client: new OpenCodeClient(target.baseUrl),
    baseUrl: target.baseUrl,
    stateDir,
    env: process.env
  });
}

function withOpenCodeDefaults<T extends { model?: string; agent?: string }>(args: T): T {
  return {
    ...args,
    model: args.model ?? process.env.SUPERVISOR_OPENCODE_MODEL,
    agent: args.agent ?? process.env.SUPERVISOR_OPENCODE_AGENT
  };
}

type RetinueBackend = AgentBackend & {
  wait(handle: AgentHandle, timeoutMs?: number): Promise<Pick<WaitResult, "jobId" | "status">>;
};

async function createRetinueBackend(supervisor: SupervisorApi): Promise<RetinueBackend> {
  return createRetinueBackendByKind(readRetinueBackendKindFromEnv(), supervisor);
}

async function createRetinueBackendForJob(supervisor: SupervisorApi, jobId: string): Promise<RetinueBackend> {
  const recordedKind = await readRetinueJobBackendKind(jobId);
  if (recordedKind) {
    return createRetinueBackendByKind(recordedKind, supervisor);
  }
  return createRetinueBackend(supervisor);
}

async function createRetinueBackendByKind(kind: AgentBackendKind, supervisor: SupervisorApi): Promise<RetinueBackend> {
  if (kind === "opencode") {
    return createOpenCodeBackend({});
  }
  if (kind === "claude-code") {
    return new SupervisorAgentBackend(supervisor);
  }
  throw new Error(`Unsupported Retinue backend: ${kind satisfies never}`);
}

function readRetinueBackendKindFromEnv(): AgentBackendKind {
  const backend = (process.env.SUPERVISOR_RETINUE_BACKEND ?? "opencode").trim().toLowerCase();
  if (backend === "opencode") {
    return "opencode";
  }
  if (backend === "claude-code" || backend === "claude") {
    return "claude-code";
  }
  throw new Error(`Unsupported SUPERVISOR_RETINUE_BACKEND: ${backend}`);
}

async function readRetinueJobBackendKind(jobId: string): Promise<AgentBackendKind | undefined> {
  const stateDir = resolveStateDir({
    explicitStateDir: process.env.SUPERVISOR_STATE_DIR,
    env: process.env
  });
  try {
    const meta = JSON.parse(await fs.readFile(getJobPaths(stateDir, jobId).meta, "utf8")) as Partial<JobMeta>;
    return meta.backend === "opencode" || meta.backend === "claude-code" ? meta.backend : undefined;
  } catch {
    return undefined;
  }
}

class SupervisorAgentBackend implements RetinueBackend {
  readonly kind = "claude-code" as const;

  constructor(private readonly supervisor: SupervisorApi) {}

  run(options: AgentRunOptions) {
    return this.supervisor.run(options);
  }

  continueJob(options: AgentContinueOptions) {
    return this.supervisor.run(options);
  }

  status(handle: AgentHandle): Promise<JobStatusResult> {
    return this.supervisor.status(handle.jobId);
  }

  result(handle: AgentHandle) {
    return this.supervisor.result(handle.jobId);
  }

  async abort(handle: AgentHandle): Promise<void> {
    await this.supervisor.kill(handle.jobId);
  }

  async wait(handle: AgentHandle, timeoutMs?: number): Promise<Pick<WaitResult, "jobId" | "status">> {
    const result = await this.supervisor.wait(handle.jobId, { timeoutMs });
    return { jobId: result.jobId, status: result.status };
  }
}

function normalizeTaskName(args: { task_name?: string; taskName?: string }): string {
  return args.task_name?.trim() || args.taskName?.trim() || "retinue-agent";
}

function isJobMeta(value: unknown): value is { name?: string } {
  return typeof value === "object" && value !== null && "jobId" in value;
}


export function createMcpSupervisorFromEnv(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env
): SupervisorApi {
  if (env.SUPERVISOR_DAEMON_URL) {
    return new DaemonClient(env.SUPERVISOR_DAEMON_URL);
  }
  if (env.SUPERVISOR_DAEMON_DISCOVERY === "1") {
    const stateDir = resolveStateDir({
      explicitStateDir: env.SUPERVISOR_STATE_DIR,
      env
    });
    return new DaemonClient(readDaemonDiscoverySync(stateDir).url);
  }

  return new ClaudeSupervisor({
    stateDir: env.SUPERVISOR_STATE_DIR,
    claudeCommand: env.SUPERVISOR_CLAUDE_COMMAND,
    claudePrefixArgs: parsePrefixArgs(env.SUPERVISOR_CLAUDE_PREFIX_ARGS),
    env,
    defaultRuntimeTimeoutMs: parseOptionalNumber(env.SUPERVISOR_DEFAULT_RUNTIME_TIMEOUT_MS),
    maxConcurrentJobs: parseOptionalNumber(env.SUPERVISOR_MAX_CONCURRENT_JOBS)
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
