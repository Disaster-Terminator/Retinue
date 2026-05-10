import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ClaudeRetinue } from "../../src/core/retinue.js";
import { getJobPaths } from "../../src/core/paths.js";

const fixturePath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../fixtures/fake-claude.mjs"
);

describe("ClaudeRetinue kill and cleanup", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "retinue-test-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("kills a running job and records killed status", async () => {
    const retinue = new ClaudeRetinue({
      stateDir: tempDir,
      claudeCommand: process.execPath,
      claudePrefixArgs: [fixturePath],
      env: { ...process.env, FAKE_CLAUDE_DELAY_MS: "10000" }
    });

    const started = await retinue.run({ cwd: tempDir, prompt: "slow" });
    const killed = await retinue.kill(started.jobId);

    expect(killed.status).toBe("killed");
    await expect(retinue.status(started.jobId)).resolves.toMatchObject({ status: "killed" });

    const waited = await retinue.wait(started.jobId, { timeoutMs: 5000 });
    expect(waited.status).toBe("killed");
  });

  it("cleans terminal jobs and preserves running jobs", async () => {
    const fast = new ClaudeRetinue({
      stateDir: tempDir,
      claudeCommand: process.execPath,
      claudePrefixArgs: [fixturePath]
    });
    const slow = new ClaudeRetinue({
      stateDir: tempDir,
      claudeCommand: process.execPath,
      claudePrefixArgs: [fixturePath],
      env: { ...process.env, FAKE_CLAUDE_DELAY_MS: "10000" }
    });

    const completed = await fast.run({ cwd: tempDir, prompt: "done" });
    await fast.wait(completed.jobId, { timeoutMs: 5000 });
    const running = await slow.run({ cwd: tempDir, prompt: "running" });

    const cleanup = await slow.cleanup({ olderThanMs: 0 });

    expect(cleanup.removedJobIds).toContain(completed.jobId);
    expect(cleanup.removedJobIds).not.toContain(running.jobId);
    await expect(fs.stat(getJobPaths(tempDir, completed.jobId).dir)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(getJobPaths(tempDir, running.jobId).dir)).resolves.toBeTruthy();

    await slow.kill(running.jobId);
  });

  it("reports temp files removed with terminal jobs and preserves running temp files", async () => {
    const fast = new ClaudeRetinue({
      stateDir: tempDir,
      claudeCommand: process.execPath,
      claudePrefixArgs: [fixturePath]
    });
    const slow = new ClaudeRetinue({
      stateDir: tempDir,
      claudeCommand: process.execPath,
      claudePrefixArgs: [fixturePath],
      env: { ...process.env, FAKE_CLAUDE_DELAY_MS: "10000" }
    });

    const completed = await fast.run({ cwd: tempDir, prompt: "temp done" });
    await fast.wait(completed.jobId, { timeoutMs: 5000 });
    const completedTemp = path.join(getJobPaths(tempDir, completed.jobId).dir, "meta.json.123.1.abc.tmp");
    await fs.writeFile(completedTemp, "partial", "utf8");

    const running = await slow.run({ cwd: tempDir, prompt: "temp running" });
    const runningTemp = path.join(getJobPaths(tempDir, running.jobId).dir, "meta.json.456.1.def.tmp");
    await fs.writeFile(runningTemp, "partial", "utf8");

    try {
      const cleanup = await slow.cleanup({ olderThanMs: 0 });

      expect(cleanup.removedJobIds).toContain(completed.jobId);
      expect(cleanup.removedTempFiles).toContain(completedTemp);
      expect(cleanup.removedTempFiles).not.toContain(runningTemp);
      await expect(fs.stat(runningTemp)).resolves.toBeTruthy();
    } finally {
      await slow.kill(running.jobId);
    }
  });
});
