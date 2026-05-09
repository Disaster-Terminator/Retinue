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
import { CLAUDE_TOOL_NAMES, OPENCODE_TOOL_NAMES, RETINUE_TOOL_NAMES, createMcpServer, createMcpSupervisorFromEnv } from "../src/mcp.js";
import { ClaudeSupervisor } from "../src/core/supervisor.js";
import { startFakeOpenCodeServer } from "./fixtures/fake-opencode-server.js";

const fixturePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures/fake-claude.mjs");

describe("MCP tools", () => {
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
    expect(RETINUE_TOOL_NAMES).toEqual(["retinue_spawn_agent", "retinue_wait_agent", "retinue_close_agent"]);
  });

  it("creates a server instance with registered tools", () => {
    const server = createMcpServer(new ClaudeSupervisor({ stateDir: "unused" }));

    expect(server).toBeTruthy();
    expect(server.server).toBeTruthy();
  });

  it("creates a daemon-backed supervisor when SUPERVISOR_DAEMON_URL is set", () => {
    const supervisor = createMcpSupervisorFromEnv({
      SUPERVISOR_DAEMON_URL: "http://127.0.0.1:27777"
    });

    expect(supervisor.constructor.name).toBe("DaemonClient");
  });

  it("discovers a daemon-backed supervisor when explicitly requested", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "supervisor-mcp-discovery-test-"));
    try {
      await writeDaemonDiscovery(tempDir, {
        url: "http://127.0.0.1:27777",
        pid: process.pid,
        startedAt: "2026-05-04T00:00:00.000Z",
        version: "0.1.0"
      });

      const supervisor = createMcpSupervisorFromEnv({
        SUPERVISOR_STATE_DIR: tempDir,
        SUPERVISOR_DAEMON_DISCOVERY: "1"
      });

      expect(supervisor.constructor.name).toBe("DaemonClient");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("calls Claude lifecycle tools through daemon RPC", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "supervisor-mcp-daemon-test-"));
    const daemon = createDaemonServer(
      new ClaudeSupervisor({
        stateDir: tempDir,
        claudeCommand: process.execPath,
        claudePrefixArgs: [fixturePath]
      })
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "supervisor-test-client", version: "0.1.0" });

    try {
      await new Promise<void>((resolve) => daemon.listen(0, "127.0.0.1", resolve));
      const address = daemon.address() as AddressInfo;
      const mcpServer = createMcpServer(
        createMcpSupervisorFromEnv({
          SUPERVISOR_DAEMON_URL: `http://127.0.0.1:${address.port}`
        })
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
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "supervisor-mcp-reconnect-test-"));
    const daemon = createDaemonServer(
      new ClaudeSupervisor({
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
    const connection = await connectMcpClientWithSupervisor(new ClaudeSupervisor({ stateDir: "unused" }));
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
    const connection = await connectMcpClientWithSupervisor(new ClaudeSupervisor({ stateDir: "unused" }));
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
    const connection = await connectMcpClientWithSupervisor(new ClaudeSupervisor({ stateDir: "unused" }));
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
    const connection = await connectMcpClientWithSupervisor(new ClaudeSupervisor({ stateDir: "unused" }));
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
      assertAbsentFields(tools.tools, "retinue_spawn_agent", ["backend", "profile", "model", "agent", "permissionMode", "opencodeBaseUrl"]);
      assertRequiredFields(tools.tools, "retinue_wait_agent", ["jobId"]);
      assertAbsentFields(tools.tools, "retinue_wait_agent", ["backend", "profile", "model", "agent", "permissionMode", "opencodeBaseUrl"]);
      assertRequiredFields(tools.tools, "retinue_close_agent", ["jobId"]);
      assertAbsentFields(tools.tools, "retinue_close_agent", ["backend", "profile", "model", "agent", "permissionMode", "opencodeBaseUrl"]);
    } finally {
      await closeMcpClient(connection);
    }
  });

  it("runs the Retinue OpenCode-first spawn/wait/result/close flow without backend arguments", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "supervisor-mcp-retinue-opencode-"));
    const fakeOpenCode = await startFakeOpenCodeServer();
    const connection = await connectMcpClientWithSupervisor(new ClaudeSupervisor({ stateDir: "unused" }));
    try {
      process.env.SUPERVISOR_STATE_DIR = tempDir;
      process.env.SUPERVISOR_OPENCODE_BASE_URL = fakeOpenCode.url;

      const spawn = parseToolJson(
        await connection.client.callTool({
          name: "retinue_spawn_agent",
          arguments: { cwd: tempDir, message: "retinue mcp", task_name: "smoke" }
        })
      );
      expect(spawn).toMatchObject({ task_name: "smoke", backend: "opencode", status: "running" });
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
        result: { parsedStdout: { result: "fake result: retinue mcp" } }
      });

      const close = parseToolJson(
        await connection.client.callTool({
          name: "retinue_close_agent",
          arguments: { jobId: spawn.jobId }
        })
      );
      expect(close).toMatchObject({ jobId: spawn.jobId, status: "completed" });
    } finally {
      delete process.env.SUPERVISOR_STATE_DIR;
      delete process.env.SUPERVISOR_OPENCODE_BASE_URL;
      await Promise.allSettled([closeMcpClient(connection), fakeOpenCode.close()]);
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps Retinue wait/close bound to the spawned OpenCode backend even if deployment env changes", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "supervisor-mcp-retinue-opencode-bound-"));
    const fakeOpenCode = await startFakeOpenCodeServer();
    const connection = await connectMcpClientWithSupervisor(new ClaudeSupervisor({ stateDir: tempDir }));
    try {
      process.env.SUPERVISOR_STATE_DIR = tempDir;
      process.env.SUPERVISOR_OPENCODE_BASE_URL = fakeOpenCode.url;

      const spawn = parseToolJson(
        await connection.client.callTool({
          name: "retinue_spawn_agent",
          arguments: { cwd: tempDir, message: "retinue bound opencode", task_name: "bound-opencode" }
        })
      );
      expect(spawn).toMatchObject({ task_name: "bound-opencode", backend: "opencode", status: "running" });
      fakeOpenCode.completeSession(spawn.externalSessionId);

      process.env.SUPERVISOR_RETINUE_BACKEND = "claude-code";

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
        result: { parsedStdout: { result: "fake result: retinue bound opencode" } }
      });

      const close = parseToolJson(
        await connection.client.callTool({
          name: "retinue_close_agent",
          arguments: { jobId: spawn.jobId }
        })
      );
      expect(close).toMatchObject({ jobId: spawn.jobId, status: "completed" });
    } finally {
      delete process.env.SUPERVISOR_STATE_DIR;
      delete process.env.SUPERVISOR_OPENCODE_BASE_URL;
      delete process.env.SUPERVISOR_RETINUE_BACKEND;
      await Promise.allSettled([closeMcpClient(connection), fakeOpenCode.close()]);
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("runs the Retinue Claude Code parity flow when deployment selects claude-code", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "supervisor-mcp-retinue-claude-"));
    const connection = await connectMcpClientWithSupervisor(
      new ClaudeSupervisor({
        stateDir: tempDir,
        claudeCommand: process.execPath,
        claudePrefixArgs: [fixturePath]
      })
    );
    try {
      process.env.SUPERVISOR_RETINUE_BACKEND = "claude-code";

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
      delete process.env.SUPERVISOR_RETINUE_BACKEND;
      await closeMcpClient(connection);
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps Retinue wait/close bound to the spawned Claude backend even if deployment env changes", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "supervisor-mcp-retinue-claude-bound-"));
    const connection = await connectMcpClientWithSupervisor(
      new ClaudeSupervisor({
        stateDir: tempDir,
        claudeCommand: process.execPath,
        claudePrefixArgs: [fixturePath]
      })
    );
    try {
      process.env.SUPERVISOR_STATE_DIR = tempDir;
      process.env.SUPERVISOR_RETINUE_BACKEND = "claude-code";

      const spawn = parseToolJson(
        await connection.client.callTool({
          name: "retinue_spawn_agent",
          arguments: { cwd: tempDir, message: "retinue bound claude", task_name: "bound-claude" }
        })
      );
      expect(spawn).toMatchObject({ task_name: "bound-claude", backend: "claude-code", status: "running" });

      process.env.SUPERVISOR_RETINUE_BACKEND = "opencode";

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
      delete process.env.SUPERVISOR_STATE_DIR;
      delete process.env.SUPERVISOR_RETINUE_BACKEND;
      await closeMcpClient(connection);
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("calls OpenCode lifecycle tools through an explicit server URL", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "supervisor-mcp-opencode-test-"));
    const fakeOpenCode = await startFakeOpenCodeServer();
    const connection = await connectMcpClientWithSupervisor(new ClaudeSupervisor({ stateDir: "unused" }));
    try {
      process.env.SUPERVISOR_STATE_DIR = tempDir;
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
      delete process.env.SUPERVISOR_STATE_DIR;
      await Promise.allSettled([closeMcpClient(connection), fakeOpenCode.close()]);
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps the MCP connection alive when OpenCode auto-serve cannot start", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "supervisor-mcp-opencode-spawn-error-"));
    const port = await freePort();
    const connection = await connectMcpClientWithSupervisor(new ClaudeSupervisor({ stateDir: "unused" }));
    try {
      process.env.SUPERVISOR_STATE_DIR = tempDir;
      process.env.SUPERVISOR_OPENCODE_AUTO_SERVE = "1";
      process.env.SUPERVISOR_OPENCODE_COMMAND = "retinue-missing-opencode-command";
      process.env.SUPERVISOR_OPENCODE_PORT = String(port);

      const result = (await connection.client.callTool({
        name: "opencode_status",
        arguments: { jobId: "nonexistent" }
      })) as { isError?: boolean; content?: Array<{ type: string; text?: string }> };
      const text = result.content?.find((item) => item.type === "text")?.text;

      expect(result.isError).toBe(true);
      expect(text).toContain('Failed to start OpenCode server command "retinue-missing-opencode-command"');
      await expect(connection.client.listTools()).resolves.toMatchObject({
        tools: expect.arrayContaining([expect.objectContaining({ name: "opencode_status" })])
      });
    } finally {
      delete process.env.SUPERVISOR_STATE_DIR;
      delete process.env.SUPERVISOR_OPENCODE_AUTO_SERVE;
      delete process.env.SUPERVISOR_OPENCODE_COMMAND;
      delete process.env.SUPERVISOR_OPENCODE_PORT;
      await closeMcpClient(connection);
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("uses OpenCode model and agent defaults from environment for MCP runs", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "supervisor-mcp-opencode-defaults-"));
    const fakeOpenCode = await startFakeOpenCodeServer();
    const connection = await connectMcpClientWithSupervisor(new ClaudeSupervisor({ stateDir: "unused" }));
    try {
      process.env.SUPERVISOR_STATE_DIR = tempDir;
      process.env.SUPERVISOR_OPENCODE_MODEL = "litellm/pro-router";
      process.env.SUPERVISOR_OPENCODE_AGENT = "build";
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
      delete process.env.SUPERVISOR_STATE_DIR;
      delete process.env.SUPERVISOR_OPENCODE_MODEL;
      delete process.env.SUPERVISOR_OPENCODE_AGENT;
      await Promise.allSettled([closeMcpClient(connection), fakeOpenCode.close()]);
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("throws a controlled error for invalid daemon discovery URL configuration", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "supervisor-mcp-bad-discovery-"));
    try {
      await writeDaemonDiscovery(tempDir, {
        url: "not-a-url",
        pid: process.pid,
        startedAt: "2026-05-04T00:00:00.000Z",
        version: "0.1.0"
      });

      expect(() =>
        createMcpSupervisorFromEnv({
          SUPERVISOR_STATE_DIR: tempDir,
          SUPERVISOR_DAEMON_DISCOVERY: "1"
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
  const client = new Client({ name: "supervisor-test-client", version: "0.1.0" });
  const mcpServer = createMcpServer(
    createMcpSupervisorFromEnv({
      SUPERVISOR_DAEMON_URL: daemonUrl
    })
  );
  await Promise.all([mcpServer.connect(serverTransport), client.connect(clientTransport)]);
  return { client, clientTransport, serverTransport };
}

async function connectMcpClientWithSupervisor(supervisor: ClaudeSupervisor) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "supervisor-test-client", version: "0.1.0" });
  const mcpServer = createMcpServer(supervisor);
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
