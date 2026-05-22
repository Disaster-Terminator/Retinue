#!/usr/bin/env node

import {
  DEFAULT_LOG_AUDIT_MAX_BYTES,
  DEFAULT_LOG_AUDIT_MAX_LINES,
  auditRetinueLogs,
  type AuditRetinueLogsOptions
} from "../core/logAudit.js";

export async function main(args = process.argv.slice(2), env = process.env): Promise<void> {
  const options = parseArgs(args);
  const result = await auditRetinueLogs({
    stateDir: options.stateDir ?? env.RETINUE_STATE_DIR,
    tracePath: options.tracePath,
    since: options.since,
    maxBytes: options.maxBytes,
    maxLines: options.maxLines
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

interface CliOptions extends AuditRetinueLogsOptions {}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    maxBytes: DEFAULT_LOG_AUDIT_MAX_BYTES,
    maxLines: DEFAULT_LOG_AUDIT_MAX_LINES
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = () => {
      const value = args[index + 1];
      if (!value) {
        throw new Error(`${arg} requires a value`);
      }
      index += 1;
      return value;
    };
    if (arg === "--state-dir") {
      options.stateDir = next();
    } else if (arg === "--trace") {
      options.tracePath = next();
    } else if (arg === "--since") {
      const since = new Date(next());
      if (Number.isNaN(since.getTime())) {
        throw new Error("--since must be an ISO timestamp");
      }
      options.since = since;
    } else if (arg === "--max-lines") {
      options.maxLines = parsePositiveInt(next(), "--max-lines");
    } else if (arg === "--max-bytes") {
      options.maxBytes = parsePositiveInt(next(), "--max-bytes");
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write(helpText());
      process.exit(0);
    } else if (arg === "--") {
      continue;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function parsePositiveInt(value: string, label: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function helpText(): string {
  return `Usage: retinue-audit-logs [options]\n\nOptions:\n  --state-dir <dir>    Retinue state directory. Defaults to RETINUE_STATE_DIR or ~/.local/state/retinue.\n  --trace <file>       Explicit Retinue trace JSONL path.\n  --since <iso>        Only include events at or after this timestamp.\n  --max-lines <n>      Maximum recent JSONL lines to inspect. Default: ${DEFAULT_LOG_AUDIT_MAX_LINES}.\n  --max-bytes <n>      Maximum bytes to read from the tail. Default: ${DEFAULT_LOG_AUDIT_MAX_BYTES}.\n`;
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
