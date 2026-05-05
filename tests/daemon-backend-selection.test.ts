import { describe, expect, it } from "vitest";
import { parseBackendSelection } from "../src/daemon/backendSelection.js";

describe("daemon backend selection parsing", () => {
  it("returns undefined when backend is not provided", () => {
    expect(parseBackendSelection({})).toBeUndefined();
  });

  it("accepts claude-code and opencode", () => {
    expect(parseBackendSelection({ backend: "claude-code" })).toBe("claude-code");
    expect(parseBackendSelection({ backend: "opencode" })).toBe("opencode");
  });

  it("rejects unknown backend values", () => {
    expect(() => parseBackendSelection({ backend: "other" })).toThrow("Unknown backend: other");
  });
});
