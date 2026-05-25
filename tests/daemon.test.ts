import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { createDaemonServer } from "../src/daemon/server.js";
import { ClaudeRetinue } from "../src/core/retinue.js";

const authToken = "daemon-test-token";
const fixturePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures/fake-claude.mjs");

describe("retinue daemon", () => {
  let tempDir: string;
  let server: http.Server | undefined;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "retinue-daemon-test-"));
  });

  afterEach(async () => {
    if (server) {
      await closeServer(server);
      server = undefined;
    }
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("runs, waits, and reads a job through HTTP", async () => {
    const retinue = new ClaudeRetinue({
      stateDir: tempDir,
      claudeCommand: process.execPath,
      claudePrefixArgs: [fixturePath]
    });
    const daemon = await startDaemon(retinue);

    await expect(getJson(`${daemon.url}/health`)).resolves.toMatchObject({
      status: "ok",
      version: "0.1.0"
    });

    const started = await postJson(`${daemon.url}/v1/jobs/run`, {
      cwd: tempDir,
      prompt: "daemon hello"
    });
    expect(started.status).toBe("running");

    const waited = await postJson(`${daemon.url}/v1/jobs/wait`, {
      jobId: started.jobId,
      timeoutMs: 5000
    });
    expect(waited.status).toBe("completed");

    const result = await postJson(`${daemon.url}/v1/jobs/result`, {
      jobId: started.jobId
    });
    expect(result.parsedStdout.result).toBe("fake result: daemon hello");
  });

  it("returns structured HTTP errors", async () => {
    const daemon = await startDaemon(
      new ClaudeRetinue({
        stateDir: tempDir,
        claudeCommand: process.execPath,
        claudePrefixArgs: [fixturePath]
      })
    );

    const response = await fetch(`${daemon.url}/v1/jobs/missing`, { method: "POST", headers: authHeaders() });
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "not_found",
        message: expect.stringMatching(/not found/i)
      }
    });
  });

  it("rejects requests without the daemon token", async () => {
    const daemon = await startDaemon(
      new ClaudeRetinue({
        stateDir: tempDir,
        claudeCommand: process.execPath,
        claudePrefixArgs: [fixturePath]
      })
    );

    const response = await fetch(`${daemon.url}/v1/jobs/run`, {
      method: "POST",
      headers: { "content-type": "text/plain", origin: "https://attacker.example" },
      body: JSON.stringify({ cwd: tempDir, prompt: "blocked" })
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "unauthorized" }
    });
  });

  async function startDaemon(retinue: ClaudeRetinue): Promise<{ url: string }> {
    server = createDaemonServer(retinue, { authToken });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    return { url: `http://127.0.0.1:${address.port}` };
  }
});

async function getJson(url: string): Promise<any> {
  const response = await fetch(url, { headers: authHeaders() });
  expect(response.ok).toBe(true);
  return response.json();
}

async function postJson(url: string, body: unknown): Promise<any> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders() },
    body: JSON.stringify(body)
  });
  expect(response.ok).toBe(true);
  return response.json();
}

function authHeaders() {
  return { authorization: `Bearer ${authToken}` };
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
