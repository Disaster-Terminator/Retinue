import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";

const ciWorkflow = readFileSync(".github/workflows/ci.yml", "utf8");
const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
  name?: string;
  private?: boolean;
  bin?: Record<string, string>;
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
  it("ships as the Retinue npm runtime package", () => {
    expect(packageJson.name).toBe("@disaster-terminator/retinue");
    expect(packageJson.private).toBe(false);
    expect(packageJson.bin).toMatchObject({
      retinue: "./dist/cli.js",
      "retinue-mcp": "./dist/mcp.js",
      retinued: "./dist/daemon.js"
    });
  });

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
      expect(command).toMatch(/scripts\/(probe-real-(claude|opencode)|probe-retinue-(opencode|claude)-mcp)\.mjs/);
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
    const mcp = JSON.parse(readFileSync("plugins/anchorpoint/.mcp.json", "utf8")) as Record<
      string,
      { command?: string; args?: string[]; env?: Record<string, string> }
    >;

    expect(mcp).toHaveProperty("retinue");
    expect(mcp).not.toHaveProperty("mcpServers");
    expect(mcp.retinue?.command).toBe("node");
    expect(mcp.retinue?.args).toEqual(["./dist/mcp.js"]);
    expect(existsSync(path.join("plugins/anchorpoint", mcp.retinue?.args?.[0] ?? ""))).toBe(true);
    expect(mcp.retinue?.startup_timeout_sec).toBe(30);
    expect(mcp.retinue?.env?.SUPERVISOR_RETINUE_BACKEND).toBe("opencode");
    expect(mcp.retinue?.env?.SUPERVISOR_OPENCODE_BASE_URL).toBe("http://127.0.0.1:4096");
    expect(mcp.retinue?.env?.SUPERVISOR_OPENCODE_AGENT).toBe("plan");
    expect(mcp.retinue?.env?.SUPERVISOR_DAEMON_DISCOVERY).toBeUndefined();
  });

  it("makes the Retinue plugin installed by default from its marketplace", () => {
    const marketplace = JSON.parse(readFileSync(".agents/plugins/marketplace.json", "utf8")) as {
      plugins?: Array<{ name?: string; policy?: { installation?: string } }>;
    };
    const retinue = marketplace.plugins?.find((plugin) => plugin.name === "retinue");
    expect(retinue?.policy?.installation).toBe("INSTALLED_BY_DEFAULT");
  });

  it("ships an agent-facing skill", () => {
    expect(existsSync("plugins/anchorpoint/skills/anchorpoint/SKILL.md")).toBe(true);
  });

  it("starts the plugin-local MCP server over stdio", async () => {
    const mcp = JSON.parse(readFileSync("plugins/anchorpoint/.mcp.json", "utf8")) as Record<
      string,
      { command: string; args: string[]; env?: Record<string, string> }
    >;
    const transport = new StdioClientTransport({
      command: mcp.retinue.command,
      args: mcp.retinue.args,
      cwd: path.resolve("plugins/anchorpoint"),
      env: mcp.retinue.env,
      stderr: "pipe"
    });
    const client = new Client({ name: "retinue-plugin-stdio-test", version: "0.1.0" });
    const stderrChunks: Buffer[] = [];
    transport.stderr?.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)));

    try {
      await client.connect(transport);
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(["retinue_spawn_agent", "retinue_wait_agent", "retinue_close_agent"]));
      expect(Buffer.concat(stderrChunks).toString("utf8")).toBe("");
    } finally {
      await Promise.allSettled([client.close(), transport.close()]);
    }
  });
});
