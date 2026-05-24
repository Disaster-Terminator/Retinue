#!/usr/bin/env node

import { execFile } from "node:child_process";

const REAL_PROBE_ENV = "RETINUE_BACKEND_CANDIDATE_REAL_PROBE";
const DEFAULT_PROMPT = "Reply exactly: RETINUE_BACKEND_CANDIDATE_OK";
const DEFAULT_TIMEOUT_MS = 30_000;

const CANDIDATES = {
  kilo: {
    envPrefix: "RETINUE_KILO",
    defaultCommand: "kilo",
    defaultModel: "litellm/intentmux",
    serverCommand: "serve",
    surfaceCommands: [
      { name: "version", args: ["--version"] },
      { name: "topHelp", args: ["--help"] },
      { name: "runHelp", args: ["run", "--help"] },
      { name: "serveHelp", args: ["serve", "--help"] },
      { name: "sessionHelp", args: ["session", "--help"] },
      { name: "exportHelp", args: ["export", "--help"] }
    ],
    buildRunArgs({ cwd, model, prompt }) {
      return ["run", "--auto", "--format", "json", "--model", model, "--dir", cwd, prompt];
    }
  },
  crush: {
    envPrefix: "RETINUE_CRUSH",
    defaultCommand: "crush",
    defaultModel: "intentmux",
    serverCommand: "server",
    surfaceCommands: [
      { name: "version", args: ["--version"] },
      { name: "topHelp", args: ["--help"] },
      { name: "runHelp", args: ["run", "--help"] },
      { name: "serverHelp", args: ["server", "--help"] },
      { name: "sessionHelp", args: ["session", "--help"] }
    ],
    buildRunArgs({ cwd, model, prompt }) {
      return ["--cwd", cwd, "--yolo", "run", "--model", model, "--quiet", prompt];
    }
  }
};

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.realRun) {
    requireRealProbeOptIn();
  }

  const selected = options.candidate === "all" ? Object.keys(CANDIDATES) : [options.candidate];
  const output = {
    ok: true,
    manualOnly: true,
    realRun: options.realRun,
    model: options.model ?? (selected.length === 1 ? CANDIDATES[selected[0]].defaultModel : undefined),
    cwd: options.cwd,
    startedAt: new Date().toISOString(),
    candidates: {}
  };

  for (const name of selected) {
    output.candidates[name] = await probeCandidate(name, CANDIDATES[name], options);
  }

  output.finishedAt = new Date().toISOString();
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

async function probeCandidate(name, candidate, options) {
  const command = process.env[`${candidate.envPrefix}_COMMAND`] || candidate.defaultCommand;
  const prefixArgs = parsePrefixArgs(process.env[`${candidate.envPrefix}_PREFIX_ARGS`]) ?? [];
  const result = {
    name,
    command,
    prefixArgs,
    serverCommand: candidate.serverCommand,
    operations: {}
  };

  for (const operation of candidate.surfaceCommands) {
    result.operations[operation.name] = await execCandidate(command, prefixArgs, operation.args, options.timeoutMs);
  }

  result.available = Object.values(result.operations).some((operation) => operation.ok);
  result.contractHints = summarizeContractHints(result.operations);

  if (options.realRun) {
    const args = candidate.buildRunArgs({ ...options, model: options.model ?? candidate.defaultModel });
    result.operations.realRun = await execCandidate(command, prefixArgs, args, options.timeoutMs);
  }

  return result;
}

function summarizeContractHints(operations) {
  const text = Object.values(operations)
    .map((operation) => `${operation.stdout}\n${operation.stderr}`)
    .join("\n")
    .toLowerCase();
  return {
    hasRun: text.includes(" run") || text.includes("run "),
    hasServer: text.includes(" serve") || text.includes("server"),
    hasSession: text.includes("session"),
    mentionsPermission: text.includes("permission"),
    mentionsMcp: text.includes("mcp"),
    mentionsJson: text.includes("json")
  };
}

function execCandidate(command, prefixArgs, args, timeoutMs) {
  const fullArgs = [...prefixArgs, ...args];
  return new Promise((resolve) => {
    execFile(command, fullArgs, { timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        command,
        args,
        exitCode: typeof error?.code === "number" ? error.code : error ? 1 : 0,
        signal: typeof error?.signal === "string" ? error.signal : undefined,
        timedOut: Boolean(error?.killed || error?.signal === "SIGTERM"),
        error: error ? error.message.split("\n")[0] : undefined,
        stdout: truncate(stdout),
        stderr: truncate(stderr)
      });
    });
  });
}

function parseArgs(argv) {
  const out = {
    candidate: "all",
    realRun: false,
    cwd: process.cwd(),
    model: process.env.RETINUE_BACKEND_CANDIDATE_MODEL,
    prompt: DEFAULT_PROMPT,
    timeoutMs: DEFAULT_TIMEOUT_MS
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--") {
      continue;
    }
    if (token === "--candidate" && i + 1 < argv.length) {
      out.candidate = parseCandidate(argv[++i]);
      continue;
    }
    if (token === "--real-run") {
      out.realRun = true;
      continue;
    }
    if (token === "--cwd" && i + 1 < argv.length) {
      out.cwd = argv[++i];
      continue;
    }
    if (token === "--model" && i + 1 < argv.length) {
      out.model = argv[++i];
      continue;
    }
    if (token === "--prompt" && i + 1 < argv.length) {
      out.prompt = argv[++i];
      continue;
    }
    if (token === "--timeout-ms" && i + 1 < argv.length) {
      out.timeoutMs = parsePositiveInt(argv[++i], "--timeout-ms");
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }

  return out;
}

function parseCandidate(value) {
  if (value === "all" || value === "kilo" || value === "crush") {
    return value;
  }
  throw new Error(`Unsupported candidate: ${value}`);
}

function parsePositiveInt(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function parsePrefixArgs(value) {
  if (!value?.trim()) {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed);
    if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) {
      throw new Error("Prefix args JSON must be an array of strings");
    }
    return parsed;
  }
  return [trimmed];
}

function requireRealProbeOptIn() {
  if (process.env[REAL_PROBE_ENV] !== "1") {
    throw new Error(`Real backend candidate probe blocked. Set ${REAL_PROBE_ENV}=1 to run model-backed commands.`);
  }
}

function truncate(value) {
  const text = String(value ?? "");
  const max = 12_000;
  return text.length > max ? `${text.slice(0, max)}\n[truncated ${text.length - max} chars]` : text;
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`);
  process.exitCode = 1;
});
