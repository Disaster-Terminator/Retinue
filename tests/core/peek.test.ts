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

describe("ClaudeSupervisor peek", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "supervisor-peek-test-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("returns bounded stdout and stderr tails for a running job", async () => {
    const supervisor = new ClaudeSupervisor({
      stateDir: tempDir,
      claudeCommand: process.execPath,
      claudePrefixArgs: [fixturePath],
      env: {
        ...process.env,
        FAKE_CLAUDE_DELAY_MS: "5000",
        FAKE_CLAUDE_INITIAL_STDOUT: "stdout-start",
        FAKE_CLAUDE_INITIAL_STDERR: "stderr-start"
      }
    });
    const started = await supervisor.run({ cwd: tempDir, prompt: "peek" });

    await waitForText(async () => (await supervisor.peek(started.jobId)).stdoutTail, "stdout-start");
    const peek = await supervisor.peek(started.jobId, { stdoutTailBytes: 6, stderrTailBytes: 6 });

    expect(peek.status).toBe("running");
    expect(peek.stdoutTail).toBe("start\n");
    expect(peek.stderrTail).toBe("start\n");

    await supervisor.kill(started.jobId);
  });
});

async function waitForText(read: () => Promise<string | undefined>, expected: string): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 3000) {
    if ((await read())?.includes(expected)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${expected}`);
}

