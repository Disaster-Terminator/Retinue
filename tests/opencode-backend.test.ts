import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { OpenCodeBackend } from "../src/backends/opencode/backend.js";
import { OpenCodeClient } from "../src/backends/opencode/client.js";
import { getJobPaths } from "../src/core/paths.js";
import { startFakeOpenCodeServer, type FakeOpenCodeServer } from "./fixtures/fake-opencode-server.js";

describe("OpenCodeBackend", () => {
  let tempDir: string;
  let server: FakeOpenCodeServer | undefined;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "supervisor-opencode-backend-"));
    server = await startFakeOpenCodeServer();
  });

  afterEach(async () => {
    if (server) {
      await server.close();
      server = undefined;
    }
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("runs OpenCode jobs and persists backend metadata", async () => {
    const backend = createBackend();

    const started = await backend.run({
      cwd: tempDir,
      prompt: "hello",
      title: "demo",
      model: "local/test",
      agent: "build"
    });

    expect(started).toMatchObject({
      backend: "opencode",
      status: "running",
      cwd: tempDir,
      title: "demo",
      model: "local/test",
      agent: "build",
      externalServerUrl: server!.url,
      externalSessionId: expect.stringMatching(/^ses_/)
    });
    expect(started.promptPath).toMatch(/prompt\.md$/);
    await expect(fs.readFile(started.promptPath, "utf8")).resolves.toBe("hello");

    await expect(fs.readFile(getJobPaths(tempDir, started.jobId).meta, "utf8").then(JSON.parse)).resolves.toMatchObject({
      backend: "opencode",
      externalSessionId: started.externalSessionId
    });
  });

  it("keeps newly started OpenCode jobs running until fake completion", async () => {
    const backend = createBackend();
    const started = await backend.run({ cwd: tempDir, prompt: "result please" });

    await expect(backend.status({ jobId: started.jobId })).resolves.toMatchObject({ status: "running" });
    await expect(backend.result({ jobId: started.jobId })).resolves.toMatchObject({ status: "running" });
    await expect(backend.status({ jobId: started.jobId })).resolves.toMatchObject({ status: "running" });

    server!.completeSession(started.externalSessionId!);
    await expect(backend.result({ jobId: started.jobId })).resolves.toMatchObject({
      status: "completed",
      sessionId: started.externalSessionId,
      parsedStdout: { result: "fake result: result please" }
    });
    await expect(backend.status({ jobId: started.jobId })).resolves.toMatchObject({ status: "completed" });
  });

  it("continues an existing OpenCode session", async () => {
    const backend = createBackend();
    const first = await backend.run({ cwd: tempDir, prompt: "first" });
    const continued = await backend.continueJob({
      cwd: tempDir,
      prompt: "second",
      externalSessionId: first.externalSessionId,
      parentJobId: first.jobId,
      parentSessionId: first.externalSessionId
    });

    expect(continued.externalSessionId).toBe(first.externalSessionId);
    expect(continued.parentJobId).toBe(first.jobId);
    server!.completeSession(first.externalSessionId!);
    await expect(backend.result({ jobId: continued.jobId })).resolves.toMatchObject({
      parsedStdout: { result: "fake result: second" }
    });
  });

  it("wait returns running before completion when timeout expires", async () => {
    const backend = createBackend();
    const started = await backend.run({ cwd: tempDir, prompt: "still running" });

    await expect(backend.wait({ jobId: started.jobId }, { timeoutMs: 20, pollIntervalMs: 5 })).resolves.toMatchObject({ status: "running" });
  });

  it("wait returns completed after fake completion", async () => {
    const backend = createBackend();
    const started = await backend.run({ cwd: tempDir, prompt: "done later" });

    setTimeout(() => server!.completeSession(started.externalSessionId!), 30);
    await expect(backend.wait({ jobId: started.jobId }, { timeoutMs: 500, pollIntervalMs: 10 })).resolves.toMatchObject({ status: "completed" });
  });

  it("aborts OpenCode sessions", async () => {
    const backend = createBackend();
    const started = await backend.run({ cwd: tempDir, prompt: "stop" });

    await backend.abort({ jobId: started.jobId });

    await expect(backend.status({ jobId: started.jobId })).resolves.toMatchObject({ status: "killed" });
    await expect(backend.result({ jobId: started.jobId })).resolves.toMatchObject({ status: "killed" });
  });

  it("cleans terminal OpenCode jobs and preserves running jobs", async () => {
    const backend = createBackend();
    const completed = await backend.run({ cwd: tempDir, prompt: "done" });
    const running = await backend.run({ cwd: tempDir, prompt: "keep" });
    server!.completeSession(completed.externalSessionId!);
    await backend.result({ jobId: completed.jobId });

    await expect(backend.cleanup()).resolves.toMatchObject({ removedJobIds: [completed.jobId] });

    await expect(fs.stat(getJobPaths(tempDir, completed.jobId).dir)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(getJobPaths(tempDir, running.jobId).dir)).resolves.toBeTruthy();
  });

  function createBackend(): OpenCodeBackend {
    return new OpenCodeBackend({
      client: new OpenCodeClient(server!.url),
      baseUrl: server!.url,
      stateDir: tempDir
    });
  }
});
