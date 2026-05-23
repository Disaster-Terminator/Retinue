#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const pluginDir = path.dirname(fileURLToPath(import.meta.url));
const runtimePath = path.join(pluginDir, "dist", "mcp.js");
loadCodexEnvOverrides();
process.env.RETINUE_CONFIG_FILE ||= path.join(pluginDir, "retinue.config.json");
const stateRoot =
  process.env.RETINUE_STATE_DIR?.trim() || path.join(os.homedir(), ".retinue");
const runCwd = path.join(stateRoot, "mcp-cwd");

mkdirSync(runCwd, { recursive: true });
process.chdir(runCwd);

process.argv[1] = runtimePath;
await import(pathToFileURL(runtimePath).href);

function loadCodexEnvOverrides() {
  const configPath = path.join(process.env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex"), "config.toml");
  if (!existsSync(configPath)) {
    return;
  }
  const config = readFileSync(configPath, "utf8");
  let inEnv = false;
  for (const rawLine of config.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    if (line.startsWith("[") && line.endsWith("]")) {
      inEnv = line === "[env]";
      continue;
    }
    if (!inEnv) {
      continue;
    }
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"(.*)"\s*$/.exec(line);
    if (!match || !match[1].startsWith("RETINUE_")) {
      continue;
    }
    process.env[match[1]] ||= match[2];
  }
}
