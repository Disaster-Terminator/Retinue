import { describe, expect, it } from "vitest";
import path from "node:path";
import { spawnSync } from "node:child_process";

const scriptPath = path.resolve("scripts/probe-backend-candidates.mjs");
const fixturePath = path.resolve("tests/fixtures/fake-backend-candidate-cli.mjs");

function runProbe(args: string[] = [], env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env }
  });
}

function fakeEnv(candidate: "RETINUE_KILO" | "RETINUE_CRUSH") {
  return {
    [`${candidate}_COMMAND`]: process.execPath,
    [`${candidate}_PREFIX_ARGS`]: JSON.stringify([fixturePath])
  };
}

function parseStderr(stderr: string) {
  try {
    return JSON.parse(stderr);
  } catch {
    return null;
  }
}

describe("probe-backend-candidates", () => {
  it("collects Kilo CLI surface evidence without real model opt-in", () => {
    const result = runProbe(["--", "--candidate", "kilo"], fakeEnv("RETINUE_KILO"));
    expect(result.status).toBe(0);

    const output = JSON.parse(result.stdout);
    expect(output.realRun).toBe(false);
    expect(output.model).toBe("litellm/intentmux");
    expect(output.candidates.kilo.available).toBe(true);
    expect(output.candidates.kilo.serverCommand).toBe("serve");
    expect(output.candidates.kilo.operations.runHelp.ok).toBe(true);
    expect(output.candidates.kilo.contractHints).toMatchObject({
      hasRun: true,
      hasServer: true,
      hasSession: true,
      mentionsPermission: true,
      mentionsMcp: true,
      mentionsJson: true
    });
  });

  it("rejects real runs unless explicitly opted in", () => {
    const result = runProbe(["--candidate", "crush", "--real-run"], {
      ...fakeEnv("RETINUE_CRUSH"),
      RETINUE_BACKEND_CANDIDATE_REAL_PROBE: "0"
    });
    expect(result.status).toBe(1);
    expect(parseStderr(result.stderr)?.error).toContain("RETINUE_BACKEND_CANDIDATE_REAL_PROBE=1");
  });

  it("passes litellm/intentmux to Kilo real-run command when opted in", () => {
    const result = runProbe(["--candidate", "kilo", "--real-run", "--cwd", "/tmp/retinue-probe"], {
      ...fakeEnv("RETINUE_KILO"),
      RETINUE_BACKEND_CANDIDATE_REAL_PROBE: "1"
    });
    expect(result.status).toBe(0);

    const output = JSON.parse(result.stdout);
    expect(output.candidates.kilo.operations.realRun.args).toEqual([
      "run",
      "--auto",
      "--format",
      "json",
      "--model",
      "litellm/intentmux",
      "--dir",
      "/tmp/retinue-probe",
      "Reply exactly: RETINUE_BACKEND_CANDIDATE_OK"
    ]);
  });

  it("uses Crush server naming and allows model override", () => {
    const result = runProbe(["--candidate", "crush", "--real-run", "--model", "custom/model"], {
      ...fakeEnv("RETINUE_CRUSH"),
      RETINUE_BACKEND_CANDIDATE_REAL_PROBE: "1"
    });
    expect(result.status).toBe(0);

    const output = JSON.parse(result.stdout);
    expect(output.candidates.crush.serverCommand).toBe("server");
    expect(output.candidates.crush.operations.realRun.args).toContain("custom/model");
    expect(output.candidates.crush.operations.realRun.args).toContain("--yolo");
  });
});
