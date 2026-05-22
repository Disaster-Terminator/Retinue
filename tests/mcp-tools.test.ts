import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { createDaemonServer } from "../src/daemon/server.js";
import { writeDaemonDiscovery } from "../src/daemon/discovery.js";
import {
  CLAUDE_TOOL_NAMES,
  OPENCODE_TOOL_NAMES,
  RETINUE_DIAGNOSTIC_TOOL_NAMES,
  RETINUE_TOOL_NAMES,
  createMcpServer,
  createMcpRetinueFromEnv,
  resolveMcpWaitTimeoutMs
} from "../src/mcp.js";
import { ClaudeRetinue } from "../src/core/retinue.js";
import { startFakeOpenCodeServer } from "./fixtures/fake-opencode-server.js";

const fixturePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures/fake-claude.mjs");

describe("MCP tools", () => {
  it("keeps the default MCP wait ceiling long enough for OpenCode soft-stall rescue", () => {
    expect(resolveMcpWaitTimeoutMs(180_000, {} as NodeJS.ProcessEnv)).toBe(180_000);
    expect(resolveMcpWaitTimeoutMs(240_000, {} as NodeJS.ProcessEnv)).toBe(180_000);
    expect(resolveMcpWaitTimeoutMs(240_000, { RETINUE_MCP_WAIT_MAX_MS: "300000" } as NodeJS.ProcessEnv)).toBe(240_000);
  });

  it("declares the Claude Code lifecycle tools", () => {
    expect(CLAUDE_TOOL_NAMES).toEqual([
      "claude_run",
      "claude_status",
      "claude_wait",
      "claude_result",
      "claude_continue",
      "claude_peek",
      "claude_kill",
      "claude_cleanup"
    ]);
  });

  it("declares the OpenCode lifecycle tools", () => {
    expect(OPENCODE_TOOL_NAMES).toEqual([
      "opencode_run",
      "opencode_status",
      "opencode_wait",
      "opencode_result",
      "opencode_continue",
      "opencode_kill",
      "opencode_cleanup"
    ]);
  });

  it("declares the Retinue Codex-like spawn tools", () => {
    expect(RETINUE_TOOL_NAMES).toEqual([
      "retinue_spawn_agent",
      "retinue_wait_agent",
      "retinue_close_agent",
      "retinue_list_agents",
      "retinue_list_permissions",
      "retinue_reply_permission"
    ]);
  });

  it("declares Retinue diagnostic tools separately from the default product tools", () => {
    expect(RETINUE_DIAGNOSTIC_TOOL_NAMES).toEqual(["retinue_audit_logs"]);
    expect(RETINUE_TOOL_NAMES).not.toContain("retinue_audit_logs");
  });

  it("creates a server instance with registered tools", () => {
    const server = createMcpServer(new ClaudeRetinue({ stateDir: "unused" }));

    expect(server).toBeTruthy();
    expect(server.server).toBeTruthy();
  });

  it("publishes only Retinue product tools by default", async () => {
    const connection = await connectMcpClientWithRetinue(new ClaudeRetinue({ stateDir: "unused" }), false);
    try {
      const toolNames = (await connection.client.listTools()).tools.map((tool) => tool.name);
      expect(toolNames).toEqual([...RETINUE_TOOL_NAMES]);
    } finally {
      await closeMcpClient(connection);
    }
  });

  it("publishes Retinue diagnostic tools only when explicitly enabled", async () => {
    const connection = await connectMcpClientWithRetinue(new ClaudeRetinue({ stateDir: "unused" }), {
      exposeBackendTools: false,
      exposeDiagnosticTools: true
    });
    try {
      const toolNames = (await connection.client.listTools()).tools.map((tool) => tool.name);
      expect(toolNames).toEqual([...RETINUE_TOOL_NAMES, ...RETINUE_DIAGNOSTIC_TOOL_NAMES]);
    } finally {
      await closeMcpClient(connection);
    }
  });

  it("creates a daemon-backed retinue when RETINUE_DAEMON_URL is set", () => {
    const retinue = createMcpRetinueFromEnv({
      RETINUE_DAEMON_URL: "http://127.0.0.1:27777"
    });

    expect(retinue.constructor.name).toBe("DaemonClient");
  });

  it("discovers a daemon-backed retinue when explicitly requested", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "retinue-mcp-discovery-test-"));
    try {
      await writeDaemonDiscovery(tempDir, {
        url: "http://127.0.0.1:27777",
        pid: process.pid,
        startedAt: "2026-05-04T00:00:00.000Z",
        version: "0.1.0"
      });

      const retinue = createMcpRetinueFromEnv({
        RETINUE_STATE_DIR: tempDir,
        RETINUE_DAEMON_DISCOVERY: "1"
      });

      expect(retinue.constructor.name).toBe("DaemonClient");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("calls Claude lifecycle tools through daemon RPC", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "retinue-mcp-daemon-test-"));
    const daemon = createDaemonServer(
      new ClaudeRetinue({
        stateDir: tempDir,
        claudeCommand: process.execPath,
        claudePrefixArgs: [fixturePath]
      })
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "retinue-test-client", version: "0.1.0" });

    try {
      await new Promise<void>((resolve) => daemon.listen(0, "127.0.0.1", resolve));
      const address = daemon.address() as AddressInfo;
      const mcpServer = createMcpServer(
        createMcpRetinueFromEnv({
          RETINUE_DAEMON_URL: `http://127.0.0.1:${address.port}`
        }),
        { exposeBackendTools: true }
      );
      await Promise.all([mcpServer.connect(serverTransport), client.connect(clientTransport)]);

      const run = parseToolJson(
        await client.callTool({
          name: "claude_run",
          arguments: { cwd: tempDir, prompt: "mcp daemon" }
        })
      );
      expect(run.status).toBe("running");

      const wait = parseToolJson(
        await client.callTool({
          name: "claude_wait",
          arguments: { jobId: run.jobId, timeoutMs: 5000 }
        })
      );
      expect(wait.status).toBe("completed");

      const result = parseToolJson(
        await client.callTool({
          name: "claude_result",
          arguments: { jobId: run.jobId }
        })
      );
      expect(result.parsedStdout.result).toBe("fake result: mcp daemon");
    } finally {
      await Promise.allSettled([clientTransport.close(), serverTransport.close(), closeServer(daemon)]);
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps daemon job truth after MCP adapter reconnects", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "retinue-mcp-reconnect-test-"));
    const daemon = createDaemonServer(
      new ClaudeRetinue({
        stateDir: tempDir,
        claudeCommand: process.execPath,
        claudePrefixArgs: [fixturePath],
        env: { ...process.env, FAKE_CLAUDE_DELAY_MS: "300" }
      })
    );
    let first: Awaited<ReturnType<typeof connectMcpClient>> | undefined;
    let second: Awaited<ReturnType<typeof connectMcpClient>> | undefined;

    try {
      await new Promise<void>((resolve) => daemon.listen(0, "127.0.0.1", resolve));
      const address = daemon.address() as AddressInfo;
      const daemonUrl = `http://127.0.0.1:${address.port}`;

      first = await connectMcpClient(daemonUrl);
      const run = parseToolJson(
        await first.client.callTool({
          name: "claude_run",
          arguments: { cwd: tempDir, prompt: "mcp reconnect" }
        })
      );
      expect(run.status).toBe("running");
      await closeMcpClient(first);
      first = undefined;

      second = await connectMcpClient(daemonUrl);
      const wait = parseToolJson(
        await second.client.callTool({
          name: "claude_wait",
          arguments: { jobId: run.jobId, timeoutMs: 5000 }
        })
      );
      expect(wait.status).toBe("completed");

      const result = parseToolJson(
        await second.client.callTool({
          name: "claude_result",
          arguments: { jobId: run.jobId }
        })
      );
      expect(result.parsedStdout.result).toBe("fake result: mcp reconnect");
    } finally {
      await Promise.allSettled([
        first ? closeMcpClient(first) : Promise.resolve(),
        second ? closeMcpClient(second) : Promise.resolve(),
        closeServer(daemon)
      ]);
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("returns structured MCP errors for missing required fields", async () => {
    const connection = await connectMcpClientWithRetinue(new ClaudeRetinue({ stateDir: "unused" }));
    try {
      await expectMcpInvalidParams(
        connection.client.callTool({
          name: "claude_status",
          arguments: {}
        })
      );
    } finally {
      await closeMcpClient(connection);
    }
  });

  it("returns structured MCP errors for wrong field types", async () => {
    const connection = await connectMcpClientWithRetinue(new ClaudeRetinue({ stateDir: "unused" }));
    try {
      await expectMcpInvalidParams(
        connection.client.callTool({
          name: "claude_wait",
          arguments: { jobId: "job_x", timeoutMs: "fast" }
        })
      );
    } finally {
      await closeMcpClient(connection);
    }
  });

  it("returns structured MCP errors for unsupported permission modes", async () => {
    const connection = await connectMcpClientWithRetinue(new ClaudeRetinue({ stateDir: "unused" }));
    try {
      await expectMcpInvalidParams(
        connection.client.callTool({
          name: "claude_run",
          arguments: { cwd: ".", prompt: "x", permissionMode: "root" }
        })
      );
    } finally {
      await closeMcpClient(connection);
    }
  });

  it("publishes concrete input schemas for key Claude tools", async () => {
    const connection = await connectMcpClientWithRetinue(new ClaudeRetinue({ stateDir: "unused" }));
    try {
      const tools = await connection.client.listTools();

      assertRequiredFields(tools.tools, "claude_run", ["cwd", "prompt"]);
      assertRequiredFields(tools.tools, "claude_status", ["jobId"]);
      assertRequiredFields(tools.tools, "claude_wait", ["jobId"]);
      assertOptionalField(tools.tools, "claude_wait", "timeoutMs");
      assertOptionalField(tools.tools, "claude_cleanup", "olderThanMs");
      assertRequiredFields(tools.tools, "opencode_run", ["cwd", "prompt"]);
      assertOptionalField(tools.tools, "opencode_run", "opencodeBaseUrl");
      assertOptionalField(tools.tools, "opencode_run", "model");
      assertOptionalField(tools.tools, "opencode_run", "agent");
      assertRequiredFields(tools.tools, "retinue_spawn_agent", ["message"]);
      assertOptionalField(tools.tools, "retinue_spawn_agent", "task_name");
      assertOptionalField(tools.tools, "retinue_spawn_agent", "cwd");
      assertOptionalField(tools.tools, "retinue_spawn_agent", "agent");
      assertAbsentFields(tools.tools, "retinue_spawn_agent", [
        "backend",
        "profile",
        "model",
        "permissionMode",
        "opencodeBaseUrl",
        "access_mode",
        "bash_policy"
      ]);
      assertRequiredFields(tools.tools, "retinue_wait_agent", ["jobId"]);
      assertAbsentFields(tools.tools, "retinue_wait_agent", ["backend", "profile", "model", "agent", "permissionMode", "opencodeBaseUrl"]);
      assertRequiredFields(tools.tools, "retinue_close_agent", ["jobId"]);
      assertAbsentFields(tools.tools, "retinue_close_agent", ["backend", "profile", "model", "agent", "permissionMode", "opencodeBaseUrl"]);
      assertAbsentFields(tools.tools, "retinue_list_agents", ["backend", "profile", "model", "agent", "permissionMode", "opencodeBaseUrl"]);
      assertRequiredFields(tools.tools, "retinue_list_permissions", ["jobId"]);
      assertAbsentFields(tools.tools, "retinue_list_permissions", ["backend", "profile", "model", "agent", "permissionMode", "opencodeBaseUrl"]);
      assertRequiredFields(tools.tools, "retinue_reply_permission", ["jobId", "requestId", "reply"]);
      assertOptionalField(tools.tools, "retinue_reply_permission", "message");
      assertAbsentFields(tools.tools, "retinue_reply_permission", ["backend", "profile", "model", "agent", "permissionMode", "opencodeBaseUrl"]);
    } finally {
      await closeMcpClient(connection);
    }
  });

  it("publishes concrete input schemas for diagnostic tools only when enabled", async () => {
    const connection = await connectMcpClientWithRetinue(new ClaudeRetinue({ stateDir: "unused" }), {
      exposeBackendTools: false,
      exposeDiagnosticTools: true
    });
    try {
      const tools = await connection.client.listTools();
      assertOptionalField(tools.tools, "retinue_audit_logs", "since");
      assertOptionalField(tools.tools, "retinue_audit_logs", "maxLines");
      assertOptionalField(tools.tools, "retinue_audit_logs", "maxBytes");
      assertOptionalField(tools.tools, "retinue_audit_logs", "stateDir");
      assertOptionalField(tools.tools, "retinue_audit_logs", "tracePath");
      assertAbsentFields(tools.tools, "retinue_audit_logs", ["backend", "profile", "model", "agent", "permissionMode", "opencodeBaseUrl"]);
    } finally {
      await closeMcpClient(connection);
    }
  });

  it("audits Retinue logs through the opt-in diagnostic MCP tool", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "retinue-mcp-log-audit-"));
    const tracePath = path.join(tempDir, "retinue.jsonl");
    await fs.writeFile(
      tracePath,
      [
        JSON.stringify({
          time: "2026-05-22T08:13:56.000Z",
          event: "opencode_job_stalled",
          jobId: "job_malformed",
          status: "stalled",
          diagnostic: {
            stallReason: "read_tool_invalid_input",
            stallSummary: "OpenCode provider/model emitted read tool call(s) with missing or invalid input. readToolCalls=call_read:pending:input={}.",
            softStallRescueSourceReason: "provider_zero_progress",
            recoveryStallReason: "read_tool_invalid_input",
            lastAssistantProviderID: "litellm",
            lastAssistantModelID: "doubao-seed-2.0-lite",
            lastAssistantAgent: "explore",
            lastAssistantMode: "explore",
            runningReadToolPartSummaries: [
              {
                tool: "read",
                callID: "call_read",
                stateStatus: "pending",
                stateInput: { type: "object", preview: "{}" }
              }
            ],
            malformedReadToolParts: 1,
            pendingPermissionCount: 0,
            pendingExternalDirectoryPermissionCount: 0
          }
        }),
        JSON.stringify({
          time: "2026-05-22T08:14:56.000Z",
          event: "opencode_job_result_read",
          jobId: "job_completed_later",
          status: "completed",
          diagnostic: {
            stallReason: "provider_zero_progress",
            lastAssistantProviderID: "litellm",
            lastAssistantModelID: "doubao-seed-2.0-lite"
          }
        })
      ].join("\n")
    );
    const connection = await connectMcpClientWithRetinue(new ClaudeRetinue({ stateDir: "unused" }), {
      exposeBackendTools: false,
      exposeDiagnosticTools: true
    });
    try {
      const audit = parseToolJson(
        await connection.client.callTool({
          name: "retinue_audit_logs",
          arguments: { tracePath, since: "2026-05-22T08:00:00.000Z" }
        })
      );
      expect(audit.issueCount).toBe(1);
      expect(audit.ignoredCompletedJobIds).toEqual(["job_completed_later"]);
      expect(audit.issues[0]).toMatchObject({
        jobIds: ["job_malformed"],
        sample: {
          stallReason: "read_tool_invalid_input",
          recoveryStallReason: "read_tool_invalid_input",
          pendingPermissionCount: 0,
          pendingExternalDirectoryPermissionCount: 0,
          runningReadToolPartSummaries: [
            {
              tool: "read",
              stateInput: { preview: "{}" }
            }
          ]
        }
      });
    } finally {
      await closeMcpClient(connection);
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("runs the Retinue OpenCode-first spawn/wait/result/close flow without backend arguments", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "retinue-mcp-retinue-opencode-"));
    const fakeOpenCode = await startFakeOpenCodeServer();
    const connection = await connectMcpClientWithRetinue(new ClaudeRetinue({ stateDir: "unused" }));
    try {
      process.env.RETINUE_STATE_DIR = tempDir;
      process.env.RETINUE_OPENCODE_BASE_URL = fakeOpenCode.url;
      process.env.RETINUE_MCP_WAIT_MAX_MS = "5";

      const spawn = parseToolJson(
        await connection.client.callTool({
          name: "retinue_spawn_agent",
        arguments: { cwd: tempDir, message: "retinue mcp", task_name: "smoke", agent: "explore" }
        })
      );
      expect(spawn).toMatchObject({
        task_name: "smoke",
        backend: "opencode",
        status: "running",
        cwd: tempDir,
        jobDir: path.join(tempDir, "jobs", spawn.jobId),
        externalServerUrl: fakeOpenCode.url,
        externalRunnerMode: "per-spawn",
        externalRootAgent: "build",
        externalRootSessionId: expect.stringMatching(/^ses_/),
        externalParentSessionId: expect.stringMatching(/^ses_/),
        externalSessionDirectory: process.cwd()
      });
      expect(fakeOpenCode.promptRequests.at(-1)).toMatchObject({ agent: "explore" });
      expect(fakeOpenCode.promptRequests.at(-1)).not.toHaveProperty("tools");
      const submittedPrompt = extractOpenCodePromptText(fakeOpenCode.promptRequests.at(-1));
      expect(submittedPrompt).toBe("retinue mcp");
      expectTaskCompatibleChildPermission(fakeOpenCode.sessionRequests.at(-1));
      const runningWait = parseToolJson(
        await connection.client.callTool({
          name: "retinue_wait_agent",
          arguments: { jobId: spawn.jobId, timeoutMs: 1000 }
        })
      );
      expect(runningWait).toMatchObject({
        jobId: spawn.jobId,
        status: "running",
        diagnostic: {
          event: "opencode_job_wait_timeout",
          status: "running"
        }
      });

      fakeOpenCode.completeSession(spawn.externalSessionId);

      const wait = parseToolJson(
        await connection.client.callTool({
          name: "retinue_wait_agent",
          arguments: { jobId: spawn.jobId, timeoutMs: 1000 }
        })
      );
      expect(wait).toMatchObject({
        task_name: "smoke",
        jobId: spawn.jobId,
        status: "completed",
        result: { parsedStdout: { result: expect.stringContaining("retinue mcp") } },
        diagnostic: {
          event: "opencode_job_result_read",
          status: "completed"
        }
      });
      expect(wait.diagnostic.message).not.toContain("still running");

      const close = parseToolJson(
        await connection.client.callTool({
          name: "retinue_close_agent",
          arguments: { jobId: spawn.jobId }
        })
      );
      expect(close).toMatchObject({ jobId: spawn.jobId, status: "completed" });
    } finally {
      delete process.env.RETINUE_STATE_DIR;
      delete process.env.RETINUE_OPENCODE_BASE_URL;
      delete process.env.RETINUE_OPENCODE_SOFT_STALL_RESCUE_GRACE_MS;
      await Promise.allSettled([closeMcpClient(connection), fakeOpenCode.close()]);
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("re-keys Retinue wait responses to a fresh task-level attempt", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "retinue-mcp-retinue-opencode-attempt-"));
    const fakeOpenCode = await startFakeOpenCodeServer();
    const connection = await connectMcpClientWithRetinue(new ClaudeRetinue({ stateDir: "unused" }));
    const previousEnv = {
      RETINUE_STATE_DIR: process.env.RETINUE_STATE_DIR,
      RETINUE_OPENCODE_BASE_URL: process.env.RETINUE_OPENCODE_BASE_URL,
      RETINUE_MCP_WAIT_MAX_MS: process.env.RETINUE_MCP_WAIT_MAX_MS,
      RETINUE_OPENCODE_STALL_READ_TOOL_MS: process.env.RETINUE_OPENCODE_STALL_READ_TOOL_MS
    };
    try {
      process.env.RETINUE_STATE_DIR = tempDir;
      process.env.RETINUE_OPENCODE_BASE_URL = fakeOpenCode.url;
      process.env.RETINUE_MCP_WAIT_MAX_MS = "5000";
      process.env.RETINUE_OPENCODE_STALL_READ_TOOL_MS = "1";
      fakeOpenCode.setAutoAssistantResponses(false);

      const spawn = parseToolJson(
        await connection.client.callTool({
          name: "retinue_spawn_agent",
          arguments: { cwd: tempDir, message: "retinue malformed read retry", task_name: "attempt-smoke", agent: "explore" }
        })
      );
      fakeOpenCode.appendMalformedReadToolAssistant(spawn.externalSessionId);
      fakeOpenCode.setAutoAssistantResponses(true);

      const wait = parseToolJson(
        await connection.client.callTool({
          name: "retinue_wait_agent",
          arguments: { jobId: spawn.jobId, timeoutMs: 1000 }
        })
      );

      expect(wait).toMatchObject({
        task_name: "attempt-smoke",
        requestedJobId: spawn.jobId,
        selectedAttemptJobId: expect.stringMatching(/^job_/),
        status: "running",
        attemptChain: [
          expect.objectContaining({ jobId: spawn.jobId, status: "stalled" }),
          expect.objectContaining({ jobId: wait.jobId, attempt: 1, selected: true })
        ]
      });
      expect(wait.jobId).not.toBe(spawn.jobId);
      const attemptMeta = JSON.parse(await fs.readFile(path.join(tempDir, "jobs", wait.jobId, "meta.json"), "utf8")) as { externalSessionId: string };
      fakeOpenCode.completeSession(attemptMeta.externalSessionId);

      const completed = parseToolJson(
        await connection.client.callTool({
          name: "retinue_wait_agent",
          arguments: { jobId: spawn.jobId, timeoutMs: 1000 }
        })
      );
      expect(completed).toMatchObject({
        task_name: "attempt-smoke",
        jobId: wait.jobId,
        requestedJobId: spawn.jobId,
        selectedAttemptJobId: wait.jobId,
        status: "completed",
        result: {
          status: "completed",
          parsedStdout: { result: expect.stringContaining("Retinue task-level retry request") }
        },
        attemptChain: [
          expect.objectContaining({ jobId: spawn.jobId, status: "stalled" }),
          expect.objectContaining({ jobId: wait.jobId, attempt: 1, selected: true })
        ]
      });
    } finally {
      restoreEnv("RETINUE_STATE_DIR", previousEnv.RETINUE_STATE_DIR);
      restoreEnv("RETINUE_OPENCODE_BASE_URL", previousEnv.RETINUE_OPENCODE_BASE_URL);
      restoreEnv("RETINUE_MCP_WAIT_MAX_MS", previousEnv.RETINUE_MCP_WAIT_MAX_MS);
      restoreEnv("RETINUE_OPENCODE_STALL_READ_TOOL_MS", previousEnv.RETINUE_OPENCODE_STALL_READ_TOOL_MS);
      await Promise.allSettled([closeMcpClient(connection), fakeOpenCode.close()]);
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("follows OpenCode agent semantics without a Retinue access-mode layer", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "retinue-mcp-retinue-opencode-agent-policy-"));
    const fakeOpenCode = await startFakeOpenCodeServer();
    const connection = await connectMcpClientWithRetinue(new ClaudeRetinue({ stateDir: "unused" }));
    try {
      process.env.RETINUE_STATE_DIR = tempDir;
      process.env.RETINUE_OPENCODE_BASE_URL = fakeOpenCode.url;

      await connection.client.callTool({
        name: "retinue_spawn_agent",
        arguments: { cwd: tempDir, message: "inspect with native explore profile", task_name: "explore-policy", agent: "explore" }
      });

      expect(fakeOpenCode.promptRequests.at(-1)).toMatchObject({ agent: "explore" });
      expect(extractOpenCodePromptText(fakeOpenCode.promptRequests.at(-1))).toBe("inspect with native explore profile");
      expect(fakeOpenCode.promptRequests.at(-1)).not.toHaveProperty("tools");
      expectTaskCompatibleChildPermission(fakeOpenCode.sessionRequests.at(-1));

      await connection.client.callTool({
        name: "retinue_spawn_agent",
        arguments: { cwd: tempDir, message: "write the implementation plan", task_name: "plan-policy", agent: "plan" }
      });

      expect(fakeOpenCode.promptRequests.at(-1)).toMatchObject({ agent: "plan" });
      expect(extractOpenCodePromptText(fakeOpenCode.promptRequests.at(-1))).toBe("write the implementation plan");
      expect(fakeOpenCode.promptRequests.at(-1)).not.toHaveProperty("tools");
      expectTaskCompatibleChildPermission(fakeOpenCode.sessionRequests.at(-1));

      await connection.client.callTool({
        name: "retinue_spawn_agent",
        arguments: { cwd: tempDir, message: "make the requested change", task_name: "build-policy", agent: "build" }
      });

      expect(fakeOpenCode.promptRequests.at(-1)).toMatchObject({ agent: "build" });
      expect(extractOpenCodePromptText(fakeOpenCode.promptRequests.at(-1))).toBe("make the requested change");
      expect(fakeOpenCode.promptRequests.at(-1)).not.toHaveProperty("tools");
      expectTaskCompatibleChildPermission(fakeOpenCode.sessionRequests.at(-1));
    } finally {
      delete process.env.RETINUE_STATE_DIR;
      delete process.env.RETINUE_OPENCODE_BASE_URL;
      await Promise.allSettled([closeMcpClient(connection), fakeOpenCode.close()]);
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("returns OpenCode diagnostics when Retinue wait times out while still running", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "retinue-mcp-retinue-opencode-running-"));
    const fakeOpenCode = await startFakeOpenCodeServer();
    fakeOpenCode.setAutoAssistantResponses(false);
    const connection = await connectMcpClientWithRetinue(new ClaudeRetinue({ stateDir: "unused" }));
    try {
      process.env.RETINUE_STATE_DIR = tempDir;
      process.env.RETINUE_OPENCODE_BASE_URL = fakeOpenCode.url;
      process.env.RETINUE_MCP_WAIT_MAX_MS = "5";

      const spawn = parseToolJson(
        await connection.client.callTool({
          name: "retinue_spawn_agent",
          arguments: { cwd: tempDir, message: "retinue still running", task_name: "running-opencode" }
        })
      );

      const wait = parseToolJson(
        await connection.client.callTool({
          name: "retinue_wait_agent",
          arguments: { jobId: spawn.jobId, timeoutMs: 5000 }
        })
      );

      expect(wait).toMatchObject({
        task_name: "running-opencode",
        jobId: spawn.jobId,
        status: "running",
        backend: "opencode",
        cwd: tempDir,
        externalSessionId: spawn.externalSessionId,
        externalServerUrl: fakeOpenCode.url,
        stateDir: tempDir,
        jobDir: path.join(tempDir, "jobs", spawn.jobId),
        promptPath: path.join(tempDir, "jobs", spawn.jobId, "prompt.md"),
        stdoutPath: path.join(tempDir, "jobs", spawn.jobId, "stdout.log"),
        stderrPath: path.join(tempDir, "jobs", spawn.jobId, "stderr.log"),
        stdoutTail: "",
        stdoutTailBytes: 0,
        stdoutTailTruncated: false,
        stderrTailTruncated: false,
        tracePath: path.join(tempDir, "logs", "retinue.jsonl"),
        requestedTimeoutMs: 5000,
        effectiveTimeoutMs: 5
      });
      expect(wait.stderrTail).toContain('"event":"opencode_job_wait_timeout"');
      expect(wait.stderrTail).toContain('"jobMessageCount"');
      expect(wait.stderrTailBytes).toBeGreaterThan(0);
      expect(wait.diagnostic).toMatchObject({
        event: "opencode_job_wait_timeout",
        backend: "opencode",
        status: "running",
        jobMessageCount: 1,
        lastMessagePartTypes: ["text"],
        readOnlyWriteIntent: false
      });
      expect(wait.diagnostic.message).toContain("OpenCode job is still running");
      expect(wait.diagnostic.message).toContain("blankAssistantRounds=0");
      expect(wait.diagnostic.message).toContain("zeroProgressAssistantRounds=0");
      expect(wait.diagnostic.message).toContain("runningReadToolParts=0");
    } finally {
      delete process.env.RETINUE_STATE_DIR;
      delete process.env.RETINUE_OPENCODE_BASE_URL;
      delete process.env.RETINUE_MCP_WAIT_MAX_MS;
      await Promise.allSettled([closeMcpClient(connection), fakeOpenCode.close()]);
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("returns structured OpenCode stall diagnostics when a Retinue child reaches stalled", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "retinue-mcp-retinue-opencode-stalled-"));
    const fakeOpenCode = await startFakeOpenCodeServer();
    fakeOpenCode.setAutoAssistantResponses(false);
    const connection = await connectMcpClientWithRetinue(new ClaudeRetinue({ stateDir: "unused" }));
    try {
      process.env.RETINUE_STATE_DIR = tempDir;
      process.env.RETINUE_OPENCODE_BASE_URL = fakeOpenCode.url;
      process.env.RETINUE_OPENCODE_STALL_ZERO_PROGRESS_ASSISTANT_MS = "1";

      const spawn = parseToolJson(
        await connection.client.callTool({
          name: "retinue_spawn_agent",
          arguments: { cwd: tempDir, message: "risk review stalls after tools", task_name: "stalled-opencode" }
        })
      );
      fakeOpenCode.appendToolCallAssistant(spawn.externalSessionId, "checking source one");
      fakeOpenCode.appendToolCallAssistant(spawn.externalSessionId, "checking source two");
      fakeOpenCode.appendZeroProgressReasoningAssistant(spawn.externalSessionId);

      const wait = parseToolJson(
        await connection.client.callTool({
          name: "retinue_wait_agent",
          arguments: { jobId: spawn.jobId, timeoutMs: 5000 }
        })
      );

      expect(wait).toMatchObject({
        task_name: "stalled-opencode",
        jobId: spawn.jobId,
        status: "stalled",
        result: {
          status: "stalled"
        },
        diagnostic: {
          event: "opencode_job_result_read",
          backend: "opencode",
          status: "stalled",
          stallReason: "provider_zero_progress",
          zeroProgressAssistantRounds: 1,
          lastAssistantProviderID: "litellm",
          lastAssistantModelID: "semantic-router",
          selectedAssistantTextBytes: expect.any(Number),
          selectedAssistantSha256: expect.any(String)
        }
      });
      expect(wait.diagnostic.message).toContain("provider/router produced zero-progress assistant output");
    } finally {
      delete process.env.RETINUE_STATE_DIR;
      delete process.env.RETINUE_OPENCODE_BASE_URL;
      delete process.env.RETINUE_OPENCODE_STALL_ZERO_PROGRESS_ASSISTANT_MS;
      await Promise.allSettled([closeMcpClient(connection), fakeOpenCode.close()]);
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("returns pending read tool call IDs when a Retinue child reaches read-tool stalled", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "retinue-mcp-retinue-opencode-read-stalled-"));
    const fakeOpenCode = await startFakeOpenCodeServer();
    fakeOpenCode.setAutoAssistantResponses(false);
    const connection = await connectMcpClientWithRetinue(new ClaudeRetinue({ stateDir: "unused" }));
    try {
      process.env.RETINUE_STATE_DIR = tempDir;
      process.env.RETINUE_OPENCODE_BASE_URL = fakeOpenCode.url;
      process.env.RETINUE_OPENCODE_STALL_READ_TOOL_MS = "1";

      const spawn = parseToolJson(
        await connection.client.callTool({
          name: "retinue_spawn_agent",
          arguments: { cwd: tempDir, message: "risk review leaves a read pending", task_name: "read-stalled-opencode" }
        })
      );
      fakeOpenCode.appendPendingReadToolAssistant(spawn.externalSessionId);

      const wait = parseToolJson(
        await connection.client.callTool({
          name: "retinue_wait_agent",
          arguments: { jobId: spawn.jobId, timeoutMs: 5000 }
        })
      );

      expect(wait).toMatchObject({
        task_name: "read-stalled-opencode",
        jobId: spawn.jobId,
        status: "stalled",
        result: {
          status: "stalled",
          stdout: expect.stringContaining("input={\"filePath\":\"docs/VERIFICATION.md\"}")
        },
        diagnostic: {
          event: "opencode_job_result_read",
          backend: "opencode",
          status: "stalled",
          stallReason: "read_tool_stalled",
          runningReadToolParts: 1,
          runningReadToolCallIds: [expect.stringMatching(/^call_/)]
        }
      });
      expect(wait.diagnostic.message).toContain("readToolCalls=call_");
      expect(wait.diagnostic.message).toContain('input={"filePath":"docs/VERIFICATION.md"}');
      expect(wait.diagnostic.runningReadToolPartSummaries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            tool: "read",
            stateStatus: "pending",
            callID: expect.stringMatching(/^call_/),
            stateInput: { type: "object", preview: '{"filePath":"docs/VERIFICATION.md"}' }
          })
        ])
      );
    } finally {
      delete process.env.RETINUE_STATE_DIR;
      delete process.env.RETINUE_OPENCODE_BASE_URL;
      delete process.env.RETINUE_OPENCODE_STALL_READ_TOOL_MS;
      await Promise.allSettled([closeMcpClient(connection), fakeOpenCode.close()]);
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("exposes an agent-facing OpenCode permission bridge for Retinue jobs", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "retinue-mcp-permission-bridge-"));
    const fakeOpenCode = await startFakeOpenCodeServer();
    fakeOpenCode.setAutoAssistantResponses(false);
    const connection = await connectMcpClientWithRetinue(new ClaudeRetinue({ stateDir: "unused" }));
    try {
      process.env.RETINUE_STATE_DIR = tempDir;
      process.env.RETINUE_OPENCODE_BASE_URL = fakeOpenCode.url;
      process.env.RETINUE_OPENCODE_STALL_READ_TOOL_MS = "1";

      const spawn = parseToolJson(
        await connection.client.callTool({
          name: "retinue_spawn_agent",
          arguments: { cwd: tempDir, message: "retinue permission bridge", task_name: "permission-bridge" }
        })
      );
      fakeOpenCode.appendPendingReadToolAssistant(spawn.externalSessionId);
      fakeOpenCode.appendExternalDirectoryPermission(spawn.externalSessionId, "/home/raystorm/projects/opencode/*", "call_read");

      const wait = parseToolJson(
        await connection.client.callTool({
          name: "retinue_wait_agent",
          arguments: { jobId: spawn.jobId, timeoutMs: 5000 }
        })
      );
      expect(wait).toMatchObject({
        jobId: spawn.jobId,
        status: "stalled",
        permissionRequired: true,
        permissions: [
          expect.objectContaining({
            id: "per_1",
            permission: "external_directory",
            patterns: ["/home/raystorm/projects/opencode/*"],
            toolCallID: "call_read"
          })
        ],
        attentionRequired: {
          kind: "permission",
          backend: "opencode",
          reason: "external_directory_permission_pending",
          replyOptions: ["once", "always", "reject"],
          permissions: [
            expect.objectContaining({
              id: "per_1",
              permission: "external_directory",
              patterns: ["/home/raystorm/projects/opencode/*"],
              toolCallID: "call_read"
            })
          ]
        },
        diagnostic: {
          stallReason: "external_directory_permission_pending",
          pendingExternalDirectoryPermissionCount: 1
        }
      });

      const list = parseToolJson(
        await connection.client.callTool({
          name: "retinue_list_permissions",
          arguments: { jobId: spawn.jobId }
        })
      );
      expect(list).toMatchObject({
        jobId: spawn.jobId,
        backend: "opencode",
        permissions: [
          expect.objectContaining({
            id: "per_1",
            sessionID: spawn.externalSessionId,
            permission: "external_directory",
            patterns: ["/home/raystorm/projects/opencode/*"],
            toolCallID: "call_read"
          })
        ]
      });

      const reply = parseToolJson(
        await connection.client.callTool({
          name: "retinue_reply_permission",
          arguments: { jobId: spawn.jobId, requestId: "per_1", reply: "reject", message: "headless deny" }
        })
      );
      expect(reply).toMatchObject({
        jobId: spawn.jobId,
        backend: "opencode",
        repliedRequestId: "per_1",
        reply: "reject",
        permissions: []
      });
    } finally {
      delete process.env.RETINUE_STATE_DIR;
      delete process.env.RETINUE_OPENCODE_BASE_URL;
      delete process.env.RETINUE_OPENCODE_STALL_READ_TOOL_MS;
      await Promise.allSettled([closeMcpClient(connection), fakeOpenCode.close()]);
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("evicts the oldest running Retinue OpenCode agent when the session slot pool is full", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "retinue-mcp-retinue-opencode-slots-"));
    const fakeOpenCode = await startFakeOpenCodeServer();
    fakeOpenCode.setAutoAssistantResponses(false);
    const connection = await connectMcpClientWithRetinue(new ClaudeRetinue({ stateDir: "unused" }));
    try {
      process.env.RETINUE_STATE_DIR = tempDir;
      process.env.RETINUE_OPENCODE_BASE_URL = fakeOpenCode.url;
      process.env.RETINUE_MAX_CONCURRENT_AGENTS = "3";

      const spawns = [];
      for (const taskName of ["slot-1", "slot-2", "slot-3", "slot-4"]) {
        spawns.push(
          parseToolJson(
            await connection.client.callTool({
              name: "retinue_spawn_agent",
              arguments: { cwd: tempDir, message: `retinue ${taskName}`, task_name: taskName }
            })
          )
        );
      }

      expect(spawns[3]).toMatchObject({
        task_name: "slot-4",
        backend: "opencode",
        status: "running",
        evictedJobId: spawns[0].jobId
      });

      const evicted = parseToolJson(
        await connection.client.callTool({
          name: "retinue_close_agent",
          arguments: { jobId: spawns[0].jobId }
        })
      );
      expect(evicted).toMatchObject({ jobId: spawns[0].jobId, status: "killed" });

      const trace = await fs.readFile(path.join(tempDir, "logs", "retinue.jsonl"), "utf8");
      expect(trace).toContain('"event":"retinue_agent_evicted"');
      expect(trace).toContain(`"evictedJobId":"${spawns[0].jobId}"`);
    } finally {
      delete process.env.RETINUE_STATE_DIR;
      delete process.env.RETINUE_OPENCODE_BASE_URL;
      delete process.env.RETINUE_MAX_CONCURRENT_AGENTS;
      await Promise.allSettled([closeMcpClient(connection), fakeOpenCode.close()]);
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("serializes concurrent Retinue spawns before enforcing the MCP session slot limit", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "retinue-mcp-retinue-opencode-concurrent-slots-"));
    const fakeOpenCode = await startFakeOpenCodeServer();
    fakeOpenCode.setAutoAssistantResponses(false);
    const connection = await connectMcpClientWithRetinue(new ClaudeRetinue({ stateDir: "unused" }));
    try {
      process.env.RETINUE_STATE_DIR = tempDir;
      process.env.RETINUE_OPENCODE_BASE_URL = fakeOpenCode.url;
      process.env.RETINUE_MAX_CONCURRENT_AGENTS = "3";

      const spawns = await Promise.all(
        ["concurrent-slot-1", "concurrent-slot-2", "concurrent-slot-3", "concurrent-slot-4"].map((taskName) =>
          connection.client
            .callTool({
              name: "retinue_spawn_agent",
              arguments: { cwd: tempDir, message: `retinue ${taskName}`, task_name: taskName }
            })
            .then(parseToolJson)
        )
      );

      const evictions = spawns.filter((spawn) => typeof spawn.evictedJobId === "string");
      expect(evictions).toHaveLength(1);

      const list = parseToolJson(await connection.client.callTool({ name: "retinue_list_agents", arguments: {} }));
      expect(list.maxAgents).toBe(3);
      expect(list.agents).toHaveLength(3);
      expect(list.agents.map((agent: { jobId: string }) => agent.jobId)).not.toContain(spawns[0].jobId);
      expect(list.agents.map((agent: { status: string }) => agent.status)).toEqual(["running", "running", "running"]);
    } finally {
      delete process.env.RETINUE_STATE_DIR;
      delete process.env.RETINUE_OPENCODE_BASE_URL;
      delete process.env.RETINUE_MAX_CONCURRENT_AGENTS;
      await Promise.allSettled([closeMcpClient(connection), fakeOpenCode.close()]);
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("lists active Retinue agents in the current MCP session pool", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "retinue-mcp-retinue-opencode-list-"));
    const fakeOpenCode = await startFakeOpenCodeServer();
    fakeOpenCode.setAutoAssistantResponses(false);
    const connection = await connectMcpClientWithRetinue(new ClaudeRetinue({ stateDir: "unused" }));
    try {
      process.env.RETINUE_STATE_DIR = tempDir;
      process.env.RETINUE_OPENCODE_BASE_URL = fakeOpenCode.url;

      const first = parseToolJson(
        await connection.client.callTool({
          name: "retinue_spawn_agent",
          arguments: { cwd: tempDir, message: "retinue list first", task_name: "list-first" }
        })
      );
      const second = parseToolJson(
        await connection.client.callTool({
          name: "retinue_spawn_agent",
          arguments: { cwd: tempDir, message: "retinue list second", task_name: "list-second" }
        })
      );

      const list = parseToolJson(await connection.client.callTool({ name: "retinue_list_agents", arguments: {} }));
      expect(list).toMatchObject({
        maxAgents: 3,
        agents: [
          { jobId: first.jobId, task_name: "list-first", backend: "opencode", status: "running" },
          { jobId: second.jobId, task_name: "list-second", backend: "opencode", status: "running" }
        ]
      });
    } finally {
      delete process.env.RETINUE_STATE_DIR;
      delete process.env.RETINUE_OPENCODE_BASE_URL;
      await Promise.allSettled([closeMcpClient(connection), fakeOpenCode.close()]);
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("removes stalled Retinue agents from the active MCP session pool", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "retinue-mcp-retinue-opencode-stalled-pool-"));
    const fakeOpenCode = await startFakeOpenCodeServer();
    fakeOpenCode.setAutoAssistantResponses(false);
    const connection = await connectMcpClientWithRetinue(new ClaudeRetinue({ stateDir: "unused" }));
    try {
      process.env.RETINUE_STATE_DIR = tempDir;
      process.env.RETINUE_OPENCODE_BASE_URL = fakeOpenCode.url;
      process.env.RETINUE_OPENCODE_STALL_ZERO_PROGRESS_ASSISTANT_MS = "1";

      const spawn = parseToolJson(
        await connection.client.callTool({
          name: "retinue_spawn_agent",
          arguments: {
            cwd: tempDir,
            message: "retinue stalled pool",
            task_name: "stalled-pool",
            agent: "explore"
          }
        })
      );
      fakeOpenCode.appendToolCallAssistant(spawn.externalSessionId, "checking source one");
      fakeOpenCode.appendToolCallAssistant(spawn.externalSessionId, "checking source two");
      fakeOpenCode.appendZeroProgressReasoningAssistant(spawn.externalSessionId);

      const wait = parseToolJson(
        await connection.client.callTool({
          name: "retinue_wait_agent",
          arguments: { jobId: spawn.jobId, timeoutMs: 1000 }
        })
      );
      expect(wait).toMatchObject({
        jobId: spawn.jobId,
        status: "stalled"
      });

      const list = parseToolJson(await connection.client.callTool({ name: "retinue_list_agents", arguments: {} }));
      expect(list.agents.map((agent: { jobId: string }) => agent.jobId)).not.toContain(spawn.jobId);
    } finally {
      delete process.env.RETINUE_STATE_DIR;
      delete process.env.RETINUE_OPENCODE_BASE_URL;
      delete process.env.RETINUE_OPENCODE_STALL_ZERO_PROGRESS_ASSISTANT_MS;
      await Promise.allSettled([closeMcpClient(connection), fakeOpenCode.close()]);
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("removes closed Retinue agents from the MCP session pool", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "retinue-mcp-retinue-opencode-close-pool-"));
    const fakeOpenCode = await startFakeOpenCodeServer();
    fakeOpenCode.setAutoAssistantResponses(false);
    const connection = await connectMcpClientWithRetinue(new ClaudeRetinue({ stateDir: "unused" }));
    try {
      process.env.RETINUE_STATE_DIR = tempDir;
      process.env.RETINUE_OPENCODE_BASE_URL = fakeOpenCode.url;

      const spawn = parseToolJson(
        await connection.client.callTool({
          name: "retinue_spawn_agent",
          arguments: { cwd: tempDir, message: "retinue close pool", task_name: "close-pool" }
        })
      );
      await connection.client.callTool({
        name: "retinue_close_agent",
        arguments: { jobId: spawn.jobId }
      });

      const list = parseToolJson(await connection.client.callTool({ name: "retinue_list_agents", arguments: {} }));
      expect(list).toMatchObject({ maxAgents: 3, agents: [] });
    } finally {
      delete process.env.RETINUE_STATE_DIR;
      delete process.env.RETINUE_OPENCODE_BASE_URL;
      await Promise.allSettled([closeMcpClient(connection), fakeOpenCode.close()]);
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps Retinue wait/close bound to the spawned OpenCode backend even if deployment env changes", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "retinue-mcp-retinue-opencode-bound-"));
    const fakeOpenCode = await startFakeOpenCodeServer();
    const connection = await connectMcpClientWithRetinue(new ClaudeRetinue({ stateDir: tempDir }));
    try {
      process.env.RETINUE_STATE_DIR = tempDir;
      process.env.RETINUE_OPENCODE_BASE_URL = fakeOpenCode.url;

      const spawn = parseToolJson(
        await connection.client.callTool({
          name: "retinue_spawn_agent",
          arguments: { cwd: tempDir, message: "retinue bound opencode", task_name: "bound-opencode" }
        })
      );
      expect(spawn).toMatchObject({ task_name: "bound-opencode", backend: "opencode", status: "running" });
      fakeOpenCode.completeSession(spawn.externalSessionId);

      process.env.RETINUE_BACKEND = "claude-code";

      const wait = parseToolJson(
        await connection.client.callTool({
          name: "retinue_wait_agent",
          arguments: { jobId: spawn.jobId, timeoutMs: 1000 }
        })
      );
      expect(wait).toMatchObject({
        task_name: "bound-opencode",
        jobId: spawn.jobId,
        status: "completed",
        result: { parsedStdout: { result: expect.stringContaining("retinue bound opencode") } }
      });

      const close = parseToolJson(
        await connection.client.callTool({
          name: "retinue_close_agent",
          arguments: { jobId: spawn.jobId }
        })
      );
      expect(close).toMatchObject({ jobId: spawn.jobId, status: "completed" });
    } finally {
      delete process.env.RETINUE_STATE_DIR;
      delete process.env.RETINUE_OPENCODE_BASE_URL;
      delete process.env.RETINUE_BACKEND;
      await Promise.allSettled([closeMcpClient(connection), fakeOpenCode.close()]);
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("runs the Retinue Claude Code parity flow when deployment selects claude-code", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "retinue-mcp-retinue-claude-"));
    const connection = await connectMcpClientWithRetinue(
      new ClaudeRetinue({
        stateDir: tempDir,
        claudeCommand: process.execPath,
        claudePrefixArgs: [fixturePath]
      })
    );
    try {
      process.env.RETINUE_BACKEND = "claude-code";

      const spawn = parseToolJson(
        await connection.client.callTool({
          name: "retinue_spawn_agent",
          arguments: { cwd: tempDir, message: "retinue claude", task_name: "claude-smoke" }
        })
      );
      expect(spawn).toMatchObject({ task_name: "claude-smoke", backend: "claude-code", status: "running" });
      expect(spawn).not.toHaveProperty("externalSessionId");

      const wait = parseToolJson(
        await connection.client.callTool({
          name: "retinue_wait_agent",
          arguments: { jobId: spawn.jobId, timeoutMs: 5000 }
        })
      );
      expect(wait).toMatchObject({
        task_name: "claude-smoke",
        jobId: spawn.jobId,
        status: "completed",
        result: { parsedStdout: { result: "fake result: retinue claude" } }
      });

      const close = parseToolJson(
        await connection.client.callTool({
          name: "retinue_close_agent",
          arguments: { jobId: spawn.jobId }
        })
      );
      expect(close).toMatchObject({ jobId: spawn.jobId, status: "completed" });
    } finally {
      delete process.env.RETINUE_BACKEND;
      await closeMcpClient(connection);
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps Retinue wait/close bound to the spawned Claude backend even if deployment env changes", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "retinue-mcp-retinue-claude-bound-"));
    const connection = await connectMcpClientWithRetinue(
      new ClaudeRetinue({
        stateDir: tempDir,
        claudeCommand: process.execPath,
        claudePrefixArgs: [fixturePath]
      })
    );
    try {
      process.env.RETINUE_STATE_DIR = tempDir;
      process.env.RETINUE_BACKEND = "claude-code";

      const spawn = parseToolJson(
        await connection.client.callTool({
          name: "retinue_spawn_agent",
          arguments: { cwd: tempDir, message: "retinue bound claude", task_name: "bound-claude" }
        })
      );
      expect(spawn).toMatchObject({ task_name: "bound-claude", backend: "claude-code", status: "running" });

      process.env.RETINUE_BACKEND = "opencode";

      const wait = parseToolJson(
        await connection.client.callTool({
          name: "retinue_wait_agent",
          arguments: { jobId: spawn.jobId, timeoutMs: 5000 }
        })
      );
      expect(wait).toMatchObject({
        task_name: "bound-claude",
        jobId: spawn.jobId,
        status: "completed",
        result: { parsedStdout: { result: "fake result: retinue bound claude" } }
      });

      const close = parseToolJson(
        await connection.client.callTool({
          name: "retinue_close_agent",
          arguments: { jobId: spawn.jobId }
        })
      );
      expect(close).toMatchObject({ jobId: spawn.jobId, status: "completed" });
    } finally {
      delete process.env.RETINUE_STATE_DIR;
      delete process.env.RETINUE_BACKEND;
      await closeMcpClient(connection);
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("calls OpenCode lifecycle tools through an explicit server URL", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "retinue-mcp-opencode-test-"));
    const fakeOpenCode = await startFakeOpenCodeServer();
    const connection = await connectMcpClientWithRetinue(new ClaudeRetinue({ stateDir: "unused" }));
    try {
      process.env.RETINUE_STATE_DIR = tempDir;
      const run = parseToolJson(
        await connection.client.callTool({
          name: "opencode_run",
          arguments: { cwd: tempDir, prompt: "mcp opencode", title: "mcp test", opencodeBaseUrl: fakeOpenCode.url }
        })
      );
      expect(run.backend).toBe("opencode");

      const result = parseToolJson(
        await connection.client.callTool({
          name: "opencode_result",
          arguments: { jobId: run.jobId, opencodeBaseUrl: fakeOpenCode.url }
        })
      );
      expect(result.parsedStdout.result).toBe("fake result: mcp opencode");
    } finally {
      delete process.env.RETINUE_STATE_DIR;
      await Promise.allSettled([closeMcpClient(connection), fakeOpenCode.close()]);
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps the MCP connection alive when OpenCode auto-serve cannot start", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "retinue-mcp-opencode-spawn-error-"));
    const port = await freePort();
    const connection = await connectMcpClientWithRetinue(new ClaudeRetinue({ stateDir: "unused" }));
    try {
      process.env.RETINUE_STATE_DIR = tempDir;
      process.env.RETINUE_OPENCODE_AUTO_SERVE = "1";
      process.env.RETINUE_OPENCODE_COMMAND = "retinue-missing-opencode-command";
      process.env.RETINUE_OPENCODE_PORT = String(port);

      const result = (await connection.client.callTool({
        name: "opencode_run",
        arguments: { cwd: tempDir, prompt: "trigger autoserve failure" }
      })) as { isError?: boolean; content?: Array<{ type: string; text?: string }> };
      const text = result.content?.find((item) => item.type === "text")?.text;

      expect(result.isError).toBe(true);
      expect(text).toContain('Failed to start OpenCode server command "retinue-missing-opencode-command"');
      await expect(connection.client.listTools()).resolves.toMatchObject({
        tools: expect.arrayContaining([expect.objectContaining({ name: "opencode_status" })])
      });
    } finally {
      delete process.env.RETINUE_STATE_DIR;
      delete process.env.RETINUE_OPENCODE_AUTO_SERVE;
      delete process.env.RETINUE_OPENCODE_COMMAND;
      delete process.env.RETINUE_OPENCODE_PORT;
      await closeMcpClient(connection);
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("uses OpenCode model and agent defaults from environment for MCP runs", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "retinue-mcp-opencode-defaults-"));
    const fakeOpenCode = await startFakeOpenCodeServer();
    const connection = await connectMcpClientWithRetinue(new ClaudeRetinue({ stateDir: "unused" }));
    try {
      process.env.RETINUE_STATE_DIR = tempDir;
      process.env.RETINUE_OPENCODE_MODEL = "litellm/pro-router";
      process.env.RETINUE_OPENCODE_AGENT = "build";
      parseToolJson(
        await connection.client.callTool({
          name: "opencode_run",
          arguments: { cwd: tempDir, prompt: "mcp env defaults", opencodeBaseUrl: fakeOpenCode.url }
        })
      );
      expect(fakeOpenCode.promptRequests[0]).toMatchObject({
        agent: "build",
        model: { providerID: "litellm", modelID: "pro-router" }
      });
    } finally {
      delete process.env.RETINUE_STATE_DIR;
      delete process.env.RETINUE_OPENCODE_MODEL;
      delete process.env.RETINUE_OPENCODE_AGENT;
      await Promise.allSettled([closeMcpClient(connection), fakeOpenCode.close()]);
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("uses Retinue JSON config for OpenCode agent defaults and session slots", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "retinue-mcp-json-config-"));
    const configPath = path.join(tempDir, "retinue.config.json");
    const fakeOpenCode = await startFakeOpenCodeServer();
    fakeOpenCode.setAutoAssistantResponses(false);
    const connection = await connectMcpClientWithRetinue(new ClaudeRetinue({ stateDir: "unused" }));
    try {
      await fs.writeFile(configPath, JSON.stringify({ maxConcurrentAgents: 2, opencode: { agent: "explore" } }), "utf8");
      process.env.RETINUE_STATE_DIR = tempDir;
      process.env.RETINUE_OPENCODE_BASE_URL = fakeOpenCode.url;
      process.env.RETINUE_CONFIG_FILE = configPath;

      const first = parseToolJson(
        await connection.client.callTool({
          name: "retinue_spawn_agent",
          arguments: { cwd: tempDir, message: "configured first", task_name: "configured-first" }
        })
      );
      const second = parseToolJson(
        await connection.client.callTool({
          name: "retinue_spawn_agent",
          arguments: { cwd: tempDir, message: "configured second", task_name: "configured-second" }
        })
      );
      const third = parseToolJson(
        await connection.client.callTool({
          name: "retinue_spawn_agent",
          arguments: { cwd: tempDir, message: "configured third", task_name: "configured-third" }
        })
      );

      expect(first).toMatchObject({ status: "running" });
      expect(second).toMatchObject({ status: "running" });
      expect(third).toMatchObject({ status: "running", evictedJobId: first.jobId });
      expect(fakeOpenCode.promptRequests.at(0)).toMatchObject({ agent: "explore" });

      const list = parseToolJson(await connection.client.callTool({ name: "retinue_list_agents", arguments: {} }));
      expect(list).toMatchObject({ maxAgents: 2 });
      expect(list.agents).toHaveLength(2);
    } finally {
      delete process.env.RETINUE_STATE_DIR;
      delete process.env.RETINUE_OPENCODE_BASE_URL;
      delete process.env.RETINUE_CONFIG_FILE;
      await Promise.allSettled([closeMcpClient(connection), fakeOpenCode.close()]);
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("uses OpenCode model and agent defaults from environment for Retinue OpenCode runs", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "retinue-mcp-retinue-opencode-defaults-"));
    const fakeOpenCode = await startFakeOpenCodeServer();
    const connection = await connectMcpClientWithRetinue(new ClaudeRetinue({ stateDir: "unused" }));
    try {
      process.env.RETINUE_STATE_DIR = tempDir;
      process.env.RETINUE_OPENCODE_BASE_URL = fakeOpenCode.url;
      process.env.RETINUE_OPENCODE_MODEL = "litellm/pro-router";
      process.env.RETINUE_OPENCODE_AGENT = "explore";
      parseToolJson(
        await connection.client.callTool({
          name: "retinue_spawn_agent",
          arguments: { cwd: tempDir, message: "retinue env defaults", task_name: "env-defaults" }
        })
      );
      expect(fakeOpenCode.promptRequests[0]).toMatchObject({
        agent: "explore",
        model: { providerID: "litellm", modelID: "pro-router" }
      });
    } finally {
      delete process.env.RETINUE_STATE_DIR;
      delete process.env.RETINUE_OPENCODE_BASE_URL;
      delete process.env.RETINUE_OPENCODE_MODEL;
      delete process.env.RETINUE_OPENCODE_AGENT;
      await Promise.allSettled([closeMcpClient(connection), fakeOpenCode.close()]);
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("throws a controlled error for invalid daemon discovery URL configuration", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "retinue-mcp-bad-discovery-"));
    try {
      await writeDaemonDiscovery(tempDir, {
        url: "not-a-url",
        pid: process.pid,
        startedAt: "2026-05-04T00:00:00.000Z",
        version: "0.1.0"
      });

      expect(() =>
        createMcpRetinueFromEnv({
          RETINUE_STATE_DIR: tempDir,
          RETINUE_DAEMON_DISCOVERY: "1"
        })
      ).toThrowError("Invalid daemon discovery: invalid url");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});

function parseToolJson(result: unknown): any {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content;
  const text = content?.find((item) => item.type === "text")?.text;
  if (!text) {
    throw new Error("Tool result did not include text content");
  }
  return JSON.parse(text);
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function connectMcpClient(daemonUrl: string) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "retinue-test-client", version: "0.1.0" });
  const mcpServer = createMcpServer(
    createMcpRetinueFromEnv({
      RETINUE_DAEMON_URL: daemonUrl
    }),
    { exposeBackendTools: true }
  );
  await Promise.all([mcpServer.connect(serverTransport), client.connect(clientTransport)]);
  return { client, clientTransport, serverTransport };
}

async function connectMcpClientWithRetinue(
  retinue: ClaudeRetinue,
  options: boolean | { exposeBackendTools?: boolean; exposeDiagnosticTools?: boolean } = true
) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "retinue-test-client", version: "0.1.0" });
  const mcpOptions = typeof options === "boolean" ? { exposeBackendTools: options } : options;
  const mcpServer = createMcpServer(retinue, mcpOptions);
  await Promise.all([mcpServer.connect(serverTransport), client.connect(clientTransport)]);
  return { client, clientTransport, serverTransport };
}

async function closeMcpClient(connection: Awaited<ReturnType<typeof connectMcpClient>>): Promise<void> {
  await Promise.allSettled([connection.client.close(), connection.clientTransport.close(), connection.serverTransport.close()]);
}

async function expectMcpInvalidParams(call: Promise<unknown>): Promise<void> {
  const result = (await call) as { isError?: boolean; content?: Array<{ type: string; text?: string }> };
  expect(result.isError).toBe(true);
  const text = result.content?.find((item) => item.type === "text")?.text;
  expect(text).toContain("MCP error -32602");
  expect(text).toContain("Input validation error");
}

function assertRequiredFields(
  tools: Array<{ name: string; inputSchema?: { properties?: Record<string, unknown>; required?: string[] } }>,
  toolName: string,
  requiredFields: string[]
): void {
  const schema = getToolSchema(tools, toolName);
  expect(Object.keys(schema.properties ?? {})).toEqual(expect.arrayContaining(requiredFields));
  expect(schema.required ?? []).toEqual(expect.arrayContaining(requiredFields));
}

function assertOptionalField(
  tools: Array<{ name: string; inputSchema?: { properties?: Record<string, unknown>; required?: string[] } }>,
  toolName: string,
  optionalField: string
): void {
  const schema = getToolSchema(tools, toolName);
  expect(Object.keys(schema.properties ?? {})).toContain(optionalField);
  expect(schema.required ?? []).not.toContain(optionalField);
}

function assertAbsentFields(
  tools: Array<{ name: string; inputSchema?: { properties?: Record<string, unknown>; required?: string[] } }>,
  toolName: string,
  absentFields: string[]
): void {
  const schema = getToolSchema(tools, toolName);
  for (const field of absentFields) {
    expect(Object.keys(schema.properties ?? {}), `${toolName} must not expose ${field}`).not.toContain(field);
    expect(schema.required ?? [], `${toolName} must not require ${field}`).not.toContain(field);
  }
}

function extractOpenCodePromptText(request: Record<string, unknown> | undefined): string {
  const parts = Array.isArray(request?.parts) ? request.parts : [];
  const first = parts[0];
  if (typeof first === "object" && first !== null && "text" in first) {
    return String((first as { text?: unknown }).text ?? "");
  }
  return "";
}

function extractOpenCodeSubtaskPart(request: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  const parts = Array.isArray(request?.parts) ? request.parts : [];
  return parts.find((part): part is Record<string, unknown> => typeof part === "object" && part !== null && part.type === "subtask");
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

function expectTaskCompatibleChildPermission(request: Record<string, unknown> | undefined): void {
  expect(request).toMatchObject({
    permission: expect.arrayContaining([
      { permission: "edit", pattern: "blocked-by-plan", action: "deny" },
      { permission: "todowrite", pattern: "*", action: "deny" },
      { permission: "task", pattern: "*", action: "deny" }
    ])
  });
}

function getToolSchema(
  tools: Array<{ name: string; inputSchema?: { properties?: Record<string, unknown>; required?: string[] } }>,
  toolName: string
): { properties?: Record<string, unknown>; required?: string[] } {
  const tool = tools.find((entry) => entry.name === toolName);
  expect(tool, `Tool ${toolName} should be registered`).toBeTruthy();
  expect(tool?.inputSchema, `Tool ${toolName} should expose an input schema`).toBeTruthy();
  return tool!.inputSchema!;
}

async function freePort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return address.port;
}
