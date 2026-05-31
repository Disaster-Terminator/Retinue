import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import os from "node:os";
import path from "node:path";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";

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
const docsIndex = readFileSync("docs/README.md", "utf8");
const configurationReference = readFileSync("docs/reference/configuration.md", "utf8");
const mcpToolsReference = readFileSync("docs/reference/mcp-tools.md", "utf8");
const diagnosticsReference = readFileSync("docs/reference/diagnostics.md", "utf8");
const realOpenCodeMcpProbe = readFileSync("scripts/probe-retinue-opencode-mcp.mjs", "utf8");
const opencodeBackendSource = readFileSync("src/backends/opencode/backend.ts", "utf8");
const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
  name?: string;
  version?: string;
  private?: boolean;
  license?: string;
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
    expect(ciWorkflow).toContain("run: pnpm run smoke:package");
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
    expect(packageJson.license).toBe("Apache-2.0");
    expect(packageJson.bin).toMatchObject({
      retinue: "dist/cli.js",
      "retinue-mcp": "dist/mcp.js",
      retinued: "dist/daemon.js",
      "retinue-daemon": "dist/daemon.js"
    });
  });

  it("pins pnpm as package manager", () => {
    expect(packageJson.packageManager).toBeTypeOf("string");
    expect(packageJson.packageManager?.startsWith("pnpm@")).toBe(true);
  });

  it("keeps verify:package and real probes as explicit scripts", () => {
    const scripts = packageJson.scripts ?? {};

    expect(scripts["verify:package"]).toBeTypeOf("string");
    expect(scripts["smoke:package"]).toBe("node scripts/smoke-package-artifacts.mjs");
    expect(scripts.test).toBe("pnpm run test:all");
    expect(scripts["test:all"]).toBe("vitest run --maxWorkers=2");
    expect(scripts["test:core"]).toBe("vitest run --maxWorkers=2 tests/core");
    expect(scripts["test:daemon"]).toContain("--maxWorkers=1");
    expect(scripts["test:opencode"]).toContain("--maxWorkers=1");
    expect(scripts["test:mcp"]).toContain("--maxWorkers=1");
    expect(scripts["test:package"]).toContain("--maxWorkers=1");
    expect(scripts["test:probes"]).toContain("--maxWorkers=1");
    expect(scripts["test:cli"]).toBe("vitest run --maxWorkers=1 tests/cli.test.ts");
    expect(scripts["test:daemon"]).toContain("tests/daemon-client.test.ts");
    expect(scripts["test:opencode"]).toContain("tests/opencode-backend.test.ts");
    expect(scripts["test:mcp"]).toContain("tests/mcp-tools.test.ts");
    expect(scripts["test:package"]).toContain("tests/ci-package-guardrails.test.ts");
    expect(scripts["test:package"]).toContain("tests/sync-plugin-runtime.test.ts");
    expect(scripts["test:probes"]).toContain("tests/probe-dogfood.test.ts");
    expect(scripts["test:probes"]).toContain("tests/probe-backend-candidates.test.ts");
    expect(scripts["test:probes"]).toContain("tests/probe-opencode-root-binding.test.ts");
    expect(scripts["test:probes"]).toContain("tests/probe-real-opencode.test.ts");
    expect(scripts["gate:commit"]).toBe("pnpm run typecheck && pnpm run test:core");
    expect(scripts["gate:fast"]).toBe("pnpm run gate:commit && pnpm run test:mcp && pnpm run test:package");
    expect(scripts["gate:local"]).toBe("pnpm run typecheck && pnpm run test:all && pnpm run smoke:package && pnpm run verify:package");
    expect(scripts["gate:release"]).toBe(
      "pnpm run typecheck && pnpm run test:all && pnpm run check:generated && pnpm run smoke:package && pnpm run verify:package"
    );
    expect(scripts.prepublishOnly).toBe("pnpm run gate:release");
    expect(scripts["dev:sync-plugin-cache"]).toBe("node scripts/sync-installed-plugin-cache.mjs");
    expect(scripts["dev:sync-plugin-cache:all"]).toBe("node scripts/sync-installed-plugin-cache.mjs --include-windows --include-wsl");
    expect(scripts["dev:install-hooks"]).toBe("node scripts/install-git-hooks.mjs");
    expect(scripts["check:generated"]).toBe("pnpm run build && git diff --exit-code -- dist plugins/retinue/dist");

    const realProbeScriptNames = Object.keys(scripts).filter((name) => name.startsWith("probe:real:"));
    expect(realProbeScriptNames.length).toBeGreaterThan(0);

    for (const scriptName of realProbeScriptNames) {
      const command = scripts[scriptName];
      expect(command).toBeTypeOf("string");
      expect(command).toMatch(
        /scripts\/(probe-real-(claude|opencode)|probe-claude-agent-sdk|probe-backend-candidates|probe-opencode-native-spawn|probe-opencode-root-binding|probe-retinue-(opencode|claude|kilo)(-slots)?-mcp|probe-retinue-opencode-slots|probe-retinue-opencode-agent-ab)\.mjs/
      );
    }

    expect(scripts["probe:hermes-retinue"]).toBe("node scripts/probe-hermes-retinue-mcp.mjs");
    expect(scripts["probe:dogfood:opencode"]).toBe("pnpm run build && node scripts/probe-retinue-opencode-dogfood.mjs");
    expect(scripts["gate:dogfood"]).toBe("pnpm run probe:dogfood:opencode");
    expect(scripts.test).not.toContain("probe:real:");
    expect(scripts.build).not.toContain("probe:real:");
    expect(scripts.typecheck).not.toContain("probe:real:");
    expect(scripts["gate:release"]).not.toContain("probe:dogfood:");
  });

  it("keeps the product OpenCode real probe on the default auto-serve path", () => {
    expect(realOpenCodeMcpProbe).toContain('process.env.RETINUE_OPENCODE_AUTO_SERVE = process.env.RETINUE_OPENCODE_AUTO_SERVE ?? "1"');
    expect(realOpenCodeMcpProbe).toContain('process.env.RETINUE_OPENCODE_HOST = process.env.RETINUE_OPENCODE_HOST ?? "127.0.0.1"');
    expect(realOpenCodeMcpProbe).toContain('process.env.RETINUE_OPENCODE_AGENT = process.env.RETINUE_OPENCODE_AGENT ?? "explore"');
    expect(realOpenCodeMcpProbe).not.toContain("Missing RETINUE_OPENCODE_BASE_URL");
  });

  it("packages the Codex plugin surface", () => {
    expect(packageJson.files).toEqual(expect.arrayContaining(["plugins/**", ".agents/plugins/**", "dist/cli/**"]));
  });

  it("packages the Hermes integration surface", () => {
    expect(packageJson.files).toEqual(expect.arrayContaining(["integrations/**"]));
  });
});

describe("Retinue Codex plugin guardrails", () => {
  it("documents the real Codex 0.128 plugin install path", () => {
    const quickStartZh = readmeZh.match(/## 快速开始[\s\S]*?预期结果：/)?.[0] ?? "";
    const quickStartEn = readmeEn.match(/## Quick Start[\s\S]*?Expected result:/)?.[0] ?? "";

    expect(quickStartZh).toContain("`/plugins`");
    expect(quickStartZh).toContain("`Install plugin`");
    expect(quickStartZh).not.toContain("codex plugin marketplace upgrade retinue-local");
    expect(quickStartEn).toContain("`/plugins`");
    expect(quickStartEn).toContain("`Install plugin`");
    expect(quickStartEn).not.toContain("codex plugin marketplace upgrade retinue-local");
  });

  it("keeps the README as a user entry and moves deep configuration to reference docs", () => {
    expect(readmeZh).toContain("OpenCode");
    expect(readmeZh).toContain("`explore`");
    expect(readmeZh).toContain("docs/reference/configuration.md");
    expect(readmeZh).not.toContain("RETINUE_OPENCODE_FALLBACK_PORTS");
    expect(readmeZh).not.toContain("RETINUE_OPENCODE_TASK_ATTEMPT_MAX");
    expect(readmeEn).toContain("OpenCode");
    expect(readmeEn).toContain("`explore`");
    expect(readmeEn).toContain("docs/reference/configuration.md");
    expect(readmeEn).not.toContain("RETINUE_OPENCODE_FALLBACK_PORTS");
    expect(readmeEn).not.toContain("RETINUE_OPENCODE_TASK_ATTEMPT_MAX");
    expect(configurationReference).toContain("RETINUE_OPENCODE_FALLBACK_PORTS");
    expect(configurationReference).toContain("RETINUE_OPENCODE_TASK_ATTEMPT_MAX");
  });

  it("documents Retinue child-agent slots and diagnostics in canonical references", () => {
    expect(configurationReference).toContain("RETINUE_MAX_CONCURRENT_AGENTS");
    expect(configurationReference).toContain("RETINUE_OVERFLOW_STRATEGY");
    expect(configurationReference).toContain("RETINUE_MAX_QUEUED_AGENTS");
    expect(mcpToolsReference).toContain('`queued`');
    expect(mcpToolsReference).toContain('`stalled`');
    expect(mcpToolsReference).toContain("permission");
    expect(diagnosticsReference).toContain("read_tool_invalid_input");
    expect(diagnosticsReference).toContain("provider_zero_progress");
    expect(diagnosticsReference).not.toContain("default 75-second soft-stall");
  });

  it("routes documentation by reader intent", () => {
    expect(docsIndex).toContain("I Want To Try Retinue");
    expect(docsIndex).toContain("I Am Configuring An Integration");
    expect(docsIndex).toContain("I Am Developing Retinue");
    expect(docsIndex).toContain("I Am Debugging A Runtime Issue");
    expect(docsIndex).toContain("project/release-plans");
    expect(docsIndex).not.toContain("docs/release/0.2.0_RELEASE_PLAN.md");
  });

  it("keeps OpenCode no-progress stall detection inside one MCP wait call", () => {
    expect(opencodeBackendSource).toContain("const DEFAULT_STALL_MS = 10 * 60_000");
    expect(opencodeBackendSource).toContain("const DEFAULT_INCOMPLETE_ASSISTANT_STALL_MS = 45_000");
    expect(opencodeBackendSource).toContain("const DEFAULT_BLANK_ASSISTANT_STALL_MS = 45_000");
    expect(opencodeBackendSource).toContain("const DEFAULT_ZERO_PROGRESS_ASSISTANT_STALL_MS = 45_000");
    expect(opencodeBackendSource).toContain("const DEFAULT_READ_TOOL_STALL_MS = 45_000");
    expect(opencodeBackendSource).toContain("const DEFAULT_COMPLETED_TOOL_LOOP_STALL_MS = 45_000");
    expect(opencodeBackendSource).not.toContain("const DEFAULT_INCOMPLETE_ASSISTANT_STALL_MS = 60_000");
    expect(opencodeBackendSource).not.toContain("const DEFAULT_ZERO_PROGRESS_ASSISTANT_STALL_MS = 120_000");
    expect(opencodeBackendSource).toContain("const DEFAULT_STALL_EMPTY_ASSISTANT_ROUNDS = 1");
  });

  it("keeps strict OpenCode read-only prompt and tool-deny layers available as opt-in behavior", () => {
    expect(opencodeBackendSource).toContain("const OPENCODE_READ_ONLY_TOOLS_NO_BASH: Record<string, boolean> = {");
    expect(opencodeBackendSource).toContain("const OPENCODE_READ_ONLY_TOOLS_WITH_READONLY_GIT_BASH: Record<string, boolean> = {");
    expect(opencodeBackendSource).toContain("edit: false");
    expect(opencodeBackendSource).toContain("write: false");
    expect(opencodeBackendSource).toContain("task: false");
    expect(opencodeBackendSource).toContain("Retinue read-only child agent contract");
    expect(opencodeBackendSource).toContain("Use only OpenCode read, grep, glob, and allowed read-only git bash commands");
    expect(opencodeBackendSource).toContain("Allowed bash is limited to read-only git inspection commands");
    expect(opencodeBackendSource).toContain("read only a small set of targeted files");
    expect(opencodeBackendSource).toContain("Use read serially");
    expect(opencodeBackendSource).toContain("Do not emit unified diffs");
    expect(opencodeBackendSource).toContain("Do not include patch blocks");
    expect(opencodeBackendSource).toContain("For code review, return findings as plain text");
    expect(opencodeBackendSource).toContain("If the user provides enough facts");
    expect(opencodeBackendSource).toContain("Do not use tools just to confirm prompt-provided facts");
    expect(opencodeBackendSource).toContain("Use at most six inspection tool calls");
    expect(opencodeBackendSource).toContain("You cannot inspect git history");
    expect(opencodeBackendSource).toContain("If the task asks for a diff");
    expect(opencodeBackendSource).toContain("Do not call bash except for allowed read-only git inspection commands");
  });

  it("declares a plugin manifest with skill and MCP surfaces", () => {
    const manifest = JSON.parse(readFileSync("plugins/retinue/.codex-plugin/plugin.json", "utf8")) as {
      name?: string;
      version?: string;
      license?: string;
      keywords?: string[];
      skills?: string;
      mcpServers?: string;
      interface?: { displayName?: string; longDescription?: string; defaultPrompt?: string[] };
    };
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { license?: string };

    expect(manifest.name).toBe("retinue");
    expect(manifest.version).toBe(packageJson.version);
    expect(manifest.license).toBe(pkg.license);
    expect(manifest.keywords).toContain("kilo");
    expect(manifest.skills).toBe("./skills/");
    expect(manifest.mcpServers).toBe("./.mcp.json");
    expect(manifest.interface?.displayName).toBe("Retinue");
    expect(manifest.interface?.longDescription).toContain("explore agent");
    expect(manifest.interface?.longDescription).toContain("Kilo");
    expect(manifest.interface?.longDescription).not.toContain("plan agent");
    expect(manifest.interface?.defaultPrompt?.join("\n")).toContain("OpenCode explore subagent");
  });

  it("uses Codex plugin MCP server map shape", () => {
    const raw = JSON.parse(readFileSync("plugins/retinue/.mcp.json", "utf8")) as RetinueMcpConfig;
    const mcp = raw.mcpServers ?? {};

    expect(raw).toHaveProperty("mcpServers");
    expect(mcp).toHaveProperty("retinue");
    expect(mcp.retinue?.command).toBe("node");
    expect(mcp.retinue?.args).toEqual(["./mcp-bootstrap.mjs"]);
    expect(mcp.retinue?.cwd).toBe(".");
    expect(existsSync(path.join("plugins/retinue", mcp.retinue?.args?.[0] ?? ""))).toBe(true);
    expect(readFileSync("plugins/retinue/mcp-bootstrap.mjs", "utf8")).toContain("process.chdir");
    expect(readFileSync("plugins/retinue/mcp-bootstrap.mjs", "utf8")).toContain("loadCodexEnvOverrides");
    expect(readFileSync("plugins/retinue/mcp-bootstrap.mjs", "utf8")).toContain("RETINUE_");
    expect(mcp.retinue?.startup_timeout_sec).toBe(30);
    expect(mcp.retinue?.env?.RETINUE_BACKEND).toBe("opencode");
    expect(mcp.retinue?.env?.RETINUE_OPENCODE_AUTO_SERVE).toBe("1");
    expect(mcp.retinue?.env?.RETINUE_OPENCODE_HOST).toBe("127.0.0.1");
    expect(mcp.retinue?.env?.RETINUE_OPENCODE_PORT).toBeUndefined();
    expect(mcp.retinue?.env?.RETINUE_OPENCODE_BASE_URL).toBeUndefined();
    expect(mcp.retinue?.env?.RETINUE_OPENCODE_AGENT).toBeUndefined();
    expect(mcp.retinue?.env?.RETINUE_OPENCODE_READ_ONLY).toBeUndefined();
    expect(existsSync("plugins/retinue/retinue.config.json")).toBe(true);
    expect(JSON.parse(readFileSync("plugins/retinue/retinue.config.json", "utf8"))).toMatchObject({
      maxConcurrentAgents: 3,
      opencode: { agent: "explore" }
    });
    expect(mcp.retinue?.env?.RETINUE_DAEMON_DISCOVERY).toBeUndefined();
    expect(mcp.retinue?.env?.RETINUE_EXPOSE_BACKEND_TOOLS).toBeUndefined();
  });

  it("makes the Retinue plugin available from its marketplace", () => {
    const marketplace = JSON.parse(readFileSync(".agents/plugins/marketplace.json", "utf8")) as {
      plugins?: Array<{ name?: string; policy?: { installation?: string } }>;
    };
    const retinue = marketplace.plugins?.find((plugin) => plugin.name === "retinue");
    expect(retinue?.policy?.installation).toBe("AVAILABLE");
  });

  it("ships an agent-facing skill", () => {
    expect(existsSync("plugins/retinue/skills/retinue/SKILL.md")).toBe(true);
  });

  it("starts the plugin-local MCP server over stdio from an isolated plugin cache", async () => {
    const pluginCacheDir = mkdtempSync(path.join(os.tmpdir(), "retinue-plugin-cache-"));
    cpSync("plugins/retinue", pluginCacheDir, { recursive: true });
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
      expect(tools.tools.map((tool) => tool.name)).toEqual([
        "retinue_spawn_agent",
        "retinue_wait_agent",
        "retinue_close_agent",
        "retinue_list_agents",
        "retinue_list_permissions",
        "retinue_reply_permission",
        "retinue_stop_runtime",
        "retinue_restart_runtime"
      ]);
      expect(Buffer.concat(stderrChunks).toString("utf8")).toBe("");
    } finally {
      await Promise.allSettled([client.close(), transport.close()]);
      rmSync(pluginCacheDir, { recursive: true, force: true });
    }
  });

  it("applies Retinue Codex env overrides from CODEX_HOME config during plugin bootstrap", async () => {
    const pluginCacheDir = mkdtempSync(path.join(os.tmpdir(), "retinue-plugin-cache-"));
    const codexHome = mkdtempSync(path.join(os.tmpdir(), "retinue-codex-home-"));
    cpSync("plugins/retinue", pluginCacheDir, { recursive: true });
    writeFileSync(path.join(codexHome, "config.toml"), '[env]\nRETINUE_MAX_CONCURRENT_AGENTS = "5"\n', "utf8");
    const mcp = loadPluginMcpConfig(pluginCacheDir);
    const retinue = resolvePluginMcpServer(pluginCacheDir, mcp.retinue);
    const transport = new StdioClientTransport({
      command: retinue.command,
      args: retinue.args,
      cwd: retinue.cwd,
      env: { ...retinue.env, CODEX_HOME: codexHome },
      stderr: "pipe"
    });
    const client = new Client({ name: "retinue-plugin-codex-env-test", version: "0.1.0" });

    try {
      await client.connect(transport);
      const listed = parseToolJson(await client.callTool({ name: "retinue_list_agents", arguments: {} }));
      expect(listed).toMatchObject({ maxAgents: 5, agents: [] });
    } finally {
      await Promise.allSettled([client.close(), transport.close()]);
      rmSync(pluginCacheDir, { recursive: true, force: true });
      rmSync(codexHome, { recursive: true, force: true });
    }
  });

  it("starts from an isolated plugin cache even when the Codex conversation cwd is elsewhere", async () => {
    const pluginCacheDir = mkdtempSync(path.join(os.tmpdir(), "retinue-plugin-cache-"));
    const conversationCwd = mkdtempSync(path.join(os.tmpdir(), "retinue-conversation-cwd-"));
    cpSync("plugins/retinue", pluginCacheDir, { recursive: true });
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
      expect(tools.tools.map((tool) => tool.name)).toEqual([
        "retinue_spawn_agent",
        "retinue_wait_agent",
        "retinue_close_agent",
        "retinue_list_agents",
        "retinue_list_permissions",
        "retinue_reply_permission",
        "retinue_stop_runtime",
        "retinue_restart_runtime"
      ]);
    } finally {
      await Promise.allSettled([client.close(), transport.close()]);
      rmSync(pluginCacheDir, { recursive: true, force: true });
      rmSync(conversationCwd, { recursive: true, force: true });
    }
  });
});

function parseToolJson(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  const text = result.content.find((item) => item.type === "text")?.text;
  if (!text) {
    throw new Error("Tool result did not include text content");
  }
  return JSON.parse(text) as Record<string, unknown>;
}
