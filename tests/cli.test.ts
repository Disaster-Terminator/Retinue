import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { createDaemonServer } from "../src/daemon/server.js";
import { writeDaemonDiscovery } from "../src/daemon/discovery.js";
import { ClaudeRetinue } from "../src/core/retinue.js";
import { startFakeOpenCodeServer, type FakeOpenCodeServer } from "./fixtures/fake-opencode-server.js";

const cliPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/cli.ts");
const fixturePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures/fake-claude.mjs");
const tsxCliPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../node_modules/tsx/dist/cli.mjs");
const execFileAsync = promisify(execFile);

describe("CLI", () => {
  let tempDir: string;
  let server: http.Server | undefined;
  let fakeOpenCode: FakeOpenCodeServer | undefined;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "retinue-cli-test-"));
  });

  afterEach(async () => {
    if (server) {
      await closeServer(server);
      server = undefined;
    }
    if (fakeOpenCode) {
      await fakeOpenCode.close();
      fakeOpenCode = undefined;
    }
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("runs, waits, and reads a job as JSON", async () => {
    const env = cliEnv(tempDir);

    const run = await execFileAsync(process.execPath, [tsxCliPath, cliPath, "run", "--cwd", tempDir, "--prompt", "cli hello"], { env });
    const started = JSON.parse(run.stdout);
    expect(started.status).toBe("running");

    const wait = await execFileAsync(process.execPath, [tsxCliPath, cliPath, "wait", started.jobId, "--timeout-ms", "5000"], { env });
    expect(JSON.parse(wait.stdout).status).toBe("completed");

    const result = await execFileAsync(process.execPath, [tsxCliPath, cliPath, "result", started.jobId], { env });
    expect(JSON.parse(result.stdout).parsedStdout.result).toBe("fake result: cli hello");
  });

  it("delegates job commands to a configured daemon URL", async () => {
    const daemonUrl = await startDaemon();
    const env = {
      ...process.env,
      RETINUE_DAEMON_URL: daemonUrl,
      RETINUE_STATE_DIR: path.join(tempDir, "client-state"),
      RETINUE_CLAUDE_COMMAND: path.join(tempDir, "missing-local-claude")
    };

    const run = await execFileAsync(process.execPath, [tsxCliPath, cliPath, "run", "--cwd", tempDir, "--prompt", "daemon cli"], { env });
    const started = JSON.parse(run.stdout);
    expect(started.status).toBe("running");

    const wait = await execFileAsync(process.execPath, [tsxCliPath, cliPath, "wait", started.jobId, "--timeout-ms", "5000"], { env });
    expect(JSON.parse(wait.stdout).status).toBe("completed");

    const result = await execFileAsync(process.execPath, [tsxCliPath, cliPath, "result", started.jobId], { env });
    expect(JSON.parse(result.stdout).parsedStdout.result).toBe("fake result: daemon cli");
  });

  it("returns daemon health from an explicit URL", async () => {
    const daemonUrl = await startDaemon();
    const env = cliEnv(tempDir);

    const result = await execFileAsync(process.execPath, [tsxCliPath, cliPath, "daemon-health", "--daemon-url", daemonUrl], {
      env
    });
    const parsed = JSON.parse(result.stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.source).toBe("explicit_url");
    expect(parsed.daemonUrl).toBe(daemonUrl);
    expect(parsed.health.status).toBe("ok");
  });

  it("returns daemon health through discovery", async () => {
    const daemonUrl = await startDaemon();
    await writeDaemonDiscovery(tempDir, {
      url: daemonUrl,
      pid: process.pid,
      startedAt: "2026-05-04T00:00:00.000Z",
      version: "0.1.0"
    });
    const env = cliEnv(tempDir);

    const result = await execFileAsync(process.execPath, [tsxCliPath, cliPath, "--discover-daemon", "daemon-health"], { env });
    const parsed = JSON.parse(result.stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.source).toBe("discovery");
    expect(parsed.daemonUrl).toBe(daemonUrl);
    expect(parsed.health.status).toBe("ok");
  });

  it("returns structured missing target failure for daemon health", async () => {
    const env = cliEnv(tempDir);
    const failing = await execFileAsync(process.execPath, [tsxCliPath, cliPath, "daemon-health"], { env }).catch(
      (error: { stdout: string; code: number }) => error
    );

    const parsed = JSON.parse(failing.stdout);
    expect(failing.code).toBe(1);
    expect(parsed.ok).toBe(false);
    expect(parsed.source).toBe("none");
    expect(parsed.error.code).toBe("missing_daemon_target");
  });

  it("rejects invalid numeric CLI flags before dispatching commands", async () => {
    const env = cliEnv(tempDir);
    const failing = await execFileAsync(process.execPath, [tsxCliPath, cliPath, "wait", "job_missing", "--timeout-ms", "abc"], { env }).catch(
      (error: { stderr: string; code: number }) => error
    );

    expect(failing.code).toBe(1);
    expect(failing.stderr).toContain("--timeout-ms must be a non-negative finite number");
  });

  it("returns structured unreachable failure for daemon health", async () => {
    const env = cliEnv(tempDir);
    const failing = await execFileAsync(
      process.execPath,
      [tsxCliPath, cliPath, "daemon-health", "--daemon-url", "http://127.0.0.1:1"],
      { env }
    ).catch((error: { stdout: string; code: number }) => error);

    const parsed = JSON.parse(failing.stdout);
    expect(failing.code).toBe(1);
    expect(parsed.ok).toBe(false);
    expect(parsed.source).toBe("explicit_url");
    expect(parsed.error.code).toBe("daemon_unreachable");
  });

  it("returns structured unreachable failure for discovered daemon health", async () => {
    await writeDaemonDiscovery(tempDir, {
      url: "http://127.0.0.1:1",
      pid: process.pid,
      startedAt: "2026-05-04T00:00:00.000Z",
      version: "0.1.0"
    });
    const env = cliEnv(tempDir);

    const failing = await execFileAsync(process.execPath, [tsxCliPath, cliPath, "--discover-daemon", "daemon-health"], {
      env
    }).catch((error: { stdout: string; code: number }) => error);

    const parsed = JSON.parse(failing.stdout);
    expect(failing.code).toBe(1);
    expect(parsed.ok).toBe(false);
    expect(parsed.source).toBe("discovery");
    expect(parsed.daemonUrl).toBe("http://127.0.0.1:1");
    expect(parsed.error.code).toBe("daemon_unreachable");
  });

  it("returns daemon_invalid_json for HTTP 200 non-JSON daemon health", async () => {
    const daemonUrl = await startHealthServer(200, "not json");
    const env = cliEnv(tempDir);
    const failing = await execFileAsync(process.execPath, [tsxCliPath, cliPath, "daemon-health", "--daemon-url", daemonUrl], {
      env
    }).catch((error: { stdout: string; code: number }) => error);

    const parsed = JSON.parse(failing.stdout);
    expect(failing.code).toBe(1);
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("daemon_invalid_json");
    expect(parsed.error.details).toBe("not json");
  });

  it("returns daemon_invalid_json for HTTP 200 malformed JSON daemon health", async () => {
    const daemonUrl = await startHealthServer(200, '{"status":');
    const env = cliEnv(tempDir);
    const failing = await execFileAsync(process.execPath, [tsxCliPath, cliPath, "daemon-health", "--daemon-url", daemonUrl], {
      env
    }).catch((error: { stdout: string; code: number }) => error);

    const parsed = JSON.parse(failing.stdout);
    expect(failing.code).toBe(1);
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("daemon_invalid_json");
    expect(parsed.error.details).toBe('{"status":');
  });

  it("returns daemon_http_error with JSON details for non-OK daemon health response", async () => {
    const daemonUrl = await startHealthServer(500, '{"error":"boom","retry":false}');
    const env = cliEnv(tempDir);
    const failing = await execFileAsync(process.execPath, [tsxCliPath, cliPath, "daemon-health", "--daemon-url", daemonUrl], {
      env
    }).catch((error: { stdout: string; code: number }) => error);

    const parsed = JSON.parse(failing.stdout);
    expect(failing.code).toBe(1);
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("daemon_http_error");
    expect(parsed.error.status).toBe(500);
    expect(parsed.error.details).toEqual({ error: "boom", retry: false });
  });

  it("returns daemon_http_error with raw body details for non-JSON non-OK daemon health response", async () => {
    const daemonUrl = await startHealthServer(500, "internal error");
    const env = cliEnv(tempDir);
    const failing = await execFileAsync(process.execPath, [tsxCliPath, cliPath, "daemon-health", "--daemon-url", daemonUrl], {
      env
    }).catch((error: { stdout: string; code: number }) => error);

    const parsed = JSON.parse(failing.stdout);
    expect(failing.code).toBe(1);
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("daemon_http_error");
    expect(parsed.error.status).toBe(500);
    expect(parsed.error.details).toBe("internal error");
  });

  it("discovers a daemon only when explicitly requested", async () => {
    const daemonUrl = await startDaemon();
    await writeDaemonDiscovery(tempDir, {
      url: daemonUrl,
      pid: process.pid,
      startedAt: "2026-05-04T00:00:00.000Z",
      version: "0.1.0"
    });
    const env = {
      ...process.env,
      RETINUE_STATE_DIR: tempDir,
      RETINUE_CLAUDE_COMMAND: path.join(tempDir, "missing-local-claude")
    };

    const run = await execFileAsync(
      process.execPath,
      [tsxCliPath, cliPath, "--discover-daemon", "run", "--cwd", tempDir, "--prompt", "discovered cli"],
      { env }
    );
    const started = JSON.parse(run.stdout);

    const wait = await execFileAsync(
      process.execPath,
      [tsxCliPath, cliPath, "--discover-daemon", "wait", started.jobId, "--timeout-ms", "5000"],
      { env }
    );
    expect(JSON.parse(wait.stdout).status).toBe("completed");

    const result = await execFileAsync(
      process.execPath,
      [tsxCliPath, cliPath, "--discover-daemon", "result", started.jobId],
      { env }
    );
    expect(JSON.parse(result.stdout).parsedStdout.result).toBe("fake result: discovered cli");
  });

  it("runs and reads an OpenCode job through an explicit server URL", async () => {
    fakeOpenCode = await startFakeOpenCodeServer();
    const env = { ...process.env, RETINUE_STATE_DIR: tempDir };

    const run = await execFileAsync(
      process.execPath,
      [
        tsxCliPath,
        cliPath,
        "opencode-run",
        "--cwd",
        tempDir,
        "--prompt",
        "opencode cli",
        "--title",
        "cli test",
        "--opencode-base-url",
        fakeOpenCode.url
      ],
      { env }
    );
    const started = JSON.parse(run.stdout);
    expect(started.backend).toBe("opencode");
    expect(started.externalSessionId).toMatch(/^ses_/);

    const result = await execFileAsync(
      process.execPath,
      [tsxCliPath, cliPath, "opencode-result", started.jobId, "--opencode-base-url", fakeOpenCode.url],
      { env }
    );
    expect(JSON.parse(result.stdout).parsedStdout.result).toBe("fake result: opencode cli");
  });

  it("uses OpenCode model and agent defaults from environment", async () => {
    fakeOpenCode = await startFakeOpenCodeServer();
    const env = {
      ...process.env,
      RETINUE_STATE_DIR: tempDir,
      RETINUE_OPENCODE_MODEL: "litellm/pro-router",
      RETINUE_OPENCODE_AGENT: "build"
    };

    await execFileAsync(
      process.execPath,
      [
        tsxCliPath,
        cliPath,
        "opencode-run",
        "--cwd",
        tempDir,
        "--prompt",
        "opencode env defaults",
        "--opencode-base-url",
        fakeOpenCode.url
      ],
      { env }
    );

    expect(fakeOpenCode.promptRequests[0]).toMatchObject({
      agent: "build",
      model: { providerID: "litellm", modelID: "pro-router" }
    });
  });

  function cliEnv(stateDir: string): NodeJS.ProcessEnv {
    return {
      ...process.env,
      RETINUE_STATE_DIR: stateDir,
      RETINUE_CLAUDE_COMMAND: process.execPath,
      RETINUE_CLAUDE_PREFIX_ARGS: fixturePath
    };
  }

  async function startDaemon(): Promise<string> {
    const retinue = new ClaudeRetinue({
      stateDir: tempDir,
      claudeCommand: process.execPath,
      claudePrefixArgs: [fixturePath]
    });
    server = createDaemonServer(retinue);
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    return `http://127.0.0.1:${address.port}`;
  }

  async function startHealthServer(statusCode: number, body: string): Promise<string> {
    server = http.createServer((request, response) => {
      if (request.method !== "GET" || request.url !== "/health") {
        response.statusCode = 404;
        response.end();
        return;
      }
      response.statusCode = statusCode;
      response.setHeader("content-type", "text/plain; charset=utf-8");
      response.end(body);
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    return `http://127.0.0.1:${address.port}`;
  }
});

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function extractOpenCodeSubtaskPart(request: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  const parts = Array.isArray(request?.parts) ? request.parts : [];
  return parts.find((part): part is Record<string, unknown> => typeof part === "object" && part !== null && part.type === "subtask");
}
