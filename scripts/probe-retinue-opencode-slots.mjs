#!/usr/bin/env node

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdir, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createMcpServer } from "../dist/mcp.js";

const OPT_IN_ENV = "RETINUE_REAL_OPENCODE_SLOT_PROBE";

async function main() {
  if (process.env[OPT_IN_ENV] !== "1") {
    throw new Error(`Manual probe blocked. Set ${OPT_IN_ENV}=1 to run this script.`);
  }

  const stateDir = await ensureStateDir(process.env.RETINUE_STATE_DIR);
  process.env.RETINUE_BACKEND = "opencode";
  process.env.RETINUE_STATE_DIR = stateDir;
  process.env.RETINUE_OPENCODE_AUTO_SERVE = process.env.RETINUE_OPENCODE_AUTO_SERVE ?? "1";
  process.env.RETINUE_OPENCODE_HOST = process.env.RETINUE_OPENCODE_HOST ?? "127.0.0.1";
  process.env.RETINUE_OPENCODE_AGENT = process.env.RETINUE_OPENCODE_AGENT ?? "plan";

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "retinue-opencode-slot-probe", version: "0.1.0" });
  const server = createMcpServer();

  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const cwd = process.cwd();
    const prompts = [
      "Read package.json and summarize the project scripts in one paragraph.",
      "Inspect src/mcp.ts and summarize the Retinue product tools.",
      "Inspect tests/mcp-tools.test.ts and summarize MCP coverage.",
      "Inspect docs/integrations/HERMES.md and summarize Hermes integration."
    ];

    const spawns = [];
    for (let index = 0; index < prompts.length; index += 1) {
      spawns.push(
        parseToolJson(
          await client.callTool({
            name: "retinue_spawn_agent",
            arguments: {
              cwd,
              task_name: `real-slot-${index + 1}`,
              message: prompts[index]
            }
          })
        )
      );
    }

    const listed = parseToolJson(await client.callTool({ name: "retinue_list_agents", arguments: {} }));
    const evictedJobId = spawns.at(-1)?.evictedJobId;
    if (!evictedJobId) {
      throw new Error(`Expected the fourth spawn to evict the oldest running job: ${JSON.stringify({ spawns, listed })}`);
    }

    await Promise.allSettled(
      listed.agents.map((agent) =>
        client.callTool({
          name: "retinue_close_agent",
          arguments: { jobId: agent.jobId }
        })
      )
    );

    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          backend: "opencode",
          maxAgents: listed.maxAgents,
          evictedJobId,
          spawnedJobIds: spawns.map((spawn) => spawn.jobId),
          activeAgentsAfterEviction: listed.agents.map((agent) => ({
            jobId: agent.jobId,
            task_name: agent.task_name,
            status: agent.status
          })),
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
  return mkdtemp(path.join(os.tmpdir(), "retinue-opencode-slot-state-"));
}

function parseToolJson(result) {
  const text = result?.content?.find((item) => item.type === "text")?.text;
  if (!text) {
    throw new Error("Tool result did not include text content");
  }
  return JSON.parse(text);
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
