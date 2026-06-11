#!/usr/bin/env node

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtemp, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createMcpServer } from "../dist/mcp.js";

const OPT_IN_ENV = "RETINUE_REAL_OPENCODE_PROBE";
const EXPECTED_MARKER = "RETINUE_OPENCODE_REAL_OK";

async function main() {
  if (process.env[OPT_IN_ENV] !== "1") {
    throw new Error(`Manual probe blocked. Set ${OPT_IN_ENV}=1 to run this script.`);
  }
  const stateDir = await ensureStateDir(process.env.RETINUE_STATE_DIR);
  process.env.RETINUE_BACKEND = "opencode";
  process.env.RETINUE_STATE_DIR = stateDir;
  process.env.RETINUE_OPENCODE_AUTO_SERVE = process.env.RETINUE_OPENCODE_AUTO_SERVE ?? "1";
  process.env.RETINUE_OPENCODE_HOST = process.env.RETINUE_OPENCODE_HOST ?? "127.0.0.1";
  process.env.RETINUE_OPENCODE_AGENT = process.env.RETINUE_OPENCODE_AGENT ?? "explore";

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "retinue-opencode-real-probe", version: "0.1.0" });
  const server = createMcpServer();

  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const cwd = process.cwd();
    const spawn = parseToolJson(
      await client.callTool({
        name: "spawn_agent",
        arguments: {
          cwd,
          task_name: "real-opencode-smoke",
          message: `Reply exactly: ${EXPECTED_MARKER}`
        }
      })
    );

    const wait = parseToolJson(
      await client.callTool({
        name: "wait_agent",
        arguments: { jobId: spawn.jobId, timeoutMs: 120000 }
      }, undefined, { timeout: 150000 })
    );

    const actual = wait?.result?.parsedStdout?.result;
    if (wait.status !== "completed" || typeof actual !== "string" || !isAcceptableMarker(actual)) {
      throw new Error(`Unexpected Retinue/OpenCode result: ${JSON.stringify(wait)}`);
    }

    const close = parseToolJson(
      await client.callTool({
        name: "close_agent",
        arguments: { jobId: spawn.jobId }
      })
    );

    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          retinueBackend: process.env.RETINUE_BACKEND,
          mode: process.env.RETINUE_OPENCODE_BASE_URL ? "attach" : "auto-serve",
          baseUrl: process.env.RETINUE_OPENCODE_BASE_URL,
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

function isAcceptableMarker(value) {
  const normalized = value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const expected = EXPECTED_MARKER.replace(/[^A-Z0-9]/g, "");
  if (normalized.includes(expected)) {
    return true;
  }
  for (let start = 0; start < normalized.length; start += 1) {
    for (const length of [expected.length - 2, expected.length - 1, expected.length, expected.length + 1, expected.length + 2]) {
      if (length <= 0 || start + length > normalized.length) {
        continue;
      }
      if (editDistance(normalized.slice(start, start + length), expected) <= 2) {
        return true;
      }
    }
  }
  return false;
}

function editDistance(left, right) {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 0; leftIndex < left.length; leftIndex += 1) {
    let diagonal = previous[0];
    previous[0] = leftIndex + 1;
    for (let rightIndex = 0; rightIndex < right.length; rightIndex += 1) {
      const above = previous[rightIndex + 1];
      previous[rightIndex + 1] =
        left[leftIndex] === right[rightIndex]
          ? diagonal
          : Math.min(previous[rightIndex], above, diagonal) + 1;
      diagonal = above;
    }
  }
  return previous[right.length];
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    const stateDir = process.env.RETINUE_STATE_DIR;
    process.stderr.write(
      `${JSON.stringify({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        stateDir,
        tracePath: stateDir ? path.join(stateDir, "logs", "retinue.jsonl") : undefined
      })}\n`
    );
    process.exit(1);
  });
