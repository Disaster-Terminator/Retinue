import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ClaudeSupervisor } from "../../src/core/supervisor.js";
import { getJobPaths } from "../../src/core/paths.js";

const fixturePath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../fixtures/fake-claude.mjs"
);

describe("ClaudeSupervisor lifecycle", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "supervisor-test-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("runs a Claude job, waits for completion, and returns parsed JSON result", async () => {
    const supervisor = new ClaudeSupervisor({
      stateDir: tempDir,
      claudeCommand: process.execPath,
      claudePrefixArgs: [fixturePath]
    });

    const started = await supervisor.run({
      cwd: tempDir,
      prompt: "hello"
    });

    expect(started.status).toBe("running");
    expect(started.schemaVersion).toBe(1);
    expect(started.backend).toBe("claude-code");
    expect(started.pid).toBeGreaterThan(0);
    expect(started.prompt).toBeUndefined();
    expect(started.promptPreview).toBe("hello");
    expect(started.promptSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(started.promptPath).toMatch(/prompt\.md$/);
    await expect(fs.readFile(started.promptPath, "utf8")).resolves.toBe("hello");
    await expect(fs.readFile(getJobPaths(tempDir, started.jobId).meta, "utf8").then(JSON.parse)).resolves.toMatchObject({
      schemaVersion: 1,
      backend: "claude-code"
    });

    const waited = await supervisor.wait(started.jobId, { timeoutMs: 5000 });
    expect(waited.status).toBe("completed");
    expect(waited.exitCode).toBe(0);

    const result = await supervisor.result(started.jobId);
    expect(result.status).toBe("completed");
    expect(result.parsedStdout).toMatchObject({
      result: "fake result: hello",
      session_id: "fake-session-1"
    });
    expect(result.sessionId).toBe("fake-session-1");
    await expect(supervisor.status(started.jobId)).resolves.toMatchObject({ sessionId: "fake-session-1" });
    expect(result.stderr).toContain("fake-claude cwd=");
  });

  it("treats old metadata without backend as claude-code", async () => {
    const jobId = "job_old_meta";
    const paths = getJobPaths(tempDir, jobId);
    const now = new Date().toISOString();
    await fs.mkdir(paths.dir, { recursive: true });
    await fs.writeFile(
      paths.meta,
      JSON.stringify(
        {
          schemaVersion: 1,
          jobId,
          pid: 99999999,
          status: "completed",
          cwd: tempDir,
          args: ["-p", "--output-format", "json"],
          promptPath: paths.prompt,
          promptPreview: "old",
          promptSha256: "1".repeat(64),
          createdAt: now,
          updatedAt: now
        },
        null,
        2
      ),
      "utf8"
    );

    const supervisor = new ClaudeSupervisor({ stateDir: tempDir });

    await expect(supervisor.status(jobId)).resolves.toMatchObject({
      jobId,
      backend: "claude-code",
      status: "completed"
    });
  });

  it("marks non-zero exits as failed", async () => {
    const supervisor = new ClaudeSupervisor({
      stateDir: tempDir,
      claudeCommand: process.execPath,
      claudePrefixArgs: [fixturePath],
      env: { ...process.env, FAKE_CLAUDE_EXIT_CODE: "7" }
    });

    const started = await supervisor.run({
      cwd: tempDir,
      prompt: "fail"
    });

    const waited = await supervisor.wait(started.jobId, { timeoutMs: 5000 });
    expect(waited.status).toBe("failed");
    expect(waited.exitCode).toBe(7);

    const result = await supervisor.result(started.jobId);
    expect(result.status).toBe("failed");
    expect(result.stderr).toContain("fake failure: 7");
  });

  it("records failed status for spawn errors without leaving a running job", async () => {
    const supervisor = new ClaudeSupervisor({
      stateDir: tempDir,
      claudeCommand: path.join(tempDir, "missing-claude-command")
    });

    const started = await supervisor.run({
      cwd: tempDir,
      prompt: "missing"
    });

    const waited = await supervisor.wait(started.jobId, { timeoutMs: 5000 });
    expect(waited.status).toBe("failed");
    await expect(supervisor.status(started.jobId)).resolves.toMatchObject({
      jobId: started.jobId,
      status: "failed"
    });
  });

  it("returns from run before a slow Claude job completes", async () => {
    const supervisor = new ClaudeSupervisor({
      stateDir: tempDir,
      claudeCommand: process.execPath,
      claudePrefixArgs: [fixturePath],
      env: { ...process.env, FAKE_CLAUDE_DELAY_MS: "5000" }
    });

    const startedAt = Date.now();
    const started = await supervisor.run({
      cwd: tempDir,
      prompt: "slow"
    });

    expect(Date.now() - startedAt).toBeLessThan(1000);
    expect(started.status).toBe("running");

    await supervisor.kill(started.jobId);
  });

  it("times out a job after its runtime budget", async () => {
    const supervisor = new ClaudeSupervisor({
      stateDir: tempDir,
      claudeCommand: process.execPath,
      claudePrefixArgs: [fixturePath],
      defaultRuntimeTimeoutMs: 100,
      env: { ...process.env, FAKE_CLAUDE_DELAY_MS: "5000" }
    });

    const started = await supervisor.run({ cwd: tempDir, prompt: "timeout" });
    const waited = await supervisor.wait(started.jobId, { timeoutMs: 5000 });

    expect(waited.status).toBe("timed_out");
    await expect(supervisor.status(started.jobId)).resolves.toMatchObject({ status: "timed_out" });
  });

  it("rejects runs over the configured concurrency limit", async () => {
    const supervisor = new ClaudeSupervisor({
      stateDir: tempDir,
      claudeCommand: process.execPath,
      claudePrefixArgs: [fixturePath],
      maxConcurrentJobs: 1,
      env: { ...process.env, FAKE_CLAUDE_DELAY_MS: "5000" }
    });

    const started = await supervisor.run({ cwd: tempDir, prompt: "first" });

    await expect(supervisor.run({ cwd: tempDir, prompt: "second" })).rejects.toThrow(/concurrency/i);
    await supervisor.kill(started.jobId);
  });

  it("does not count abandoned disk-backed live jobs against the concurrency limit", async () => {
    const paths = getJobPaths(tempDir, "job_external_alive");
    const now = new Date().toISOString();
    await fs.mkdir(paths.dir, { recursive: true });
    await fs.writeFile(
      paths.meta,
      JSON.stringify(
        {
          schemaVersion: 1,
          jobId: "job_external_alive",
          pid: process.pid,
          status: "running",
          cwd: tempDir,
          args: ["-p", "--output-format", "json"],
          promptPath: paths.prompt,
          promptPreview: "external",
          promptSha256: "1".repeat(64),
          createdAt: now,
          updatedAt: now
        },
        null,
        2
      ),
      "utf8"
    );

    const supervisor = new ClaudeSupervisor({
      stateDir: tempDir,
      claudeCommand: process.execPath,
      claudePrefixArgs: [fixturePath],
      maxConcurrentJobs: 1
    });

    await expect(supervisor.status("job_external_alive")).resolves.toMatchObject({ status: "abandoned" });
    const started = await supervisor.run({ cwd: tempDir, prompt: "not blocked" });
    await expect(supervisor.wait(started.jobId, { timeoutMs: 5000 })).resolves.toMatchObject({ status: "completed" });
  });

  it("continues from a previous job session id", async () => {
    const supervisor = new ClaudeSupervisor({
      stateDir: tempDir,
      claudeCommand: process.execPath,
      claudePrefixArgs: [fixturePath]
    });
    const first = await supervisor.run({ cwd: tempDir, prompt: "first" });
    await supervisor.wait(first.jobId, { timeoutMs: 5000 });

    const continued = await supervisor.continueJob({
      cwd: tempDir,
      prompt: "second",
      jobId: first.jobId
    });
    await supervisor.wait(continued.jobId, { timeoutMs: 5000 });

    expect(continued.resume).toBe("fake-session-1");
    expect(continued.parentJobId).toBe(first.jobId);
    expect(continued.parentSessionId).toBe("fake-session-1");
    await expect(supervisor.result(continued.jobId)).resolves.toMatchObject({
      parsedStdout: { result: "fake result: second", session_id: "fake-session-1" }
    });
  });
});
