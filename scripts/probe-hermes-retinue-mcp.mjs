#!/usr/bin/env node

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";

const REAL_PROBE_ENV = "SUPERVISOR_REAL_HERMES_RETINUE_PROBE";
const DEFAULT_TOOL_NAMES = ["retinue_spawn_agent", "retinue_wait_agent", "retinue_close_agent"];

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const stateDir = await ensureStateDir(options.stateDir ?? process.env.SUPERVISOR_STATE_DIR);
  const env = {
    ...process.env,
    SUPERVISOR_RETINUE_BACKEND: process.env.SUPERVISOR_RETINUE_BACKEND ?? "opencode",
    SUPERVISOR_OPENCODE_AUTO_SERVE: process.env.SUPERVISOR_OPENCODE_AUTO_SERVE ?? "1",
    SUPERVISOR_OPENCODE_HOST: process.env.SUPERVISOR_OPENCODE_HOST ?? "127.0.0.1",
    SUPERVISOR_OPENCODE_AGENT: process.env.SUPERVISOR_OPENCODE_AGENT ?? "plan",
    SUPERVISOR_STATE_DIR: stateDir
  };

  const transport = new StdioClientTransport({
    command: options.command,
    args: options.args,
    cwd: options.cwd,
    env,
    stderr: "pipe"
  });
  const client = new Client({ name: "hermes-retinue-mcp-probe", version: "0.1.0" });
  const stderrChunks = [];
  transport.stderr?.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)));

  try {
    await client.connect(transport);
    const listed = await client.listTools();
    const toolNames = listed.tools.map((tool) => tool.name).sort();
    assertToolList(toolNames);

    if (process.env[REAL_PROBE_ENV] !== "1") {
      printResult({
        ok: true,
        mode: "tool-list",
        hermesConfigShape: "mcp_servers.retinue",
        command: options.command,
        args: options.args,
        cwd: options.cwd,
        tools: toolNames,
        hermesToolNames: toolNames.map((name) => `mcp_retinue_${name}`),
        stateDir,
        stderr: Buffer.concat(stderrChunks).toString("utf8")
      });
      return;
    }

    const fixture = await prepareRealProbeFixture(stateDir, options);
    const projectCwd = options.projectCwd ?? fixture.cwd;
    const prompt = options.prompt ?? fixture.prompt;
    const expectText = options.expect ?? fixture.expect;

    const spawn = parseToolJson(
      await client.callTool({
        name: "retinue_spawn_agent",
        arguments: {
          cwd: projectCwd,
          task_name: "hermes-retinue-smoke",
          message: prompt
        }
      })
    );
    const wait = parseToolJson(
      await client.callTool({
        name: "retinue_wait_agent",
        arguments: { jobId: spawn.jobId, timeoutMs: options.timeoutMs }
      })
    );
    const actual = wait?.result?.parsedStdout?.result;
    if (wait.status !== "completed" || typeof actual !== "string" || !actual.includes(expectText)) {
      throw new Error(`Unexpected Retinue result: ${JSON.stringify(wait)}`);
    }
    const close = parseToolJson(
      await client.callTool({
        name: "retinue_close_agent",
        arguments: { jobId: spawn.jobId }
      })
    );

    printResult({
      ok: true,
      mode: "real-opencode",
      hermesConfigShape: "mcp_servers.retinue",
      backend: spawn.backend,
      jobId: spawn.jobId,
      externalSessionId: spawn.externalSessionId,
      status: wait.status,
      result: actual,
      closeStatus: close.status,
      projectCwd,
      markerSha256: fixture.markerSha256,
      stateDir,
      tracePath: path.join(stateDir, "logs", "retinue.jsonl")
    });
  } finally {
    await Promise.allSettled([client.close(), transport.close()]);
  }
}

function parseArgs(args) {
  const options = {
    command: process.execPath,
    args: [path.resolve("dist/mcp.js")],
    cwd: process.cwd(),
    projectCwd: undefined,
    prompt: undefined,
    expect: undefined,
    timeoutMs: 120000,
    stateDir: undefined
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = () => {
      index += 1;
      if (index >= args.length) {
        throw new Error(`Missing value for ${arg}`);
      }
      return args[index];
    };
    if (arg === "--command") {
      options.command = next();
    } else if (arg === "--arg") {
      options.args.push(next());
    } else if (arg === "--clear-args") {
      options.args = [];
    } else if (arg === "--cwd") {
      options.cwd = next();
    } else if (arg === "--project-cwd") {
      options.projectCwd = next();
    } else if (arg === "--prompt") {
      options.prompt = next();
    } else if (arg === "--expect") {
      options.expect = next();
    } else if (arg === "--timeout-ms") {
      options.timeoutMs = Number.parseInt(next(), 10);
    } else if (arg === "--state-dir") {
      options.stateDir = next();
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 0) {
    throw new Error("--timeout-ms must be a non-negative integer");
  }
  return options;
}

async function prepareRealProbeFixture(stateDir, options) {
  if (options.projectCwd || options.prompt || options.expect) {
    return {
      cwd: options.projectCwd ?? process.cwd(),
      prompt: options.prompt ?? "Reply exactly: HERMES_RETINUE_OK",
      expect: options.expect ?? "HERMES_RETINUE_OK",
      markerSha256: undefined
    };
  }

  const cwd = path.join(stateDir, "fixture-workspace");
  const marker = `retinue-marker-${randomUUID()}`;
  await mkdir(cwd, { recursive: true });
  await writeFile(path.join(cwd, "RETINUE_MARKER.txt"), `${marker}\n`, "utf8");
  await writeFile(path.join(cwd, "package.json"), `${JSON.stringify({ name: "retinue-hermes-fixture", private: true }, null, 2)}\n`, "utf8");
  return {
    cwd,
    prompt:
      "Read RETINUE_MARKER.txt in the current working directory. Reply with exactly two lines: first line MARKER=<the exact file contents without trailing newline>, second line HERMES_RETINUE_FILE_READ_OK.",
    expect: marker,
    markerSha256: sha256(marker)
  };
}

async function ensureStateDir(stateDir) {
  if (stateDir) {
    await mkdir(stateDir, { recursive: true });
    return stateDir;
  }
  return mkdtemp(path.join(os.tmpdir(), "retinue-hermes-state-"));
}

function assertToolList(toolNames) {
  for (const name of DEFAULT_TOOL_NAMES) {
    if (!toolNames.includes(name)) {
      throw new Error(`Missing Retinue MCP tool: ${name}. Saw: ${toolNames.join(", ")}`);
    }
  }
}

function parseToolJson(result) {
  const text = result?.content?.find((item) => item.type === "text")?.text;
  if (!text) {
    throw new Error("Tool result did not include text content");
  }
  return JSON.parse(text);
}

function printResult(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`);
  process.exitCode = 1;
});
