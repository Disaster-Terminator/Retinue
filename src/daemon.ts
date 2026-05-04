#!/usr/bin/env node

import { createDaemonServer } from "./daemon/server.js";
import { ClaudeSupervisor } from "./core/supervisor.js";

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const host = flags.host ?? process.env.SUPERVISOR_DAEMON_HOST ?? "127.0.0.1";
  const port = flags.port ? Number(flags.port) : Number(process.env.SUPERVISOR_DAEMON_PORT ?? "27777");
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid --port: ${String(flags.port ?? process.env.SUPERVISOR_DAEMON_PORT)}`);
  }

  const server = createDaemonServer(createSupervisorFromEnv());
  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  process.stdout.write(`${JSON.stringify({ status: "listening", host, port: actualPort })}\n`);
}

function createSupervisorFromEnv(): ClaudeSupervisor {
  return new ClaudeSupervisor({
    stateDir: process.env.SUPERVISOR_STATE_DIR,
    claudeCommand: process.env.SUPERVISOR_CLAUDE_COMMAND,
    claudePrefixArgs: parsePrefixArgs(process.env.SUPERVISOR_CLAUDE_PREFIX_ARGS),
    env: process.env,
    defaultRuntimeTimeoutMs: parseOptionalNumber(process.env.SUPERVISOR_DEFAULT_RUNTIME_TIMEOUT_MS),
    maxConcurrentJobs: parseOptionalNumber(process.env.SUPERVISOR_MAX_CONCURRENT_JOBS)
  });
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

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
