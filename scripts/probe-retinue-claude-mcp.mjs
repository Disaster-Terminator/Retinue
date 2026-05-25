#!/usr/bin/env node

import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { assertCompletedResult, assertExpectedResult, parseProbeArgs } from "../dist/core/probeRealClaudeHelpers.js";
import { createMcpServer } from "../dist/mcp.js";

let activeStateDir;

async function main() {
  const permissionProbe = process.argv.includes("--permission");
  const probeArgs = process.argv.slice(2).filter((arg) => arg !== "--permission");
  const options = parseProbeArgs(["direct", ...probeArgs]);
  const stateDir = options.stateDir ?? (await mkdtemp(path.join(os.tmpdir(), "retinue-claude-real-state-")));
  activeStateDir = stateDir;
  const previousStateDir = process.env.RETINUE_STATE_DIR;
  const previousBackend = process.env.RETINUE_BACKEND;
  process.env.RETINUE_STATE_DIR = stateDir;
  process.env.RETINUE_BACKEND = "claude-code";

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "retinue-claude-real-probe", version: "0.1.0" });
  const server = createMcpServer();
  let spawnedJobId;
  let close;

  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const spawn = parseToolJson(
      await client.callTool({
        name: "retinue_spawn_agent",
        arguments: {
          cwd: options.cwd,
          task_name: permissionProbe ? "real-claude-permission" : "real-claude-smoke",
          message: permissionProbe ? "Use the Read tool to read /etc/hostname, then reply exactly: RETINUE_CLAUDE_PERMISSION_OK" : options.prompt
        }
      })
    );
    spawnedJobId = spawn.jobId;

    const wait = permissionProbe
      ? await waitThroughPermission(client, spawn.jobId, options.timeoutMs)
      : parseToolJson(
          await client.callTool({
            name: "retinue_wait_agent",
            arguments: { jobId: spawn.jobId, timeoutMs: options.timeoutMs }
          }, undefined, { timeout: options.timeoutMs + 30_000 })
        );
    const actual = permissionProbe ? assertCompletedResult(wait.result) : assertExpectedResult(wait.result, options.expected);

    close = parseToolJson(
      await client.callTool({
        name: "retinue_close_agent",
        arguments: { jobId: spawn.jobId }
      })
    );
    spawnedJobId = undefined;

    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          retinueBackend: process.env.RETINUE_BACKEND,
          backend: spawn.backend,
          task_name: spawn.task_name,
          jobId: spawn.jobId,
          mode: permissionProbe ? "permission" : "completion",
          status: wait.status,
          result: actual,
          permission: wait.permission,
          closeStatus: close.status,
          stateDir
        },
        null,
        2
      )}\n`
    );
  } finally {
    if (spawnedJobId) {
      await bestEffortClose(client, spawnedJobId);
    }
    await Promise.allSettled([client.close(), clientTransport.close(), serverTransport.close()]);
    restoreEnv("RETINUE_STATE_DIR", previousStateDir);
    restoreEnv("RETINUE_BACKEND", previousBackend);
  }
}

async function bestEffortClose(client, jobId) {
  try {
    await client.callTool({
      name: "retinue_close_agent",
      arguments: { jobId }
    });
  } catch {
    // Preserve the original probe failure.
  }
}

async function waitThroughPermission(client, jobId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const first = parseToolJson(
    await client.callTool({
      name: "retinue_wait_agent",
      arguments: { jobId, timeoutMs: Math.min(timeoutMs, 15000) }
    }, undefined, { timeout: timeoutMs + 30_000 })
  );
  const permission = first.permissions?.[0];
  if (!permission?.id) {
    throw new Error(`Expected Claude SDK permission request, got ${JSON.stringify(first).slice(0, 500)}`);
  }
  const reply = parseToolJson(
    await client.callTool({
      name: "retinue_reply_permission",
      arguments: { jobId, requestId: permission.id, reply: "once" }
    })
  );
  const second = await waitUntilTerminal(client, jobId, Math.max(0, deadline - Date.now()));
  return {
    ...second,
    permission: {
      requestId: permission.id,
      permission: permission.permission,
      reply: reply.reply
    }
  };
}

async function waitUntilTerminal(client, jobId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() <= deadline) {
    const remaining = Math.max(0, deadline - Date.now());
    const waitMs = Math.min(Math.max(remaining, 1), 15000);
    last = parseToolJson(
      await client.callTool({
        name: "retinue_wait_agent",
        arguments: { jobId, timeoutMs: waitMs }
      }, undefined, { timeout: waitMs + 30_000 })
    );
    if (last.status !== "running") {
      return last;
    }
    await sleep(Math.min(1000, Math.max(100, remaining)));
  }
  return last ?? { jobId, status: "running" };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  process.stderr.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error), stateDir: activeStateDir })}\n`);
  process.exitCode = 1;
});
