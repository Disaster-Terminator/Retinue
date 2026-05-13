import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { assertDaemonHostAllowed, buildDaemonReadyPayload } from "../src/daemon.js";

describe("daemon package entrypoint", () => {
  it("exposes retinue-daemon as a package binary", async () => {
    const packageJson = JSON.parse(await fs.readFile(path.resolve("package.json"), "utf8"));

    expect(packageJson.bin["retinue-daemon"]).toBe("./dist/daemon.js");
  });

  it("builds daemon discovery-ready payloads", () => {
    const payload = buildDaemonReadyPayload({
      host: "127.0.0.1",
      port: 27777,
      pid: 123,
      startedAt: "2026-05-04T00:00:00.000Z",
      version: "0.1.0"
    });

    expect(payload).toEqual({
      status: "listening",
      host: "127.0.0.1",
      port: 27777,
      url: "http://127.0.0.1:27777",
      pid: 123,
      startedAt: "2026-05-04T00:00:00.000Z",
      version: "0.1.0"
    });
  });

  it("rejects non-loopback daemon hosts unless explicitly allowed", () => {
    expect(() => assertDaemonHostAllowed("127.0.0.1", {})).not.toThrow();
    expect(() => assertDaemonHostAllowed("localhost", {})).not.toThrow();
    expect(() => assertDaemonHostAllowed("0.0.0.0", {})).toThrow(/non-loopback/i);
    expect(() => assertDaemonHostAllowed("0.0.0.0", { RETINUE_DAEMON_ALLOW_NON_LOOPBACK: "1" })).not.toThrow();
  });
});
