#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import * as esbuild from "esbuild";

const rootDist = path.resolve("dist");
const pluginRoot = path.resolve("plugins/retinue");
const pluginDist = path.resolve("plugins/retinue/dist");
const pluginDistLock = path.resolve("plugins/retinue/.dist-sync.lock");
const stagingDist = path.resolve("plugins/retinue", `.dist-${process.pid}-${Date.now()}-${randomUUID()}`);

await fs.mkdir(pluginRoot, { recursive: true });
try {
  await fs.cp(rootDist, stagingDist, { recursive: true });
  await esbuild.build({
    entryPoints: [path.resolve("src/mcp.ts")],
    outfile: path.join(stagingDist, "mcp.js"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    sourcemap: true
  });

  await withDirectoryLock(pluginDistLock, async () => {
    await fs.rm(pluginDist, { recursive: true, force: true });
    await fs.rename(stagingDist, pluginDist);
  });
} finally {
  await fs.rm(stagingDist, { recursive: true, force: true });
}

process.stdout.write(`Synced plugin runtime to ${path.relative(process.cwd(), pluginDist)}\n`);

async function withDirectoryLock(lockDir, callback) {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      await fs.mkdir(lockDir);
      break;
    } catch (error) {
      if (!isFileExistsError(error)) {
        throw error;
      }
      await removeStaleLock(lockDir);
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for plugin runtime sync lock at ${lockDir}`);
      }
      await sleep(25);
    }
  }
  try {
    await callback();
  } finally {
    await fs.rm(lockDir, { recursive: true, force: true });
  }
}

async function removeStaleLock(lockDir) {
  try {
    const stat = await fs.stat(lockDir);
    if (Date.now() - stat.mtimeMs > 30_000) {
      await fs.rm(lockDir, { recursive: true, force: true });
    }
  } catch {
    // Best-effort stale lock cleanup only.
  }
}

function isFileExistsError(error) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
