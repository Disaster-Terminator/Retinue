import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { createDaemonServer } from "../src/daemon/server.js";
import { ClaudeSupervisor } from "../src/core/supervisor.js";

describe("daemon RPC contract", () => {
  let tempDir: string;
  let server: http.Server | undefined;
  let baseUrl: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "supervisor-rpc-contract-test-"));
    server = createDaemonServer(new ClaudeSupervisor({ stateDir: tempDir }));
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    if (server) {
      await closeServer(server);
      server = undefined;
    }
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("returns a structured not_found error for unknown routes", async () => {
    await expect(postRaw("/v1/jobs/missing", "")).resolves.toMatchObject({
      status: 404,
      body: { error: { code: "not_found" } }
    });
  });

  it("returns daemon health metadata", async () => {
    const response = await fetch(`${baseUrl}/health`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: "ok",
      version: "0.1.0",
      pid: process.pid,
      stateDir: tempDir
    });
  });

  it("returns a structured bad_json error for malformed JSON", async () => {
    await expect(postRaw("/v1/jobs/status", "{")).resolves.toMatchObject({
      status: 400,
      body: { error: { code: "bad_json" } }
    });
  });

  it("returns a structured invalid_request error for missing jobId", async () => {
    await expect(postRaw("/v1/jobs/status", "{}")).resolves.toMatchObject({
      status: 400,
      body: { error: { code: "invalid_request" } }
    });
  });

  it("returns a structured body_too_large error when JSON exceeds the configured limit", async () => {
    await closeServer(server!);
    server = createDaemonServer(new ClaudeSupervisor({ stateDir: tempDir }), { maxBodyBytes: 16 });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;

    await expect(postRaw("/v1/jobs/status", JSON.stringify({ jobId: "job_large_body" }))).resolves.toMatchObject({
      status: 413,
      body: { error: { code: "body_too_large" } }
    });
  });

  async function postRaw(pathname: string, body: string): Promise<{ status: number; body: any }> {
    const response = await fetch(`${baseUrl}${pathname}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body
    });
    return { status: response.status, body: await response.json() };
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
