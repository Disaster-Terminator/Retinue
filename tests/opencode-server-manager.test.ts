import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { getOpenCodeServerDiscoveryPath, getRetinueTracePath } from "../src/core/paths.js";
import {
  buildServeArgs,
  ensureOpenCodeServer,
  resolveOpenCodeCommandForSpawn,
  resolveOpenCodeServer,
  resolveOpenCodeServerFromEnv
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
    expect(buildServeArgs({ host: "127.0.0.1", port: 0 })).toEqual(["serve", "--hostname", "127.0.0.1", "--port", "0"]);
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

  it("rejects non-loopback and non-http base URLs", () => {
    expect(() => resolveOpenCodeServer({ baseUrl: "https://127.0.0.1:4096" })).toThrow("must use http");
    expect(() => resolveOpenCodeServer({ baseUrl: "http://example.com:4096" })).toThrow("must be loopback");
  });
});

async function startHealthServer(body: string): Promise<{ port: number; close(): Promise<void> }> {
  const server = http.createServer((_request, response) => {
    response.statusCode = 200;
    response.end(body);
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
