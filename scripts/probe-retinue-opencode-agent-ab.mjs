#!/usr/bin/env node

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdir, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createMcpServer } from "../dist/mcp.js";

const OPT_IN_ENV = "RETINUE_REAL_OPENCODE_AGENT_AB_PROBE";
const DEFAULT_AGENTS = ["plan", "explore"];
const DEFAULT_TIMEOUT_MS = 180_000;

const TASKS = [
  {
    name: "taxonomy-review",
    message:
      "Read-only bounded review. Use at most 4 repository inspection tool calls. Inspect only src/backends/opencode/backend.ts and tests if needed. Do not propose patches, do not output unified diffs, do not write files. Task: verify whether provider/auth errors are classified before read-only patch/write intent. Final answer must include PASS or FAIL, 1-3 bullet evidence lines with file/function names, and end with RETINUE_AB_TAXONOMY_DONE."
  },
  {
    name: "prompt-contract-review",
    message:
      "Read-only bounded review. Use at most 4 repository inspection tool calls. Inspect only Retinue plugin skill/config docs and source that constructs OpenCode prompts. Do not propose patches, do not output unified diffs, do not write files. Task: verify whether default read-only child prompt tells the child not to emit patch blocks/write intent. Final answer must include PASS or FAIL, 1-3 bullet evidence lines with file/function names, and end with RETINUE_AB_PROMPT_DONE."
  },
  {
    name: "lifecycle-review",
    message:
      "Read-only bounded review. Use at most 4 repository inspection tool calls. Inspect only source related to OpenCode server lifecycle and job close/slot eviction. Do not propose patches, do not output unified diffs, do not write files. Task: identify whether close/evict attempts can report process-not-found after process already exited, and whether that is treated as fatal. Final answer must include PASS or FAIL, 1-3 bullet evidence lines with file/function names, and end with RETINUE_AB_LIFECYCLE_DONE."
  }
];

async function main() {
  if (process.env[OPT_IN_ENV] !== "1") {
    throw new Error(`Manual probe blocked. Set ${OPT_IN_ENV}=1 to run this script.`);
  }

  const rootStateDir = await ensureStateDir(process.env.RETINUE_STATE_DIR);
  const agents = parseAgents(process.env.RETINUE_OPENCODE_AGENT_LIST);
  const timeoutMs = parsePositiveInt(process.env.RETINUE_OPENCODE_AGENT_AB_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  const results = [];

  for (const agent of agents) {
    results.push(await runAgentProbe({ agent, rootStateDir, timeoutMs }));
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        cwd: process.cwd(),
        agents,
        timeoutMs,
        rootStateDir,
        results
      },
      null,
      2
    )}\n`
  );
}

async function runAgentProbe({ agent, rootStateDir, timeoutMs }) {
  const stateDir = rootStateDir;
  await mkdir(path.join(stateDir, "agent-ab-runs", sanitizePathPart(agent)), { recursive: true });

  const previousEnv = snapshotEnv([
    "RETINUE_BACKEND",
    "RETINUE_STATE_DIR",
    "RETINUE_OPENCODE_AUTO_SERVE",
    "RETINUE_OPENCODE_HOST",
    "RETINUE_OPENCODE_AGENT"
  ]);
  process.env.RETINUE_BACKEND = "opencode";
  process.env.RETINUE_STATE_DIR = stateDir;
  process.env.RETINUE_OPENCODE_AUTO_SERVE = process.env.RETINUE_OPENCODE_AUTO_SERVE ?? "1";
  process.env.RETINUE_OPENCODE_HOST = process.env.RETINUE_OPENCODE_HOST ?? "127.0.0.1";
  process.env.RETINUE_OPENCODE_AGENT = agent;

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: `retinue-opencode-agent-ab-${agent}`, version: "0.1.0" });
  const server = createMcpServer();
  const spawns = [];

  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const cwd = process.cwd();
    for (const task of TASKS) {
      spawns.push(
        parseToolJson(
          await client.callTool({
            name: "retinue_spawn_agent",
            arguments: {
              cwd,
              task_name: `${agent}-${task.name}`,
              access_mode: "read_only",
              bash_policy: "readonly_git",
              message: task.message
            }
          })
        )
      );
    }

    const waits = await Promise.all(
      spawns.map(async (spawn) => {
        try {
          const wait = parseToolJson(
            await client.callTool(
              {
                name: "retinue_wait_agent",
                arguments: { jobId: spawn.jobId, timeoutMs }
              },
              undefined,
              { timeout: timeoutMs + 30_000 }
            )
          );
          return summarizeWait(spawn, wait);
        } catch (error) {
          return {
            task_name: spawn.task_name,
            jobId: spawn.jobId,
            status: "wait_error",
            error: error instanceof Error ? error.message : String(error)
          };
        }
      })
    );

    await Promise.allSettled(
      spawns.map((spawn) =>
        client.callTool({
          name: "retinue_close_agent",
          arguments: { jobId: spawn.jobId }
        })
      )
    );

    return {
      agent,
      stateDir,
      agentArtifactDir: path.join(stateDir, "agent-ab-runs", sanitizePathPart(agent)),
      tracePath: path.join(stateDir, "logs", "retinue.jsonl"),
      completed: waits.filter((wait) => wait.status === "completed").length,
      stalled: waits.filter((wait) => wait.status === "stalled").length,
      running: waits.filter((wait) => wait.status === "running").length,
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
    externalServerUrl: spawn.externalServerUrl,
    externalSessionDirectory: spawn.externalSessionDirectory,
    status: wait.status,
    stallReason: wait.diagnostic?.stallReason,
    stallSummary: wait.diagnostic?.stallSummary,
    lastAssistantAgent: wait.diagnostic?.lastAssistantAgent,
    lastAssistantMode: wait.diagnostic?.lastAssistantMode,
    lastAssistantProviderID: wait.diagnostic?.lastAssistantProviderID,
    lastAssistantModelID: wait.diagnostic?.lastAssistantModelID,
    toolCallAssistantRounds: wait.diagnostic?.toolCallAssistantRounds,
    blankAssistantRounds: wait.diagnostic?.blankAssistantRounds,
    runningReadToolParts: wait.diagnostic?.runningReadToolParts,
    readOnlyWriteIntent: wait.diagnostic?.readOnlyWriteIntent,
    stdoutPreview: typeof stdout === "string" ? stdout.slice(0, 240) : ""
  };
}

async function ensureStateDir(stateDir) {
  if (stateDir) {
    await mkdir(stateDir, { recursive: true });
    return stateDir;
  }
  return mkdtemp(path.join(os.tmpdir(), "retinue-opencode-agent-ab-state-"));
}

function parseAgents(value) {
  const agents = (value ? value.split(",") : DEFAULT_AGENTS).map((agent) => agent.trim()).filter(Boolean);
  if (agents.length === 0) {
    throw new Error("RETINUE_OPENCODE_AGENT_LIST did not include any agent names");
  }
  return agents;
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

main()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    process.stderr.write(
      `${JSON.stringify({
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      })}\n`
    );
    process.exit(1);
  });
