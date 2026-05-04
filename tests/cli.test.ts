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
import { ClaudeSupervisor } from "../src/core/supervisor.js";

const cliPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/cli.ts");
const fixturePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures/fake-claude.mjs");
const tsxCliPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../node_modules/tsx/dist/cli.mjs");
const execFileAsync = promisify(execFile);

describe("CLI", () => {
  let tempDir: string;
  let server: http.Server | undefined;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "supervisor-cli-test-"));
  });

  afterEach(async () => {
    if (server) {
      await closeServer(server);
      server = undefined;
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
      SUPERVISOR_DAEMON_URL: daemonUrl,
      SUPERVISOR_STATE_DIR: path.join(tempDir, "client-state"),
      SUPERVISOR_CLAUDE_COMMAND: path.join(tempDir, "missing-local-claude")
    };

    const run = await execFileAsync(process.execPath, [tsxCliPath, cliPath, "run", "--cwd", tempDir, "--prompt", "daemon cli"], { env });
    const started = JSON.parse(run.stdout);
    expect(started.status).toBe("running");

    const wait = await execFileAsync(process.execPath, [tsxCliPath, cliPath, "wait", started.jobId, "--timeout-ms", "5000"], { env });
    expect(JSON.parse(wait.stdout).status).toBe("completed");

    const result = await execFileAsync(process.execPath, [tsxCliPath, cliPath, "result", started.jobId], { env });
    expect(JSON.parse(result.stdout).parsedStdout.result).toBe("fake result: daemon cli");
  });


  it("reports daemon health via explicit URL", async () => {
    const daemonUrl = await startDaemon();
    const env = cliEnv(tempDir);

    const health = await execFileAsync(process.execPath, [tsxCliPath, cliPath, "daemon-health", "--daemon-url", daemonUrl], { env });
    const parsed = JSON.parse(health.stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.source).toBe("explicit_url");
    expect(parsed.daemonUrl).toBe(daemonUrl);
    expect(parsed.health.status).toBe("ok");
  });

  it("reports daemon health via discovery", async () => {
    const daemonUrl = await startDaemon();
    await writeDaemonDiscovery(tempDir, {
      url: daemonUrl,
      pid: process.pid,
      startedAt: "2026-05-04T00:00:00.000Z",
      version: "0.1.0"
    });
    const env = {
      ...process.env,
      SUPERVISOR_STATE_DIR: tempDir
    };

    const health = await execFileAsync(process.execPath, [tsxCliPath, cliPath, "daemon-health", "--discover-daemon"], { env });
    const parsed = JSON.parse(health.stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.source).toBe("discovery");
    expect(parsed.daemonUrl).toBe(daemonUrl);
    expect(parsed.discovery.url).toBe(daemonUrl);
    expect(parsed.health.status).toBe("ok");
  });

  it("reports unreachable daemon as structured failure", async () => {
    const env = cliEnv(tempDir);
    const health = await execFileAsync(process.execPath, [tsxCliPath, cliPath, "daemon-health", "--daemon-url", "http://127.0.0.1:1"], { env });
    const parsed = JSON.parse(health.stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.source).toBe("explicit_url");
    expect(parsed.error.code).toBe("daemon_unreachable");
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
      SUPERVISOR_STATE_DIR: tempDir,
      SUPERVISOR_CLAUDE_COMMAND: path.join(tempDir, "missing-local-claude")
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

  function cliEnv(stateDir: string): NodeJS.ProcessEnv {
    return {
      ...process.env,
      SUPERVISOR_STATE_DIR: stateDir,
      SUPERVISOR_CLAUDE_COMMAND: process.execPath,
      SUPERVISOR_CLAUDE_PREFIX_ARGS: fixturePath
    };
  }

  async function startDaemon(): Promise<string> {
    const supervisor = new ClaudeSupervisor({
      stateDir: tempDir,
      claudeCommand: process.execPath,
      claudePrefixArgs: [fixturePath]
    });
    server = createDaemonServer(supervisor);
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
