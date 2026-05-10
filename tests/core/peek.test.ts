import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ClaudeRetinue } from "../../src/core/retinue.js";

const fixturePath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../fixtures/fake-claude.mjs"
);

describe("ClaudeRetinue peek", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "retinue-peek-test-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("returns bounded stdout and stderr tails for a running job", async () => {
    const retinue = new ClaudeRetinue({
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
    const started = await retinue.run({ cwd: tempDir, prompt: "peek" });

    await waitForText(async () => (await retinue.peek(started.jobId)).stdoutTail, "stdout-start");
    const peek = await retinue.peek(started.jobId, { stdoutTailBytes: 6, stderrTailBytes: 6 });

    expect(peek.status).toBe("running");
    expect(peek.stdoutTail).toBe("start\n");
    expect(peek.stderrTail).toBe("start\n");

    await retinue.kill(started.jobId);
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

