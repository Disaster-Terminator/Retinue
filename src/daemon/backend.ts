export type DaemonBackend = "claude-code" | "opencode";

export const DEFAULT_DAEMON_BACKEND: DaemonBackend = "claude-code";

export function parseDaemonBackend(value: unknown): DaemonBackend {
  if (value === undefined) {
    return DEFAULT_DAEMON_BACKEND;
  }
  if (value === "claude-code" || value === "opencode") {
    return value;
  }
  throw new Error(`Unsupported backend: ${String(value)}`);
}
