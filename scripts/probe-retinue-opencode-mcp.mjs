#!/usr/bin/env node

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtemp, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createMcpServer } from "../dist/mcp.js";

const OPT_IN_ENV = "RETINUE_REAL_OPENCODE_PROBE";

async function main() {
  if (process.env[OPT_IN_ENV] !== "1") {
    throw new Error(`Manual probe blocked. Set ${OPT_IN_ENV}=1 to run this script.`);
  }
  if (!process.env.RETINUE_OPENCODE_BASE_URL) {
    throw new Error("Missing RETINUE_OPENCODE_BASE_URL.");
  }
  const stateDir = await ensureStateDir(process.env.RETINUE_STATE_DIR);
  process.env.RETINUE_BACKEND = "opencode";
  process.env.RETINUE_STATE_DIR = stateDir;

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "retinue-opencode-real-probe", version: "0.1.0" });
  const server = createMcpServer();

  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const cwd = process.cwd();
    const spawn = parseToolJson(
      await client.callTool({
        name: "retinue_spawn_agent",
        arguments: {
          cwd,
          task_name: "real-opencode-smoke",
          message: "Reply exactly: RETINUE_OPENCODE_REAL_OK"
        }
      })
    );

    const wait = parseToolJson(
      await client.callTool({
        name: "retinue_wait_agent",
        arguments: { jobId: spawn.jobId, timeoutMs: 120000 }
      }, undefined, { timeout: 150000 })
    );

    const actual = wait?.result?.parsedStdout?.result;
    if (wait.status !== "completed" || typeof actual !== "string" || !actual.includes("RETINUE_OPENCODE_REAL_OK")) {
      throw new Error(`Unexpected Retinue/OpenCode result: ${JSON.stringify(wait)}`);
    }

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
          externalSessionId: spawn.externalSessionId,
          status: wait.status,
          result: actual,
          closeStatus: close.status,
          stateDir,
          tracePath: path.join(stateDir, "logs", "retinue.jsonl")
        },
        null,
        2
      )}\n`
    );
  } finally {
    await Promise.allSettled([client.close(), clientTransport.close(), serverTransport.close()]);
  }
}

async function ensureStateDir(stateDir) {
  if (stateDir) {
    await mkdir(stateDir, { recursive: true });
    return stateDir;
  }
  return mkdtemp(path.join(os.tmpdir(), "retinue-opencode-real-state-"));
}

function parseToolJson(result) {
  const text = result?.content?.find((item) => item.type === "text")?.text;
  if (!text) {
    throw new Error("Tool result did not include text content");
  }
  return JSON.parse(text);
}

main().catch((error) => {
  const stateDir = process.env.RETINUE_STATE_DIR;
  process.stderr.write(
    `${JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      stateDir,
      tracePath: stateDir ? path.join(stateDir, "logs", "retinue.jsonl") : undefined
    })}\n`
  );
  process.exitCode = 1;
});
