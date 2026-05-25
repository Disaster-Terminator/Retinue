import { describe, expect, it } from "vitest";
import { assertCompletedResult, assertExpectedResult, parseProbeArgs, readJsonOutput } from "../src/core/probeRealClaudeHelpers.js";

describe("real Claude probe helpers", () => {
  it("parses mode and common probe flags", () => {
    expect(
      parseProbeArgs([
        "daemon",
        "--cwd",
        "G:/repository/retinue",
        "--expect",
        "RETINUE_REAL_OK",
        "--timeout-ms",
        "120000"
      ])
    ).toMatchObject({
      mode: "daemon",
      cwd: "G:/repository/retinue",
      expected: "RETINUE_REAL_OK",
      timeoutMs: 120000
    });
  });

  it("ignores pnpm argument separators", () => {
    expect(parseProbeArgs(["direct", "--", "--expect", "RETINUE_REAL_OK"])).toMatchObject({
      mode: "direct",
      expected: "RETINUE_REAL_OK"
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
          parsedStdout: { result: "RETINUE_REAL_OK" }
        },
        "RETINUE_REAL_OK"
      )
    ).not.toThrow();

    expect(() =>
      assertExpectedResult(
        {
          status: "completed",
          exitCode: 0,
          parsedStdout: { result: "wrong" }
        },
        "RETINUE_REAL_OK"
      )
    ).toThrow("Expected Claude result");
  });

  it("validates completion without coupling permission probes to exact model text", () => {
    expect(
      assertCompletedResult({
        status: "completed",
        exitCode: 0,
        parsedStdout: { result: "_OK" }
      })
    ).toBe("_OK");

    expect(() =>
      assertCompletedResult({
        status: "running",
        exitCode: 0,
        parsedStdout: { result: "_OK" }
      })
    ).toThrow("Expected completed job");
  });

  it("accepts result objects that store exit code under exitStatus", () => {
    expect(() =>
      assertExpectedResult(
        {
          status: "completed",
          exitStatus: { exitCode: 0 },
          parsedStdout: { result: "RETINUE_REAL_OK" }
        },
        "RETINUE_REAL_OK"
      )
    ).not.toThrow();
  });
});
