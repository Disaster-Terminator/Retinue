#!/usr/bin/env node

import { execFile, spawn } from "node:child_process";
import { mkdtemp, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { assertExpectedResult, parseProbeArgs, readJsonOutput } from "../dist/core/probeRealClaudeHelpers.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repoRoot, "dist", "cli.js");
const daemonPath = path.join(repoRoot, "dist", "daemon.js");
const mcpPath = path.join(repoRoot, "dist", "mcp.js");

async function main() {
  const options = parseProbeArgs(process.argv.slice(2));
  const output =
    options.mode === "direct"
      ? await runDirectProbe(options)
      : options.mode === "daemon"
        ? await runDaemonProbe(options)
        : await runMcpDaemonProbe(options);

  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

async function runDirectProbe(options) {
  const stateDir = await ensureStateDir(options.stateDir);
  const env = buildEnv({ RETINUE_STATE_DIR: stateDir });
  const result = await runCliLifecycle(options, env);

  return {
    ok: true,
    mode: "direct",
    jobId: result.jobId,
    status: result.status,
    result: result.result,
    stateDir
  };
}

async function runDaemonProbe(options) {
  const stateDir = await ensureStateDir(options.stateDir);
  const daemon = await startDaemon(options, stateDir);
  try {
    const env = buildEnv({
      RETINUE_STATE_DIR: stateDir,
      RETINUE_DAEMON_URL: daemon.ready.url
    });
    const result = await runCliLifecycle(options, env);

    return {
      ok: true,
      mode: "daemon",
      daemonUrl: daemon.ready.url,
      jobId: result.jobId,
      status: result.status,
      result: result.result,
      stateDir
    };
  } finally {
    await stopChild(daemon.child);
  }
}

async function runMcpDaemonProbe(options) {
  const stateDir = await ensureStateDir(options.stateDir);
  const daemon = await startDaemon(options, stateDir);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [mcpPath],
    cwd: repoRoot,
    env: buildEnv({
      RETINUE_STATE_DIR: stateDir,
      RETINUE_DAEMON_URL: daemon.ready.url
    }),
    stderr: "pipe"
  });
  const client = new Client({ name: "retinue-real-probe", version: "0.1.0" });

  try {
    await client.connect(transport);
    const run = parseToolJson(
      await client.callTool({
        name: "claude_run",
        arguments: { cwd: options.cwd, prompt: options.prompt }
      })
    );
    const wait = parseToolJson(
      await client.callTool({
        name: "claude_wait",
        arguments: { jobId: run.jobId, timeoutMs: options.timeoutMs }
      }, undefined, { timeout: options.timeoutMs + 30_000 })
    );
    const result = parseToolJson(
      await client.callTool({
        name: "claude_result",
        arguments: { jobId: run.jobId }
      })
    );
    const actual = assertExpectedResult(result, options.expected);

    return {
      ok: true,
      mode: "mcp-daemon",
      daemonUrl: daemon.ready.url,
      jobId: run.jobId,
      waitStatus: wait.status,
      status: result.status,
      result: actual,
      stateDir
    };
  } finally {
    await Promise.allSettled([client.close(), stopChild(daemon.child)]);
  }
}

async function runCliLifecycle(options, env) {
  const run = readJsonOutput(
    (
      await execNode([cliPath, "run", "--cwd", options.cwd, "--prompt", options.prompt], {
        env
      })
    ).stdout
  );
  const wait = readJsonOutput(
    (
      await execNode([cliPath, "wait", run.jobId, "--timeout-ms", String(options.timeoutMs)], {
        env
      })
    ).stdout
  );
  const result = readJsonOutput(
    (
      await execNode([cliPath, "result", run.jobId], {
        env
      })
    ).stdout
  );
  const actual = assertExpectedResult(result, options.expected);

  return {
    jobId: run.jobId,
    waitStatus: wait.status,
    status: result.status,
    result: actual
  };
}

async function startDaemon(options, stateDir) {
  const child = spawn(process.execPath, [daemonPath, "--host", options.host, "--port", String(options.port)], {
    cwd: repoRoot,
    env: buildEnv({ RETINUE_STATE_DIR: stateDir }),
    stdio: ["ignore", "pipe", "pipe"]
  });
  const stderr = [];
  child.stderr?.on("data", (chunk) => stderr.push(String(chunk)));

  try {
    const ready = await readDaemonReady(child, stderr);
    return { child, ready };
  } catch (error) {
    await stopChild(child);
    throw error;
  }
}

function readDaemonReady(child, stderr) {
  return new Promise((resolve, reject) => {
    const lines = createInterface({ input: child.stdout });
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for daemon readiness. stderr: ${stderr.join("")}`));
    }, 10000);

    const onExit = (code) => {
      cleanup();
      reject(new Error(`Daemon exited before readiness with code ${String(code)}. stderr: ${stderr.join("")}`));
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onLine = (line) => {
      try {
        const parsed = JSON.parse(line);
        if (parsed?.status === "listening" && parsed?.url) {
          cleanup();
          resolve(parsed);
        }
      } catch {
        // Ignore non-JSON daemon output and wait for readiness.
      }
    };
    const cleanup = () => {
      clearTimeout(timer);
      lines.off("line", onLine);
      child.off("exit", onExit);
      child.off("error", onError);
      lines.close();
    };

    lines.on("line", onLine);
    child.once("exit", onExit);
    child.once("error", onError);
  });
}

function parseToolJson(result) {
  const content = result?.content;
  const text = Array.isArray(content) ? content.find((item) => item.type === "text")?.text : undefined;
  if (!text) {
    throw new Error("MCP tool result did not include text content");
  }
  return JSON.parse(text);
}

function execNode(args, options) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, args, { cwd: repoRoot, env: options.env, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        error.message = `${error.message}\nstdout:\n${stdout}\nstderr:\n${stderr}`;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function ensureStateDir(stateDir) {
  if (stateDir) {
    await mkdir(stateDir, { recursive: true });
    return stateDir;
  }
  return mkdtemp(path.join(os.tmpdir(), "retinue-real-probe-"));
}

function buildEnv(overrides) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") {
      env[key] = value;
    }
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (typeof value === "string") {
      env[key] = value;
    }
  }
  return env;
}

function stopChild(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 5000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill();
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
