import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ClaudeSupervisor } from "../../src/core/supervisor.js";

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
    expect(started.pid).toBeGreaterThan(0);

    const waited = await supervisor.wait(started.jobId, { timeoutMs: 5000 });
    expect(waited.status).toBe("completed");
    expect(waited.exitCode).toBe(0);

    const result = await supervisor.result(started.jobId);
    expect(result.status).toBe("completed");
    expect(result.parsedStdout).toMatchObject({
      result: "fake result: hello",
      session_id: "fake-session-1"
    });
    expect(result.stderr).toContain("fake-claude cwd=");
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
});
