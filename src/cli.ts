#!/usr/bin/env node

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { main as auditLogsMain } from "./cli/auditRetinueLogs.js";
import { ensureOpenCodeServer, resolveOpenCodeServerFromEnv, stopManagedOpenCodeServers } from "./backends/opencode/serverManager.js";
import { readDaemonDiscovery, validateLoopbackHttpUrl, type DaemonDiscovery } from "./daemon/discovery.js";
import { resolveStateDir } from "./core/paths.js";
import { CLAUDE_TOOL_NAMES, OPENCODE_TOOL_NAMES, RETINUE_DIAGNOSTIC_TOOL_NAMES, RETINUE_TOOL_NAMES } from "./mcp.js";

type CommandContext = {
  args: string[];
  daemonUrl?: string;
  daemonToken?: string;
  discoverDaemon: boolean;
};

async function main(): Promise<void> {
  const context = extractGlobalFlags(process.argv.slice(2));
  const [group, command, ...args] = context.args;

  if (group === "daemon" && command === "health") {
    const flags = parseFlags(args);
    const health = await daemonHealth({
      daemonUrl: flags["daemon-url"] ?? context.daemonUrl,
      daemonToken: flags["daemon-token"] ?? context.daemonToken,
      discoverDaemon: booleanFlag(flags, "discover-daemon", context.discoverDaemon)
    });
    writeJson(health);
    if (isFailureResult(health)) {
      process.exitCode = 1;
    }
    return;
  }

  if (group === "diagnostics" && command === "audit-logs") {
    await auditLogsMain(args, process.env);
    return;
  }

  if (group === "plugin" && command === "sync-cache") {
    await runPluginSyncCache(args);
    return;
  }

  if (group === "mcp" && command === "tools") {
    const flags = parseFlags(args);
    writeJson({
      defaultTools: [...RETINUE_TOOL_NAMES],
      diagnosticTools: booleanFlag(flags, "include-diagnostics", false) ? [...RETINUE_DIAGNOSTIC_TOOL_NAMES] : undefined,
      backendDebugTools: booleanFlag(flags, "include-backend-debug", false)
        ? {
            claude: [...CLAUDE_TOOL_NAMES],
            opencode: [...OPENCODE_TOOL_NAMES]
          }
        : undefined
    });
    return;
  }

  if (group === "runtime" && command === "stop") {
    const flags = parseFlags(args);
    writeJson(
      await stopRuntime({
        runtime: flags.runtime,
        cwd: flags.cwd,
        all: booleanFlag(flags, "all", false),
        force: booleanFlag(flags, "force", false)
      })
    );
    return;
  }

  if (group === "runtime" && command === "restart") {
    const flags = parseFlags(args);
    writeJson(
      await restartRuntime({
        runtime: flags.runtime,
        cwd: required(flags.cwd, "--cwd"),
        force: booleanFlag(flags, "force", false)
      })
    );
    return;
  }

  if (group === "help" || group === "--help" || group === "-h" || group === undefined) {
    process.stdout.write(helpText());
    return;
  }

  throw new Error(`Unknown command: ${[group, command].filter(Boolean).join(" ") || "(missing)"}. Legacy flat CLI commands were removed; use grouped Retinue control-plane commands.`);
}

async function daemonHealth(options: { daemonUrl?: string; daemonToken?: string; discoverDaemon: boolean }): Promise<unknown> {
  const source = options.daemonUrl ? "explicit_url" : options.discoverDaemon ? "discovery" : "none";
  if (source === "none") {
    return {
      ok: false,
      source,
      error: {
        code: "missing_daemon_target",
        message: "Provide --daemon-url <url> or enable --discover-daemon"
      }
    };
  }

  let daemonUrl = options.daemonUrl;
  let daemonToken = options.daemonToken;
  if (!daemonUrl) {
    try {
      const discovery = await discoverDaemon();
      daemonUrl = discovery.url;
      daemonToken = discovery.token;
    } catch (error) {
      return {
        ok: false,
        source,
        error: {
          code: "discovery_error",
          message: error instanceof Error ? error.message : String(error)
        }
      };
    }
  }

  return readDaemonHealth(daemonUrl, source, daemonToken);
}

async function readDaemonHealth(daemonUrl: string, source: "explicit_url" | "discovery", daemonToken?: string): Promise<unknown> {
  let normalizedUrl: string;
  try {
    normalizedUrl = validateLoopbackHttpUrl(daemonUrl);
  } catch (error) {
    return {
      ok: false,
      source,
      daemonUrl,
      error: {
        code: "invalid_daemon_url",
        message: error instanceof Error ? error.message : String(error)
      }
    };
  }
  try {
    const response = await fetch(`${normalizedUrl}/health`, {
      headers: daemonToken ? { authorization: `Bearer ${daemonToken}` } : undefined
    });
    const bodyText = await response.text();
    const { parsed, value } = parseJson(bodyText);
    if (!response.ok) {
      return {
        ok: false,
        source,
        daemonUrl,
        error: {
          code: "daemon_http_error",
          message: `Daemon health request failed with HTTP ${response.status}`,
          status: response.status,
          details: value
        }
      };
    }
    if (!parsed) {
      return {
        ok: false,
        source,
        daemonUrl,
        error: {
          code: "daemon_invalid_json",
          message: "Daemon health response was not valid JSON",
          details: bodyText
        }
      };
    }
    return {
      ok: true,
      source,
      daemonUrl,
      health: value
    };
  } catch (error) {
    return {
      ok: false,
      source,
      daemonUrl,
      error: {
        code: "daemon_unreachable",
        message: error instanceof Error ? error.message : String(error)
      }
    };
  }
}

async function stopRuntime(options: { runtime?: string; cwd?: string; all: boolean; force: boolean }): Promise<unknown> {
  const runtime = options.runtime ?? "opencode";
  if (runtime !== "opencode") {
    return { runtime, status: "unsupported" };
  }
  if (options.all !== true && !options.cwd?.trim()) {
    return {
      runtime,
      status: "invalid_request",
      error: "runtime stop requires --cwd <dir> or --all"
    };
  }
  const stateDir = resolveStateDir({
    explicitStateDir: process.env.RETINUE_STATE_DIR,
    env: process.env
  });
  return stopManagedOpenCodeServers({ stateDir, cwd: options.cwd, all: options.all, force: options.force, reason: "manual" });
}

async function restartRuntime(options: { runtime?: string; cwd: string; force: boolean }): Promise<unknown> {
  const runtime = options.runtime ?? "opencode";
  if (runtime !== "opencode") {
    return { runtime, status: "unsupported" };
  }
  const resolution = resolveOpenCodeServerFromEnv(process.env);
  if (resolution.mode === "attach") {
    return {
      backend: runtime,
      status: "not_managed",
      error: "runtime restart only manages Retinue auto-served OpenCode servers; RETINUE_OPENCODE_BASE_URL is external."
    };
  }
  const stateDir = resolveStateDir({
    explicitStateDir: process.env.RETINUE_STATE_DIR,
    env: process.env
  });
  const stopped = await stopManagedOpenCodeServers({ stateDir, cwd: options.cwd, force: options.force, reason: "restart" });
  if (stopped.status === "blocked") {
    return stopped;
  }
  const started = await ensureOpenCodeServer(resolution, { stateDir, cwd: options.cwd });
  return {
    backend: runtime,
    status: "restarted",
    stopped: stopped.stopped,
    started: {
      baseUrl: started.baseUrl,
      cwd: options.cwd,
      reusedExisting: started.started !== true
    }
  };
}

async function runPluginSyncCache(args: string[]): Promise<void> {
  const translated: string[] = [];
  for (const arg of args) {
    if (arg === "--all") {
      translated.push("--include-windows", "--include-wsl");
      continue;
    }
    translated.push(arg);
  }
  await execNodeScript(resolvePackageScript("sync-installed-plugin-cache.mjs"), translated);
}

function resolvePackageScript(name: string): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "scripts", name);
}

function execNodeScript(scriptPath: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      stdio: "inherit",
      env: process.env
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${path.basename(scriptPath)} exited with ${signal ?? code}`));
    });
  });
}

function parseJson(text: string): { parsed: boolean; value: unknown } {
  if (!text.trim()) {
    return { parsed: true, value: null };
  }
  try {
    return { parsed: true, value: JSON.parse(text) };
  } catch {
    return { parsed: false, value: text };
  }
}

function parseFlags(args: string[]): Record<string, string | undefined> {
  const flags: Record<string, string | undefined> = {};
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token?.startsWith("--")) {
      continue;
    }
    const name = token.slice(2);
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      flags[name] = "true";
      continue;
    }
    flags[name] = value;
    index += 1;
  }
  return flags;
}

function extractGlobalFlags(args: string[]): CommandContext {
  const remaining: string[] = [];
  let daemonUrl = process.env.RETINUE_DAEMON_URL;
  let daemonToken = process.env.RETINUE_DAEMON_TOKEN;
  let discoverDaemon = process.env.RETINUE_DAEMON_DISCOVERY === "1";

  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--daemon-url") {
      daemonUrl = required(args[index + 1], "--daemon-url");
      index += 1;
      continue;
    }
    if (args[index] === "--daemon-token") {
      daemonToken = required(args[index + 1], "--daemon-token");
      index += 1;
      continue;
    }
    if (args[index] === "--discover-daemon") {
      discoverDaemon = true;
      continue;
    }
    remaining.push(args[index]);
  }

  return { args: remaining, daemonUrl, daemonToken, discoverDaemon };
}

async function discoverDaemon(): Promise<DaemonDiscovery> {
  const stateDir = resolveStateDir({
    explicitStateDir: process.env.RETINUE_STATE_DIR,
    env: process.env
  });
  return readDaemonDiscovery(stateDir);
}

function booleanFlag(flags: Record<string, string | undefined>, name: string, defaultValue: boolean): boolean {
  const value = flags[name];
  if (value === undefined) {
    return defaultValue;
  }
  return value === "true" || value === "1";
}

function required(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(`Missing required ${name}`);
  }
  return value;
}

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function isFailureResult(value: unknown): boolean {
  return typeof value === "object" && value !== null && "ok" in value && (value as { ok?: boolean }).ok === false;
}

function helpText(): string {
  return `Usage: retinue <group> <command> [options]

Groups:
  daemon health                 Check a Retinue daemon by explicit URL or discovery.
  diagnostics audit-logs        Audit Retinue logs in compact form by default.
  mcp tools                     Print the default MCP product tool surface.
  plugin sync-cache             Sync the packaged Retinue plugin cache.
  runtime stop                  Stop Retinue-managed local runtime servers.
  runtime restart               Restart a Retinue-managed local runtime server.

Legacy flat commands such as run, wait, result, and opencode-run were removed from the default CLI.
`;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
