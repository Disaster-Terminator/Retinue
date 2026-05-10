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

describe("result limits and status reconciliation", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "retinue-test-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("limits result output by default while preserving file paths", async () => {
    const retinue = new ClaudeRetinue({
      stateDir: tempDir,
      claudeCommand: process.execPath,
      claudePrefixArgs: [fixturePath],
      env: { ...process.env, FAKE_CLAUDE_LARGE_STDOUT_BYTES: "70000" }
    });
    const started = await retinue.run({ cwd: tempDir, prompt: "large" });
    await retinue.wait(started.jobId, { timeoutMs: 5000 });

    const result = await retinue.result(started.jobId);

    expect(result.stdout.length).toBeLessThan(70000);
    expect(result.stdoutTruncated).toBe(true);
    expect(result.stdoutBytes).toBeGreaterThan(70000);
    expect(result.stdoutPath).toMatch(/stdout\.log$/);
    expect(result.stderrPath).toMatch(/stderr\.log$/);
    expect(result.parsedStdout).toMatchObject({ result: "fake result: large" });
  });

  it("marks stale running metadata as orphaned when pid no longer exists", async () => {
    const retinue = new ClaudeRetinue({ stateDir: tempDir });
    const paths = getJobPaths(tempDir, "job_stale");
    await fs.mkdir(paths.dir, { recursive: true });
    await fs.writeFile(
      paths.meta,
      JSON.stringify(
        {
          jobId: "job_stale",
          pid: 99999999,
          status: "running",
          cwd: tempDir,
          args: ["-p", "--output-format", "json"],
          promptPath: path.join(paths.dir, "prompt.md"),
          promptPreview: "stale",
          promptSha256: "0".repeat(64),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        },
        null,
        2
      ),
      "utf8"
    );

    await expect(retinue.status("job_stale")).resolves.toMatchObject({
      jobId: "job_stale",
      status: "orphaned"
    });
  });

  it("marks unowned running metadata with a live pid as abandoned", async () => {
    const retinue = new ClaudeRetinue({ stateDir: tempDir });
    const paths = getJobPaths(tempDir, "job_unowned_alive");
    const now = new Date().toISOString();
    await fs.mkdir(paths.dir, { recursive: true });
    await fs.writeFile(
      paths.meta,
      JSON.stringify(
        {
          schemaVersion: 1,
          jobId: "job_unowned_alive",
          pid: process.pid,
          status: "running",
          cwd: tempDir,
          args: ["-p", "--output-format", "json"],
          promptPath: path.join(paths.dir, "prompt.md"),
          promptPreview: "alive",
          promptSha256: "3".repeat(64),
          createdAt: now,
          updatedAt: now
        },
        null,
        2
      ),
      "utf8"
    );

    await expect(retinue.status("job_unowned_alive")).resolves.toMatchObject({
      jobId: "job_unowned_alive",
      status: "abandoned"
    });
  });

  it("reads old job metadata without schemaVersion", async () => {
    const retinue = new ClaudeRetinue({ stateDir: tempDir });
    const paths = getJobPaths(tempDir, "job_old_schema");
    const now = new Date().toISOString();
    await fs.mkdir(paths.dir, { recursive: true });
    await fs.writeFile(
      paths.meta,
      JSON.stringify(
        {
          jobId: "job_old_schema",
          pid: 99999999,
          status: "completed",
          cwd: tempDir,
          args: ["-p", "--output-format", "json"],
          promptPath: path.join(paths.dir, "prompt.md"),
          promptPreview: "old",
          promptSha256: "2".repeat(64),
          createdAt: now,
          updatedAt: now
        },
        null,
        2
      ),
      "utf8"
    );

    await expect(retinue.status("job_old_schema")).resolves.toMatchObject({
      jobId: "job_old_schema",
      status: "completed"
    });
  });

  it("returns structured not_found for missing jobs", async () => {
    const retinue = new ClaudeRetinue({ stateDir: tempDir });

    await expect(retinue.status("job_missing")).resolves.toMatchObject({
      jobId: "job_missing",
      status: "not_found"
    });
    await expect(retinue.result("job_missing")).resolves.toMatchObject({
      jobId: "job_missing",
      status: "not_found"
    });
    await expect(retinue.kill("job_missing")).resolves.toMatchObject({
      jobId: "job_missing",
      status: "not_found"
    });
  });

  it("returns structured corrupted for invalid job metadata", async () => {
    const retinue = new ClaudeRetinue({ stateDir: tempDir });
    const paths = getJobPaths(tempDir, "job_corrupt");
    await fs.mkdir(paths.dir, { recursive: true });
    await fs.writeFile(paths.meta, "{not-json", "utf8");

    await expect(retinue.status("job_corrupt")).resolves.toMatchObject({
      jobId: "job_corrupt",
      status: "corrupted"
    });
    await expect(retinue.result("job_corrupt")).resolves.toMatchObject({
      jobId: "job_corrupt",
      status: "corrupted"
    });
  });
});
