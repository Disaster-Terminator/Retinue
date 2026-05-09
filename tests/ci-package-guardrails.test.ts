import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import os from "node:os";
import path from "node:path";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";

type RetinueMcpServerConfig = {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  startup_timeout_sec?: number;
};
type RetinueMcpConfig = {
  mcpServers?: Record<string, RetinueMcpServerConfig>;
};

function loadPluginMcpConfig(pluginRoot: string): Record<string, RetinueMcpServerConfig> {
  const raw = JSON.parse(readFileSync(path.join(pluginRoot, ".mcp.json"), "utf8")) as RetinueMcpConfig;
  return raw.mcpServers ?? {};
}

function resolvePluginMcpServer(pluginRoot: string, server: RetinueMcpServerConfig): RetinueMcpServerConfig {
  const cwd =
    typeof server.cwd === "string" && (server.cwd.startsWith("./") || server.cwd.startsWith("../") || server.cwd === ".")
      ? path.resolve(pluginRoot, server.cwd)
      : server.cwd;

  return {
    ...server,
    cwd
  };
}

const ciWorkflow = readFileSync(".github/workflows/ci.yml", "utf8");
const readmeZh = readFileSync("README.md", "utf8");
const readmeEn = readFileSync("README.en.md", "utf8");
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
    expect(ciWorkflow).toContain("run: pnpm run check:generated");
    expect(ciWorkflow).toContain("run: pnpm test");
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
    expect(scripts["check:generated"]).toBe("pnpm run build && git diff --exit-code -- dist plugins/anchorpoint/dist");

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
  it("documents the real Codex 0.128 plugin install path", () => {
    const quickStartZh = readmeZh.match(/## 快速开始[\s\S]*?预期结果：/)?.[0] ?? "";
    const quickStartEn = readmeEn.match(/## Quick Start[\s\S]*?Expected result:/)?.[0] ?? "";

    expect(quickStartZh).toContain("`/plugins`");
    expect(quickStartZh).toContain("右方向键");
    expect(quickStartZh).toContain("`Install plugin`");
    expect(quickStartZh).not.toContain("codex plugin marketplace upgrade retinue-local");
    expect(quickStartEn).toContain("`/plugins`");
    expect(quickStartEn).toContain("Right Arrow");
    expect(quickStartEn).toContain("`Install plugin`");
    expect(quickStartEn).not.toContain("codex plugin marketplace upgrade retinue-local");
  });

  it("documents the default OpenCode lifecycle and fallback-port behavior", () => {
    expect(readmeZh).toContain("%USERPROFILE%\\.opencode\\bin\\opencode");
    expect(readmeZh).toContain("默认插件配置会管理本机 OpenCode server 生命周期");
    expect(readmeZh).toContain("`4097` 到 `4127`");
    expect(readmeEn).toContain("%USERPROFILE%\\.opencode\\bin\\opencode");
    expect(readmeEn).toContain("The default plugin config manages the local OpenCode server lifecycle");
    expect(readmeEn).toContain("`4097` through `4127`");
    expect(readmeZh).not.toContain("端口被外部服务占用时尝试 `4097`。");
    expect(readmeEn).not.toContain("tries `4097` when that port is occupied");
  });

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

  it("uses Codex plugin MCP server map shape", () => {
    const raw = JSON.parse(readFileSync("plugins/anchorpoint/.mcp.json", "utf8")) as RetinueMcpConfig;
    const mcp = raw.mcpServers ?? {};

    expect(raw).toHaveProperty("mcpServers");
    expect(mcp).toHaveProperty("retinue");
    expect(mcp.retinue?.command).toBe("node");
    expect(mcp.retinue?.args).toEqual(["./dist/mcp.js"]);
    expect(mcp.retinue?.cwd).toBe(".");
    expect(existsSync(path.join("plugins/anchorpoint", mcp.retinue?.args?.[0] ?? ""))).toBe(true);
    expect(mcp.retinue?.startup_timeout_sec).toBe(30);
    expect(mcp.retinue?.env?.SUPERVISOR_RETINUE_BACKEND).toBe("opencode");
    expect(mcp.retinue?.env?.SUPERVISOR_OPENCODE_AUTO_SERVE).toBe("1");
    expect(mcp.retinue?.env?.SUPERVISOR_OPENCODE_HOST).toBe("127.0.0.1");
    expect(mcp.retinue?.env?.SUPERVISOR_OPENCODE_PORT).toBeUndefined();
    expect(mcp.retinue?.env?.SUPERVISOR_OPENCODE_BASE_URL).toBeUndefined();
    expect(mcp.retinue?.env?.SUPERVISOR_OPENCODE_AGENT).toBe("plan");
    expect(mcp.retinue?.env?.SUPERVISOR_DAEMON_DISCOVERY).toBeUndefined();
    expect(mcp.retinue?.env?.SUPERVISOR_EXPOSE_BACKEND_TOOLS).toBeUndefined();
  });

  it("makes the Retinue plugin available from its marketplace", () => {
    const marketplace = JSON.parse(readFileSync(".agents/plugins/marketplace.json", "utf8")) as {
      plugins?: Array<{ name?: string; policy?: { installation?: string } }>;
    };
    const retinue = marketplace.plugins?.find((plugin) => plugin.name === "retinue");
    expect(retinue?.policy?.installation).toBe("AVAILABLE");
  });

  it("ships an agent-facing skill", () => {
    expect(existsSync("plugins/anchorpoint/skills/anchorpoint/SKILL.md")).toBe(true);
  });

  it("starts the plugin-local MCP server over stdio from an isolated plugin cache", async () => {
    const pluginCacheDir = mkdtempSync(path.join(os.tmpdir(), "retinue-plugin-cache-"));
    cpSync("plugins/anchorpoint", pluginCacheDir, { recursive: true });
    const mcp = loadPluginMcpConfig(pluginCacheDir);
    const retinue = resolvePluginMcpServer(pluginCacheDir, mcp.retinue);
    const transport = new StdioClientTransport({
      command: retinue.command,
      args: retinue.args,
      cwd: retinue.cwd,
      env: retinue.env,
      stderr: "pipe"
    });
    const client = new Client({ name: "retinue-plugin-stdio-test", version: "0.1.0" });
    const stderrChunks: Buffer[] = [];
    transport.stderr?.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)));

    try {
      await client.connect(transport);
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual(["retinue_spawn_agent", "retinue_wait_agent", "retinue_close_agent"]);
      expect(Buffer.concat(stderrChunks).toString("utf8")).toBe("");
    } finally {
      await Promise.allSettled([client.close(), transport.close()]);
      rmSync(pluginCacheDir, { recursive: true, force: true });
    }
  });

  it("starts from an isolated plugin cache even when the Codex conversation cwd is elsewhere", async () => {
    const pluginCacheDir = mkdtempSync(path.join(os.tmpdir(), "retinue-plugin-cache-"));
    const conversationCwd = mkdtempSync(path.join(os.tmpdir(), "retinue-conversation-cwd-"));
    cpSync("plugins/anchorpoint", pluginCacheDir, { recursive: true });
    const mcp = loadPluginMcpConfig(pluginCacheDir);
    const retinue = resolvePluginMcpServer(pluginCacheDir, mcp.retinue);
    expect(retinue.cwd).toBe(pluginCacheDir);
    const transport = new StdioClientTransport({
      command: retinue.command,
      args: retinue.args,
      cwd: retinue.cwd,
      env: retinue.env,
      stderr: "pipe"
    });
    const client = new Client({ name: "retinue-plugin-cross-cwd-test", version: "0.1.0" });

    try {
      await client.connect(transport);
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual(["retinue_spawn_agent", "retinue_wait_agent", "retinue_close_agent"]);
    } finally {
      await Promise.allSettled([client.close(), transport.close()]);
      rmSync(pluginCacheDir, { recursive: true, force: true });
      rmSync(conversationCwd, { recursive: true, force: true });
    }
  });
});
