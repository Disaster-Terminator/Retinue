#!/usr/bin/env node

import { ClaudeSupervisor } from "./core/supervisor.js";

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  const supervisor = new ClaudeSupervisor({
    stateDir: process.env.SUPERVISOR_STATE_DIR,
    claudeCommand: process.env.SUPERVISOR_CLAUDE_COMMAND,
    claudePrefixArgs: parsePrefixArgs(process.env.SUPERVISOR_CLAUDE_PREFIX_ARGS),
    env: process.env
  });

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
          permissionMode: flags["permission-mode"] as never
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

