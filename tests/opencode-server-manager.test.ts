import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { getOpenCodeServerDiscoveryPath } from "../src/core/paths.js";
import { buildServeArgs, ensureOpenCodeServer, resolveOpenCodeServer, resolveOpenCodeServerFromEnv } from "../src/backends/opencode/serverManager.js";

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
    expect(resolveOpenCodeServer({ autoServe: true })).toEqual({
      mode: "serve",
      command: "opencode",
      args: ["serve", "--hostname", "127.0.0.1", "--port", "4096"],
      host: "127.0.0.1",
      port: 4096,
      fallbackPorts: [4097]
    });
  });

  it("builds explicit opencode serve args", () => {
    expect(buildServeArgs({ host: "127.0.0.1", port: 0 })).toEqual(["serve", "--hostname", "127.0.0.1", "--port", "0"]);
  });

  it("resolves opt-in serve from env", () => {
    expect(
      resolveOpenCodeServerFromEnv({
        SUPERVISOR_OPENCODE_AUTO_SERVE: "1",
        SUPERVISOR_OPENCODE_COMMAND: "opencode-test",
        SUPERVISOR_OPENCODE_HOST: "127.0.0.1",
        SUPERVISOR_OPENCODE_PORT: "4096",
        SUPERVISOR_OPENCODE_FALLBACK_PORTS: "4097,4098"
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
