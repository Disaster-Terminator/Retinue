import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const PROBE_SCRIPT = "scripts/probe-real-opencode.mjs";

describe("manual OpenCode probe script", () => {
  it("rejects missing opt-in", () => {
    const result = runProbe({ SUPERVISOR_OPENCODE_BASE_URL: "http://127.0.0.1:1" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("SUPERVISOR_REAL_OPENCODE_PROBE=1");
  });

  it("rejects non-loopback URL", () => {
    const result = runProbe({
      SUPERVISOR_REAL_OPENCODE_PROBE: "1",
      SUPERVISOR_OPENCODE_BASE_URL: "http://example.com:8080"
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Non-loopback URL rejected");
  });

  it("uses structured parts and accepts 204-style empty responses", () => {
    const source = readFileSync(PROBE_SCRIPT, "utf8");
    expect(source).toContain('parts: [{ type: "text", text: "Reply exactly: SUPERVISOR_OPENCODE_REAL_OK" }]');
    expect(source).not.toContain('prompt: "Reply exactly: SUPERVISOR_OPENCODE_REAL_OK"');
    expect(source).toContain("if (!trimmed) {\n    return null;");
  });
});

function runProbe(env: Record<string, string>) {
  return spawnSync("node", [PROBE_SCRIPT], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, ...env }
  });
}
