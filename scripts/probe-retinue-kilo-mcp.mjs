#!/usr/bin/env node

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createMcpServer } from "../dist/mcp.js";

const OPT_IN_ENV = "RETINUE_REAL_KILO_PROBE";
const EXPECTED_MARKER = "RETINUE_KILO_REAL_OK";
const EXPECTED_PERMISSION_MARKER = "RETINUE_KILO_PERMISSION_OK";

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (process.env[OPT_IN_ENV] !== "1") {
    throw new Error(`Manual probe blocked. Set ${OPT_IN_ENV}=1 to run this script.`);
  }
  const stateDir = await ensureStateDir(process.env.RETINUE_STATE_DIR);
  process.env.RETINUE_BACKEND = "kilo";
  process.env.RETINUE_STATE_DIR = stateDir;
  process.env.RETINUE_KILO_AUTO_SERVE = process.env.RETINUE_KILO_AUTO_SERVE ?? "1";
  process.env.RETINUE_KILO_HOST = process.env.RETINUE_KILO_HOST ?? "127.0.0.1";
  process.env.RETINUE_KILO_AGENT = process.env.RETINUE_KILO_AGENT ?? "explore";

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "retinue-kilo-real-probe", version: "0.1.0" });
  const server = createMcpServer();

  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const result = options.permission
      ? await runPermissionProbe(client, stateDir)
      : await runSmokeProbe(client, stateDir);

    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    await Promise.allSettled([client.close(), clientTransport.close(), serverTransport.close()]);
  }
}

async function runSmokeProbe(client, stateDir) {
  const cwd = process.cwd();
  const spawn = parseToolJson(
    await client.callTool({
      name: "retinue_spawn_agent",
      arguments: {
        cwd,
        task_name: "real-kilo-smoke",
        message: `Reply exactly: ${EXPECTED_MARKER}`
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
  if (wait.status !== "completed" || typeof actual !== "string" || !isAcceptableMarker(actual, EXPECTED_MARKER)) {
    throw new Error(`Unexpected Retinue/Kilo result: ${JSON.stringify(wait)}`);
  }

  const close = parseToolJson(
    await client.callTool({
      name: "retinue_close_agent",
      arguments: { jobId: spawn.jobId }
    })
  );

  return baseOutput({
    spawn,
    status: wait.status,
    result: actual,
    closeStatus: close.status,
    stateDir,
    probe: "completion"
  });
}

async function runPermissionProbe(client, stateDir) {
  const cwd = process.cwd();
  const externalDir = await mkdtemp(path.join(os.tmpdir(), "retinue-kilo-permission-target-"));
  const externalFile = path.join(externalDir, "marker.txt");
  await writeFile(externalFile, `${EXPECTED_PERMISSION_MARKER}\n`, "utf8");

  const spawn = parseToolJson(
    await client.callTool({
      name: "retinue_spawn_agent",
      arguments: {
        cwd,
        task_name: "real-kilo-permission",
        message: [
          `Use the read tool to read this exact file outside the workspace: ${externalFile}`,
          `Then reply exactly with the file content: ${EXPECTED_PERMISSION_MARKER}`
        ].join("\n")
      }
    })
  );

  let wait = parseToolJson(
    await client.callTool({
      name: "retinue_wait_agent",
      arguments: { jobId: spawn.jobId, timeoutMs: 120000 }
    }, undefined, { timeout: 150000 })
  );

  if (!wait.permissionRequired) {
    throw new Error(`Expected Retinue/Kilo permission wait but got: ${JSON.stringify(wait)}`);
  }

  const permissions = parseToolJson(
    await client.callTool({
      name: "retinue_list_permissions",
      arguments: { jobId: spawn.jobId }
    })
  );
  const request = permissions.permissions?.[0];
  if (!request?.id || request.permission !== "external_directory") {
    throw new Error(`Expected external_directory permission but got: ${JSON.stringify(permissions)}`);
  }

  const reply = parseToolJson(
    await client.callTool({
      name: "retinue_reply_permission",
      arguments: { jobId: spawn.jobId, requestId: request.id, reply: "once" }
    })
  );

  wait = parseToolJson(
    await client.callTool({
      name: "retinue_wait_agent",
      arguments: { jobId: spawn.jobId, timeoutMs: 120000 }
    }, undefined, { timeout: 150000 })
  );

  const actual = wait?.result?.parsedStdout?.result;
  if (wait.status !== "completed" || typeof actual !== "string" || !isAcceptableMarker(actual, EXPECTED_PERMISSION_MARKER)) {
    throw new Error(`Unexpected Retinue/Kilo permission result: ${JSON.stringify(wait)}`);
  }

  const close = parseToolJson(
    await client.callTool({
      name: "retinue_close_agent",
      arguments: { jobId: spawn.jobId }
    })
  );

  return baseOutput({
    spawn,
    status: wait.status,
    result: actual,
    closeStatus: close.status,
    stateDir,
    probe: "permission",
    permission: {
      requestId: request.id,
      permission: request.permission,
      reply: reply.reply,
      remainingPermissionCount: reply.permissions?.length ?? 0
    }
  });
}

function baseOutput({ spawn, status, result, closeStatus, stateDir, probe, permission }) {
  return {
    ok: true,
    probe,
    retinueBackend: process.env.RETINUE_BACKEND,
    mode: process.env.RETINUE_KILO_BASE_URL ? "attach" : "auto-serve",
    baseUrl: process.env.RETINUE_KILO_BASE_URL,
    modelOverride: process.env.RETINUE_KILO_MODEL,
    backend: spawn.backend,
    task_name: spawn.task_name,
    jobId: spawn.jobId,
    externalSessionId: spawn.externalSessionId,
    status,
    result,
    closeStatus,
    stateDir,
    tracePath: path.join(stateDir, "logs", "retinue.jsonl"),
    ...(permission ? { permission } : {})
  };
}

function parseArgs(argv) {
  const options = { permission: false };
  for (const token of argv) {
    if (token === "--") {
      continue;
    }
    if (token === "--permission") {
      options.permission = true;
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }
  return options;
}

async function ensureStateDir(stateDir) {
  if (stateDir) {
    await mkdir(stateDir, { recursive: true });
    return stateDir;
  }
  return mkdtemp(path.join(os.tmpdir(), "retinue-kilo-real-state-"));
}

function parseToolJson(result) {
  const text = result?.content?.find((item) => item.type === "text")?.text;
  if (!text) {
    throw new Error("Tool result did not include text content");
  }
  return JSON.parse(text);
}

function isAcceptableMarker(value, expectedMarker = EXPECTED_MARKER) {
  const normalized = value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const expected = expectedMarker.replace(/[^A-Z0-9]/g, "");
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
