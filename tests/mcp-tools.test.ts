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
    expect(RETINUE_TOOL_NAMES).toEqual(["retinue_spawn_agent", "retinue_wait_agent", "retinue_close_agent", "retinue_list_agents"]);
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
      assertOptionalField(tools.tools, "retinue_spawn_agent", "access_mode");
      assertOptionalField(tools.tools, "retinue_spawn_agent", "bash_policy");
      assertAbsentFields(tools.tools, "retinue_spawn_agent", ["backend", "profile", "model", "permissionMode", "opencodeBaseUrl"]);
      assertRequiredFields(tools.tools, "retinue_wait_agent", ["jobId"]);
      assertAbsentFields(tools.tools, "retinue_wait_agent", ["backend", "profile", "model", "agent", "permissionMode", "opencodeBaseUrl"]);
      assertRequiredFields(tools.tools, "retinue_close_agent", ["jobId"]);
      assertAbsentFields(tools.tools, "retinue_close_agent", ["backend", "profile", "model", "agent", "permissionMode", "opencodeBaseUrl"]);
      assertAbsentFields(tools.tools, "retinue_list_agents", ["backend", "profile", "model", "agent", "permissionMode", "opencodeBaseUrl"]);
    } finally {
      await closeMcpClient(connection);
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
        arguments: { cwd: tempDir, message: "retinue mcp", task_name: "smoke", agent: "plan" }
        })
      );
      expect(spawn).toMatchObject({
        task_name: "smoke",
        backend: "opencode",
        status: "running",
        cwd: tempDir,
        jobDir: path.join(tempDir, "jobs", spawn.jobId),
        externalServerUrl: fakeOpenCode.url,
        externalSessionDirectory: process.cwd()
      });
      expect(fakeOpenCode.promptRequests.at(-1)).toMatchObject({ agent: "plan" });
      expect(fakeOpenCode.promptRequests.at(-1)).not.toHaveProperty("tools");
      const submittedPrompt = extractOpenCodePromptText(fakeOpenCode.promptRequests.at(-1));
      expect(submittedPrompt).toBe("retinue mcp");
      const permissions = fakeOpenCode.sessionRequests.at(-1)?.permission ?? [];
      expect(fakeOpenCode.sessionRequests.at(-1)).toMatchObject({
        permission: expect.arrayContaining([
          { permission: "doom_loop", pattern: "*", action: "deny" },
          { permission: "patch", pattern: "*", action: "deny" },
          { permission: "bash", pattern: "*", action: "deny" },
          { permission: "bash", pattern: "git diff --cached*", action: "allow" }
        ])
      });
      expect(permissions.findIndex((rule) => rule.permission === "bash" && rule.pattern === "git diff --cached*")).toBeLessThan(
        permissions.findIndex((rule) => rule.permission === "bash" && rule.pattern === "*")
      );
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
      await Promise.allSettled([closeMcpClient(connection), fakeOpenCode.close()]);
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("lets a Retinue OpenCode spawn opt into the active OpenCode profile permissions", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "retinue-mcp-retinue-opencode-profile-access-"));
    const fakeOpenCode = await startFakeOpenCodeServer();
    const connection = await connectMcpClientWithRetinue(new ClaudeRetinue({ stateDir: "unused" }));
    try {
      process.env.RETINUE_STATE_DIR = tempDir;
      process.env.RETINUE_OPENCODE_BASE_URL = fakeOpenCode.url;

      await connection.client.callTool({
        name: "retinue_spawn_agent",
        arguments: { cwd: tempDir, message: "retinue profile access", task_name: "profile-access", access_mode: "profile" }
      });

      expect(fakeOpenCode.promptRequests.at(-1)).not.toHaveProperty("tools");
      expect(extractOpenCodePromptText(fakeOpenCode.promptRequests.at(-1))).toBe("retinue profile access");
    } finally {
      delete process.env.RETINUE_STATE_DIR;
      delete process.env.RETINUE_OPENCODE_BASE_URL;
      await Promise.allSettled([closeMcpClient(connection), fakeOpenCode.close()]);
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("lets a Retinue OpenCode read-only spawn opt out of readonly git bash", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "retinue-mcp-retinue-opencode-readonly-git-"));
    const fakeOpenCode = await startFakeOpenCodeServer();
    const connection = await connectMcpClientWithRetinue(new ClaudeRetinue({ stateDir: "unused" }));
    try {
      process.env.RETINUE_STATE_DIR = tempDir;
      process.env.RETINUE_OPENCODE_BASE_URL = fakeOpenCode.url;

      await connection.client.callTool({
        name: "retinue_spawn_agent",
        arguments: { cwd: tempDir, message: "inspect staged diff", task_name: "no-bash", bash_policy: "none" }
      });

      expect(fakeOpenCode.promptRequests.at(-1)).not.toHaveProperty("tools");
      expect(fakeOpenCode.sessionRequests.at(-1)).toMatchObject({
        permission: expect.arrayContaining([
          { permission: "patch", pattern: "*", action: "deny" },
          { permission: "bash", pattern: "*", action: "deny" }
        ])
      });
      expect(fakeOpenCode.sessionRequests.at(-1)).toMatchObject({
        permission: expect.not.arrayContaining([{ permission: "bash", pattern: "git diff --cached*", action: "allow" }])
      });
    } finally {
      delete process.env.RETINUE_STATE_DIR;
      delete process.env.RETINUE_OPENCODE_BASE_URL;
      await Promise.allSettled([closeMcpClient(connection), fakeOpenCode.close()]);
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("uses the configured Retinue plugin access mode when spawn omits access_mode", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "retinue-mcp-retinue-opencode-config-access-"));
    const configPath = path.join(tempDir, "retinue.config.json");
    const fakeOpenCode = await startFakeOpenCodeServer();
    const connection = await connectMcpClientWithRetinue(new ClaudeRetinue({ stateDir: "unused" }));
    try {
      await fs.writeFile(configPath, JSON.stringify({ opencode: { defaultAccessMode: "profile" } }), "utf8");
      process.env.RETINUE_STATE_DIR = tempDir;
      process.env.RETINUE_OPENCODE_BASE_URL = fakeOpenCode.url;
      process.env.RETINUE_CONFIG_FILE = configPath;

      await connection.client.callTool({
        name: "retinue_spawn_agent",
        arguments: { cwd: tempDir, message: "retinue configured access", task_name: "configured-access" }
      });

      expect(fakeOpenCode.promptRequests.at(-1)).not.toHaveProperty("tools");
    } finally {
      delete process.env.RETINUE_STATE_DIR;
      delete process.env.RETINUE_OPENCODE_BASE_URL;
      delete process.env.RETINUE_CONFIG_FILE;
      await Promise.allSettled([closeMcpClient(connection), fakeOpenCode.close()]);
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("uses the configured Retinue no-bash policy when spawn omits bash_policy", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "retinue-mcp-retinue-opencode-config-bash-"));
    const configPath = path.join(tempDir, "retinue.config.json");
    const fakeOpenCode = await startFakeOpenCodeServer();
    const connection = await connectMcpClientWithRetinue(new ClaudeRetinue({ stateDir: "unused" }));
    try {
      await fs.writeFile(configPath, JSON.stringify({ opencode: { defaultAccessMode: "read_only", readOnlyBashPolicy: "none" } }), "utf8");
      process.env.RETINUE_STATE_DIR = tempDir;
      process.env.RETINUE_OPENCODE_BASE_URL = fakeOpenCode.url;
      process.env.RETINUE_CONFIG_FILE = configPath;

      await connection.client.callTool({
        name: "retinue_spawn_agent",
        arguments: { cwd: tempDir, message: "inspect configured staged diff", task_name: "configured-bash" }
      });

      expect(fakeOpenCode.promptRequests.at(-1)).not.toHaveProperty("tools");
      expect(fakeOpenCode.sessionRequests.at(-1)).toMatchObject({
        permission: expect.not.arrayContaining([{ permission: "bash", pattern: "git diff --cached*", action: "allow" }])
      });
    } finally {
      delete process.env.RETINUE_STATE_DIR;
      delete process.env.RETINUE_OPENCODE_BASE_URL;
      delete process.env.RETINUE_CONFIG_FILE;
      await Promise.allSettled([closeMcpClient(connection), fakeOpenCode.close()]);
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("uses configured Retinue strict read-only prompt and tool denial when enabled", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "retinue-mcp-retinue-opencode-strict-readonly-"));
    const configPath = path.join(tempDir, "retinue.config.json");
    const fakeOpenCode = await startFakeOpenCodeServer();
    const connection = await connectMcpClientWithRetinue(new ClaudeRetinue({ stateDir: "unused" }));
    try {
      await fs.writeFile(
        configPath,
        JSON.stringify({ opencode: { defaultAccessMode: "read_only", readOnlyToolDeny: true, readOnlyPromptContract: true } }),
        "utf8"
      );
      process.env.RETINUE_STATE_DIR = tempDir;
      process.env.RETINUE_OPENCODE_BASE_URL = fakeOpenCode.url;
      process.env.RETINUE_CONFIG_FILE = configPath;

      await connection.client.callTool({
        name: "retinue_spawn_agent",
        arguments: { cwd: tempDir, message: "inspect configured strict mode", task_name: "configured-strict" }
      });

      expect(fakeOpenCode.promptRequests.at(-1)?.tools).toMatchObject({
        edit: false,
        write: false,
        apply_patch: false,
        patch: false,
        task: false
      });
      expect(extractOpenCodePromptText(fakeOpenCode.promptRequests.at(-1))).toContain("Retinue read-only child agent");
    } finally {
      delete process.env.RETINUE_STATE_DIR;
      delete process.env.RETINUE_OPENCODE_BASE_URL;
      delete process.env.RETINUE_CONFIG_FILE;
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
          lastAssistantModelID: "semantic-router"
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

      const spawn = parseToolJson(
        await connection.client.callTool({
          name: "retinue_spawn_agent",
          arguments: { cwd: tempDir, message: "retinue stalled pool", task_name: "stalled-pool" }
        })
      );
      fakeOpenCode.appendPatchAssistant(spawn.externalSessionId);

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
        model: { providerID: "litellm", modelID: "pro-router" },
        agent: "build"
      });
    } finally {
      delete process.env.RETINUE_STATE_DIR;
      delete process.env.RETINUE_OPENCODE_MODEL;
      delete process.env.RETINUE_OPENCODE_AGENT;
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
        model: { providerID: "litellm", modelID: "pro-router" },
        agent: "explore"
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

async function connectMcpClientWithRetinue(retinue: ClaudeRetinue, exposeBackendTools = true) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "retinue-test-client", version: "0.1.0" });
  const mcpServer = createMcpServer(retinue, { exposeBackendTools });
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
