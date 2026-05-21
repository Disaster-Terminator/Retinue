#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const DEFAULT_MAX_BYTES = 1024 * 1024;
const DEFAULT_MAX_LINES = 500;

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const stateDir = options.stateDir ?? process.env.RETINUE_STATE_DIR ?? path.join(os.homedir(), ".local/state/retinue");
  const tracePath = options.tracePath ?? path.join(stateDir, "logs", "retinue.jsonl");
  const events = await readRecentJsonl(tracePath, {
    maxBytes: options.maxBytes,
    maxLines: options.maxLines,
    since: options.since
  });
  const issues = summarizeIssues(events);
  const output = {
    ok: true,
    tracePath,
    since: options.since?.toISOString(),
    scannedEvents: events.length,
    issueCount: issues.length,
    issues
  };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

function parseArgs(args) {
  const options = {
    maxBytes: DEFAULT_MAX_BYTES,
    maxLines: DEFAULT_MAX_LINES
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

function parsePositiveInt(value, label) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

async function readRecentJsonl(filePath, options) {
  const text = await readTail(filePath, options.maxBytes);
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-options.maxLines);
  const events = [];
  for (const line of lines) {
    try {
      const event = JSON.parse(line);
      const timestamp = eventTime(event);
      if (options.since && timestamp && timestamp < options.since) {
        continue;
      }
      events.push(event);
    } catch {
      // Ignore partial or malformed tail lines.
    }
  }
  return events;
}

async function readTail(filePath, maxBytes) {
  const handle = await fs.open(filePath, "r");
  try {
    const stats = await handle.stat();
    const length = Math.min(stats.size, maxBytes);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, stats.size - length);
    return buffer.toString("utf8").replace(/^\uFFFD+/, "");
  } finally {
    await handle.close();
  }
}

function summarizeIssues(events) {
  const issuesBySignature = new Map();
  for (const event of events) {
    const diagnostic = isRecord(event.diagnostic) ? event.diagnostic : undefined;
    if (!diagnostic) {
      continue;
    }
    const status = event.event === "opencode_job_stalled" || diagnostic.stallReason ? "stalled" : undefined;
    if (status !== "stalled") {
      continue;
    }
    const signature = [
      diagnostic.stallReason ?? "unknown_stall",
      diagnostic.lastAssistantProviderID ?? "unknown_provider",
      diagnostic.lastAssistantModelID ?? "unknown_model",
      diagnostic.lastAssistantAgent ?? "unknown_agent",
      diagnostic.lastAssistantMode ?? "unknown_mode"
    ].join("|");
    const current = issuesBySignature.get(signature) ?? {
      signature,
      title: createIssueTitle(diagnostic),
      description: createIssueDescription(diagnostic),
      count: 0,
      firstSeen: undefined,
      lastSeen: undefined,
      jobIds: [],
      sample: undefined
    };
    current.count += 1;
    const timestamp = eventTime(event)?.toISOString();
    current.firstSeen = earlier(current.firstSeen, timestamp);
    current.lastSeen = later(current.lastSeen, timestamp);
    if (typeof event.jobId === "string" && !current.jobIds.includes(event.jobId)) {
      current.jobIds.push(event.jobId);
    }
    current.sample ??= compact({
      jobId: event.jobId,
      event: event.event,
      sessionId: diagnostic.sessionId,
      parentSessionId: diagnostic.parentSessionId,
      childSessionIds: diagnostic.childSessionIds,
      sessionDirectory: diagnostic.sessionDirectory,
      stallReason: diagnostic.stallReason,
      stallSummary: diagnostic.stallSummary,
      noCompletedAssistantDurationMs: diagnostic.noCompletedAssistantDurationMs,
      toolCallAssistantRounds: diagnostic.toolCallAssistantRounds,
      blankAssistantRounds: diagnostic.blankAssistantRounds,
      runningReadToolParts: diagnostic.runningReadToolParts,
      malformedReadToolParts: diagnostic.malformedReadToolParts,
      runningReadToolPartSummaries: diagnostic.runningReadToolPartSummaries,
      readOnlyWriteIntent: diagnostic.readOnlyWriteIntent
    });
    issuesBySignature.set(signature, current);
  }
  return [...issuesBySignature.values()].sort((left, right) => right.count - left.count || String(right.lastSeen).localeCompare(String(left.lastSeen)));
}

function createIssueTitle(diagnostic) {
  const reason = diagnostic.stallReason ?? "unknown_stall";
  const provider = diagnostic.lastAssistantProviderID ?? "unknown_provider";
  const model = diagnostic.lastAssistantModelID ?? "unknown_model";
  return `Investigate Retinue ${reason} on ${provider}/${model}`;
}

function createIssueDescription(diagnostic) {
  const parts = [
    diagnostic.stallSummary,
    diagnostic.sessionDirectory ? `cwd=${diagnostic.sessionDirectory}` : undefined,
    diagnostic.lastAssistantAgent ? `agent=${diagnostic.lastAssistantAgent}` : undefined,
    diagnostic.lastAssistantMode ? `mode=${diagnostic.lastAssistantMode}` : undefined,
    Number.isFinite(diagnostic.noCompletedAssistantDurationMs) ? `durationMs=${diagnostic.noCompletedAssistantDurationMs}` : undefined
  ].filter(Boolean);
  return parts.join("; ");
}

function eventTime(event) {
  const raw = typeof event.time === "string" ? event.time : typeof event.timestamp === "string" ? event.timestamp : undefined;
  if (!raw) {
    return undefined;
  }
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function earlier(left, right) {
  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }
  return left < right ? left : right;
}

function later(left, right) {
  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }
  return left > right ? left : right;
}

function compact(record) {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

function isRecord(value) {
  return typeof value === "object" && value !== null;
}

function helpText() {
  return `Usage: node scripts/audit-retinue-logs.mjs [options]\n\nOptions:\n  --state-dir <dir>    Retinue state directory. Defaults to RETINUE_STATE_DIR or ~/.local/state/retinue.\n  --trace <file>       Explicit Retinue trace JSONL path.\n  --since <iso>        Only include events at or after this timestamp.\n  --max-lines <n>      Maximum recent JSONL lines to inspect. Default: ${DEFAULT_MAX_LINES}.\n  --max-bytes <n>      Maximum bytes to read from the tail. Default: ${DEFAULT_MAX_BYTES}.\n`;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
