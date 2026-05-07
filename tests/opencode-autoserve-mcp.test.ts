import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { getOpenCodeServerDiscoveryPath } from "../src/core/paths.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mcpPath = path.join(repoRoot, "src/mcp.ts");
const tsxCliPath = path.join(repoRoot, "node_modules/tsx/dist/cli.mjs");
const fakeOpenCodeCommand = path.join(repoRoot, "tests/fixtures/fake-opencode-cli.mjs");

describe("Retinue OpenCode auto-serve MCP E2E", () => {
  let tempDir: string;
  let occupied: Awaited<ReturnType<typeof startExternalServer>> | undefined;
  let first: Awaited<ReturnType<typeof connectRetinueMcp>> | undefined;
  let second: Awaited<ReturnType<typeof connectRetinueMcp>> | undefined;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "retinue-opencode-autoserve-mcp-"));
  });

  afterEach(async () => {
    await Promise.allSettled([
      first ? closeRetinueMcp(first) : Promise.resolve(),
      second ? closeRetinueMcp(second) : Promise.resolve(),
      occupied ? occupied.close() : Promise.resolve()
    ]);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("lets two independent MCP processes share a Retinue-managed fallback OpenCode server", async () => {
    occupied = await startExternalServer();
    const fallbackPort = await freePort();
    const env = {
      SUPERVISOR_STATE_DIR: tempDir,
      SUPERVISOR_RETINUE_BACKEND: "opencode",
      SUPERVISOR_OPENCODE_AUTO_SERVE: "1",
      SUPERVISOR_OPENCODE_COMMAND: process.execPath,
      SUPERVISOR_OPENCODE_PREFIX_ARGS: fakeOpenCodeCommand,
      SUPERVISOR_OPENCODE_HOST: "127.0.0.1",
      SUPERVISOR_OPENCODE_PORT: String(occupied.port),
      SUPERVISOR_OPENCODE_FALLBACK_PORTS: String(fallbackPort),
      SUPERVISOR_OPENCODE_AGENT: "plan"
    };

    first = await connectRetinueMcp(env);
    second = await connectRetinueMcp(env);

    const firstSpawn = parseToolJson(
      await first.client.callTool({
        name: "retinue_spawn_agent",
        arguments: { cwd: tempDir, task_name: "first-thread", message: "Reply exactly: FIRST_OK" }
      })
    );
    const secondSpawn = parseToolJson(
      await second.client.callTool({
        name: "retinue_spawn_agent",
        arguments: { cwd: tempDir, task_name: "second-thread", message: "Reply exactly: SECOND_OK" }
      })
    );

    const firstWait = parseToolJson(await first.client.callTool({ name: "retinue_wait_agent", arguments: { jobId: firstSpawn.jobId, timeoutMs: 5000 } }));
    const secondWait = parseToolJson(await second.client.callTool({ name: "retinue_wait_agent", arguments: { jobId: secondSpawn.jobId, timeoutMs: 5000 } }));

    expect(firstWait).toMatchObject({ status: "completed", result: { parsedStdout: { result: "fake cli result: Reply exactly: FIRST_OK" } } });
    expect(secondWait).toMatchObject({ status: "completed", result: { parsedStdout: { result: "fake cli result: Reply exactly: SECOND_OK" } } });

    const discovery = JSON.parse(await fs.readFile(getOpenCodeServerDiscoveryPath(tempDir), "utf8")) as { baseUrl?: string };
    expect(discovery.baseUrl).toBe(`http://127.0.0.1:${fallbackPort}`);
  });
});

async function connectRetinueMcp(env: Record<string, string>) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [tsxCliPath, mcpPath],
    cwd: repoRoot,
    env,
    stderr: "pipe"
  });
  const client = new Client({ name: "retinue-autoserve-test", version: "0.1.0" });
  await client.connect(transport);
  return { client, transport };
}

async function closeRetinueMcp(connection: Awaited<ReturnType<typeof connectRetinueMcp>>): Promise<void> {
  await Promise.allSettled([connection.client.close(), connection.transport.close()]);
}

function parseToolJson(result: unknown): any {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content;
  const text = content?.find((item) => item.type === "text")?.text;
  if (!text) {
    throw new Error("Tool result did not include text content");
  }
  return JSON.parse(text);
}

async function startExternalServer(): Promise<{ port: number; close(): Promise<void> }> {
  const server = http.createServer((_request, response) => {
    response.statusCode = 200;
    response.end("external service");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    port: address.port,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  };
}

async function freePort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return address.port;
}
