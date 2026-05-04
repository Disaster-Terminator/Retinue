#!/usr/bin/env node

import { ClaudeSupervisor } from "./core/supervisor.js";
import { DaemonClient } from "./daemon/client.js";
import type {
  JobResult,
  JobStatusResult,
  KillResult,
} from "./core/types.js";

interface CliSupervisor {
  run: ClaudeSupervisor["run"];
  status: (jobId: string) => Promise<JobStatusResult>;
  wait: ClaudeSupervisor["wait"];
  result: (jobId: string) => Promise<JobResult>;
  continueJob: ClaudeSupervisor["continueJob"];
  peek: ClaudeSupervisor["peek"];
  kill: (jobId: string) => Promise<KillResult>;
  cleanup: ClaudeSupervisor["cleanup"];
}

async function main(): Promise<void> {
  const global = extractGlobalFlags(process.argv.slice(2));
  const [command, ...args] = global.args;
  const supervisor = createSupervisorFromEnv(global.daemonUrl);

  switch (command) {
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

function extractGlobalFlags(args: string[]): { args: string[]; daemonUrl?: string } {
  const remaining: string[] = [];
  let daemonUrl = process.env.SUPERVISOR_DAEMON_URL;

  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--daemon-url") {
      daemonUrl = args[index + 1];
      index += 1;
      continue;
    }
    remaining.push(args[index]);
  }

  return { args: remaining, daemonUrl };
}

function createSupervisorFromEnv(daemonUrl: string | undefined): CliSupervisor {
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

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
