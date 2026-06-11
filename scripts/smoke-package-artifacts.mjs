#!/usr/bin/env node

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFile } from "node:child_process";
import { cp, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const EXPECTED_TOOL_NAMES = [
  "spawn_agent",
  "wait_agent",
  "close_agent",
  "list_agents",
  "list_permissions",
  "reply_permission",
  "stop_runtime",
  "restart_runtime"
];
const execFileAsync = promisify(execFile);

async function main() {
  const cliResult = await smokeCli();
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
          checks: [cliResult, rootResult, pluginResult]
        },
        null,
        2
      )}\n`
    );
  } finally {
    await rm(pluginCacheDir, { recursive: true, force: true });
  }
}

async function smokeCli() {
  const cliPath = path.resolve("dist/cli.js");
  try {
    await execFileAsync(process.execPath, [cliPath, "daemon", "health"], {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 10_000
    });
  } catch (error) {
    const stdout = typeof error === "object" && error !== null && "stdout" in error ? String(error.stdout) : "";
    const parsed = parseJson(stdout);
    if (parsed?.ok === false && parsed?.error?.code === "missing_daemon_target") {
      return {
        label: "dist/cli.js",
        command: "daemon health",
        ok: true,
        expectedFailureCode: parsed.error.code
      };
    }
    throw error;
  }
  throw new Error("dist/cli.js daemon health unexpectedly succeeded without a daemon target");
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
      RETINUE_OPENCODE_AGENT: "explore",
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

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function assertToolNames(label, actual) {
  const missing = EXPECTED_TOOL_NAMES.filter((name) => !actual.includes(name));
  if (missing.length > 0) {
    throw new Error(`${label} missing Retinue MCP tools: ${missing.join(", ")}. Saw: ${actual.join(", ")}`);
  }
  const unexpected = actual.filter((name) => !EXPECTED_TOOL_NAMES.includes(name));
  if (unexpected.length > 0) {
    throw new Error(`${label} exposed unexpected MCP tools: ${unexpected.join(", ")}. Saw: ${actual.join(", ")}`);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
