import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";

const ciWorkflow = readFileSync(".github/workflows/ci.yml", "utf8");
const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
  packageManager?: string;
  scripts?: Record<string, string>;
  files?: string[];
};

describe("CI workflow guardrails", () => {
  it("uses pnpm setup and frozen install", () => {
    expect(ciWorkflow).toContain("uses: pnpm/action-setup@v4");
    expect(ciWorkflow).toContain("run: pnpm install --frozen-lockfile");
  });

  it("runs required quality gates", () => {
    expect(ciWorkflow).toContain("run: pnpm run typecheck");
    expect(ciWorkflow).toContain("run: pnpm test");
    expect(ciWorkflow).toContain("run: pnpm run build");
    expect(ciWorkflow).toContain("run: pnpm run verify:package");
  });

  it("does not run real probes or npm/package-lock flows", () => {
    expect(ciWorkflow).not.toMatch(/probe:real:[^\s'"`]+/);
    expect(ciWorkflow).not.toMatch(/\bnpm\s+(install|ci)\b/);
    expect(ciWorkflow).not.toMatch(/package-lock(?:\.json)?/);
  });
});

describe("package.json guardrails", () => {
  it("pins pnpm as package manager", () => {
    expect(packageJson.packageManager).toBeTypeOf("string");
    expect(packageJson.packageManager?.startsWith("pnpm@")).toBe(true);
  });

  it("keeps verify:package and real probes as explicit scripts", () => {
    const scripts = packageJson.scripts ?? {};

    expect(scripts["verify:package"]).toBeTypeOf("string");

    const realProbeScriptNames = Object.keys(scripts).filter((name) => name.startsWith("probe:real:"));
    expect(realProbeScriptNames.length).toBeGreaterThan(0);

    for (const scriptName of realProbeScriptNames) {
      const command = scripts[scriptName];
      expect(command).toBeTypeOf("string");
      expect(command).toMatch(/scripts\/(probe-real-(claude|opencode)|probe-retinue-opencode-mcp)\.mjs/);
    }

    expect(scripts.test).not.toContain("probe:real:");
    expect(scripts.build).not.toContain("probe:real:");
    expect(scripts.typecheck).not.toContain("probe:real:");
  });

  it("packages the Codex plugin surface", () => {
    expect(packageJson.files).toEqual(expect.arrayContaining(["plugins/**", ".agents/plugins/**"]));
  });
});

describe("Retinue Codex plugin guardrails", () => {
  it("declares a plugin manifest with skill and MCP surfaces", () => {
    const manifest = JSON.parse(readFileSync("plugins/anchorpoint/.codex-plugin/plugin.json", "utf8")) as {
      name?: string;
      skills?: string;
      mcpServers?: string;
      interface?: { displayName?: string };
    };

    expect(manifest.name).toBe("retinue");
    expect(manifest.skills).toBe("./skills/");
    expect(manifest.mcpServers).toBe("./.mcp.json");
    expect(manifest.interface?.displayName).toBe("Retinue");
  });

  it("uses plugin-level MCP server map shape", () => {
    const mcp = JSON.parse(readFileSync("plugins/anchorpoint/.mcp.json", "utf8")) as Record<string, { env?: Record<string, string> }>;

    expect(mcp).toHaveProperty("retinue");
    expect(mcp).not.toHaveProperty("mcpServers");
    expect(mcp.retinue?.env?.SUPERVISOR_DAEMON_DISCOVERY).toBeUndefined();
  });

  it("ships an agent-facing skill", () => {
    expect(existsSync("plugins/anchorpoint/skills/anchorpoint/SKILL.md")).toBe(true);
  });
});
