import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ClaudeRetinue } from "../../src/core/retinue.js";
import { getJobPaths } from "../../src/core/paths.js";
import type { JobMeta, JobStatus } from "../../src/core/types.js";

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

  it("preserves uncertain jobs during cleanup", async () => {
    const retinue = new ClaudeRetinue({
      stateDir: tempDir,
      claudeCommand: process.execPath,
      claudePrefixArgs: [fixturePath]
    });
    const completed = await retinue.run({ cwd: tempDir, prompt: "done" });
    await retinue.wait(completed.jobId, { timeoutMs: 5000 });
    const orphaned = await writeJobMeta(tempDir, "job_orphaned_cleanup", "orphaned");
    const abandoned = await writeJobMeta(tempDir, "job_abandoned_cleanup", "abandoned");
    const stalled = await writeJobMeta(tempDir, "job_stalled_cleanup", "stalled");
    const corruptedDir = getJobPaths(tempDir, "job_corrupted_cleanup").dir;
    await fs.mkdir(corruptedDir, { recursive: true });
    await fs.writeFile(path.join(corruptedDir, "meta.json"), "{", "utf8");

    const cleanup = await retinue.cleanup({ olderThanMs: 0 });

    expect(cleanup.removedJobIds).toContain(completed.jobId);
    expect(cleanup.removedJobIds).not.toContain(orphaned.jobId);
    expect(cleanup.removedJobIds).not.toContain(abandoned.jobId);
    expect(cleanup.removedJobIds).not.toContain(stalled.jobId);
    expect(cleanup.removedJobIds).not.toContain("job_corrupted_cleanup");
    await expect(fs.stat(getJobPaths(tempDir, orphaned.jobId).dir)).resolves.toBeTruthy();
    await expect(fs.stat(getJobPaths(tempDir, abandoned.jobId).dir)).resolves.toBeTruthy();
    await expect(fs.stat(getJobPaths(tempDir, stalled.jobId).dir)).resolves.toBeTruthy();
    await expect(fs.stat(corruptedDir)).resolves.toBeTruthy();
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

async function writeJobMeta(stateDir: string, jobId: string, status: JobStatus): Promise<JobMeta> {
  const paths = getJobPaths(stateDir, jobId);
  await fs.mkdir(paths.dir, { recursive: true });
  const now = new Date().toISOString();
  const meta: JobMeta = {
    schemaVersion: 1,
    backend: "claude-code",
    jobId,
    pid: -1,
    status,
    cwd: stateDir,
    promptPath: paths.prompt,
    promptPreview: status,
    promptSha256: status,
    args: [],
    createdAt: now,
    updatedAt: now
  };
  await fs.writeFile(paths.meta, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
  return meta;
}
