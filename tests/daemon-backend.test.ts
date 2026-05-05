import { describe, expect, it } from "vitest";
import { DEFAULT_DAEMON_BACKEND, parseDaemonBackend } from "../src/daemon/backend.js";

describe("daemon backend selection", () => {
  it("defaults to claude-code", () => {
    expect(DEFAULT_DAEMON_BACKEND).toBe("claude-code");
    expect(parseDaemonBackend(undefined)).toBe("claude-code");
  });

  it("accepts supported backend values", () => {
    expect(parseDaemonBackend("claude-code")).toBe("claude-code");
    expect(parseDaemonBackend("opencode")).toBe("opencode");
  });

  it("rejects unsupported values deterministically", () => {
    expect(() => parseDaemonBackend("Claude-Code")).toThrow("Unsupported backend: Claude-Code");
    expect(() => parseDaemonBackend("unknown")).toThrow("Unsupported backend: unknown");
    expect(() => parseDaemonBackend(123)).toThrow("Unsupported backend: 123");
  });
});
