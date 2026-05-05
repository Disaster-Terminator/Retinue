const VALID_MODES = new Set(["direct", "daemon", "mcp-daemon"]);
const DEFAULT_PROMPT = "Reply exactly: SUPERVISOR_REAL_OK";
const DEFAULT_EXPECTED = "SUPERVISOR_REAL_OK";
const DEFAULT_TIMEOUT_MS = 90000;
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 0;

export interface RealClaudeProbeOptions {
  mode: "direct" | "daemon" | "mcp-daemon";
  cwd: string;
  prompt: string;
  expected: string;
  timeoutMs: number;
  host: string;
  port: number;
  stateDir?: string;
}

export function parseProbeArgs(argv: string[]): RealClaudeProbeOptions {
  let mode = "direct";
  let index = 0;
  if (argv[0] && !argv[0].startsWith("--")) {
    mode = argv[0];
    index = 1;
  }
  if (!VALID_MODES.has(mode)) {
    throw new Error(`Unknown probe mode: ${mode}`);
  }

  const options: RealClaudeProbeOptions = {
    mode: mode as RealClaudeProbeOptions["mode"],
    cwd: process.cwd(),
    prompt: DEFAULT_PROMPT,
    expected: DEFAULT_EXPECTED,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    host: DEFAULT_HOST,
    port: DEFAULT_PORT,
    stateDir: undefined
  };

  while (index < argv.length) {
    const flag = argv[index];
    const value = argv[index + 1];
    switch (flag) {
      case "--cwd":
        options.cwd = requiredFlagValue(flag, value);
        index += 2;
        break;
      case "--prompt":
        options.prompt = requiredFlagValue(flag, value);
        index += 2;
        break;
      case "--expect":
        options.expected = requiredFlagValue(flag, value);
        index += 2;
        break;
      case "--timeout-ms":
        options.timeoutMs = parsePositiveInteger(requiredFlagValue(flag, value), flag);
        index += 2;
        break;
      case "--host":
        options.host = requiredFlagValue(flag, value);
        index += 2;
        break;
      case "--port":
        options.port = parsePort(requiredFlagValue(flag, value), flag);
        index += 2;
        break;
      case "--state-dir":
        options.stateDir = requiredFlagValue(flag, value);
        index += 2;
        break;
      default:
        throw new Error(`Unknown option: ${String(flag)}`);
    }
  }

  return options;
}

export function readJsonOutput(stdout: string): Record<string, unknown> {
  const candidates = [stdout.trim()];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed) {
      candidates.push(trimmed);
    }
  }

  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start >= 0 && end > start) {
    candidates.push(stdout.slice(start, end + 1));
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Try the next candidate.
    }
  }

  throw new Error(`Command stdout did not contain a JSON object: ${stdout.slice(0, 500)}`);
}

export function assertExpectedResult(result: any, expected: string): string {
  if (result?.status !== "completed") {
    throw new Error(`Expected completed job, got ${String(result?.status)}`);
  }
  const exitCode = result?.exitCode ?? result?.exitStatus?.exitCode;
  if (exitCode !== 0) {
    throw new Error(`Expected exitCode 0, got ${String(exitCode)}`);
  }
  const actual = result?.parsedStdout?.result;
  if (actual !== expected) {
    throw new Error(`Expected Claude result ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
  return actual;
}

function requiredFlagValue(flag: string, value: string | undefined): string {
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

function parsePositiveInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}

function parsePort(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
    throw new Error(`${flag} must be a port between 0 and 65535`);
  }
  return parsed;
}
