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
import type { RetinueApi } from "../src/core/types.js";

const cliPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/cli.ts");
const tsxCliPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../node_modules/tsx/dist/cli.mjs");
const execFileAsync = promisify(execFile);
const daemonToken = "cli-daemon-test-token";

describe("CLI", () => {
  let tempDir: string;
  let server: http.Server | undefined;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "retinue-cli-test-"));
  });

  afterEach(async () => {
    if (server) {
      await closeServer(server);
      server = undefined;
    }
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("rejects legacy flat job commands", async () => {
    const failing = await execCli(["run", "--cwd", tempDir, "--prompt", "legacy"], cliEnv(tempDir)).catch(
      (error: { stderr: string; code: number }) => error
    );

    expect(failing.code).toBe(1);
    expect(failing.stderr).toContain("Legacy flat CLI commands were removed");
  });

  it("returns daemon health from an explicit URL", async () => {
    const daemonUrl = await startDaemon();
    const result = await execCli(["daemon", "health", "--daemon-url", daemonUrl], {
      ...cliEnv(tempDir),
      RETINUE_DAEMON_TOKEN: daemonToken
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
      version: "0.1.0",
      token: daemonToken
    });

    const result = await execCli(["--discover-daemon", "daemon", "health"], cliEnv(tempDir));
    const parsed = JSON.parse(result.stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.source).toBe("discovery");
    expect(parsed.daemonUrl).toBe(daemonUrl);
    expect(parsed.health.status).toBe("ok");
  });

  it("returns structured missing target failure for daemon health", async () => {
    const failing = await execCli(["daemon", "health"], cliEnv(tempDir)).catch((error: { stdout: string; code: number }) => error);

    const parsed = JSON.parse(failing.stdout);
    expect(failing.code).toBe(1);
    expect(parsed.ok).toBe(false);
    expect(parsed.source).toBe("none");
    expect(parsed.error.code).toBe("missing_daemon_target");
  });

  it("prints the current MCP product tools", async () => {
    const result = await execCli(["mcp", "tools"], cliEnv(tempDir));
    const parsed = JSON.parse(result.stdout);

    expect(parsed.defaultTools).toEqual([
      "spawn_agent",
      "wait_agent",
      "close_agent",
      "list_agents",
      "list_permissions",
      "reply_permission",
      "stop_runtime",
      "restart_runtime"
    ]);
    expect(parsed.diagnosticTools).toBeUndefined();
    expect(parsed.backendDebugTools).toBeUndefined();
  });

  it("can include non-default MCP diagnostic and backend debug tools", async () => {
    const result = await execCli(["mcp", "tools", "--include-diagnostics", "--include-backend-debug"], cliEnv(tempDir));
    const parsed = JSON.parse(result.stdout);

    expect(parsed.diagnosticTools).toEqual(["audit_logs"]);
    expect(parsed.backendDebugTools.opencode).toContain("opencode_run");
    expect(parsed.backendDebugTools.claude).toContain("claude_run");
  });

  it("runs compact log audit through the CLI control plane", async () => {
    const result = await execCli(["diagnostics", "audit-logs", "--state-dir", tempDir, "--max-lines", "10"], cliEnv(tempDir));

    expect(result.stdout).toContain("Retinue log audit:");
    expect(result.stdout).toContain("issues=0");
  });

  it("runs plugin cache sync as a package-level bootstrap command", async () => {
    const cacheRoot = path.join(tempDir, "cache");
    const target = path.join(cacheRoot, "retinue-local", "retinue", "0.2.0");
    await fs.mkdir(path.join(target, ".codex-plugin"), { recursive: true });
    await fs.writeFile(path.join(target, ".codex-plugin", "plugin.json"), JSON.stringify({ name: "retinue" }), "utf8");

    const result = await execCli(["plugin", "sync-cache", "--cache-root", cacheRoot, "--json"], cliEnv(tempDir));
    const parsed = JSON.parse(result.stdout);

    expect(parsed.ok).toBe(true);
    expect(parsed.dryRun).toBe(true);
    expect(parsed.pluginName).toBe("retinue");
    expect(parsed.targets[0].targets[0].path).toBe(target);
  });

  it("returns structured runtime stop validation instead of throwing", async () => {
    const result = await execCli(["runtime", "stop"], cliEnv(tempDir));
    const parsed = JSON.parse(result.stdout);

    expect(parsed).toMatchObject({
      runtime: "opencode",
      status: "invalid_request"
    });
  });

  function cliEnv(stateDir: string): NodeJS.ProcessEnv {
    return {
      ...process.env,
      RETINUE_STATE_DIR: stateDir
    };
  }

  async function execCli(args: string[], env: NodeJS.ProcessEnv) {
    return execFileAsync(process.execPath, [tsxCliPath, cliPath, ...args], { env });
  }

  async function startDaemon(): Promise<string> {
    server = createDaemonServer(createHealthOnlyRetinue(), { authToken: daemonToken });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    return `http://127.0.0.1:${address.port}`;
  }
});

function createHealthOnlyRetinue(): RetinueApi & { getStateDir(): string } {
  return {
    getStateDir: () => "test-state-dir",
    run: async () => {
      throw new Error("not implemented in CLI health tests");
    },
    continueJob: async () => {
      throw new Error("not implemented in CLI health tests");
    },
    status: async () => {
      throw new Error("not implemented in CLI health tests");
    },
    wait: async () => {
      throw new Error("not implemented in CLI health tests");
    },
    result: async () => {
      throw new Error("not implemented in CLI health tests");
    },
    peek: async () => {
      throw new Error("not implemented in CLI health tests");
    },
    kill: async () => {
      throw new Error("not implemented in CLI health tests");
    },
    cleanup: async () => {
      throw new Error("not implemented in CLI health tests");
    }
  };
}

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
