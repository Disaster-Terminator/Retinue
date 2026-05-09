#!/usr/bin/env node

import { ClaudeSupervisor } from "./core/supervisor.js";
import { DaemonClient } from "./daemon/client.js";
import { readDaemonDiscovery } from "./daemon/discovery.js";
import { resolveStateDir } from "./core/paths.js";
import { OpenCodeBackend } from "./backends/opencode/backend.js";
import { OpenCodeClient } from "./backends/opencode/client.js";
import { ensureOpenCodeServer, resolveOpenCodeServerFromEnv } from "./backends/opencode/serverManager.js";
import type { SupervisorApi } from "./core/types.js";

async function main(): Promise<void> {
  const global = extractGlobalFlags(process.argv.slice(2));
  const [command, ...args] = global.args;

  if (command === "daemon-health") {
    const health = await daemonHealth(global);
    writeJson(health);
    if (isFailureResult(health)) {
      process.exitCode = 1;
    }
    return;
  }

  const supervisor = await createSupervisorFromEnv(global);

  switch (command) {
    case "opencode-run": {
      const flags = parseFlags(args);
      const backend = await createOpenCodeBackend(flags);
      writeJson(
        await backend.run({
          cwd: required(flags.cwd, "--cwd"),
          prompt: required(flags.prompt, "--prompt"),
          name: flags.name,
          title: flags.title,
          model: resolveOpenCodeModel(flags),
          agent: resolveOpenCodeAgent(flags)
        })
      );
      return;
    }
    case "opencode-status": {
      writeJson(await (await createOpenCodeBackend(parseFlags(args))).status({ jobId: required(args[0], "jobId") }));
      return;
    }
    case "opencode-wait": {
      const [jobId, ...rest] = args;
      const flags = parseFlags(rest);
      const backend = await createOpenCodeBackend(flags);
      const waited = await backend.wait({ jobId: required(jobId, "jobId") }, flags["timeout-ms"] ? Number(flags["timeout-ms"]) : undefined);
      writeJson(waited);
      return;
    }
    case "opencode-result": {
      writeJson(await (await createOpenCodeBackend(parseFlags(args.slice(1)))).result({ jobId: required(args[0], "jobId") }));
      return;
    }
    case "opencode-continue": {
      const flags = parseFlags(args);
      const backend = await createOpenCodeBackend(flags);
      writeJson(
        await backend.continueJob({
          cwd: required(flags.cwd, "--cwd"),
          prompt: required(flags.prompt, "--prompt"),
          externalSessionId: required(flags["external-session-id"], "--external-session-id"),
          parentJobId: flags["job-id"],
          parentSessionId: flags["external-session-id"],
          name: flags.name,
          title: flags.title,
          model: resolveOpenCodeModel(flags),
          agent: resolveOpenCodeAgent(flags)
        })
      );
      return;
    }
    case "opencode-kill": {
      const [jobId, ...rest] = args;
      const backend = await createOpenCodeBackend(parseFlags(rest));
      await backend.abort({ jobId: required(jobId, "jobId") });
      writeJson({ jobId, status: "killed" });
      return;
    }
    case "opencode-cleanup": {
      const flags = parseFlags(args);
      writeJson(
        await (await createOpenCodeBackend(flags)).cleanup({
          olderThanMs: flags["older-than-ms"] ? Number(flags["older-than-ms"]) : undefined
        })
      );
      return;
    }
    case "run": {
      const flags = parseFlags(args);
      const cwd = required(flags.cwd, "--cwd");
      const prompt = required(flags.prompt, "--prompt");
      writeJson(
        await supervisor.run({
          cwd,
          prompt,
          name: flags.name,
          resume: flags.resume,
          maxTurns: flags["max-turns"] ? Number(flags["max-turns"]) : undefined,
          permissionMode: flags["permission-mode"] as never,
          timeoutMs: flags["timeout-ms"] ? Number(flags["timeout-ms"]) : undefined
        })
      );
      return;
    }
    case "status": {
      writeJson(await supervisor.status(required(args[0], "jobId")));
      return;
    }
    case "wait": {
      const [jobId, ...rest] = args;
      const flags = parseFlags(rest);
      writeJson(
        await supervisor.wait(required(jobId, "jobId"), {
          timeoutMs: flags["timeout-ms"] ? Number(flags["timeout-ms"]) : undefined
        })
      );
      return;
    }
    case "result": {
      writeJson(await supervisor.result(required(args[0], "jobId")));
      return;
    }
    case "continue": {
      const flags = parseFlags(args);
      writeJson(
        await supervisor.continueJob({
          cwd: required(flags.cwd, "--cwd"),
          prompt: required(flags.prompt, "--prompt"),
          jobId: flags["job-id"],
          sessionId: flags["session-id"],
          name: flags.name,
          maxTurns: flags["max-turns"] ? Number(flags["max-turns"]) : undefined,
          permissionMode: flags["permission-mode"] as never,
          timeoutMs: flags["timeout-ms"] ? Number(flags["timeout-ms"]) : undefined
        })
      );
      return;
    }
    case "peek": {
      const [jobId, ...rest] = args;
      const flags = parseFlags(rest);
      writeJson(
        await supervisor.peek(required(jobId, "jobId"), {
          stdoutTailBytes: flags["stdout-tail-bytes"] ? Number(flags["stdout-tail-bytes"]) : undefined,
          stderrTailBytes: flags["stderr-tail-bytes"] ? Number(flags["stderr-tail-bytes"]) : undefined
        })
      );
      return;
    }
    case "kill": {
      writeJson(await supervisor.kill(required(args[0], "jobId")));
      return;
    }
    case "cleanup": {
      const flags = parseFlags(args);
      writeJson(
        await supervisor.cleanup({
          olderThanMs: flags["older-than-ms"] ? Number(flags["older-than-ms"]) : undefined
        })
      );
      return;
    }
    default:
      throw new Error(`Unknown command: ${command ?? "(missing)"}`);
  }
}

async function createOpenCodeBackend(flags: Record<string, string | undefined>): Promise<OpenCodeBackend> {
  const env = {
    ...process.env,
    SUPERVISOR_OPENCODE_BASE_URL: flags["opencode-base-url"] ?? process.env.SUPERVISOR_OPENCODE_BASE_URL
  };
  const resolution = resolveOpenCodeServerFromEnv(env);
  const stateDir = resolveStateDir({ explicitStateDir: process.env.SUPERVISOR_STATE_DIR, env: process.env });
  return new OpenCodeBackend({
    target: async (cwd) => {
      const target = await ensureOpenCodeServer(resolution, { stateDir, cwd });
      return { client: new OpenCodeClient(target.baseUrl), baseUrl: target.baseUrl };
    },
    stateDir,
    env: process.env
  });
}

function resolveOpenCodeModel(flags: Record<string, string | undefined>): string | undefined {
  return flags.model ?? process.env.SUPERVISOR_OPENCODE_MODEL;
}

function resolveOpenCodeAgent(flags: Record<string, string | undefined>): string | undefined {
  return flags.agent ?? process.env.SUPERVISOR_OPENCODE_AGENT;
}

async function daemonHealth(global: { daemonUrl?: string; discoverDaemon: boolean }): Promise<unknown> {
  const source = global.daemonUrl ? "explicit_url" : global.discoverDaemon ? "discovery" : "none";
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

  let daemonUrl = global.daemonUrl;
  if (!daemonUrl) {
    try {
      daemonUrl = await discoverDaemonUrl();
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

  return readDaemonHealth(daemonUrl, source);
}

async function readDaemonHealth(daemonUrl: string, source: "explicit_url" | "discovery"): Promise<unknown> {
  const normalizedUrl = daemonUrl.replace(/\/+$/, "");
  try {
    const response = await fetch(`${normalizedUrl}/health`);
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
    flags[token.slice(2)] = args[index + 1];
    index += 1;
  }
  return flags;
}

function extractGlobalFlags(args: string[]): { args: string[]; daemonUrl?: string; discoverDaemon: boolean } {
  const remaining: string[] = [];
  let daemonUrl = process.env.SUPERVISOR_DAEMON_URL;
  let discoverDaemon = process.env.SUPERVISOR_DAEMON_DISCOVERY === "1";

  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--daemon-url") {
      daemonUrl = args[index + 1];
      index += 1;
      continue;
    }
    if (args[index] === "--discover-daemon") {
      discoverDaemon = true;
      continue;
    }
    remaining.push(args[index]);
  }

  return { args: remaining, daemonUrl, discoverDaemon };
}

async function createSupervisorFromEnv(global: { daemonUrl?: string; discoverDaemon: boolean }): Promise<SupervisorApi> {
  const daemonUrl = global.daemonUrl ?? (global.discoverDaemon ? await discoverDaemonUrl() : undefined);
  if (daemonUrl) {
    return new DaemonClient(daemonUrl);
  }

  return new ClaudeSupervisor({
    stateDir: process.env.SUPERVISOR_STATE_DIR,
    claudeCommand: process.env.SUPERVISOR_CLAUDE_COMMAND,
    claudePrefixArgs: parsePrefixArgs(process.env.SUPERVISOR_CLAUDE_PREFIX_ARGS),
    env: process.env,
    defaultRuntimeTimeoutMs: parseOptionalNumber(process.env.SUPERVISOR_DEFAULT_RUNTIME_TIMEOUT_MS),
    maxConcurrentJobs: parseOptionalNumber(process.env.SUPERVISOR_MAX_CONCURRENT_JOBS)
  });
}

async function discoverDaemonUrl(): Promise<string> {
  const stateDir = resolveStateDir({
    explicitStateDir: process.env.SUPERVISOR_STATE_DIR,
    env: process.env
  });
  return (await readDaemonDiscovery(stateDir)).url;
}

function parsePrefixArgs(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  const trimmed = value.trim();
  if (trimmed.startsWith("[")) {
    return JSON.parse(trimmed) as string[];
  }
  return [value];
}

function parseOptionalNumber(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
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

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
