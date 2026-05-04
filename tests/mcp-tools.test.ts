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
import { CLAUDE_TOOL_NAMES, createMcpServer, createMcpSupervisorFromEnv } from "../src/mcp.js";
import { ClaudeSupervisor } from "../src/core/supervisor.js";

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
