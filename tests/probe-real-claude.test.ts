import { describe, expect, it } from "vitest";
import { assertExpectedResult, parseProbeArgs, readJsonOutput } from "../scripts/probe-real-claude.mjs";

describe("real Claude probe helpers", () => {
  it("parses mode and common probe flags", () => {
    expect(
      parseProbeArgs([
        "daemon",
        "--cwd",
        "G:/repository/supervisor",
        "--expect",
        "SUPERVISOR_REAL_OK",
        "--timeout-ms",
        "120000"
      ])
    ).toMatchObject({
      mode: "daemon",
      cwd: "G:/repository/supervisor",
      expected: "SUPERVISOR_REAL_OK",
      timeoutMs: 120000
    });
  });

  it("rejects unknown probe modes", () => {
    expect(() => parseProbeArgs(["unknown"])).toThrow("Unknown probe mode: unknown");
  });

  it("reads JSON from command stdout", () => {
    expect(readJsonOutput('noise\n{"jobId":"abc","status":"running"}\n')).toEqual({
      jobId: "abc",
      status: "running"
    });
  });

  it("validates the parsed Claude result text", () => {
    expect(() =>
      assertExpectedResult(
        {
          status: "completed",
          exitCode: 0,
          parsedStdout: { result: "SUPERVISOR_REAL_OK" }
        },
        "SUPERVISOR_REAL_OK"
      )
    ).not.toThrow();

    expect(() =>
      assertExpectedResult(
        {
          status: "completed",
          exitCode: 0,
          parsedStdout: { result: "wrong" }
        },
        "SUPERVISOR_REAL_OK"
      )
    ).toThrow("Expected Claude result");
  });

  it("accepts result objects that store exit code under exitStatus", () => {
    expect(() =>
      assertExpectedResult(
        {
          status: "completed",
          exitStatus: { exitCode: 0 },
          parsedStdout: { result: "SUPERVISOR_REAL_OK" }
        },
        "SUPERVISOR_REAL_OK"
      )
    ).not.toThrow();
  });
});
