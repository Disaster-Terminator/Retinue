import { describe, expect, it } from "vitest";
import { buildClaudeArgs } from "../../src/core/claudeArgs.js";

describe("buildClaudeArgs", () => {
  it("builds safe print-mode JSON args by default", () => {
    const args = buildClaudeArgs({ prompt: "Summarize this repo", cwd: "/repo" });

    expect(args).toContain("-p");
    expect(args).toContain("--output-format");
    expect(args).toContain("json");
    expect(args).not.toContain("Summarize this repo");
    expect(args).not.toContain("--dangerously-skip-permissions");
    expect(args).not.toContain("--permission-mode");
    expect(args).not.toContain("bypassPermissions");
  });

  it("supports explicit resume, max turns, and non-bypass permission mode", () => {
    const args = buildClaudeArgs({
      prompt: "Continue",
      cwd: "/repo",
      resume: "session-123",
      maxTurns: 3,
      permissionMode: "plan"
    });

    expect(args).toEqual([
      "-p",
      "--output-format",
      "json",
      "--resume",
      "session-123",
      "--max-turns",
      "3",
      "--permission-mode",
      "plan"
    ]);
  });
});
