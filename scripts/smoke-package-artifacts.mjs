#!/usr/bin/env node

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { cp, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const EXPECTED_TOOL_NAMES = ["retinue_spawn_agent", "retinue_wait_agent", "retinue_close_agent", "retinue_list_agents"];

async function main() {
  const rootResult = await smokeMcpServer({
    label: "dist/mcp.js",
    command: process.execPath,
    args: [path.resolve("dist/mcp.js")],
    cwd: process.cwd()
  });

  const pluginCacheDir = await mkdtemp(path.join(os.tmpdir(), "retinue-package-smoke-"));
  try {
    await cp(path.resolve("plugins/retinue"), pluginCacheDir, { recursive: true });
    const pluginResult = await smokeMcpServer({
      label: "plugins/retinue/mcp-bootstrap.mjs",
      command: process.execPath,
      args: ["./mcp-bootstrap.mjs"],
      cwd: pluginCacheDir
    });

    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          checks: [rootResult, pluginResult]
        },
        null,
        2
      )}\n`
    );
  } finally {
    await rm(pluginCacheDir, { recursive: true, force: true });
  }
}

async function smokeMcpServer({ label, command, args, cwd }) {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "retinue-package-smoke-state-"));
  const transport = new StdioClientTransport({
    command,
    args,
    cwd,
    env: {
      ...process.env,
      RETINUE_BACKEND: "opencode",
      RETINUE_OPENCODE_AUTO_SERVE: "1",
      RETINUE_OPENCODE_HOST: "127.0.0.1",
      RETINUE_OPENCODE_AGENT: "plan",
      RETINUE_STATE_DIR: stateDir
    },
    stderr: "pipe"
  });
  const client = new Client({ name: "retinue-package-smoke", version: "0.1.0" });
  const stderrChunks = [];
  transport.stderr?.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)));

  try {
    await client.connect(transport);
    const listed = await client.listTools();
    const toolNames = listed.tools.map((tool) => tool.name);
    assertToolNames(label, toolNames);
    const stderr = Buffer.concat(stderrChunks).toString("utf8");
    if (stderr.trim()) {
      throw new Error(`${label} wrote unexpected stderr during MCP smoke: ${stderr}`);
    }
    return {
      label,
      tools: toolNames,
      stateDir
    };
  } finally {
    await Promise.allSettled([client.close(), transport.close()]);
    await rm(stateDir, { recursive: true, force: true });
  }
}

function assertToolNames(label, actual) {
  const missing = EXPECTED_TOOL_NAMES.filter((name) => !actual.includes(name));
  if (missing.length > 0) {
    throw new Error(`${label} missing Retinue MCP tools: ${missing.join(", ")}. Saw: ${actual.join(", ")}`);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
