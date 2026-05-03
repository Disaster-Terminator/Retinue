import { describe, expect, it } from "vitest";
import path from "node:path";
import { resolveStateDir, getJobPaths } from "../../src/core/paths.js";

describe("state paths", () => {
  it("uses an explicit state directory before environment defaults", () => {
    const stateDir = resolveStateDir({
      explicitStateDir: "/tmp/supervisor-explicit",
      env: { SUPERVISOR_STATE_DIR: "/tmp/supervisor-env" },
      platform: "linux",
      homeDir: "/home/tester"
    });

    expect(stateDir).toBe(path.normalize("/tmp/supervisor-explicit"));
  });

  it("uses SUPERVISOR_STATE_DIR when no explicit state directory is provided", () => {
    const stateDir = resolveStateDir({
      env: { SUPERVISOR_STATE_DIR: "/tmp/supervisor-env" },
      platform: "linux",
      homeDir: "/home/tester"
    });

    expect(stateDir).toBe(path.normalize("/tmp/supervisor-env"));
  });

  it("builds stable per-job file paths", () => {
    const paths = getJobPaths("/tmp/supervisor-state", "job_123");

    expect(paths.dir).toBe(path.normalize("/tmp/supervisor-state/jobs/job_123"));
    expect(paths.meta).toBe(path.normalize("/tmp/supervisor-state/jobs/job_123/meta.json"));
    expect(paths.stdout).toBe(path.normalize("/tmp/supervisor-state/jobs/job_123/stdout.log"));
    expect(paths.stderr).toBe(path.normalize("/tmp/supervisor-state/jobs/job_123/stderr.log"));
    expect(paths.exitStatus).toBe(path.normalize("/tmp/supervisor-state/jobs/job_123/exit-status.json"));
  });
});
