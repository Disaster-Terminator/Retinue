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
import type { CreateMcpServerOptions } from "../src/mcp.js";
import { ClaudeRetinue } from "../src/core/retinue.js";
import { startFakeOpenCodeServer } from "./fixtures/fake-opencode-server.js";

const fixturePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures/fake-claude.mjs");
const daemonToken = "mcp-daemon-test-token";

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
      "spawn_agent",
      "wait_agent",
      "close_agent",
      "list_agents",
      "list_permissions",
      "reply_permission",
      "stop_runtime",
      "restart_runtime"
    ]);
  });

  it("declares Retinue diagnostic tools separately from the default product tools", () => {
    expect(RETINUE_DIAGNOSTIC_TOOL_NAMES).toEqual(["audit_logs"]);
    expect(RETINUE_TOOL_NAMES).not.toContain("audit_logs");
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
      }),
      { authToken: daemonToken }
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "retinue-test-client", version: "0.1.0" });

    try {
      await new Promise<void>((resolve) => daemon.listen(0, "127.0.0.1", resolve));
      const address = daemon.address() as AddressInfo;
      const mcpServer = createMcpServer(
        createMcpRetinueFromEnv({
          RETINUE_DAEMON_URL: `http://127.0.0.1:${address.port}`,
          RETINUE_DAEMON_TOKEN: daemonToken
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
      }),
      { authToken: daemonToken }
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
      assertRequiredFields(tools.tools, "spawn_agent", ["message"]);
      assertOptionalField(tools.tools, "spawn_agent", "task_name");
      assertOptionalField(tools.tools, "spawn_agent", "cwd");
      assertOptionalField(tools.tools, "spawn_agent", "agent");
      expect(getToolDescription(tools.tools, "spawn_agent")).toContain("not a Retinue backend name like opencode");
      assertAbsentFields(tools.tools, "spawn_agent", [
        "backend",
        "profile",
        "model",
        "permissionMode",
        "opencodeBaseUrl",
        "access_mode",
        "bash_policy"
      ]);
      assertRequiredFields(tools.tools, "wait_agent", ["jobId"]);
      assertAbsentFields(tools.tools, "wait_agent", ["backend", "profile", "model", "agent", "permissionMode", "opencodeBaseUrl"]);
      assertRequiredFields(tools.tools, "close_agent", ["jobId"]);
      assertAbsentFields(tools.tools, "close_agent", ["backend", "profile", "model", "agent", "permissionMode", "opencodeBaseUrl"]);
      assertAbsentFields(tools.tools, "list_agents", ["backend", "profile", "model", "agent", "permissionMode", "opencodeBaseUrl"]);
      assertOptionalField(tools.tools, "list_permissions", "jobId");
      assertAbsentFields(tools.tools, "list_permissions", ["backend", "profile", "model", "agent", "permissionMode", "opencodeBaseUrl"]);
      assertRequiredFields(tools.tools, "reply_permission", ["jobId", "requestId", "reply"]);
      assertOptionalField(tools.tools, "reply_permission", "message");
      assertAbsentFields(tools.tools, "reply_permission", ["backend", "profile", "model", "agent", "permissionMode", "opencodeBaseUrl"]);
      assertOptionalField(tools.tools, "stop_runtime", "runtime");
      assertOptionalField(tools.tools, "stop_runtime", "cwd");
      assertOptionalField(tools.tools, "stop_runtime", "all");
      assertOptionalField(tools.tools, "stop_runtime", "force");
      assertAbsentFields(tools.tools, "stop_runtime", ["backend", "profile", "model", "agent", "permissionMode", "opencodeBaseUrl"]);
      assertOptionalField(tools.tools, "restart_runtime", "runtime");
      assertRequiredFields(tools.tools, "restart_runtime", ["cwd"]);
      assertOptionalField(tools.tools, "restart_runtime", "force");
      assertAbsentFields(tools.tools, "restart_runtime", ["backend", "profile", "model", "agent", "permissionMode", "opencodeBaseUrl"]);
      expect(getToolDescription(tools.tools, "list_permissions")).toContain("backend permission requests");
      expect(getToolDescription(tools.tools, "list_permissions")).not.toContain("OpenCode permission requests");
      expect(getToolDescription(tools.tools, "reply_permission")).toContain("backend permission request");
      expect(getToolDescription(tools.tools, "reply_permission")).not.toContain("OpenCode permission request");
    } finally {
      await closeMcpClient(connection);
    }
  });

  it("enforces Retinue runtime lifecycle ownership boundaries", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "retinue-mcp-runtime-lifecycle-"));
    const previousStateDir = process.env.RETINUE_STATE_DIR;
    const previousBaseUrl = process.env.RETINUE_OPENCODE_BASE_URL;
    process.env.RETINUE_STATE_DIR = tempDir;
    process.env.RETINUE_OPENCODE_BASE_URL = "http://127.0.0.1:65535";
    const connection = await connectMcpClientWithRetinue(new ClaudeRetinue({ stateDir: "unused" }), false);
    try {
      await expect(
        connection.client
          .callTool({
            name: "stop_runtime",
            arguments: {}
          })
          .then(parseToolJson)
      ).resolves.toMatchObject({
        status: "invalid_request",
        error: "stop_runtime requires cwd or all=true"
      });
      await expect(
        connection.client
          .callTool({
            name: "restart_runtime",
            arguments: { cwd: tempDir }
          })
          .then(parseToolJson)
      ).resolves.toMatchObject({
        backend: "opencode",
        status: "not_managed"
      });
    } finally {
      await closeMcpClient(connection);
      if (previousStateDir === undefined) {
        delete process.env.RETINUE_STATE_DIR;
      } else {
        process.env.RETINUE_STATE_DIR = previousStateDir;
      }
      if (previousBaseUrl === undefined) {
        delete process.env.RETINUE_OPENCODE_BASE_URL;
      } else {
        process.env.RETINUE_OPENCODE_BASE_URL = previousBaseUrl;
      }
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("publishes concrete input schemas for diagnostic tools only when enabled", async () => {
    const connection = await connectMcpClientWithRetinue(new ClaudeRetinue({ stateDir: "unused" }), {
      exposeBackendTools: false,
      exposeDiagnosticTools: true
    });
    try {
      const tools = await connection.client.listTools();
      assertOptionalField(tools.tools, "audit_logs", "since");
      assertOptionalField(tools.tools, "audit_logs", "maxLines");
      assertOptionalField(tools.tools, "audit_logs", "maxBytes");
      assertOptionalField(tools.tools, "audit_logs", "stateDir");
      assertOptionalField(tools.tools, "audit_logs", "tracePath");
      assertOptionalField(tools.tools, "audit_logs", "compact");
      assertAbsentFields(tools.tools, "audit_logs", ["backend", "profile", "model", "agent", "permissionMode", "opencodeBaseUrl"]);
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
      const compactAudit = parseToolJson(
        await connection.client.callTool({
          name: "audit_logs",
          arguments: { tracePath, since: "2026-05-22T08:00:00.000Z" }
        })
      );
      expect(compactAudit).toMatchObject({
        format: "compact",
        issueCount: 1,
        ignoredCompletedJobIds: ["job_completed_later"]
      });
      expect(compactAudit.text).toContain("Retinue log audit: issues=1 attention=0 scanned=2 ignoredCompleted=1");
      expect(compactAudit.text).toContain("#1 count=1 jobs=job_malformed");
      expect(compactAudit.issues).toBeUndefined();

      const audit = parseToolJson(
        await connection.client.callTool({
          name: "audit_logs",
          arguments: { tracePath, since: "2026-05-22T08:00:00.000Z", compact: false }
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
          name: "spawn_agent",
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
        externalRunnerMode: "shared-root",
        externalRootSessionId: expect.stringMatching(/^ses_/),
        externalParentSessionId: expect.stringMatching(/^ses_/),
        externalSessionDirectory: process.cwd()
      });
      expect(spawn).not.toHaveProperty("externalRootAgent");
      expect(fakeOpenCode.promptRequests.at(-1)).toMatchObject({ agent: "explore" });
      expect(fakeOpenCode.promptRequests.at(-1)).not.toHaveProperty("tools");
      const submittedPrompt = extractOpenCodePromptText(fakeOpenCode.promptRequests.at(-1));
      expect(submittedPrompt).toBe("retinue mcp");
      expectTaskCompatibleChildPermission(fakeOpenCode.sessionRequests.at(-1));
      const runningWait = parseToolJson(
        await connection.client.callTool({
          name: "wait_agent",
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
          name: "wait_agent",
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
          name: "close_agent",
          arguments: { jobId: spawn.jobId }
        })
      );
      expect(close).toMatchObject({ jobId: spawn.jobId, status: "completed" });
    } finally {
      delete process.env.RETINUE_STATE_DIR;
      delete process.env.RETINUE_OPENCODE_BASE_URL;
      await Promise.allSettled([closeMcpClient(connection), fakeOpenCode.close()]);
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("closes stalled OpenCode jobs so unresolved sessions do not pin managed servers", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "retinue-mcp-close-stalled-opencode-"));
    const fakeOpenCode = await startFakeOpenCodeServer();
    fakeOpenCode.setAutoAssistantResponses(false);
    const connection = await connectMcpClientWithRetinue(new ClaudeRetinue({ stateDir: "unused" }));
    try {
      process.env.RETINUE_STATE_DIR = tempDir;
      process.env.RETINUE_OPENCODE_BASE_URL = fakeOpenCode.url;
      process.env.RETINUE_OPENCODE_STALL_READ_TOOL_MS = "1";

      const spawn = parseToolJson(
        await connection.client.callTool({
          name: "spawn_agent",
          arguments: { cwd: tempDir, message: "read then stall", task_name: "close-stalled" }
        })
      );
      fakeOpenCode.appendPendingReadToolAssistant(spawn.externalSessionId);

      await expect(
        connection.client
          .callTool({ name: "wait_agent", arguments: { jobId: spawn.jobId, timeoutMs: 1000 } })
          .then(parseToolJson)
      ).resolves.toMatchObject({ jobId: spawn.jobId, status: "stalled" });

      await expect(
        connection.client.callTool({ name: "close_agent", arguments: { jobId: spawn.jobId } }).then(parseToolJson)
      ).resolves.toMatchObject({ jobId: spawn.jobId, status: "killed" });
      await expect(fs.readFile(path.join(tempDir, "jobs", spawn.jobId, "meta.json"), "utf8").then(JSON.parse)).resolves.toMatchObject({
        status: "killed"
      });
    } finally {
      delete process.env.RETINUE_STATE_DIR;
      delete process.env.RETINUE_OPENCODE_BASE_URL;
      delete process.env.RETINUE_OPENCODE_STALL_READ_TOOL_MS;
      await Promise.allSettled([closeMcpClient(connection), fakeOpenCode.close()]);
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("closes OpenCode jobs whose server became unreachable", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "retinue-mcp-close-unreachable-opencode-"));
    const fakeOpenCode = await startFakeOpenCodeServer();
    fakeOpenCode.setAutoAssistantResponses(false);
    const connection = await connectMcpClientWithRetinue(new ClaudeRetinue({ stateDir: "unused" }));
    try {
      process.env.RETINUE_STATE_DIR = tempDir;
      process.env.RETINUE_OPENCODE_BASE_URL = fakeOpenCode.url;

      const spawn = parseToolJson(
        await connection.client.callTool({
          name: "spawn_agent",
          arguments: { cwd: tempDir, message: "server disappears", task_name: "close-unreachable" }
        })
      );
      await fakeOpenCode.close();

      await expect(
        connection.client.callTool({ name: "close_agent", arguments: { jobId: spawn.jobId } }).then(parseToolJson)
      ).resolves.toMatchObject({ jobId: spawn.jobId, status: "killed" });
      await expect(fs.readFile(path.join(tempDir, "jobs", spawn.jobId, "meta.json"), "utf8").then(JSON.parse)).resolves.toMatchObject({
        status: "killed"
      });
      await expect(fs.readFile(path.join(tempDir, "logs", "retinue.jsonl"), "utf8")).resolves.toContain(
        '"event":"opencode_job_backend_unreachable"'
      );
    } finally {
      delete process.env.RETINUE_STATE_DIR;
      delete process.env.RETINUE_OPENCODE_BASE_URL;
      await Promise.allSettled([closeMcpClient(connection), fakeOpenCode.close()]);
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("clarifies OpenCode patch parts without write intent in agent-facing diagnostics", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "retinue-mcp-opencode-patch-summary-"));
    const fakeOpenCode = await startFakeOpenCodeServer();
    fakeOpenCode.setAutoAssistantResponses(false);
    const connection = await connectMcpClientWithRetinue(new ClaudeRetinue({ stateDir: "unused" }));
    try {
      process.env.RETINUE_STATE_DIR = tempDir;
      process.env.RETINUE_OPENCODE_BASE_URL = fakeOpenCode.url;

      const spawn = parseToolJson(
        await connection.client.callTool({
          name: "spawn_agent",
          arguments: { cwd: tempDir, message: "read-only review", task_name: "patch-summary" }
        })
      );
      fakeOpenCode.appendPatchAssistant(spawn.externalSessionId, "review text");
      fakeOpenCode.completeSessionWithFinalText(spawn.externalSessionId, "final review");

      const wait = parseToolJson(
        await connection.client.callTool({
          name: "wait_agent",
          arguments: { jobId: spawn.jobId, timeoutMs: 1000 }
        })
      );

      expect(wait).toMatchObject({
        task_name: "patch-summary",
        jobId: spawn.jobId,
        status: "completed",
        diagnostic: {
          event: "opencode_job_result_read",
          status: "completed",
          patchPartSummary: expect.stringContaining("OpenCode patch part")
        }
      });
      expect(wait.diagnostic).not.toHaveProperty("patchPartCount");
      expect(wait.diagnostic.message).toContain("OpenCode job result was read successfully");
      expect(wait.diagnostic.message).toContain("OpenCode patch part");
    } finally {
      delete process.env.RETINUE_STATE_DIR;
      delete process.env.RETINUE_OPENCODE_BASE_URL;
      await Promise.allSettled([closeMcpClient(connection), fakeOpenCode.close()]);
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("scopes shared OpenCode roots to one MCP server session", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "retinue-mcp-shared-root-"));
    const fakeOpenCode = await startFakeOpenCodeServer();
    const firstConnection = await connectMcpClientWithRetinue(new ClaudeRetinue({ stateDir: "unused" }));
    const secondConnection = await connectMcpClientWithRetinue(new ClaudeRetinue({ stateDir: "unused" }));
    const previousRootBindingMode = process.env.RETINUE_OPENCODE_ROOT_BINDING_MODE;
    try {
      process.env.RETINUE_STATE_DIR = tempDir;
      process.env.RETINUE_OPENCODE_BASE_URL = fakeOpenCode.url;
      delete process.env.RETINUE_OPENCODE_ROOT_BINDING_MODE;

      const first = parseToolJson(
        await firstConnection.client.callTool({
          name: "spawn_agent",
          arguments: { cwd: tempDir, message: "shared root one", task_name: "shared-one", agent: "explore" }
        })
      );
      const second = parseToolJson(
        await firstConnection.client.callTool({
          name: "spawn_agent",
          arguments: { cwd: tempDir, message: "shared root two", task_name: "shared-two", agent: "explore" }
        })
      );
      const third = parseToolJson(
        await secondConnection.client.callTool({
          name: "spawn_agent",
          arguments: { cwd: tempDir, message: "shared root other mcp", task_name: "shared-other-mcp", agent: "explore" }
        })
      );
      const fourth = parseToolJson(
        await secondConnection.client.callTool({
          name: "spawn_agent",
          arguments: { cwd: tempDir, message: "shared root other mcp second child", task_name: "shared-other-mcp-two", agent: "explore" }
        })
      );

      expect(first.externalRunnerMode).toBe("shared-root");
      expect(second.externalRunnerMode).toBe("shared-root");
      expect(third.externalRunnerMode).toBe("shared-root");
      expect(fourth.externalRunnerMode).toBe("shared-root");
      expect(second.externalRootSessionId).toBe(first.externalRootSessionId);
      expect(third.externalRootSessionId).not.toBe(first.externalRootSessionId);
      expect(fourth.externalRootSessionId).toBe(third.externalRootSessionId);
      expect(fourth.externalSessionId).not.toBe(third.externalSessionId);
      expect(fakeOpenCode.sessionRequests).toEqual([
        expect.objectContaining({ title: "retinue-shared-root" }),
        expect.objectContaining({ parentID: first.externalRootSessionId, agent: "explore" }),
        expect.objectContaining({ parentID: first.externalRootSessionId, agent: "explore" }),
        expect.objectContaining({ title: "retinue-shared-root" }),
        expect.objectContaining({ parentID: third.externalRootSessionId, agent: "explore" }),
        expect.objectContaining({ parentID: third.externalRootSessionId, agent: "explore" })
      ]);
      expect(fakeOpenCode.sessionRequests[0]).not.toHaveProperty("agent");
      expect(fakeOpenCode.sessionRequests[3]).not.toHaveProperty("agent");
    } finally {
      delete process.env.RETINUE_STATE_DIR;
      delete process.env.RETINUE_OPENCODE_BASE_URL;
      restoreEnv("RETINUE_OPENCODE_ROOT_BINDING_MODE", previousRootBindingMode);
      await Promise.allSettled([closeMcpClient(firstConnection), closeMcpClient(secondConnection), fakeOpenCode.close()]);
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
          name: "spawn_agent",
          arguments: { cwd: tempDir, message: "retinue malformed read retry", task_name: "attempt-smoke", agent: "explore" }
        })
      );
      fakeOpenCode.appendMalformedReadToolAssistant(spawn.externalSessionId);
      fakeOpenCode.setAutoAssistantResponses(true);

      const wait = parseToolJson(
        await connection.client.callTool({
          name: "wait_agent",
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
          name: "wait_agent",
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

  it("does not expose a stale selected attempt when the root job completes late", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "retinue-mcp-retinue-opencode-late-root-"));
    const fakeOpenCode = await startFakeOpenCodeServer();
    const connection = await connectMcpClientWithRetinue(new ClaudeRetinue({ stateDir: "unused" }));
    const previousEnv = {
      RETINUE_STATE_DIR: process.env.RETINUE_STATE_DIR,
      RETINUE_OPENCODE_BASE_URL: process.env.RETINUE_OPENCODE_BASE_URL,
      RETINUE_MCP_WAIT_MAX_MS: process.env.RETINUE_MCP_WAIT_MAX_MS,
      RETINUE_OPENCODE_STALL_ZERO_PROGRESS_ASSISTANT_MS: process.env.RETINUE_OPENCODE_STALL_ZERO_PROGRESS_ASSISTANT_MS,
      RETINUE_OPENCODE_STALL_FINALIZATION_AFTER_TOOL_PROGRESS_MS:
        process.env.RETINUE_OPENCODE_STALL_FINALIZATION_AFTER_TOOL_PROGRESS_MS
    };
    try {
      process.env.RETINUE_STATE_DIR = tempDir;
      process.env.RETINUE_OPENCODE_BASE_URL = fakeOpenCode.url;
      process.env.RETINUE_MCP_WAIT_MAX_MS = "5000";
      process.env.RETINUE_OPENCODE_STALL_ZERO_PROGRESS_ASSISTANT_MS = "1";
      process.env.RETINUE_OPENCODE_STALL_FINALIZATION_AFTER_TOOL_PROGRESS_MS = "1";
      fakeOpenCode.setAutoAssistantResponses(false);

      const spawn = parseToolJson(
        await connection.client.callTool({
          name: "spawn_agent",
          arguments: { cwd: tempDir, message: "retinue root completes after retry selection", task_name: "late-root", agent: "explore" }
        })
      );
      fakeOpenCode.appendToolCallAssistant(spawn.externalSessionId, "checking source");
      fakeOpenCode.appendZeroProgressReasoningAssistant(spawn.externalSessionId);

      await expect(
        connection.client.callTool({ name: "wait_agent", arguments: { jobId: spawn.jobId, timeoutMs: 100 } })
      ).resolves.toBeDefined();

      const selected = parseToolJson(
        await connection.client.callTool({ name: "wait_agent", arguments: { jobId: spawn.jobId, timeoutMs: 200 } })
      );
      expect(selected).toMatchObject({
        requestedJobId: spawn.jobId,
        selectedAttemptJobId: expect.stringMatching(/^job_/)
      });
      expect(selected.jobId).not.toBe(spawn.jobId);

      fakeOpenCode.completeSessionWithFinalText(spawn.externalSessionId, "late root review");

      const completed = parseToolJson(
        await connection.client.callTool({ name: "wait_agent", arguments: { jobId: spawn.jobId, timeoutMs: 1000 } })
      );
      expect(completed).toMatchObject({
        task_name: "late-root",
        jobId: spawn.jobId,
        status: "completed",
        result: {
          status: "completed",
          parsedStdout: { result: "late root review" }
        },
        attemptChain: [
          expect.objectContaining({ jobId: spawn.jobId, status: "completed", selected: true }),
          expect.objectContaining({ jobId: selected.selectedAttemptJobId, attempt: 1, selected: false })
        ]
      });
      expect(completed.selectedAttemptJobId).toBeUndefined();
    } finally {
      restoreEnv("RETINUE_STATE_DIR", previousEnv.RETINUE_STATE_DIR);
      restoreEnv("RETINUE_OPENCODE_BASE_URL", previousEnv.RETINUE_OPENCODE_BASE_URL);
      restoreEnv("RETINUE_MCP_WAIT_MAX_MS", previousEnv.RETINUE_MCP_WAIT_MAX_MS);
      restoreEnv("RETINUE_OPENCODE_STALL_ZERO_PROGRESS_ASSISTANT_MS", previousEnv.RETINUE_OPENCODE_STALL_ZERO_PROGRESS_ASSISTANT_MS);
      restoreEnv(
        "RETINUE_OPENCODE_STALL_FINALIZATION_AFTER_TOOL_PROGRESS_MS",
        previousEnv.RETINUE_OPENCODE_STALL_FINALIZATION_AFTER_TOOL_PROGRESS_MS
      );
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
        name: "spawn_agent",
        arguments: { cwd: tempDir, message: "inspect with native explore profile", task_name: "explore-policy", agent: "explore" }
      });

      expect(fakeOpenCode.promptRequests.at(-1)).toMatchObject({ agent: "explore" });
      expect(extractOpenCodePromptText(fakeOpenCode.promptRequests.at(-1))).toBe("inspect with native explore profile");
      expect(fakeOpenCode.promptRequests.at(-1)).not.toHaveProperty("tools");
      expectTaskCompatibleChildPermission(fakeOpenCode.sessionRequests.at(-1));

      await connection.client.callTool({
        name: "spawn_agent",
        arguments: { cwd: tempDir, message: "write the implementation plan", task_name: "plan-policy", agent: "plan" }
      });

      expect(fakeOpenCode.promptRequests.at(-1)).toMatchObject({ agent: "plan" });
      expect(extractOpenCodePromptText(fakeOpenCode.promptRequests.at(-1))).toBe("write the implementation plan");
      expect(fakeOpenCode.promptRequests.at(-1)).not.toHaveProperty("tools");
      expectTaskCompatibleChildPermission(fakeOpenCode.sessionRequests.at(-1));

      await connection.client.callTool({
        name: "spawn_agent",
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
          name: "spawn_agent",
          arguments: { cwd: tempDir, message: "retinue still running", task_name: "running-opencode" }
        })
      );

      const wait = parseToolJson(
        await connection.client.callTool({
          name: "wait_agent",
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
        lastMessagePartTypes: ["text"]
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

  it("surfaces OpenCode zero-progress stalls when fresh attempts are disabled", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "retinue-mcp-retinue-opencode-stalled-"));
    const fakeOpenCode = await startFakeOpenCodeServer();
    fakeOpenCode.setAutoAssistantResponses(false);
    const connection = await connectMcpClientWithRetinue(new ClaudeRetinue({ stateDir: "unused" }));
    try {
      process.env.RETINUE_STATE_DIR = tempDir;
      process.env.RETINUE_OPENCODE_BASE_URL = fakeOpenCode.url;
      process.env.RETINUE_OPENCODE_STALL_ZERO_PROGRESS_ASSISTANT_MS = "1";
      process.env.RETINUE_OPENCODE_STALL_FINALIZATION_AFTER_TOOL_PROGRESS_MS = "1";
      process.env.RETINUE_OPENCODE_TASK_ATTEMPT_MAX = "0";

      const spawn = parseToolJson(
        await connection.client.callTool({
          name: "spawn_agent",
          arguments: { cwd: tempDir, message: "risk review stalls after tools", task_name: "stalled-opencode" }
        })
      );
      fakeOpenCode.appendToolCallAssistant(spawn.externalSessionId, "checking source one");
      fakeOpenCode.appendToolCallAssistant(spawn.externalSessionId, "checking source two");
      fakeOpenCode.appendZeroProgressReasoningAssistant(spawn.externalSessionId);

      const wait = parseToolJson(
        await connection.client.callTool({
          name: "wait_agent",
          arguments: { jobId: spawn.jobId, timeoutMs: 100 }
        })
      );

      expect(wait).toMatchObject({
        task_name: "stalled-opencode",
        jobId: spawn.jobId,
        status: "stalled",
        diagnostic: {
          event: "opencode_job_result_read",
          stallReason: "provider_zero_progress",
          zeroProgressAssistantRounds: 1,
          lastAssistantProviderID: "litellm",
          lastAssistantModelID: "semantic-router"
        }
      });
      expect(wait.diagnostic.message).toContain("final assistant output made no visible progress");
      const list = parseToolJson(await connection.client.callTool({ name: "list_agents", arguments: {} }));
      expect(list.agents).toEqual([]);
    } finally {
      delete process.env.RETINUE_STATE_DIR;
      delete process.env.RETINUE_OPENCODE_BASE_URL;
      delete process.env.RETINUE_OPENCODE_STALL_ZERO_PROGRESS_ASSISTANT_MS;
      delete process.env.RETINUE_OPENCODE_STALL_FINALIZATION_AFTER_TOOL_PROGRESS_MS;
      delete process.env.RETINUE_OPENCODE_TASK_ATTEMPT_MAX;
      await Promise.allSettled([closeMcpClient(connection), fakeOpenCode.close()]);
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("returns structured OpenCode stall diagnostics when recovery is disabled", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "retinue-mcp-retinue-opencode-stalled-"));
    const fakeOpenCode = await startFakeOpenCodeServer();
    fakeOpenCode.setAutoAssistantResponses(false);
    const connection = await connectMcpClientWithRetinue(new ClaudeRetinue({ stateDir: "unused" }));
    try {
      process.env.RETINUE_STATE_DIR = tempDir;
      process.env.RETINUE_OPENCODE_BASE_URL = fakeOpenCode.url;
      process.env.RETINUE_OPENCODE_STALL_ZERO_PROGRESS_ASSISTANT_MS = "1";
      process.env.RETINUE_OPENCODE_STALL_FINALIZATION_AFTER_TOOL_PROGRESS_MS = "1";
      process.env.RETINUE_OPENCODE_TASK_ATTEMPT_MAX = "0";

      const spawn = parseToolJson(
        await connection.client.callTool({
          name: "spawn_agent",
          arguments: { cwd: tempDir, message: "risk review stalls after tools", task_name: "stalled-opencode" }
        })
      );
      fakeOpenCode.appendToolCallAssistant(spawn.externalSessionId, "checking source one");
      fakeOpenCode.appendToolCallAssistant(spawn.externalSessionId, "checking source two");
      fakeOpenCode.appendZeroProgressReasoningAssistant(spawn.externalSessionId);

      const wait = parseToolJson(
        await connection.client.callTool({
          name: "wait_agent",
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
      expect(wait.diagnostic.message).toContain("final assistant output made no visible progress");
    } finally {
      delete process.env.RETINUE_STATE_DIR;
      delete process.env.RETINUE_OPENCODE_BASE_URL;
      delete process.env.RETINUE_OPENCODE_STALL_ZERO_PROGRESS_ASSISTANT_MS;
      delete process.env.RETINUE_OPENCODE_STALL_FINALIZATION_AFTER_TOOL_PROGRESS_MS;
      delete process.env.RETINUE_OPENCODE_TASK_ATTEMPT_MAX;
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
          name: "spawn_agent",
          arguments: { cwd: tempDir, message: "risk review leaves a read pending", task_name: "read-stalled-opencode" }
        })
      );
      fakeOpenCode.appendPendingReadToolAssistant(spawn.externalSessionId);

      const wait = parseToolJson(
        await connection.client.callTool({
          name: "wait_agent",
          arguments: { jobId: spawn.jobId, timeoutMs: 5000 }
        })
      );

      expect(wait).toMatchObject({
        task_name: "read-stalled-opencode",
        jobId: spawn.jobId,
        status: "stalled",
        result: {
          status: "stalled",
          stdout: expect.stringContaining("input={\"filePath\":\"docs/how-to/verify.md\"}")
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
      expect(wait.diagnostic.message).toContain('input={"filePath":"docs/how-to/verify.md"}');
      expect(wait.diagnostic.runningReadToolPartSummaries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            tool: "read",
            stateStatus: "pending",
            callID: expect.stringMatching(/^call_/),
            stateInput: { type: "object", preview: '{"filePath":"docs/how-to/verify.md"}' }
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
      process.env.RETINUE_OPENCODE_STALL_READ_TOOL_MS = "600000";

      const spawn = parseToolJson(
        await connection.client.callTool({
          name: "spawn_agent",
          arguments: { cwd: tempDir, message: "retinue permission bridge", task_name: "permission-bridge" }
        })
      );
      fakeOpenCode.appendPendingReadToolAssistant(spawn.externalSessionId);
      fakeOpenCode.appendExternalDirectoryPermission(spawn.externalSessionId, "/home/raystorm/projects/opencode/*", "call_read");

      const wait = parseToolJson(
        await connection.client.callTool({
          name: "wait_agent",
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
            toolCallID: "call_read",
            approval: expect.objectContaining({
              kind: "opencode_permission",
              title: "Access external directory /home/raystorm/projects/opencode",
              lines: expect.arrayContaining([
                "Target: /home/raystorm/projects/opencode",
                "Pattern: /home/raystorm/projects/opencode/*",
                `Delegated workspace: ${tempDir}`,
                "Scope: outside delegated workspace"
              ]),
              recommendedReply: "reject",
              recommendedMessage: expect.stringContaining("outside the delegated workspace"),
              scope: expect.objectContaining({
                target: "/home/raystorm/projects/opencode",
                cwd: tempDir,
                relation: "outside_workspace"
              }),
              options: [
                expect.objectContaining({ reply: "once", label: "Allow once" }),
                expect.objectContaining({ reply: "always", label: "Allow always", requiresConfirmation: true }),
                expect.objectContaining({ reply: "reject", label: "Reject" })
              ]
            })
          })
        ],
        permissionActions: [
          {
            id: "per_1",
            permission: "external_directory",
            target: "/home/raystorm/projects/opencode",
            patterns: ["/home/raystorm/projects/opencode/*"],
            toolCallID: "call_read",
            recommendedReply: "reject",
            recommendedMessage: expect.stringContaining("outside the delegated workspace"),
            relation: "outside_workspace"
          }
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
              toolCallID: "call_read",
            approval: expect.objectContaining({
              title: "Access external directory /home/raystorm/projects/opencode",
              recommendedReply: "reject",
              recommendedMessage: expect.stringContaining(`under ${tempDir}`),
              guidance: expect.arrayContaining([
                "Prefer reply=once when the requested scope is needed for the current task.",
                "Use reply=reject when the path or tool is outside the delegated task scope."
              ])
              })
            })
          ]
        },
        diagnostic: {
          stallReason: "external_directory_permission_pending",
          pendingExternalDirectoryPermissionCount: 1
        }
      });
      expect(wait.diagnostic.pendingExternalDirectoryPermissions).toBeUndefined();
      expect(wait.diagnostic.pendingPermissions).toBeUndefined();
      expect(wait.diagnostic.permissionActions).toEqual([
        expect.objectContaining({
          id: "per_1",
          recommendedReply: "reject",
          target: "/home/raystorm/projects/opencode"
        })
      ]);
      expect(wait.result.stderr).toBeUndefined();
      expect(wait.result.stderrOmitted).toBe(true);
      expect(wait.result.stderrTail).toContain("external_directory permission");
      expect(wait.result.stderrPath).toEqual(expect.stringContaining(spawn.jobId));

      const list = parseToolJson(
        await connection.client.callTool({
          name: "list_permissions",
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
            toolCallID: "call_read",
            approval: expect.objectContaining({
              title: "Access external directory /home/raystorm/projects/opencode",
              scope: expect.objectContaining({
                relation: "outside_workspace"
              }),
              options: [
                expect.objectContaining({ reply: "once", effect: "Resume this blocked OpenCode tool call only." }),
                expect.objectContaining({ reply: "always", requiresConfirmation: true }),
                expect.objectContaining({ reply: "reject" })
              ]
            })
          })
        ]
      });

      const allPermissions = parseToolJson(
        await connection.client.callTool({
          name: "list_permissions",
          arguments: {}
        })
      );
      expect(allPermissions).toMatchObject({
        scope: "known_jobs",
        agents: [
          expect.objectContaining({
            jobId: spawn.jobId,
            backend: "opencode",
            status: "stalled",
            permissions: [
              expect.objectContaining({
                id: "per_1",
                sessionID: spawn.externalSessionId,
                permission: "external_directory",
                patterns: ["/home/raystorm/projects/opencode/*"],
                toolCallID: "call_read"
              })
            ]
          })
        ],
        permissions: [
          expect.objectContaining({
            jobId: spawn.jobId,
            backend: "opencode",
            status: "stalled",
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
          name: "reply_permission",
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

  it("reports unsupported permission bridge capability in backend-neutral terms", async () => {
    const connection = await connectMcpClientWithRetinue(new ClaudeRetinue({ stateDir: "unused" }));
    try {
      process.env.RETINUE_BACKEND = "claude-code";

      const result = (await connection.client.callTool({
        name: "list_permissions",
        arguments: { jobId: "job_without_permission_bridge" }
      })) as { isError?: boolean; content?: Array<{ type: string; text?: string }> };

      expect(result.isError).toBe(true);
      const text = result.content?.find((item) => item.type === "text")?.text;
      expect(text).toContain("Retinue backend claude-code does not expose permission requests");
      expect(text).not.toContain("OpenCode permissions");
    } finally {
      delete process.env.RETINUE_BACKEND;
      await closeMcpClient(connection);
    }
  });

  it("surfaces Claude SDK permissions through Retinue MCP without selecting a model by default", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "retinue-mcp-claude-sdk-permission-"));
    const previousBackend = process.env.RETINUE_BACKEND;
    const previousStateDir = process.env.RETINUE_STATE_DIR;
    const previousRuntime = process.env.RETINUE_CLAUDE_RUNTIME;
    const previousModel = process.env.RETINUE_CLAUDE_MODEL;
    const previousCommand = process.env.RETINUE_CLAUDE_COMMAND;
    const previousPrefixArgs = process.env.RETINUE_CLAUDE_PREFIX_ARGS;
    const seenModels: unknown[] = [];
    const connection = await connectMcpClientWithRetinue(new ClaudeRetinue({ stateDir: "unused" }), {
      exposeBackendTools: true,
      preferClaudeSdk: true,
      claudeSdkQuery: async function* ({ options }) {
        seenModels.push(options?.model);
        expect(Object.prototype.hasOwnProperty.call(options ?? {}, "env")).toBe(false);
        expect(Object.prototype.hasOwnProperty.call(options ?? {}, "model")).toBe(false);
        const permission = await options?.canUseTool?.(
          "Read",
          { file_path: "/etc/hostname" },
          {
            signal: new AbortController().signal,
            toolUseID: "tool-read-1",
            displayName: "Read",
            description: "/etc/hostname",
            decisionReason: "Path is outside allowed working directories",
            suggestions: []
          }
        );
        expect((permission as typeof permission & { updatedInput?: unknown })?.updatedInput).toEqual({ file_path: "/etc/hostname" });
        yield {
          type: "result",
          subtype: "success",
          is_error: false,
          result: `permission:${permission?.behavior}`,
          session_id: "sdk-mcp-session"
        };
      }
    });
    try {
      process.env.RETINUE_BACKEND = "claude-code";
      process.env.RETINUE_STATE_DIR = tempDir;
      process.env.RETINUE_CLAUDE_RUNTIME = "sdk";
      delete process.env.RETINUE_CLAUDE_MODEL;
      delete process.env.RETINUE_CLAUDE_COMMAND;
      delete process.env.RETINUE_CLAUDE_PREFIX_ARGS;

      const spawn = parseToolJson(
        await connection.client.callTool({
          name: "spawn_agent",
          arguments: { cwd: tempDir, message: "read /etc/hostname", task_name: "claude-sdk-permission" }
        })
      );
      expect(spawn).toMatchObject({
        backend: "claude-code",
        status: "running",
        task_name: "claude-sdk-permission"
      });

      const wait = parseToolJson(
        await connection.client.callTool({
          name: "wait_agent",
          arguments: { jobId: spawn.jobId, timeoutMs: 1000 }
        })
      );
      expect(wait).toMatchObject({
        jobId: spawn.jobId,
        status: "running",
        backend: "claude-code",
        permissionRequired: true,
        permissions: [
          expect.objectContaining({
            id: "tool-read-1",
            permission: "Read",
            patterns: ["/etc/hostname"],
            approval: expect.objectContaining({
              kind: "claude_code_permission",
              title: "Read",
              recommendedReply: "once"
            })
          })
        ],
        attentionRequired: expect.objectContaining({
          kind: "permission",
          backend: "claude-code",
          reason: "claude_code_permission_pending"
        })
      });

      const reply = parseToolJson(
        await connection.client.callTool({
          name: "reply_permission",
          arguments: { jobId: spawn.jobId, requestId: "tool-read-1", reply: "once" }
        })
      );
      expect(reply).toMatchObject({
        jobId: spawn.jobId,
        backend: "claude-code",
        repliedRequestId: "tool-read-1",
        reply: "once",
        permissions: []
      });

      const completed = parseToolJson(
        await connection.client.callTool({
          name: "wait_agent",
          arguments: { jobId: spawn.jobId, timeoutMs: 1000 }
        })
      );
      expect(completed).toMatchObject({
        jobId: spawn.jobId,
        status: "completed",
        result: {
          parsedStdout: {
            result: "permission:allow",
            session_id: "sdk-mcp-session"
          }
        }
      });
      expect(seenModels).toEqual([undefined]);
    } finally {
      restoreEnv("RETINUE_BACKEND", previousBackend);
      restoreEnv("RETINUE_STATE_DIR", previousStateDir);
      restoreEnv("RETINUE_CLAUDE_RUNTIME", previousRuntime);
      restoreEnv("RETINUE_CLAUDE_MODEL", previousModel);
      restoreEnv("RETINUE_CLAUDE_COMMAND", previousCommand);
      restoreEnv("RETINUE_CLAUDE_PREFIX_ARGS", previousPrefixArgs);
      await closeMcpClient(connection);
      await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("passes a Retinue Claude agent selection to the Claude SDK backend", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "retinue-mcp-claude-sdk-agent-"));
    const previousBackend = process.env.RETINUE_BACKEND;
    const previousStateDir = process.env.RETINUE_STATE_DIR;
    const previousRuntime = process.env.RETINUE_CLAUDE_RUNTIME;
    const previousCommand = process.env.RETINUE_CLAUDE_COMMAND;
    const previousPrefixArgs = process.env.RETINUE_CLAUDE_PREFIX_ARGS;
    const seenAgents: unknown[] = [];
    const connection = await connectMcpClientWithRetinue(new ClaudeRetinue({ stateDir: "unused" }), {
      preferClaudeSdk: true,
      claudeSdkQuery: async function* ({ options }) {
        seenAgents.push(options?.agent);
        yield {
          type: "result",
          subtype: "success",
          is_error: false,
          result: "agent:code-reviewer",
          session_id: "sdk-mcp-agent-session"
        };
      }
    });
    try {
      process.env.RETINUE_BACKEND = "claude-code";
      process.env.RETINUE_STATE_DIR = tempDir;
      process.env.RETINUE_CLAUDE_RUNTIME = "sdk";
      delete process.env.RETINUE_CLAUDE_COMMAND;
      delete process.env.RETINUE_CLAUDE_PREFIX_ARGS;

      const spawn = parseToolJson(
        await connection.client.callTool({
          name: "spawn_agent",
          arguments: { cwd: tempDir, message: "use code reviewer", task_name: "claude-sdk-agent", agent: "code-reviewer" }
        })
      );
      expect(spawn).toMatchObject({
        backend: "claude-code",
        status: "running",
        task_name: "claude-sdk-agent",
        agent: "code-reviewer"
      });

      const completed = parseToolJson(
        await connection.client.callTool({
          name: "wait_agent",
          arguments: { jobId: spawn.jobId, timeoutMs: 1000 }
        })
      );
      expect(completed).toMatchObject({
        jobId: spawn.jobId,
        status: "completed",
        result: {
          parsedStdout: {
            result: "agent:code-reviewer",
            session_id: "sdk-mcp-agent-session"
          }
        }
      });
      expect(seenAgents).toEqual(["code-reviewer"]);

      const close = parseToolJson(
        await connection.client.callTool({
          name: "close_agent",
          arguments: { jobId: spawn.jobId }
        })
      );
      expect(close).toMatchObject({ jobId: spawn.jobId, status: "completed" });
    } finally {
      restoreEnv("RETINUE_BACKEND", previousBackend);
      restoreEnv("RETINUE_STATE_DIR", previousStateDir);
      restoreEnv("RETINUE_CLAUDE_RUNTIME", previousRuntime);
      restoreEnv("RETINUE_CLAUDE_COMMAND", previousCommand);
      restoreEnv("RETINUE_CLAUDE_PREFIX_ARGS", previousPrefixArgs);
      await closeMcpClient(connection);
      await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("does not leak OpenCode agent defaults into Claude SDK Retinue runs", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "retinue-mcp-claude-sdk-agent-default-"));
    const previousBackend = process.env.RETINUE_BACKEND;
    const previousStateDir = process.env.RETINUE_STATE_DIR;
    const previousRuntime = process.env.RETINUE_CLAUDE_RUNTIME;
    const previousCommand = process.env.RETINUE_CLAUDE_COMMAND;
    const previousPrefixArgs = process.env.RETINUE_CLAUDE_PREFIX_ARGS;
    const previousClaudeAgent = process.env.RETINUE_CLAUDE_AGENT;
    const previousOpenCodeAgent = process.env.RETINUE_OPENCODE_AGENT;
    const seenAgents: unknown[] = [];
    const connection = await connectMcpClientWithRetinue(new ClaudeRetinue({ stateDir: "unused" }), {
      preferClaudeSdk: true,
      claudeSdkQuery: async function* ({ options }) {
        seenAgents.push(options?.agent);
        yield {
          type: "result",
          subtype: "success",
          is_error: false,
          result: "agent-default",
          session_id: "sdk-mcp-agent-default-session"
        };
      }
    });
    try {
      process.env.RETINUE_BACKEND = "claude-code";
      process.env.RETINUE_STATE_DIR = tempDir;
      process.env.RETINUE_CLAUDE_RUNTIME = "sdk";
      process.env.RETINUE_OPENCODE_AGENT = "explore";
      delete process.env.RETINUE_CLAUDE_AGENT;
      delete process.env.RETINUE_CLAUDE_COMMAND;
      delete process.env.RETINUE_CLAUDE_PREFIX_ARGS;

      const spawn = parseToolJson(
        await connection.client.callTool({
          name: "spawn_agent",
          arguments: { cwd: tempDir, message: "use claude default", task_name: "claude-sdk-agent-default" }
        })
      );
      expect(spawn).toMatchObject({
        backend: "claude-code",
        status: "running",
        task_name: "claude-sdk-agent-default"
      });
      expect(spawn.agent).toBeUndefined();

      const completed = parseToolJson(
        await connection.client.callTool({
          name: "wait_agent",
          arguments: { jobId: spawn.jobId, timeoutMs: 1000 }
        })
      );
      expect(completed).toMatchObject({ jobId: spawn.jobId, status: "completed" });
      expect(seenAgents).toEqual([undefined]);
    } finally {
      restoreEnv("RETINUE_BACKEND", previousBackend);
      restoreEnv("RETINUE_STATE_DIR", previousStateDir);
      restoreEnv("RETINUE_CLAUDE_RUNTIME", previousRuntime);
      restoreEnv("RETINUE_CLAUDE_COMMAND", previousCommand);
      restoreEnv("RETINUE_CLAUDE_PREFIX_ARGS", previousPrefixArgs);
      restoreEnv("RETINUE_CLAUDE_AGENT", previousClaudeAgent);
      restoreEnv("RETINUE_OPENCODE_AGENT", previousOpenCodeAgent);
      await closeMcpClient(connection);
      await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("uses a Claude-specific agent default for Claude SDK Retinue runs", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "retinue-mcp-claude-sdk-agent-env-"));
    const previousBackend = process.env.RETINUE_BACKEND;
    const previousStateDir = process.env.RETINUE_STATE_DIR;
    const previousRuntime = process.env.RETINUE_CLAUDE_RUNTIME;
    const previousCommand = process.env.RETINUE_CLAUDE_COMMAND;
    const previousPrefixArgs = process.env.RETINUE_CLAUDE_PREFIX_ARGS;
    const previousClaudeAgent = process.env.RETINUE_CLAUDE_AGENT;
    const seenAgents: unknown[] = [];
    const connection = await connectMcpClientWithRetinue(new ClaudeRetinue({ stateDir: "unused" }), {
      preferClaudeSdk: true,
      claudeSdkQuery: async function* ({ options }) {
        seenAgents.push(options?.agent);
        yield {
          type: "result",
          subtype: "success",
          is_error: false,
          result: "agent:repo-explorer",
          session_id: "sdk-mcp-agent-env-session"
        };
      }
    });
    try {
      process.env.RETINUE_BACKEND = "claude-code";
      process.env.RETINUE_STATE_DIR = tempDir;
      process.env.RETINUE_CLAUDE_RUNTIME = "sdk";
      process.env.RETINUE_CLAUDE_AGENT = "repo-explorer";
      delete process.env.RETINUE_CLAUDE_COMMAND;
      delete process.env.RETINUE_CLAUDE_PREFIX_ARGS;

      const spawn = parseToolJson(
        await connection.client.callTool({
          name: "spawn_agent",
          arguments: { cwd: tempDir, message: "use claude env agent", task_name: "claude-sdk-agent-env" }
        })
      );
      expect(spawn).toMatchObject({
        backend: "claude-code",
        status: "running",
        task_name: "claude-sdk-agent-env",
        agent: "repo-explorer"
      });

      const completed = parseToolJson(
        await connection.client.callTool({
          name: "wait_agent",
          arguments: { jobId: spawn.jobId, timeoutMs: 1000 }
        })
      );
      expect(completed).toMatchObject({ jobId: spawn.jobId, status: "completed" });
      expect(seenAgents).toEqual(["repo-explorer"]);
    } finally {
      restoreEnv("RETINUE_BACKEND", previousBackend);
      restoreEnv("RETINUE_STATE_DIR", previousStateDir);
      restoreEnv("RETINUE_CLAUDE_RUNTIME", previousRuntime);
      restoreEnv("RETINUE_CLAUDE_COMMAND", previousCommand);
      restoreEnv("RETINUE_CLAUDE_PREFIX_ARGS", previousPrefixArgs);
      restoreEnv("RETINUE_CLAUDE_AGENT", previousClaudeAgent);
      await closeMcpClient(connection);
      await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
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
      process.env.RETINUE_OVERFLOW_STRATEGY = "evict";

      const spawns = [];
      for (const taskName of ["slot-1", "slot-2", "slot-3", "slot-4"]) {
        spawns.push(
          parseToolJson(
            await connection.client.callTool({
              name: "spawn_agent",
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
          name: "close_agent",
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
      delete process.env.RETINUE_OVERFLOW_STRATEGY;
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
      process.env.RETINUE_OVERFLOW_STRATEGY = "evict";

      const spawns = await Promise.all(
        ["concurrent-slot-1", "concurrent-slot-2", "concurrent-slot-3", "concurrent-slot-4"].map((taskName) =>
          connection.client
            .callTool({
              name: "spawn_agent",
              arguments: { cwd: tempDir, message: `retinue ${taskName}`, task_name: taskName }
            })
            .then(parseToolJson)
        )
      );

      const evictions = spawns.filter((spawn) => typeof spawn.evictedJobId === "string");
      expect(evictions).toHaveLength(1);

      const list = parseToolJson(await connection.client.callTool({ name: "list_agents", arguments: {} }));
      expect(list.maxAgents).toBe(3);
      expect(list.agents).toHaveLength(3);
      expect(list.agents.map((agent: { jobId: string }) => agent.jobId)).not.toContain(spawns[0].jobId);
      expect(list.agents.map((agent: { status: string }) => agent.status)).toEqual(["running", "running", "running"]);
    } finally {
      delete process.env.RETINUE_STATE_DIR;
      delete process.env.RETINUE_OPENCODE_BASE_URL;
      delete process.env.RETINUE_MAX_CONCURRENT_AGENTS;
      delete process.env.RETINUE_OVERFLOW_STRATEGY;
      await Promise.allSettled([closeMcpClient(connection), fakeOpenCode.close()]);
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("enforces a global Retinue agent budget across MCP server sessions", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "retinue-mcp-retinue-global-budget-"));
    const fakeOpenCode = await startFakeOpenCodeServer();
    fakeOpenCode.setAutoAssistantResponses(false);
    const firstConnection = await connectMcpClientWithRetinue(new ClaudeRetinue({ stateDir: "unused" }));
    const secondConnection = await connectMcpClientWithRetinue(new ClaudeRetinue({ stateDir: "unused" }));
    try {
      process.env.RETINUE_STATE_DIR = tempDir;
      process.env.RETINUE_OPENCODE_BASE_URL = fakeOpenCode.url;
      process.env.RETINUE_MAX_CONCURRENT_AGENTS = "5";
      process.env.RETINUE_GLOBAL_AGENT_BUDGET = "3";

      const first = parseToolJson(
        await firstConnection.client.callTool({
          name: "spawn_agent",
          arguments: { cwd: tempDir, message: "retinue global budget one", task_name: "global-budget-1" }
        })
      );
      const second = parseToolJson(
        await firstConnection.client.callTool({
          name: "spawn_agent",
          arguments: { cwd: tempDir, message: "retinue global budget two", task_name: "global-budget-2" }
        })
      );
      const third = parseToolJson(
        await secondConnection.client.callTool({
          name: "spawn_agent",
          arguments: { cwd: tempDir, message: "retinue global budget three", task_name: "global-budget-3" }
        })
      );
      delete process.env.RETINUE_OPENCODE_BASE_URL;

      const queued = parseToolJson(
        await secondConnection.client.callTool({
          name: "spawn_agent",
          arguments: { cwd: tempDir, message: "retinue global budget four", task_name: "global-budget-4" }
        })
      );

      expect([first.status, second.status, third.status]).toEqual(["running", "running", "running"]);
      expect(queued).toMatchObject({
        task_name: "global-budget-4",
        status: "queued",
        backend: "opencode",
        queuePosition: 1,
        maxQueuedAgents: 20
      });
      expect(queued.jobId).toEqual(expect.any(String));

      const firstList = parseToolJson(await firstConnection.client.callTool({ name: "list_agents", arguments: {} }));
      const secondList = parseToolJson(await secondConnection.client.callTool({ name: "list_agents", arguments: {} }));
      expect(firstList.agents).toHaveLength(2);
      expect(secondList.agents).toEqual([
        expect.objectContaining({ jobId: third.jobId, status: "running" }),
        expect.objectContaining({ jobId: queued.jobId, status: "queued", queuePosition: 1 })
      ]);

      const trace = await fs.readFile(path.join(tempDir, "logs", "retinue.jsonl"), "utf8");
      expect(trace).toContain('"event":"retinue_agent_queued"');
      expect(trace).toContain(`"jobId":"${queued.jobId}"`);
      expect(trace).not.toContain("retinue_global_agent_budget_status_failed");
    } finally {
      delete process.env.RETINUE_STATE_DIR;
      delete process.env.RETINUE_OPENCODE_BASE_URL;
      delete process.env.RETINUE_MAX_CONCURRENT_AGENTS;
      delete process.env.RETINUE_GLOBAL_AGENT_BUDGET;
      await Promise.allSettled([closeMcpClient(firstConnection), closeMcpClient(secondConnection), fakeOpenCode.close()]);
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("counts a running root job toward the global budget when its selected attempt metadata is stale", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "retinue-mcp-retinue-global-budget-stale-attempt-"));
    const fakeOpenCode = await startFakeOpenCodeServer();
    fakeOpenCode.setAutoAssistantResponses(false);
    const connection = await connectMcpClientWithRetinue(new ClaudeRetinue({ stateDir: "unused" }));
    try {
      process.env.RETINUE_STATE_DIR = tempDir;
      process.env.RETINUE_OPENCODE_BASE_URL = fakeOpenCode.url;
      process.env.RETINUE_MAX_CONCURRENT_AGENTS = "5";
      process.env.RETINUE_GLOBAL_AGENT_BUDGET = "1";

      const first = parseToolJson(
        await connection.client.callTool({
          name: "spawn_agent",
          arguments: { cwd: tempDir, message: "retinue stale selected attempt one", task_name: "stale-attempt-1" }
        })
      );
      expect(first).toMatchObject({ status: "running" });

      const metaPath = path.join(tempDir, "jobs", first.jobId, "meta.json");
      const meta = JSON.parse(await fs.readFile(metaPath, "utf8"));
      await fs.writeFile(metaPath, `${JSON.stringify({ ...meta, selectedAttemptJobId: "job_missing_attempt" }, null, 2)}\n`, "utf8");

      const queued = parseToolJson(
        await connection.client.callTool({
          name: "spawn_agent",
          arguments: { cwd: tempDir, message: "retinue stale selected attempt two", task_name: "stale-attempt-2" }
        })
      );
      expect(queued).toMatchObject({
        status: "queued",
        queuePosition: 1,
        maxQueuedAgents: 20
      });
      const trace = await fs.readFile(path.join(tempDir, "logs", "retinue.jsonl"), "utf8");
      expect(trace).toContain('"hasSessionSlot":true');
      expect(trace).toContain('"hasGlobalSlot":false');
    } finally {
      delete process.env.RETINUE_STATE_DIR;
      delete process.env.RETINUE_OPENCODE_BASE_URL;
      delete process.env.RETINUE_MAX_CONCURRENT_AGENTS;
      delete process.env.RETINUE_GLOBAL_AGENT_BUDGET;
      await Promise.allSettled([closeMcpClient(connection), fakeOpenCode.close()]);
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("promotes queued Retinue agents when a slot becomes available", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "retinue-mcp-retinue-queue-promote-"));
    const fakeOpenCode = await startFakeOpenCodeServer();
    fakeOpenCode.setAutoAssistantResponses(false);
    const connection = await connectMcpClientWithRetinue(new ClaudeRetinue({ stateDir: "unused" }));
    try {
      process.env.RETINUE_STATE_DIR = tempDir;
      process.env.RETINUE_OPENCODE_BASE_URL = fakeOpenCode.url;
      process.env.RETINUE_MAX_CONCURRENT_AGENTS = "1";

      const first = parseToolJson(
        await connection.client.callTool({
          name: "spawn_agent",
          arguments: { cwd: tempDir, message: "retinue queued promote one", task_name: "queue-promote-1" }
        })
      );
      const second = parseToolJson(
        await connection.client.callTool({
          name: "spawn_agent",
          arguments: { cwd: tempDir, message: "retinue queued promote two", task_name: "queue-promote-2" }
        })
      );

      expect(first).toMatchObject({ status: "running" });
      expect(second).toMatchObject({ status: "queued", queuePosition: 1 });

      await connection.client.callTool({ name: "close_agent", arguments: { jobId: first.jobId } });
      const promoted = parseToolJson(
        await connection.client.callTool({ name: "wait_agent", arguments: { jobId: second.jobId, timeoutMs: 0 } })
      );

      expect(promoted).toMatchObject({
        requestedJobId: second.jobId,
        selectedAttemptJobId: expect.any(String),
        status: "running"
      });
      expect(promoted.jobId).not.toBe(second.jobId);
      const attemptMeta = JSON.parse(await fs.readFile(path.join(tempDir, "jobs", promoted.jobId, "meta.json"), "utf8")) as {
        externalSessionId: string;
      };
      fakeOpenCode.completeSessionWithFinalText(attemptMeta.externalSessionId, "queued final");
      const completed = parseToolJson(
        await connection.client.callTool({ name: "wait_agent", arguments: { jobId: second.jobId, timeoutMs: 1000 } })
      );
      expect(completed).toMatchObject({
        jobId: second.jobId,
        status: "completed",
        result: {
          status: "completed",
          stdout: "queued final"
        }
      });
      expect(completed.requestedJobId).toBeUndefined();
      await expect(fs.readFile(path.join(tempDir, "jobs", second.jobId, "meta.json"), "utf8").then(JSON.parse)).resolves.toMatchObject({
        status: "completed",
        selectedAttemptJobId: promoted.jobId
      });

      const trace = await fs.readFile(path.join(tempDir, "logs", "retinue.jsonl"), "utf8");
      expect(trace).toContain('"event":"retinue_queued_agent_promoted"');
      expect(trace).toContain(`"jobId":"${second.jobId}"`);
    } finally {
      delete process.env.RETINUE_STATE_DIR;
      delete process.env.RETINUE_OPENCODE_BASE_URL;
      delete process.env.RETINUE_MAX_CONCURRENT_AGENTS;
      await Promise.allSettled([closeMcpClient(connection), fakeOpenCode.close()]);
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps queued Retinue agents queued until both session and global slots are available", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "retinue-mcp-retinue-queue-both-limits-"));
    const fakeOpenCode = await startFakeOpenCodeServer();
    fakeOpenCode.setAutoAssistantResponses(false);
    const firstConnection = await connectMcpClientWithRetinue(new ClaudeRetinue({ stateDir: "unused" }));
    const secondConnection = await connectMcpClientWithRetinue(new ClaudeRetinue({ stateDir: "unused" }));
    try {
      process.env.RETINUE_STATE_DIR = tempDir;
      process.env.RETINUE_OPENCODE_BASE_URL = fakeOpenCode.url;
      process.env.RETINUE_MAX_CONCURRENT_AGENTS = "1";
      process.env.RETINUE_GLOBAL_AGENT_BUDGET = "3";

      const first = parseToolJson(
        await firstConnection.client.callTool({
          name: "spawn_agent",
          arguments: { cwd: tempDir, message: "retinue both limits one", task_name: "both-limits-1" }
        })
      );
      const queued = parseToolJson(
        await firstConnection.client.callTool({
          name: "spawn_agent",
          arguments: { cwd: tempDir, message: "retinue both limits queued", task_name: "both-limits-queued" }
        })
      );

      process.env.RETINUE_MAX_CONCURRENT_AGENTS = "3";
      const second = parseToolJson(
        await secondConnection.client.callTool({
          name: "spawn_agent",
          arguments: { cwd: tempDir, message: "retinue both limits two", task_name: "both-limits-2" }
        })
      );
      const third = parseToolJson(
        await secondConnection.client.callTool({
          name: "spawn_agent",
          arguments: { cwd: tempDir, message: "retinue both limits three", task_name: "both-limits-3" }
        })
      );

      expect([first.status, second.status, third.status]).toEqual(["running", "running", "running"]);
      expect(queued).toMatchObject({ status: "queued", queuePosition: 1 });

      await firstConnection.client.callTool({ name: "close_agent", arguments: { jobId: first.jobId } });
      const fourth = parseToolJson(
        await secondConnection.client.callTool({
          name: "spawn_agent",
          arguments: { cwd: tempDir, message: "retinue both limits four", task_name: "both-limits-4" }
        })
      );
      expect(fourth).toMatchObject({ status: "running" });

      const stillQueued = parseToolJson(
        await firstConnection.client.callTool({ name: "wait_agent", arguments: { jobId: queued.jobId, timeoutMs: 0 } })
      );
      expect(stillQueued).toMatchObject({ jobId: queued.jobId, status: "queued", queuePosition: 1 });

      await secondConnection.client.callTool({ name: "close_agent", arguments: { jobId: second.jobId } });
      const promoted = parseToolJson(
        await firstConnection.client.callTool({ name: "wait_agent", arguments: { jobId: queued.jobId, timeoutMs: 0 } })
      );
      expect(promoted).toMatchObject({
        requestedJobId: queued.jobId,
        selectedAttemptJobId: expect.any(String),
        status: "running"
      });
      expect(promoted.jobId).not.toBe(queued.jobId);
    } finally {
      delete process.env.RETINUE_STATE_DIR;
      delete process.env.RETINUE_OPENCODE_BASE_URL;
      delete process.env.RETINUE_MAX_CONCURRENT_AGENTS;
      delete process.env.RETINUE_GLOBAL_AGENT_BUDGET;
      await Promise.allSettled([closeMcpClient(firstConnection), closeMcpClient(secondConnection), fakeOpenCode.close()]);
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("reports queue exhaustion separately from global budget exhaustion", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "retinue-mcp-retinue-queue-exhausted-"));
    const fakeOpenCode = await startFakeOpenCodeServer();
    fakeOpenCode.setAutoAssistantResponses(false);
    const connection = await connectMcpClientWithRetinue(new ClaudeRetinue({ stateDir: "unused" }));
    try {
      process.env.RETINUE_STATE_DIR = tempDir;
      process.env.RETINUE_OPENCODE_BASE_URL = fakeOpenCode.url;
      process.env.RETINUE_MAX_CONCURRENT_AGENTS = "1";
      process.env.RETINUE_GLOBAL_AGENT_BUDGET = "5";
      process.env.RETINUE_MAX_QUEUED_AGENTS = "1";

      const first = parseToolJson(
        await connection.client.callTool({
          name: "spawn_agent",
          arguments: { cwd: tempDir, message: "retinue queue exhausted one", task_name: "queue-exhausted-1" }
        })
      );
      const queued = parseToolJson(
        await connection.client.callTool({
          name: "spawn_agent",
          arguments: { cwd: tempDir, message: "retinue queue exhausted two", task_name: "queue-exhausted-2" }
        })
      );
      const exhausted = parseToolJson(
        await connection.client.callTool({
          name: "spawn_agent",
          arguments: { cwd: tempDir, message: "retinue queue exhausted three", task_name: "queue-exhausted-3" }
        })
      );

      expect(first).toMatchObject({ status: "running" });
      expect(queued).toMatchObject({ status: "queued", queuePosition: 1, maxQueuedAgents: 1 });
      expect(exhausted).toMatchObject({
        status: "resource_exhausted",
        reason: "queue_full",
        message: "Retinue queued-agent budget exhausted: 1/1",
        maxQueuedAgents: 1,
        queuedAgents: 1,
        activeSessionAgents: 1
      });
      expect(exhausted).not.toHaveProperty("activeGlobalAgents");
    } finally {
      delete process.env.RETINUE_STATE_DIR;
      delete process.env.RETINUE_OPENCODE_BASE_URL;
      delete process.env.RETINUE_MAX_CONCURRENT_AGENTS;
      delete process.env.RETINUE_GLOBAL_AGENT_BUDGET;
      delete process.env.RETINUE_MAX_QUEUED_AGENTS;
      await Promise.allSettled([closeMcpClient(connection), fakeOpenCode.close()]);
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("defaults to three session slots and five global slots", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "retinue-mcp-retinue-default-global-budget-"));
    const fakeOpenCode = await startFakeOpenCodeServer();
    fakeOpenCode.setAutoAssistantResponses(false);
    const firstConnection = await connectMcpClientWithRetinue(new ClaudeRetinue({ stateDir: "unused" }));
    const secondConnection = await connectMcpClientWithRetinue(new ClaudeRetinue({ stateDir: "unused" }));
    const previousMaxConcurrentAgents = process.env.RETINUE_MAX_CONCURRENT_AGENTS;
    const previousGlobalAgentBudget = process.env.RETINUE_GLOBAL_AGENT_BUDGET;
    const previousOverflowStrategy = process.env.RETINUE_OVERFLOW_STRATEGY;
    const previousMaxQueuedAgents = process.env.RETINUE_MAX_QUEUED_AGENTS;
    try {
      process.env.RETINUE_STATE_DIR = tempDir;
      process.env.RETINUE_OPENCODE_BASE_URL = fakeOpenCode.url;
      delete process.env.RETINUE_MAX_CONCURRENT_AGENTS;
      delete process.env.RETINUE_GLOBAL_AGENT_BUDGET;
      delete process.env.RETINUE_OVERFLOW_STRATEGY;
      delete process.env.RETINUE_MAX_QUEUED_AGENTS;

      const first = parseToolJson(
        await firstConnection.client.callTool({
          name: "spawn_agent",
          arguments: { cwd: tempDir, message: "retinue default budget one", task_name: "default-budget-1" }
        })
      );
      const second = parseToolJson(
        await firstConnection.client.callTool({
          name: "spawn_agent",
          arguments: { cwd: tempDir, message: "retinue default budget two", task_name: "default-budget-2" }
        })
      );
      const third = parseToolJson(
        await firstConnection.client.callTool({
          name: "spawn_agent",
          arguments: { cwd: tempDir, message: "retinue default budget three", task_name: "default-budget-3" }
        })
      );
      const fourth = parseToolJson(
        await secondConnection.client.callTool({
          name: "spawn_agent",
          arguments: { cwd: tempDir, message: "retinue default budget four", task_name: "default-budget-4" }
        })
      );
      const fifth = parseToolJson(
        await secondConnection.client.callTool({
          name: "spawn_agent",
          arguments: { cwd: tempDir, message: "retinue default budget five", task_name: "default-budget-5" }
        })
      );
      const queued = parseToolJson(
        await secondConnection.client.callTool({
          name: "spawn_agent",
          arguments: { cwd: tempDir, message: "retinue default budget six", task_name: "default-budget-6" }
        })
      );

      expect([first.status, second.status, third.status, fourth.status, fifth.status]).toEqual([
        "running",
        "running",
        "running",
        "running",
        "running"
      ]);
      expect(queued).toMatchObject({
        task_name: "default-budget-6",
        status: "queued",
        queuePosition: 1,
        maxQueuedAgents: 20
      });

      const firstList = parseToolJson(await firstConnection.client.callTool({ name: "list_agents", arguments: {} }));
      const secondList = parseToolJson(await secondConnection.client.callTool({ name: "list_agents", arguments: {} }));
      expect(firstList).toMatchObject({ maxAgents: 3 });
      expect(secondList).toMatchObject({ maxAgents: 3 });
      expect(firstList.agents).toHaveLength(3);
      expect(secondList.agents).toHaveLength(3);
      expect(secondList.agents.at(-1)).toMatchObject({ jobId: queued.jobId, status: "queued", queuePosition: 1 });
    } finally {
      delete process.env.RETINUE_STATE_DIR;
      delete process.env.RETINUE_OPENCODE_BASE_URL;
      if (previousMaxConcurrentAgents === undefined) {
        delete process.env.RETINUE_MAX_CONCURRENT_AGENTS;
      } else {
        process.env.RETINUE_MAX_CONCURRENT_AGENTS = previousMaxConcurrentAgents;
      }
      if (previousGlobalAgentBudget === undefined) {
        delete process.env.RETINUE_GLOBAL_AGENT_BUDGET;
      } else {
        process.env.RETINUE_GLOBAL_AGENT_BUDGET = previousGlobalAgentBudget;
      }
      if (previousOverflowStrategy === undefined) {
        delete process.env.RETINUE_OVERFLOW_STRATEGY;
      } else {
        process.env.RETINUE_OVERFLOW_STRATEGY = previousOverflowStrategy;
      }
      if (previousMaxQueuedAgents === undefined) {
        delete process.env.RETINUE_MAX_QUEUED_AGENTS;
      } else {
        process.env.RETINUE_MAX_QUEUED_AGENTS = previousMaxQueuedAgents;
      }
      await Promise.allSettled([closeMcpClient(firstConnection), closeMcpClient(secondConnection), fakeOpenCode.close()]);
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
          name: "spawn_agent",
          arguments: { cwd: tempDir, message: "retinue list first", task_name: "list-first" }
        })
      );
      const second = parseToolJson(
        await connection.client.callTool({
          name: "spawn_agent",
          arguments: { cwd: tempDir, message: "retinue list second", task_name: "list-second" }
        })
      );

      const list = parseToolJson(await connection.client.callTool({ name: "list_agents", arguments: {} }));
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
      process.env.RETINUE_OPENCODE_STALL_FINALIZATION_AFTER_TOOL_PROGRESS_MS = "1";
      process.env.RETINUE_OPENCODE_TASK_ATTEMPT_MAX = "0";

      const spawn = parseToolJson(
        await connection.client.callTool({
          name: "spawn_agent",
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
          name: "wait_agent",
          arguments: { jobId: spawn.jobId, timeoutMs: 1000 }
        })
      );
      expect(wait).toMatchObject({
        jobId: spawn.jobId,
        status: "stalled"
      });

      const list = parseToolJson(await connection.client.callTool({ name: "list_agents", arguments: {} }));
      expect(list.agents.map((agent: { jobId: string }) => agent.jobId)).not.toContain(spawn.jobId);
    } finally {
      delete process.env.RETINUE_STATE_DIR;
      delete process.env.RETINUE_OPENCODE_BASE_URL;
      delete process.env.RETINUE_OPENCODE_STALL_ZERO_PROGRESS_ASSISTANT_MS;
      delete process.env.RETINUE_OPENCODE_STALL_FINALIZATION_AFTER_TOOL_PROGRESS_MS;
      delete process.env.RETINUE_OPENCODE_TASK_ATTEMPT_MAX;
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
          name: "spawn_agent",
          arguments: { cwd: tempDir, message: "retinue close pool", task_name: "close-pool" }
        })
      );
      await connection.client.callTool({
        name: "close_agent",
        arguments: { jobId: spawn.jobId }
      });

      const list = parseToolJson(await connection.client.callTool({ name: "list_agents", arguments: {} }));
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
          name: "spawn_agent",
          arguments: { cwd: tempDir, message: "retinue bound opencode", task_name: "bound-opencode" }
        })
      );
      expect(spawn).toMatchObject({ task_name: "bound-opencode", backend: "opencode", status: "running" });
      fakeOpenCode.completeSession(spawn.externalSessionId);

      process.env.RETINUE_BACKEND = "claude-code";

      const wait = parseToolJson(
        await connection.client.callTool({
          name: "wait_agent",
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
          name: "close_agent",
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
          name: "spawn_agent",
          arguments: { cwd: tempDir, message: "retinue claude", task_name: "claude-smoke" }
        })
      );
      expect(spawn).toMatchObject({ task_name: "claude-smoke", backend: "claude-code", status: "running" });
      expect(spawn).not.toHaveProperty("externalSessionId");

      const wait = parseToolJson(
        await connection.client.callTool({
          name: "wait_agent",
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
          name: "close_agent",
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
          name: "spawn_agent",
          arguments: { cwd: tempDir, message: "retinue bound claude", task_name: "bound-claude" }
        })
      );
      expect(spawn).toMatchObject({ task_name: "bound-claude", backend: "claude-code", status: "running" });

      process.env.RETINUE_BACKEND = "opencode";

      const wait = parseToolJson(
        await connection.client.callTool({
          name: "wait_agent",
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
          name: "close_agent",
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
          name: "spawn_agent",
          arguments: { cwd: tempDir, message: "configured first", task_name: "configured-first" }
        })
      );
      const second = parseToolJson(
        await connection.client.callTool({
          name: "spawn_agent",
          arguments: { cwd: tempDir, message: "configured second", task_name: "configured-second" }
        })
      );
      const third = parseToolJson(
        await connection.client.callTool({
          name: "spawn_agent",
          arguments: { cwd: tempDir, message: "configured third", task_name: "configured-third" }
        })
      );

      expect(first).toMatchObject({ status: "running" });
      expect(second).toMatchObject({ status: "running" });
      expect(third).toMatchObject({ status: "queued", queuePosition: 1 });
      expect(fakeOpenCode.promptRequests.at(0)).toMatchObject({ agent: "explore" });

      const list = parseToolJson(await connection.client.callTool({ name: "list_agents", arguments: {} }));
      expect(list).toMatchObject({ maxAgents: 2 });
      expect(list.agents).toHaveLength(3);
      expect(list.agents.at(-1)).toMatchObject({ jobId: third.jobId, status: "queued", queuePosition: 1 });
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
          name: "spawn_agent",
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

  it("leaves the Kilo model unset by default so Kilo config owns routing", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "retinue-mcp-retinue-kilo-defaults-"));
    const fakeKilo = await startFakeOpenCodeServer();
    const connection = await connectMcpClientWithRetinue(new ClaudeRetinue({ stateDir: "unused" }));
    try {
      process.env.RETINUE_BACKEND = "kilo";
      process.env.RETINUE_STATE_DIR = tempDir;
      process.env.RETINUE_KILO_BASE_URL = fakeKilo.url;
      process.env.RETINUE_KILO_AGENT = "explore";
      const run = parseToolJson(
        await connection.client.callTool({
          name: "spawn_agent",
          arguments: { cwd: tempDir, message: "retinue kilo defaults", task_name: "kilo-defaults" }
        })
      );
      expect(run).toMatchObject({ backend: "kilo", status: "running" });
      expect(fakeKilo.promptRequests[0]).toMatchObject({
        agent: "explore"
      });
      expect(fakeKilo.promptRequests[0].model).toBeUndefined();
    } finally {
      delete process.env.RETINUE_BACKEND;
      delete process.env.RETINUE_STATE_DIR;
      delete process.env.RETINUE_KILO_BASE_URL;
      delete process.env.RETINUE_KILO_AGENT;
      await Promise.allSettled([closeMcpClient(connection), fakeKilo.close()]);
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
      RETINUE_DAEMON_URL: daemonUrl,
      RETINUE_DAEMON_TOKEN: daemonToken
    }),
    { exposeBackendTools: true }
  );
  await Promise.all([mcpServer.connect(serverTransport), client.connect(clientTransport)]);
  return { client, clientTransport, serverTransport };
}

async function connectMcpClientWithRetinue(
  retinue: ClaudeRetinue,
  options: boolean | CreateMcpServerOptions = true
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
      { permission: "todowrite", pattern: "*", action: "deny" },
      { permission: "task", pattern: "*", action: "deny" }
    ])
  });
  expect(request?.permission).not.toContainEqual({ permission: "edit", pattern: "blocked-by-plan", action: "deny" });
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

function getToolDescription(tools: Array<{ name: string; description?: string }>, toolName: string): string {
  const tool = tools.find((entry) => entry.name === toolName);
  expect(tool, `Tool ${toolName} should be registered`).toBeTruthy();
  expect(tool?.description, `Tool ${toolName} should expose a description`).toBeTruthy();
  return tool!.description!;
}

async function freePort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return address.port;
}
