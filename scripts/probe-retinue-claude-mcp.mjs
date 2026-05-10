#!/usr/bin/env node

import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { assertExpectedResult, parseProbeArgs } from "../dist/core/probeRealClaudeHelpers.js";
import { createMcpServer } from "../dist/mcp.js";

async function main() {
  const options = parseProbeArgs(["direct", ...process.argv.slice(2)]);
  const stateDir = options.stateDir ?? (await mkdtemp(path.join(os.tmpdir(), "retinue-claude-real-state-")));
  const previousStateDir = process.env.RETINUE_STATE_DIR;
  const previousBackend = process.env.RETINUE_BACKEND;
  process.env.RETINUE_STATE_DIR = stateDir;
  process.env.RETINUE_BACKEND = "claude-code";

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "retinue-claude-real-probe", version: "0.1.0" });
  const server = createMcpServer();

  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const spawn = parseToolJson(
      await client.callTool({
        name: "retinue_spawn_agent",
        arguments: {
          cwd: options.cwd,
          task_name: "real-claude-smoke",
          message: options.prompt
        }
      })
    );

    const wait = parseToolJson(
      await client.callTool({
        name: "retinue_wait_agent",
        arguments: { jobId: spawn.jobId, timeoutMs: options.timeoutMs }
      }, undefined, { timeout: options.timeoutMs + 30_000 })
    );
    const actual = assertExpectedResult(wait.result, options.expected);

    const close = parseToolJson(
      await client.callTool({
        name: "retinue_close_agent",
        arguments: { jobId: spawn.jobId }
      })
    );

    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          retinueBackend: process.env.RETINUE_BACKEND,
          backend: spawn.backend,
          task_name: spawn.task_name,
          jobId: spawn.jobId,
          status: wait.status,
          result: actual,
          closeStatus: close.status,
          stateDir
        },
        null,
        2
      )}\n`
    );
  } finally {
    await Promise.allSettled([client.close(), clientTransport.close(), serverTransport.close()]);
    restoreEnv("RETINUE_STATE_DIR", previousStateDir);
    restoreEnv("RETINUE_BACKEND", previousBackend);
  }
}

function parseToolJson(result) {
  const text = result?.content?.find((item) => item.type === "text")?.text;
  if (!text) {
    throw new Error("Tool result did not include text content");
  }
  return JSON.parse(text);
}

function restoreEnv(name, value) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`);
  process.exitCode = 1;
});
