import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const cliPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/cli.ts");
const fixturePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures/fake-claude.mjs");
const tsxCliPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../node_modules/tsx/dist/cli.mjs");
const execFileAsync = promisify(execFile);

describe("CLI", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "supervisor-cli-test-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("runs, waits, and reads a job as JSON", async () => {
    const env = cliEnv(tempDir);

    const run = await execFileAsync(process.execPath, [tsxCliPath, cliPath, "run", "--cwd", tempDir, "--prompt", "cli hello"], { env });
    const started = JSON.parse(run.stdout);
    expect(started.status).toBe("running");

    const wait = await execFileAsync(process.execPath, [tsxCliPath, cliPath, "wait", started.jobId, "--timeout-ms", "5000"], { env });
    expect(JSON.parse(wait.stdout).status).toBe("completed");

    const result = await execFileAsync(process.execPath, [tsxCliPath, cliPath, "result", started.jobId], { env });
    expect(JSON.parse(result.stdout).parsedStdout.result).toBe("fake result: cli hello");
  });

  function cliEnv(stateDir: string): NodeJS.ProcessEnv {
    return {
      ...process.env,
      SUPERVISOR_STATE_DIR: stateDir,
      SUPERVISOR_CLAUDE_COMMAND: process.execPath,
      SUPERVISOR_CLAUDE_PREFIX_ARGS: fixturePath
    };
  }
});
