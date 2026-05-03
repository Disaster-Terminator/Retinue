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

describe("result limits and status reconciliation", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "supervisor-test-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("limits result output by default while preserving file paths", async () => {
    const supervisor = new ClaudeSupervisor({
      stateDir: tempDir,
      claudeCommand: process.execPath,
      claudePrefixArgs: [fixturePath],
      env: { ...process.env, FAKE_CLAUDE_LARGE_STDOUT_BYTES: "70000" }
    });
    const started = await supervisor.run({ cwd: tempDir, prompt: "large" });
    await supervisor.wait(started.jobId, { timeoutMs: 5000 });

    const result = await supervisor.result(started.jobId);

    expect(result.stdout.length).toBeLessThan(70000);
    expect(result.stdoutTruncated).toBe(true);
    expect(result.stdoutBytes).toBeGreaterThan(70000);
    expect(result.stdoutPath).toMatch(/stdout\.log$/);
    expect(result.stderrPath).toMatch(/stderr\.log$/);
    expect(result.parsedStdout).toMatchObject({ result: "fake result: large" });
  });

  it("marks stale running metadata as orphaned when pid no longer exists", async () => {
    const supervisor = new ClaudeSupervisor({ stateDir: tempDir });
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

    await expect(supervisor.status("job_stale")).resolves.toMatchObject({
      jobId: "job_stale",
      status: "orphaned"
    });
  });

  it("returns structured not_found for missing jobs", async () => {
    const supervisor = new ClaudeSupervisor({ stateDir: tempDir });

    await expect(supervisor.status("job_missing")).resolves.toMatchObject({
      jobId: "job_missing",
      status: "not_found"
    });
    await expect(supervisor.result("job_missing")).resolves.toMatchObject({
      jobId: "job_missing",
      status: "not_found"
    });
    await expect(supervisor.kill("job_missing")).resolves.toMatchObject({
      jobId: "job_missing",
      status: "not_found"
    });
  });

  it("returns structured corrupted for invalid job metadata", async () => {
    const supervisor = new ClaudeSupervisor({ stateDir: tempDir });
    const paths = getJobPaths(tempDir, "job_corrupt");
    await fs.mkdir(paths.dir, { recursive: true });
    await fs.writeFile(paths.meta, "{not-json", "utf8");

    await expect(supervisor.status("job_corrupt")).resolves.toMatchObject({
      jobId: "job_corrupt",
      status: "corrupted"
    });
    await expect(supervisor.result("job_corrupt")).resolves.toMatchObject({
      jobId: "job_corrupt",
      status: "corrupted"
    });
  });
});
