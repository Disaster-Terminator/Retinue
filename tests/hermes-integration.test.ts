import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";

const hermesDoc = readFileSync("docs/integrations/HERMES.md", "utf8");
const hermesConfig = readFileSync("integrations/hermes/mcp-retinue.yaml", "utf8");
const hermesSkill = readFileSync("integrations/hermes/skills/retinue/SKILL.md", "utf8");

describe("Hermes Agent integration", () => {
  it("ships a Hermes-native mcp_servers config snippet for Retinue", () => {
    expect(hermesConfig).toContain("mcp_servers:");
    expect(hermesConfig).toContain("retinue:");
    expect(hermesConfig).toContain('command: "retinue-mcp"');
    expect(hermesConfig).toContain('RETINUE_BACKEND: "opencode"');
    expect(hermesConfig).toContain('RETINUE_OPENCODE_AUTO_SERVE: "1"');
    expect(hermesConfig).not.toContain("RETINUE_OPENCODE_AGENT");
    expect(hermesConfig).not.toContain("mcpServers");
  });

  it("documents Hermes as a master-agent MCP client, not a Retinue backend", () => {
    expect(hermesDoc).toContain("Hermes Agent is a peer master-agent surface, not a Retinue backend");
    expect(hermesDoc).toContain("mcp_servers");
    expect(hermesDoc).toContain("mcp_retinue_retinue_spawn_agent");
    expect(hermesDoc).toContain("RETINUE_REAL_HERMES_RETINUE_PROBE=1");
    expect(hermesDoc).not.toContain("RETINUE_BACKEND=hermes");
  });

  it("ships a Hermes-facing skill that names the prefixed Retinue tools", () => {
    expect(existsSync("integrations/hermes/skills/retinue/SKILL.md")).toBe(true);
    expect(hermesSkill).toContain("requires_toolsets: [retinue]");
    expect(hermesSkill).toContain("mcp_retinue_retinue_spawn_agent");
    expect(hermesSkill).toContain("mcp_retinue_retinue_wait_agent");
    expect(hermesSkill).toContain("mcp_retinue_retinue_close_agent");
  });
});
