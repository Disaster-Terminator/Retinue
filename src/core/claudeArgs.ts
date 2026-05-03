import type { RunOptions } from "./types.js";

export function buildClaudeArgs(options: RunOptions): string[] {
  const args = ["-p", "--output-format", "json"];

  if (options.resume) {
    args.push("--resume", options.resume);
  }

  if (options.maxTurns !== undefined) {
    args.push("--max-turns", String(options.maxTurns));
  }

  if (options.permissionMode) {
    args.push("--permission-mode", options.permissionMode);
  }

  return args;
}
