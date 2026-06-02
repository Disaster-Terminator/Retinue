#!/usr/bin/env node

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createMcpServer } from "../dist/mcp.js";

const timeoutMs = Number.parseInt(process.env.RETINUE_CROSS_SESSION_PROBE_TIMEOUT_MS ?? "180000", 10);
const writable = process.env.RETINUE_CROSS_SESSION_WRITABLE === "1";

async function main() {
  const stateDir = process.env.RETINUE_STATE_DIR ?? (await mkdtemp(path.join(os.tmpdir(), "retinue-cross-session-state-")));
  const cwd = process.env.RETINUE_CROSS_SESSION_CWD ?? (await mkdtemp(path.join(os.tmpdir(), "retinue-cross-session-work-")));
  await mkdir(stateDir, { recursive: true });
  await mkdir(cwd, { recursive: true });

  const markerPath = path.join(cwd, "RETINUE_CROSS_SESSION_MARKER.txt");
  await writeFile(markerPath, "initial\n", "utf8");

  const previous = snapshotEnv([
    "RETINUE_BACKEND",
    "RETINUE_STATE_DIR",
    "RETINUE_OPENCODE_AUTO_SERVE",
    "RETINUE_OPENCODE_HOST",
    "RETINUE_OPENCODE_ROOT_BINDING_MODE",
    "RETINUE_OPENCODE_AGENT"
  ]);
  process.env.RETINUE_BACKEND = "opencode";
  process.env.RETINUE_STATE_DIR = stateDir;
  process.env.RETINUE_OPENCODE_AUTO_SERVE = process.env.RETINUE_OPENCODE_AUTO_SERVE ?? "1";
  process.env.RETINUE_OPENCODE_HOST = process.env.RETINUE_OPENCODE_HOST ?? "127.0.0.1";
  process.env.RETINUE_OPENCODE_ROOT_BINDING_MODE = "shared_root";
  process.env.RETINUE_OPENCODE_AGENT = writable ? "build" : "explore";

  const a = await connect("a");
  const b = await connect("b");
  try {
    const spawns = await Promise.all([
      spawn(a.client, cwd, "a-one", writable),
      spawn(a.client, cwd, "a-two", writable),
      spawn(b.client, cwd, "b-one", writable),
      spawn(b.client, cwd, "b-two", writable)
    ]);
    const waits = await Promise.all(spawns.map((spawned) => waitTerminal(spawned.client, spawned.jobId)));
    await Promise.allSettled(
      spawns.map((spawned) => spawned.client.callTool({ name: "retinue_close_agent", arguments: { jobId: spawned.jobId } }))
    );
    await a.client.callTool({
      name: "retinue_stop_runtime",
      arguments: { runtime: "opencode", all: true, force: true }
    });

    const rootsA = unique(spawns.filter((item) => item.group === "a").map((item) => item.externalRootSessionId));
    const rootsB = unique(spawns.filter((item) => item.group === "b").map((item) => item.externalRootSessionId));
    const output = {
      ok: rootsA.length === 1 && rootsB.length === 1 && rootsA[0] !== rootsB[0] && waits.every((item) => item.status === "completed"),
      writable,
      cwd,
      stateDir,
      tracePath: path.join(stateDir, "logs", "retinue.jsonl"),
      rootsA,
      rootsB,
      spawns: spawns.map(({ client, ...rest }) => rest),
      waits: waits.map((wait) => ({
        jobId: wait.jobId,
        status: wait.status,
        stallReason: wait.diagnostic?.stallReason
      })),
      markerText: await readFile(markerPath, "utf8").catch(() => "")
    };
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    if (!output.ok) process.exitCode = 1;
  } finally {
    restoreEnv(previous);
    await Promise.allSettled([a.close(), b.close()]);
    if (!process.env.RETINUE_CROSS_SESSION_CWD) {
      await rm(cwd, { recursive: true, force: true });
    }
  }
}

async function connect(name) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: `retinue-cross-session-${name}`, version: "0.1.0" });
  const server = createMcpServer();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    close: async () => {
      await Promise.allSettled([client.close(), clientTransport.close(), serverTransport.close()]);
    }
  };
}

async function spawn(client, cwd, name, canWrite) {
  const message = canWrite
    ? `Append one line containing ${name} to RETINUE_CROSS_SESSION_MARKER.txt, then answer with ${name} DONE.`
    : `Read RETINUE_CROSS_SESSION_MARKER.txt, then answer with ${name} DONE.`;
  const parsed = parseToolJson(
    await client.callTool({
      name: "retinue_spawn_agent",
      arguments: { cwd, task_name: `cross-session-${name}`, agent: canWrite ? "build" : "explore", message }
    })
  );
  return { ...parsed, client, group: name.slice(0, 1) };
}

async function waitTerminal(client, jobId) {
  const deadline = Date.now() + timeoutMs;
  let last;
  do {
    const remaining = Math.max(1, deadline - Date.now());
    last = parseToolJson(
      await client.callTool(
        { name: "retinue_wait_agent", arguments: { jobId, timeoutMs: remaining } },
        undefined,
        { timeout: remaining + 30000 }
      )
    );
    if (last.status !== "running" && last.status !== "queued") {
      return { ...last, jobId };
    }
    await sleep(500);
  } while (Date.now() < deadline);
  return { ...last, jobId };
}

function parseToolJson(result) {
  const text = result?.content?.find((item) => item.type === "text")?.text;
  if (!text) {
    throw new Error("tool result did not include text JSON");
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`tool result was not JSON: ${text.slice(0, 200)}`, { cause: error });
  }
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function snapshotEnv(keys) {
  return Object.fromEntries(keys.map((key) => [key, process.env[key]]));
}

function restoreEnv(previous) {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exitCode = 1;
});
