import { describe, expect, it } from "vitest";
import { CLAUDE_TOOL_NAMES, createMcpServer } from "../src/mcp.js";
import { ClaudeSupervisor } from "../src/core/supervisor.js";

describe("MCP tools", () => {
  it("declares the Claude Code lifecycle tools", () => {
    expect(CLAUDE_TOOL_NAMES).toEqual([
      "claude_run",
      "claude_status",
      "claude_wait",
      "claude_result",
      "claude_kill",
      "claude_cleanup"
    ]);
  });

  it("creates a server instance with registered tools", () => {
    const server = createMcpServer(new ClaudeSupervisor({ stateDir: "unused" }));

    expect(server).toBeTruthy();
    expect(server.server).toBeTruthy();
  });
});

