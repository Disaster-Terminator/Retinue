#!/usr/bin/env node
import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const pluginDir = path.dirname(fileURLToPath(import.meta.url));
const runtimePath = path.join(pluginDir, "dist", "mcp.js");
process.env.RETINUE_CONFIG_FILE ||= path.join(pluginDir, "retinue.config.json");
const stateRoot =
  process.env.RETINUE_STATE_DIR?.trim() || path.join(os.homedir(), ".retinue");
const runCwd = path.join(stateRoot, "mcp-cwd");

mkdirSync(runCwd, { recursive: true });
process.chdir(runCwd);

process.argv[1] = runtimePath;
await import(pathToFileURL(runtimePath).href);
