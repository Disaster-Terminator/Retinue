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
  beforeEach(async () => { tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "supervisor-opencode-backend-")); server = await startFakeOpenCodeServer(); });
  afterEach(async () => { if (server) await server.close(); await fs.rm(tempDir, { recursive: true, force: true }); });

  it("newly started job remains running before fake completion", async () => {
    const backend = createBackend(); const started = await backend.run({ cwd: tempDir, prompt: "hello" });
    await expect(backend.status({ jobId: started.jobId })).resolves.toMatchObject({ status: "running" });
  });

  it("wait-like polling stays running before completion and then completes", async () => {
    const backend = createBackend(); const started = await backend.run({ cwd: tempDir, prompt: "later" });
    const early = await backend.status({ jobId: started.jobId }); expect(early.status).toBe("running");
    server!.completeSession(started.externalSessionId!);
    await expect(backend.status({ jobId: started.jobId })).resolves.toMatchObject({ status: "completed" });
  });

  it("result does not force completion", async () => {
    const backend = createBackend(); const started = await backend.run({ cwd: tempDir, prompt: "result please" });
    await expect(backend.result({ jobId: started.jobId })).resolves.toMatchObject({ status: "running", parsedStdout: { result: "fake result: result please" } });
    await expect(backend.status({ jobId: started.jobId })).resolves.toMatchObject({ status: "running" });
    server!.completeSession(started.externalSessionId!);
    await expect(backend.result({ jobId: started.jobId })).resolves.toMatchObject({ status: "completed" });
  });

  it("aborts OpenCode sessions and keeps killed", async () => {
    const backend = createBackend(); const started = await backend.run({ cwd: tempDir, prompt: "stop" });
    await backend.abort({ jobId: started.jobId }); server!.completeSession(started.externalSessionId!);
    await expect(backend.status({ jobId: started.jobId })).resolves.toMatchObject({ status: "killed" });
  });

  it("cleans terminal OpenCode jobs and preserves running jobs", async () => {
    const backend = createBackend(); const completed = await backend.run({ cwd: tempDir, prompt: "done" }); const running = await backend.run({ cwd: tempDir, prompt: "keep" });
    server!.completeSession(completed.externalSessionId!); await backend.status({ jobId: completed.jobId });
    await expect(backend.cleanup()).resolves.toMatchObject({ removedJobIds: [completed.jobId] });
    await expect(fs.stat(getJobPaths(tempDir, completed.jobId).dir)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(getJobPaths(tempDir, running.jobId).dir)).resolves.toBeTruthy();
  });

  function createBackend(): OpenCodeBackend { return new OpenCodeBackend({ client: new OpenCodeClient(server!.url), baseUrl: server!.url, stateDir: tempDir }); }
});
