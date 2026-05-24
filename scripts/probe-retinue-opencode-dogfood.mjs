#!/usr/bin/env node

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdir, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createMcpServer } from "../dist/mcp.js";
import { classifyDogfoodWait, summarizeDogfoodResults } from "./lib/dogfood-summary.mjs";

const DEFAULT_AGENTS = ["explore"];
const DEFAULT_TIMEOUT_MS = 180_000;

const TASKS = [
  {
    name: "workflow-review",
    marker: "RETINUE_DOGFOOD_WORKFLOW_DONE",
    message:
      "Read-only bounded review. Use at most 4 repository inspection tool calls. Inspect package.json, docs/VERIFICATION.md, and tests/ci-package-guardrails.test.ts only if needed. Do not propose patches, do not output unified diffs, and do not write files. Task: judge whether the verification workflow has grouped tests and guardrails against ad hoc single-file testing. Final answer must include PASS or FAIL, 1-3 evidence lines with file references, and end with RETINUE_DOGFOOD_WORKFLOW_DONE."
  },
  {
    name: "readonly-contract-review",
    marker: "RETINUE_DOGFOOD_READONLY_DONE",
    message:
      "Read-only bounded review. Use at most 4 repository inspection tool calls. Inspect src/backends/opencode/backend.ts, src/mcp.ts, plugins/retinue/retinue.config.json, and docs/backends/OPENCODE.md only if needed. Treat retinue.config.json as packaged defaults, not persistent user configuration. Do not propose patches, do not output unified diffs, and do not write files. Task: judge whether the default read-only OpenCode path keeps the session permission boundary while leaving the extra Retinue prompt contract and prompt-level tools:false map opt-in rather than mandatory. Final answer must include PASS or FAIL, 1-3 evidence lines with file references, and end with RETINUE_DOGFOOD_READONLY_DONE."
  },
  {
    name: "stall-diagnostics-review",
    marker: "RETINUE_DOGFOOD_STALL_DONE",
    message:
      "Read-only bounded review. Use at most 4 repository inspection tool calls. Inspect src/backends/opencode/backend.ts, src/mcp.ts, and tests/mcp-tools.test.ts only if needed. Do not propose patches, do not output unified diffs, and do not write files. Task: judge whether stalled OpenCode jobs expose actionable diagnostics to callers. Final answer must include PASS or FAIL, 1-3 evidence lines with file references, and end with RETINUE_DOGFOOD_STALL_DONE."
  }
];

async function main() {
  const rootStateDir = await ensureStateDir(process.env.RETINUE_STATE_DIR);
  const agents = parseAgents(process.env.RETINUE_DOGFOOD_OPENCODE_AGENT_LIST ?? process.env.RETINUE_OPENCODE_AGENT_LIST);
  const rootBindingModes = parseRootBindingModes(process.env.RETINUE_DOGFOOD_OPENCODE_ROOT_BINDING_MODE_LIST);
  const accessMode = parseAccessMode(process.env.RETINUE_DOGFOOD_OPENCODE_ACCESS_MODE);
  const timeoutMs = parsePositiveInt(process.env.RETINUE_DOGFOOD_OPENCODE_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  const results = [];

  for (const agent of agents) {
    for (const rootBindingMode of rootBindingModes) {
      results.push(await runAgentDogfood({ agent, rootBindingMode, accessMode, rootStateDir, timeoutMs }));
    }
  }

  const summary = summarizeDogfoodResults(results);
  const output = {
    ok: summary.ok,
    cwd: process.cwd(),
    agents,
    rootBindingModes,
    accessMode,
    timeoutMs,
    rootStateDir,
    tracePath: path.join(rootStateDir, "logs", "retinue.jsonl"),
    summary,
    results
  };

  const text = `${JSON.stringify(output, null, 2)}\n`;
  if (summary.ok) {
    process.stdout.write(text);
    return;
  }
  process.stderr.write(text);
  process.exitCode = 1;
}

async function runAgentDogfood({ agent, rootBindingMode, accessMode, rootStateDir, timeoutMs }) {
  const stateDir = rootStateDir;
  await mkdir(path.join(stateDir, "dogfood-runs", sanitizePathPart(agent), sanitizePathPart(rootBindingMode)), { recursive: true });

  const previousEnv = snapshotEnv([
    "RETINUE_BACKEND",
    "RETINUE_STATE_DIR",
    "RETINUE_OPENCODE_AUTO_SERVE",
    "RETINUE_OPENCODE_HOST",
    "RETINUE_OPENCODE_AGENT",
    "RETINUE_OPENCODE_ROOT_BINDING_MODE"
  ]);
  process.env.RETINUE_BACKEND = "opencode";
  process.env.RETINUE_STATE_DIR = stateDir;
  process.env.RETINUE_OPENCODE_AUTO_SERVE = process.env.RETINUE_OPENCODE_AUTO_SERVE ?? "1";
  process.env.RETINUE_OPENCODE_HOST = process.env.RETINUE_OPENCODE_HOST ?? "127.0.0.1";
  process.env.RETINUE_OPENCODE_AGENT = agent;
  process.env.RETINUE_OPENCODE_ROOT_BINDING_MODE = rootBindingMode;

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: `retinue-opencode-dogfood-${agent}`, version: "0.1.0" });
  const server = createMcpServer();
  const spawns = [];

  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const cwd = process.cwd();
    for (const task of TASKS) {
      spawns.push({
        task,
        spawn: parseToolJson(
          await client.callTool({
            name: "retinue_spawn_agent",
            arguments: {
              cwd,
              task_name: `${agent}-${rootBindingMode}-${task.name}`,
              access_mode: accessMode,
              bash_policy: "readonly_git",
              message: task.message
            }
          })
        )
      });
    }

    const waits = await Promise.all(
      spawns.map(async ({ task, spawn }) => {
        try {
          const wait = await waitForTerminal(client, spawn.jobId, timeoutMs);
          return classifyDogfoodWait(summarizeWait(spawn, wait), task.marker);
        } catch (error) {
          return classifyDogfoodWait(
            {
              task_name: spawn.task_name,
              jobId: spawn.jobId,
              status: "wait_error",
              error: error instanceof Error ? error.message : String(error)
            },
            task.marker
          );
        }
      })
    );

    await Promise.allSettled(
      spawns.map(({ spawn }) =>
        client.callTool({
          name: "retinue_close_agent",
          arguments: { jobId: spawn.jobId }
        })
      )
    );

    return {
      agent,
      rootBindingMode,
      accessMode,
      stateDir,
      agentArtifactDir: path.join(stateDir, "dogfood-runs", sanitizePathPart(agent), sanitizePathPart(rootBindingMode)),
      tracePath: path.join(stateDir, "logs", "retinue.jsonl"),
      waits
    };
  } finally {
    await Promise.allSettled([client.close(), clientTransport.close(), serverTransport.close()]);
    restoreEnv(previousEnv);
  }
}

function summarizeWait(spawn, wait) {
  const stdout = wait?.result?.parsedStdout?.result ?? wait?.result?.stdout ?? "";
  return {
    task_name: spawn.task_name,
    jobId: spawn.jobId,
    backend: spawn.backend,
    externalSessionId: spawn.externalSessionId,
    externalRunnerMode: spawn.externalRunnerMode,
    externalRootAgent: spawn.externalRootAgent,
    externalRootSessionId: spawn.externalRootSessionId,
    externalParentSessionId: spawn.externalParentSessionId,
    externalServerUrl: spawn.externalServerUrl,
    externalSessionDirectory: spawn.externalSessionDirectory,
    status: wait.status,
    stallReason: wait.diagnostic?.stallReason,
    stallSummary: wait.diagnostic?.stallSummary,
    permissionRequired: wait.permissionRequired === true,
    attentionRequiredKind: wait.attentionRequired?.kind,
    permissionCount: Array.isArray(wait.permissions) ? wait.permissions.length : undefined,
    permissions: Array.isArray(wait.permissions) ? wait.permissions : undefined,
    lastAssistantAgent: wait.diagnostic?.lastAssistantAgent,
    lastAssistantMode: wait.diagnostic?.lastAssistantMode,
    lastAssistantProviderID: wait.diagnostic?.lastAssistantProviderID,
    lastAssistantModelID: wait.diagnostic?.lastAssistantModelID,
    toolCallAssistantRounds: wait.diagnostic?.toolCallAssistantRounds,
    blankAssistantRounds: wait.diagnostic?.blankAssistantRounds,
    runningReadToolParts: wait.diagnostic?.runningReadToolParts,
    runningReadToolCallIds: wait.diagnostic?.runningReadToolCallIds,
    runningReadToolPartSummaries: wait.diagnostic?.runningReadToolPartSummaries,
    readOnlyWriteIntent: wait.diagnostic?.readOnlyWriteIntent,
    stdoutPath: wait.result?.stdoutPath,
    stderrPath: wait.result?.stderrPath,
    stdoutText: typeof stdout === "string" ? stdout : "",
    stdoutPreview: typeof stdout === "string" ? stdout.slice(0, 500) : ""
  };
}

async function waitForTerminal(client, jobId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastWait;
  for (;;) {
    const remaining = Math.max(0, deadline - Date.now());
    if (remaining === 0 && lastWait) {
      return lastWait;
    }
    const waitTimeoutMs = Math.max(1, remaining);
    lastWait = parseToolJson(
      await client.callTool(
        {
          name: "retinue_wait_agent",
          arguments: { jobId, timeoutMs: waitTimeoutMs }
        },
        undefined,
        { timeout: waitTimeoutMs + 30_000 }
      )
    );
    if (lastWait.status !== "running") {
      return lastWait;
    }
    if (Date.now() >= deadline) {
      return lastWait;
    }
    await sleep(500);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensureStateDir(stateDir) {
  if (stateDir) {
    await mkdir(stateDir, { recursive: true });
    return stateDir;
  }
  return mkdtemp(path.join(os.tmpdir(), "retinue-opencode-dogfood-state-"));
}

function parseAgents(value) {
  const agents = (value ? value.split(",") : DEFAULT_AGENTS).map((agent) => agent.trim()).filter(Boolean);
  if (agents.length === 0) {
    throw new Error("RETINUE_DOGFOOD_OPENCODE_AGENT_LIST did not include any agent names");
  }
  return agents;
}

function parseRootBindingModes(value) {
  const modes = (value ? value.split(",") : ["per_spawn"]).map((mode) => mode.trim()).filter(Boolean);
  if (modes.length === 0) {
    throw new Error("RETINUE_DOGFOOD_OPENCODE_ROOT_BINDING_MODE_LIST did not include any modes");
  }
  for (const mode of modes) {
    if (!["per_spawn", "per-spawn", "shared_root", "shared-root"].includes(mode)) {
      throw new Error(`Unsupported root binding mode: ${mode}`);
    }
  }
  return modes;
}

function parseAccessMode(value) {
  if (value === undefined || value === "") {
    return "read_only";
  }
  if (value === "read_only" || value === "profile") {
    return value;
  }
  throw new Error(`Unsupported RETINUE_DOGFOOD_OPENCODE_ACCESS_MODE: ${value}`);
}

function parsePositiveInt(value, fallback) {
  if (value === undefined || value === "") {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive integer timeout, got ${value}`);
  }
  return parsed;
}

function parseToolJson(result) {
  const text = result?.content?.find((item) => item.type === "text")?.text;
  if (!text) {
    throw new Error("Tool result did not include text content");
  }
  return JSON.parse(text);
}

function snapshotEnv(keys) {
  return new Map(keys.map((key) => [key, process.env[key]]));
}

function restoreEnv(snapshot) {
  for (const [key, value] of snapshot.entries()) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function sanitizePathPart(value) {
  return value.replace(/[^A-Za-z0-9_.-]/g, "_");
}

main().catch((error) => {
  process.stderr.write(
    `${JSON.stringify(
      {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        stateDir: process.env.RETINUE_STATE_DIR,
        tracePath: process.env.RETINUE_STATE_DIR ? path.join(process.env.RETINUE_STATE_DIR, "logs", "retinue.jsonl") : undefined
      },
      null,
      2
    )}\n`
  );
  process.exit(1);
});
