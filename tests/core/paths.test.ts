import { describe, expect, it } from "vitest";
import path from "node:path";
import { resolveStateDir, getJobPaths, getRetinueTracePath } from "../../src/core/paths.js";

describe("state paths", () => {
  it("uses an explicit state directory before environment defaults", () => {
    const stateDir = resolveStateDir({
      explicitStateDir: "/tmp/retinue-explicit",
      env: { RETINUE_STATE_DIR: "/tmp/retinue-env" },
      platform: "linux",
      homeDir: "/home/tester"
    });

    expect(stateDir).toBe(path.normalize("/tmp/retinue-explicit"));
  });

  it("uses RETINUE_STATE_DIR when no explicit state directory is provided", () => {
    const stateDir = resolveStateDir({
      env: { RETINUE_STATE_DIR: "/tmp/retinue-env" },
      platform: "linux",
      homeDir: "/home/tester"
    });

    expect(stateDir).toBe(path.normalize("/tmp/retinue-env"));
  });

  it("builds stable per-job file paths", () => {
    const paths = getJobPaths("/tmp/retinue-state", "job_123");

    expect(paths.dir).toBe(path.normalize("/tmp/retinue-state/jobs/job_123"));
    expect(paths.meta).toBe(path.normalize("/tmp/retinue-state/jobs/job_123/meta.json"));
    expect(paths.stdout).toBe(path.normalize("/tmp/retinue-state/jobs/job_123/stdout.log"));
    expect(paths.stderr).toBe(path.normalize("/tmp/retinue-state/jobs/job_123/stderr.log"));
    expect(paths.exitStatus).toBe(path.normalize("/tmp/retinue-state/jobs/job_123/exit-status.json"));
  });

  it("rejects job ids that could escape the jobs directory", () => {
    expect(() => getJobPaths("/tmp/retinue-state", "../outside")).toThrow(/invalid retinue jobid/i);
    expect(() => getJobPaths("/tmp/retinue-state", "job/../outside")).toThrow(/invalid retinue jobid/i);
    expect(() => getJobPaths("/tmp/retinue-state", "job\\outside")).toThrow(/invalid retinue jobid/i);
  });

  it("builds a stable Retinue trace path", () => {
    expect(getRetinueTracePath("/tmp/retinue-state")).toBe(path.normalize("/tmp/retinue-state/logs/retinue.jsonl"));
  });
});
