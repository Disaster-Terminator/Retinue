import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { getJobPaths, getOpenCodeServerDiscoveryPath, getRetinueTracePath } from "../src/core/paths.js";
import {
  buildServeArgs,
  ensureOpenCodeServer,
  resolveOpenCodeCommandForSpawn,
  resolveOpenCodeServer,
  resolveOpenCodeServerFromEnv,
  scheduleManagedOpenCodeServerIdleShutdown,
  stopManagedOpenCodeServers
} from "../src/backends/opencode/serverManager.js";

describe("OpenCode server manager", () => {
  it("attaches to an explicit loopback base URL", () => {
    expect(resolveOpenCodeServer({ baseUrl: "http://127.0.0.1:4096/path" })).toEqual({
      mode: "attach",
      baseUrl: "http://127.0.0.1:4096"
    });
  });

  it("rejects missing server target unless auto-serve is enabled", () => {
    expect(() => resolveOpenCodeServer({ autoServe: false })).toThrow("OpenCode server target missing");
  });

  it("defaults auto-serve to the stable local OpenCode port", () => {
    const resolution = resolveOpenCodeServer({ autoServe: true });
    expect(resolution).toEqual({
      mode: "serve",
      command: "opencode",
      args: ["serve", "--hostname", "127.0.0.1", "--port", "4096"],
      host: "127.0.0.1",
      port: 4096,
      fallbackPorts: expect.arrayContaining([4097, 4098, 4127])
    });
    expect(resolution.mode === "serve" ? resolution.fallbackPorts : []).toHaveLength(31);
  });

  it("builds explicit opencode serve args", () => {
    expect(buildServeArgs({ host: "127.0.0.1", port: 4096 })).toEqual(["serve", "--hostname", "127.0.0.1", "--port", "4096"]);
  });

  it("rejects OpenCode auto-serve port 0 because the selected random port cannot be discovered", () => {
    expect(() =>
      resolveOpenCodeServerFromEnv({
        RETINUE_OPENCODE_AUTO_SERVE: "1",
        RETINUE_OPENCODE_PORT: "0"
      })
    ).toThrow("RETINUE_OPENCODE_PORT must be a port between 1 and 65535");
  });

  it("resolves opt-in serve from env", () => {
    expect(
      resolveOpenCodeServerFromEnv({
        RETINUE_OPENCODE_AUTO_SERVE: "1",
        RETINUE_OPENCODE_COMMAND: "opencode-test",
        RETINUE_OPENCODE_HOST: "127.0.0.1",
        RETINUE_OPENCODE_PORT: "4096",
        RETINUE_OPENCODE_FALLBACK_PORTS: "4097,4098"
      })
    ).toEqual({
      mode: "serve",
      command: "opencode-test",
      args: ["serve", "--hostname", "127.0.0.1", "--port", "4096"],
      host: "127.0.0.1",
      port: 4096,
      fallbackPorts: [4097, 4098]
    });
  });

  it("keeps explicit attach but prepares auto-serve fallback when both are configured", () => {
    const resolution = resolveOpenCodeServerFromEnv({
      RETINUE_OPENCODE_BASE_URL: "http://127.0.0.1:4097",
      RETINUE_OPENCODE_AUTO_SERVE: "1",
      RETINUE_OPENCODE_COMMAND: "opencode-test",
      RETINUE_OPENCODE_HOST: "127.0.0.1",
      RETINUE_OPENCODE_PORT: "4096",
      RETINUE_OPENCODE_FALLBACK_PORTS: "4098"
    });

    expect(resolution).toEqual({
      mode: "attach",
      baseUrl: "http://127.0.0.1:4097",
      fallbackServe: {
        mode: "serve",
        command: "opencode-test",
        args: ["serve", "--hostname", "127.0.0.1", "--port", "4096"],
        host: "127.0.0.1",
        port: 4096,
        fallbackPorts: [4098]
      }
    });
  });

  it("falls back to managed auto-serve when an explicit attach URL is unreachable and auto-serve is enabled", async () => {
    const attachPort = await freePort();
    const servePort = await freePort();
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "retinue-opencode-attach-fallback-"));
    const command = await writeFakeOpenCodeCommand();
    let target: Awaited<ReturnType<typeof ensureOpenCodeServer>> | undefined;
    try {
      target = await ensureOpenCodeServer(
        {
          mode: "attach",
          baseUrl: `http://127.0.0.1:${attachPort}`,
          fallbackServe: {
            mode: "serve",
            command,
            args: buildServeArgs({ host: "127.0.0.1", port: servePort }),
            host: "127.0.0.1",
            port: servePort,
            fallbackPorts: []
          }
        },
        { stateDir, healthTimeoutMs: 5000, healthPollMs: 50 }
      );

      expect(target.baseUrl).toBe(`http://127.0.0.1:${servePort}`);
      expect(target.started).toBe(true);
      const trace = await fs.readFile(getRetinueTracePath(stateDir), "utf8");
      expect(trace).toContain('"event":"opencode_server_attach_unreachable"');
      expect(trace).toContain(`"baseUrl":"http://127.0.0.1:${attachPort}"`);
      expect(trace).toContain(`"baseUrl":"http://127.0.0.1:${servePort}"`);
      expect(trace).toContain('"event":"opencode_server_ready"');
    } finally {
      target?.child?.kill();
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("rejects managed OpenCode server binds to non-loopback hosts by default", () => {
    expect(() =>
      resolveOpenCodeServerFromEnv({
        RETINUE_OPENCODE_AUTO_SERVE: "1",
        RETINUE_OPENCODE_HOST: "0.0.0.0"
      })
    ).toThrow(/Refusing to bind managed OpenCode server to a non-loopback host/);
  });

  it("allows managed OpenCode server non-loopback binds only with explicit override", () => {
    expect(
      resolveOpenCodeServerFromEnv({
        RETINUE_OPENCODE_AUTO_SERVE: "1",
        RETINUE_OPENCODE_HOST: "0.0.0.0",
        RETINUE_OPENCODE_ALLOW_NON_LOOPBACK: "1"
      })
    ).toMatchObject({
      mode: "serve",
      host: "0.0.0.0",
      args: ["serve", "--hostname", "0.0.0.0", "--port", "4096"]
    });
  });

  it("diagnoses stale legacy supervisor env without treating it as Retinue config", () => {
    expect(() =>
      resolveOpenCodeServerFromEnv({
        SUPERVISOR_RETINUE_BACKEND: "opencode",
        SUPERVISOR_OPENCODE_AUTO_SERVE: "1",
        SUPERVISOR_OPENCODE_HOST: "127.0.0.1",
        SUPERVISOR_OPENCODE_AGENT: "plan"
      })
    ).toThrow(/legacy SUPERVISOR_.*reload or restart/i);
  });

  it("falls back to the next candidate port when the preferred port is not OpenCode", async () => {
    const occupied = await startHealthServer("not opencode");
    const fallbackPorts = [await freePort(), await freePort(), await freePort()];
    const command = await writeFakeOpenCodeCommand();
    let target: Awaited<ReturnType<typeof ensureOpenCodeServer>> | undefined;
    try {
      target = await ensureOpenCodeServer(
        {
          mode: "serve",
          command,
          args: buildServeArgs({ host: "127.0.0.1", port: occupied.port }),
          host: "127.0.0.1",
          port: occupied.port,
          fallbackPorts
        },
        { healthTimeoutMs: 5000, healthPollMs: 50 }
      );

      expect(fallbackPorts.map((port) => `http://127.0.0.1:${port}`)).toContain(target.baseUrl);
      expect(target.started).toBe(true);
    } finally {
      target?.child?.kill();
      await occupied.close();
    }
  });

  it("falls back to the next candidate port when the spawned server exits before health", async () => {
    const failingPort = await freePort();
    const fallbackPort = await freePort();
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "retinue-opencode-startup-fallback-"));
    const command = await writeFakeOpenCodeCommandThatExitsOnPort(failingPort);
    let target: Awaited<ReturnType<typeof ensureOpenCodeServer>> | undefined;
    try {
      target = await ensureOpenCodeServer(
        {
          mode: "serve",
          command,
          args: buildServeArgs({ host: "127.0.0.1", port: failingPort }),
          host: "127.0.0.1",
          port: failingPort,
          fallbackPorts: [fallbackPort]
        },
        { stateDir, healthTimeoutMs: 5000, healthPollMs: 50 }
      );

      expect(target.baseUrl).toBe(`http://127.0.0.1:${fallbackPort}`);
      expect(target.started).toBe(true);
      const trace = await fs.readFile(getRetinueTracePath(stateDir), "utf8");
      expect(trace).toContain('"event":"opencode_server_start_failed"');
      expect(trace).toContain(`"baseUrl":"http://127.0.0.1:${failingPort}"`);
      expect(trace).toContain(`"baseUrl":"http://127.0.0.1:${fallbackPort}"`);
      expect(trace).toContain('"event":"opencode_server_ready"');
    } finally {
      target?.child?.kill();
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("times out an unresponsive OpenCode health endpoint instead of hanging startup", async () => {
    const port = await freePort();
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "retinue-opencode-unresponsive-health-"));
    const command = await writeFakeOpenCodeCommandWithHangingHealth();

    try {
      await expect(
        Promise.race([
          ensureOpenCodeServer(
            {
              mode: "serve",
              command,
              args: buildServeArgs({ host: "127.0.0.1", port }),
              host: "127.0.0.1",
              port,
              fallbackPorts: []
            },
            { stateDir, healthTimeoutMs: 100, healthPollMs: 25 }
          ),
          rejectAfter(1000, "health probe did not honor startup timeout")
        ])
      ).rejects.toThrow(/Timed out waiting for OpenCode server/);

      const trace = await fs.readFile(getRetinueTracePath(stateDir), "utf8");
      expect(trace).toContain('"event":"opencode_server_start_failed"');
      expect(trace).toContain(`"baseUrl":"http://127.0.0.1:${port}"`);
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("does not attach to an unowned healthy OpenCode server while auto-serving", async () => {
    const occupied = await startHealthServer(JSON.stringify({ healthy: true, version: "external" }));
    const fallbackPort = await freePort();
    const command = await writeFakeOpenCodeCommand();
    let target: Awaited<ReturnType<typeof ensureOpenCodeServer>> | undefined;
    try {
      target = await ensureOpenCodeServer(
        {
          mode: "serve",
          command,
          args: buildServeArgs({ host: "127.0.0.1", port: occupied.port }),
          host: "127.0.0.1",
          port: occupied.port,
          fallbackPorts: [fallbackPort]
        },
        { healthTimeoutMs: 5000, healthPollMs: 50 }
      );

      expect(target.baseUrl).toBe(`http://127.0.0.1:${fallbackPort}`);
      expect(target.started).toBe(true);
    } finally {
      target?.child?.kill();
      await occupied.close();
    }
  });

  it("starts managed OpenCode servers in the requested project cwd", async () => {
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "retinue-opencode-project-"));
    const port = await freePort();
    const command = await writeFakeOpenCodeCommandWithSessions();
    let target: Awaited<ReturnType<typeof ensureOpenCodeServer>> | undefined;
    try {
      target = await ensureOpenCodeServer(
        {
          mode: "serve",
          command,
          args: buildServeArgs({ host: "127.0.0.1", port }),
          host: "127.0.0.1",
          port,
          fallbackPorts: []
        },
        { cwd: projectDir, healthTimeoutMs: 5000, healthPollMs: 50 }
      );

      const created = (await (await fetch(`${target.baseUrl}/session`, { method: "POST", body: "{}" })).json()) as { id: string };
      const session = (await (await fetch(`${target.baseUrl}/session/${created.id}`)).json()) as { directory?: string };
      expect(session.directory).toBe(projectDir);
    } finally {
      target?.child?.kill();
      await fs.rm(projectDir, { recursive: true, force: true });
    }
  });

  it("stops managed OpenCode servers after an idle shutdown grace period", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "retinue-opencode-state-"));
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "retinue-opencode-project-"));
    const port = await freePort();
    const command = await writeFakeOpenCodeCommandWithSessions();
    let target: Awaited<ReturnType<typeof ensureOpenCodeServer>> | undefined;
    try {
      target = await ensureOpenCodeServer(
        {
          mode: "serve",
          command,
          args: buildServeArgs({ host: "127.0.0.1", port }),
          host: "127.0.0.1",
          port,
          fallbackPorts: []
        },
        { stateDir, cwd: projectDir, healthTimeoutMs: 5000, healthPollMs: 50 }
      );

      scheduleManagedOpenCodeServerIdleShutdown(target.baseUrl, {
        stateDir,
        cwd: projectDir,
        delayMs: 10
      });

      await waitForUnreachable(target.baseUrl);
      const trace = await fs.readFile(getRetinueTracePath(stateDir), "utf8");
      expect(trace).toContain('"event":"opencode_server_idle_shutdown_scheduled"');
      expect(trace).toContain('"event":"opencode_server_stopped"');
    } finally {
      target?.child?.kill();
      await fs.rm(stateDir, { recursive: true, force: true });
      await fs.rm(projectDir, { recursive: true, force: true });
    }
  });

  it("does not stop a reused managed OpenCode server when a new running job appears before the idle timer fires", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "retinue-opencode-state-"));
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "retinue-opencode-project-"));
    const port = await freePort();
    const command = await writeFakeOpenCodeCommandWithSessions();
    let target: Awaited<ReturnType<typeof ensureOpenCodeServer>> | undefined;
    try {
      target = await ensureOpenCodeServer(
        {
          mode: "serve",
          command,
          args: buildServeArgs({ host: "127.0.0.1", port }),
          host: "127.0.0.1",
          port,
          fallbackPorts: []
        },
        { stateDir, cwd: projectDir, healthTimeoutMs: 5000, healthPollMs: 50 }
      );

      scheduleManagedOpenCodeServerIdleShutdown(target.baseUrl, {
        stateDir,
        cwd: projectDir,
        delayMs: 20
      });
      await writeOpenCodeRunningJob(stateDir, "job_running_reused_server", target.baseUrl, projectDir);
      await sleep(80);

      await expect(fetch(`${target.baseUrl}/global/health`).then((response) => response.ok)).resolves.toBe(true);
      const trace = await fs.readFile(getRetinueTracePath(stateDir), "utf8");
      expect(trace).toContain('"event":"opencode_server_idle_shutdown_scheduled"');
      expect(trace).toContain('"event":"opencode_server_idle_shutdown_skipped"');
      expect(trace).not.toContain('"event":"opencode_server_stopped"');
    } finally {
      target?.child?.kill();
      await fs.rm(stateDir, { recursive: true, force: true });
      await fs.rm(projectDir, { recursive: true, force: true });
    }
  });

  it("stops a Retinue-managed OpenCode server recorded in discovery", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "retinue-opencode-manual-stop-"));
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "retinue-opencode-project-"));
    const port = await freePort();
    const command = await writeFakeOpenCodeCommandWithSessions();
    let target: Awaited<ReturnType<typeof ensureOpenCodeServer>> | undefined;
    try {
      target = await ensureOpenCodeServer(
        {
          mode: "serve",
          command,
          args: buildServeArgs({ host: "127.0.0.1", port }),
          host: "127.0.0.1",
          port,
          fallbackPorts: []
        },
        { stateDir, cwd: projectDir, healthTimeoutMs: 5000, healthPollMs: 50 }
      );

      const stopped = await stopManagedOpenCodeServers({ stateDir, cwd: projectDir, reason: "manual" });

      expect(stopped).toMatchObject({
        backend: "opencode",
        status: "stopped",
        stopped: [expect.objectContaining({ baseUrl: target.baseUrl, cwd: projectDir })],
        blocked: []
      });
      await waitForUnreachable(target.baseUrl);
      await expect(ensureOpenCodeServer(
        {
          mode: "serve",
          command: "retinue-missing-opencode-command",
          args: buildServeArgs({ host: "127.0.0.1", port }),
          host: "127.0.0.1",
          port,
          fallbackPorts: []
        },
        { stateDir, cwd: projectDir, healthTimeoutMs: 100, healthPollMs: 25 }
      )).rejects.toThrow(/Failed to start OpenCode server command/);
    } finally {
      target?.child?.kill();
      await fs.rm(stateDir, { recursive: true, force: true });
      await fs.rm(projectDir, { recursive: true, force: true });
    }
  });

  it("blocks managed OpenCode server stop while jobs are running unless forced", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "retinue-opencode-force-stop-"));
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "retinue-opencode-project-"));
    const port = await freePort();
    const command = await writeFakeOpenCodeCommandWithSessions();
    let target: Awaited<ReturnType<typeof ensureOpenCodeServer>> | undefined;
    try {
      target = await ensureOpenCodeServer(
        {
          mode: "serve",
          command,
          args: buildServeArgs({ host: "127.0.0.1", port }),
          host: "127.0.0.1",
          port,
          fallbackPorts: []
        },
        { stateDir, cwd: projectDir, healthTimeoutMs: 5000, healthPollMs: 50 }
      );
      await writeOpenCodeRunningJob(stateDir, "job_running_runtime_stop", target.baseUrl, projectDir);

      await expect(stopManagedOpenCodeServers({ stateDir, cwd: projectDir, reason: "manual" })).resolves.toMatchObject({
        status: "blocked",
        blocked: [expect.objectContaining({ runningJobIds: ["job_running_runtime_stop"] })],
        stopped: []
      });
      await expect(fetch(`${target.baseUrl}/global/health`).then((response) => response.ok)).resolves.toBe(true);

      await expect(stopManagedOpenCodeServers({ stateDir, cwd: projectDir, reason: "manual", force: true })).resolves.toMatchObject({
        status: "stopped",
        stopped: [expect.objectContaining({ baseUrl: target.baseUrl, killedJobIds: ["job_running_runtime_stop"] })],
        blocked: []
      });
      await waitForUnreachable(target.baseUrl);
      await expect(fs.readFile(getJobPaths(stateDir, "job_running_runtime_stop").meta, "utf8").then(JSON.parse)).resolves.toMatchObject({
        status: "killed"
      });
    } finally {
      target?.child?.kill();
      await fs.rm(stateDir, { recursive: true, force: true });
      await fs.rm(projectDir, { recursive: true, force: true });
    }
  });

  it("reuses a Retinue-managed OpenCode server recorded in state discovery", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "retinue-opencode-discovery-"));
    const managed = await startHealthServer(JSON.stringify({ healthy: true, version: "managed" }));
    const occupied = await startHealthServer(JSON.stringify({ healthy: true, version: "external" }));
    try {
      await fs.writeFile(
        getOpenCodeServerDiscoveryPath(stateDir),
        `${JSON.stringify(
          {
            baseUrl: `http://127.0.0.1:${managed.port}`,
            pid: process.pid,
            startedAt: new Date().toISOString(),
            version: "0.1.0"
          },
          null,
          2
        )}\n`,
        "utf8"
      );

      const target = await ensureOpenCodeServer(
        {
          mode: "serve",
          command: "missing-opencode",
          args: buildServeArgs({ host: "127.0.0.1", port: occupied.port }),
          host: "127.0.0.1",
          port: occupied.port,
          fallbackPorts: []
        },
        { stateDir, healthTimeoutMs: 500, healthPollMs: 50 }
      );

      expect(target.baseUrl).toBe(`http://127.0.0.1:${managed.port}`);
      expect(target.started).toBe(false);
    } finally {
      await Promise.allSettled([managed.close(), occupied.close(), fs.rm(stateDir, { recursive: true, force: true })]);
    }
  });

  it("reuses a discovered managed OpenCode server when the health probe briefly times out", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "retinue-opencode-slow-discovery-"));
    const managed = await startHealthServer(JSON.stringify({ healthy: true, version: "managed" }), 500);
    const baseUrl = `http://127.0.0.1:${managed.port}`;

    try {
      await fs.writeFile(
        getOpenCodeServerDiscoveryPath(stateDir),
        `${JSON.stringify(
          {
            baseUrl,
            pid: process.pid,
            startedAt: new Date().toISOString(),
            version: "0.1.0"
          },
          null,
          2
        )}\n`,
        "utf8"
      );

      await expect(
        ensureOpenCodeServer(
          {
            mode: "serve",
            command: "retinue-missing-opencode-command",
            args: buildServeArgs({ host: "127.0.0.1", port: managed.port }),
            host: "127.0.0.1",
            port: managed.port,
            fallbackPorts: []
          },
          { stateDir }
        )
      ).resolves.toMatchObject({ baseUrl, started: false });
    } finally {
      await Promise.allSettled([managed.close(), fs.rm(stateDir, { recursive: true, force: true })]);
    }
  });

  it("does not remove a fresh partially-written startup lock", async () => {
    const port = await freePort();
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "retinue-opencode-fresh-lock-"));

    try {
      await fs.mkdir(path.dirname(getOpenCodeServerDiscoveryPath(stateDir)), { recursive: true });
      await fs.writeFile(path.join(path.dirname(getOpenCodeServerDiscoveryPath(stateDir)), "opencode-server.lock"), "", "utf8");

      await expect(
        ensureOpenCodeServer(
          {
            mode: "serve",
            command: "retinue-missing-opencode-command",
            args: buildServeArgs({ host: "127.0.0.1", port }),
            host: "127.0.0.1",
            port,
            fallbackPorts: []
          },
          { stateDir, lockTimeoutMs: 50 }
        )
      ).rejects.toThrow(/Timed out waiting for OpenCode server startup lock/);
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("reports a missing OpenCode command without crashing the MCP process", async () => {
    const port = await freePort();
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "retinue-opencode-trace-"));

    try {
      await expect(
        ensureOpenCodeServer(
          {
            mode: "serve",
            command: "retinue-missing-opencode-command",
            args: buildServeArgs({ host: "127.0.0.1", port }),
            host: "127.0.0.1",
            port,
            fallbackPorts: []
          },
          { stateDir, healthTimeoutMs: 500, healthPollMs: 50 }
        )
      ).rejects.toThrow(/Failed to start OpenCode server command "retinue-missing-opencode-command"/);

      const trace = await fs.readFile(getRetinueTracePath(stateDir), "utf8");
      expect(trace).toContain('"event":"opencode_server_spawn"');
      expect(trace).toContain('"event":"opencode_server_start_failed"');
      expect(trace).toContain("retinue-missing-opencode-command");
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("finds the default official Windows OpenCode install outside the inherited PATH", async () => {
    const existing = new Set(["C:\\Users\\Disas\\.opencode\\bin\\opencode"]);

    await expect(
      resolveOpenCodeCommandForSpawn("opencode", {
        platform: "win32",
        env: {
          USERPROFILE: "C:\\Users\\Disas",
          LOCALAPPDATA: "C:\\Users\\Disas\\AppData\\Local",
          APPDATA: "C:\\Users\\Disas\\AppData\\Roaming",
          Path: "C:\\Windows\\System32"
        },
        exists: async (candidate) => existing.has(candidate)
      })
    ).resolves.toEqual({
      command: "C:\\Users\\Disas\\.opencode\\bin\\opencode",
      shell: false
    });
  });

  it("falls back to package-manager Windows OpenCode shims when the official install is absent", async () => {
    const existing = new Set(["C:\\Users\\Disas\\.local\\pnpm-global\\opencode.CMD"]);

    await expect(
      resolveOpenCodeCommandForSpawn("opencode", {
        platform: "win32",
        env: {
          USERPROFILE: "C:\\Users\\Disas",
          LOCALAPPDATA: "C:\\Users\\Disas\\AppData\\Local",
          APPDATA: "C:\\Users\\Disas\\AppData\\Roaming",
          Path: "C:\\Windows\\System32"
        },
        exists: async (candidate) => existing.has(candidate)
      })
    ).resolves.toEqual({
      command: "C:\\Users\\Disas\\.local\\pnpm-global\\opencode.CMD",
      shell: true
    });
  });

  it("prefers an inherited PATH OpenCode command before Windows fallback locations", async () => {
    const existing = new Set(["C:\\Tools\\opencode.EXE", "C:\\Users\\Disas\\.local\\pnpm-global\\opencode.CMD"]);

    await expect(
      resolveOpenCodeCommandForSpawn("opencode", {
        platform: "win32",
        env: {
          USERPROFILE: "C:\\Users\\Disas",
          Path: "C:\\Tools;C:\\Windows\\System32"
        },
        exists: async (candidate) => existing.has(candidate)
      })
    ).resolves.toEqual({
      command: "C:\\Tools\\opencode.EXE",
      shell: false
    });
  });

  it("finds the default official POSIX OpenCode install outside the inherited PATH", async () => {
    const existing = new Set(["/home/raystorm/.opencode/bin/opencode"]);

    await expect(
      resolveOpenCodeCommandForSpawn("opencode", {
        platform: "linux",
        env: {
          HOME: "/home/raystorm",
          PATH: "/usr/local/bin:/usr/bin"
        },
        exists: async (candidate) => existing.has(candidate)
      })
    ).resolves.toEqual({
      command: "/home/raystorm/.opencode/bin/opencode",
      shell: false
    });
  });

  it("rejects non-loopback and non-http base URLs", () => {
    expect(() => resolveOpenCodeServer({ baseUrl: "https://127.0.0.1:4096" })).toThrow("must use http");
    expect(() => resolveOpenCodeServer({ baseUrl: "http://example.com:4096" })).toThrow("must be loopback");
  });
});

async function startHealthServer(body: string, delayMs = 0): Promise<{ port: number; close(): Promise<void> }> {
  const server = http.createServer((_request, response) => {
    setTimeout(() => {
      response.statusCode = 200;
      response.end(body);
    }, delayMs);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    port: address.port,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  };
}

async function freePort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return address.port;
}

function rejectAfter(ms: number, message: string): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(message)), ms);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForUnreachable(baseUrl: string): Promise<void> {
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      await fetch(`${baseUrl}/global/health`);
    } catch {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(`Expected OpenCode server at ${baseUrl} to stop`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function writeOpenCodeRunningJob(stateDir: string, jobId: string, baseUrl: string, cwd: string): Promise<void> {
  const paths = getJobPaths(stateDir, jobId);
  await fs.mkdir(paths.dir, { recursive: true });
  const now = new Date().toISOString();
  await fs.writeFile(
    paths.meta,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        backend: "opencode",
        jobId,
        pid: -1,
        status: "running",
        cwd,
        promptPath: paths.prompt,
        promptPreview: "running",
        promptSha256: "running",
        externalServerUrl: baseUrl,
        args: [],
        createdAt: now,
        updatedAt: now
      },
      null,
      2
    )}\n`,
    "utf8"
  );
}

async function writeFakeOpenCodeCommand(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "retinue-fake-opencode-command-"));
  const file = path.join(dir, "opencode-fake.mjs");
  await fs.writeFile(
    file,
    `#!/usr/bin/env node
import http from "node:http";
const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
const host = process.argv[process.argv.indexOf("--hostname") + 1];
const server = http.createServer((request, response) => {
  if (request.url === "/global/health") {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ healthy: true, version: "fake" }));
    return;
  }
  response.statusCode = 404;
  response.end("{}");
});
server.listen(port, host);
`,
    { mode: 0o755 }
  );
  return file;
}

async function writeFakeOpenCodeCommandWithHangingHealth(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "retinue-fake-opencode-command-"));
  const file = path.join(dir, "opencode-fake.mjs");
  await fs.writeFile(
    file,
    `#!/usr/bin/env node
import http from "node:http";
const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
const host = process.argv[process.argv.indexOf("--hostname") + 1];
const server = http.createServer((request, response) => {
  if (request.url === "/global/health") {
    response.setHeader("content-type", "application/json");
    return;
  }
  response.statusCode = 404;
  response.end("{}");
});
server.listen(port, host);
`,
    { mode: 0o755 }
  );
  return file;
}

async function writeFakeOpenCodeCommandThatExitsOnPort(failingPort: number): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "retinue-fake-opencode-command-"));
  const file = path.join(dir, "opencode-fake.mjs");
  await fs.writeFile(
    file,
    `#!/usr/bin/env node
import http from "node:http";
const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
const host = process.argv[process.argv.indexOf("--hostname") + 1];
if (port === ${JSON.stringify(failingPort)}) {
  process.exit(1);
}
const server = http.createServer((request, response) => {
  if (request.url === "/global/health") {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ healthy: true, version: "fake" }));
    return;
  }
  response.statusCode = 404;
  response.end("{}");
});
server.listen(port, host);
`,
    { mode: 0o755 }
  );
  return file;
}

async function writeFakeOpenCodeCommandWithSessions(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "retinue-fake-opencode-command-"));
  const file = path.join(dir, "opencode-fake.mjs");
  await fs.writeFile(
    file,
    `#!/usr/bin/env node
import http from "node:http";
const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
const host = process.argv[process.argv.indexOf("--hostname") + 1];
const serverCwd = process.cwd();
const sessions = new Map();
let nextSession = 1;
const server = http.createServer((request, response) => {
  response.setHeader("content-type", "application/json");
  if (request.url === "/global/health") {
    response.end(JSON.stringify({ healthy: true, version: "fake" }));
    return;
  }
  if (request.method === "POST" && request.url === "/session") {
    const session = { id: \`ses_\${nextSession++}\`, directory: serverCwd, state: "running" };
    sessions.set(session.id, session);
    response.end(JSON.stringify(session));
    return;
  }
  const match = /^\\/session\\/([^/]+)$/.exec(request.url ?? "");
  if (request.method === "GET" && match) {
    const session = sessions.get(decodeURIComponent(match[1]));
    response.statusCode = session ? 200 : 404;
    response.end(JSON.stringify(session ?? { error: { message: "Missing session" } }));
    return;
  }
  response.statusCode = 404;
  response.end("{}");
});
server.listen(port, host);
`,
    { mode: 0o755 }
  );
  return file;
}
