#!/usr/bin/env node

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../dist/mcp.js";

const OPT_IN_ENV = "SUPERVISOR_REAL_OPENCODE_PROBE";

async function main() {
  if (process.env[OPT_IN_ENV] !== "1") {
    throw new Error(`Manual probe blocked. Set ${OPT_IN_ENV}=1 to run this script.`);
  }
  if (!process.env.SUPERVISOR_OPENCODE_BASE_URL) {
    throw new Error("Missing SUPERVISOR_OPENCODE_BASE_URL.");
  }

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
      })
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
          backend: spawn.backend,
          task_name: spawn.task_name,
          jobId: spawn.jobId,
          externalSessionId: spawn.externalSessionId,
          status: wait.status,
          result: actual,
          closeStatus: close.status
        },
        null,
        2
      )}\n`
    );
  } finally {
    await Promise.allSettled([client.close(), clientTransport.close(), serverTransport.close()]);
  }
}

function parseToolJson(result) {
  const text = result?.content?.find((item) => item.type === "text")?.text;
  if (!text) {
    throw new Error("Tool result did not include text content");
  }
  return JSON.parse(text);
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`);
  process.exitCode = 1;
});
