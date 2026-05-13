#!/usr/bin/env node
import { chmodSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const hooksDir = ".githooks";

if (!existsSync(hooksDir)) {
  console.error(`Missing ${hooksDir}. Run this command from the Retinue repository root.`);
  process.exit(1);
}

const git = spawnSync("git", ["config", "core.hooksPath", hooksDir], {
  stdio: "inherit"
});

if (git.status !== 0) {
  process.exit(git.status ?? 1);
}

for (const entry of readdirSync(hooksDir)) {
  const hookPath = join(hooksDir, entry);
  try {
    chmodSync(hookPath, 0o755);
  } catch {
    // Git for Windows can still run hooks through sh even when chmod is not meaningful.
  }
}

console.log(`Retinue git hooks installed: core.hooksPath=${hooksDir}`);
