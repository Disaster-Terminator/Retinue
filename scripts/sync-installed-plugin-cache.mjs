#!/usr/bin/env node

import { cp, mkdir, readdir, readFile, rename, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const DEFAULT_PLUGIN_DIR = path.resolve("plugins/retinue");
const execFileAsync = promisify(execFile);

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const sourceDir = path.resolve(options.sourceDir ?? DEFAULT_PLUGIN_DIR);
  const manifest = await readManifest(sourceDir);
  const pluginName = options.pluginName ?? manifest.name;
  const cacheRoots = await resolveCacheRoots(options);
  const targetGroups = [];
  for (const cacheRoot of cacheRoots) {
    const targets = await findInstalledPluginTargets(cacheRoot, {
      marketplaceName: options.marketplaceName,
      pluginName,
      version: options.version
    });
    targetGroups.push({ cacheRoot, targets });
  }
  const targets = targetGroups.flatMap((group) => group.targets);

  if (targets.length === 0) {
    throw new Error(`No installed Codex plugin cache found for ${pluginName} under ${cacheRoots.join(", ")}`);
  }

  if (!options.apply) {
    print({
      ok: true,
      dryRun: true,
      sourceDir,
      pluginName,
      cacheRoots,
      targets: targetGroups,
      next: "Run with --apply to replace these installed cache directories, then restart Codex and open a new thread."
    });
    return;
  }

  const synced = [];
  for (const target of targets) {
    await replaceDirectory(sourceDir, target.path);
    synced.push(target);
  }

  print({
    ok: true,
    dryRun: false,
    sourceDir,
    pluginName,
    synced,
    next: "Restart the matching Codex host and open a new thread. Existing threads should not be used as the reload proof."
  });
}

function parseArgs(args) {
  const options = {
    apply: false,
    cacheRoots: [],
    includeWindows: false,
    marketplaceName: undefined,
    pluginName: undefined,
    sourceDir: undefined,
    version: undefined
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = () => {
      index += 1;
      if (index >= args.length) {
        throw new Error(`Missing value for ${arg}`);
      }
      return args[index];
    };
    if (arg === "--apply") {
      options.apply = true;
    } else if (arg === "--") {
      continue;
    } else if (arg === "--cache-root") {
      options.cacheRoots.push(next());
    } else if (arg === "--include-windows") {
      options.includeWindows = true;
    } else if (arg === "--marketplace") {
      options.marketplaceName = next();
    } else if (arg === "--plugin") {
      options.pluginName = next();
    } else if (arg === "--source-dir") {
      options.sourceDir = next();
    } else if (arg === "--version") {
      options.version = next();
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

async function resolveCacheRoots(options) {
  const roots = options.cacheRoots.length > 0 ? [...options.cacheRoots] : [defaultCurrentCacheRoot()];
  if (options.includeWindows) {
    const windowsRoot = await detectWindowsCacheRoot();
    if (windowsRoot) {
      roots.push(windowsRoot);
    }
  }
  return [...new Set(roots.map((root) => path.resolve(root)))];
}

function defaultCurrentCacheRoot() {
  return path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"), "plugins", "cache");
}

async function detectWindowsCacheRoot() {
  if (process.platform === "win32") {
    return defaultCurrentCacheRoot();
  }
  if (!process.env.WSL_DISTRO_NAME && !process.env.WSL_INTEROP) {
    return undefined;
  }
  try {
    const { stdout } = await execFileAsync("cmd.exe", ["/c", "echo", "%USERPROFILE%"], { encoding: "utf8", timeout: 5000 });
    const windowsHome = stdout.trim().replace(/\r/g, "");
    const mountedHome = windowsPathToWslPath(windowsHome);
    return mountedHome ? path.join(mountedHome, ".codex", "plugins", "cache") : undefined;
  } catch {
    return undefined;
  }
}

function windowsPathToWslPath(value) {
  const normalized = value.replace(/\\/g, "/");
  const match = /^([A-Za-z]):\/(.*)$/.exec(normalized);
  if (!match) {
    return undefined;
  }
  return `/mnt/${match[1].toLowerCase()}/${match[2]}`;
}

async function readManifest(sourceDir) {
  const manifestPath = path.join(sourceDir, ".codex-plugin", "plugin.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (!manifest || typeof manifest.name !== "string" || !manifest.name.trim()) {
    throw new Error(`Invalid plugin manifest at ${manifestPath}`);
  }
  return manifest;
}

async function findInstalledPluginTargets(cacheRoot, filters) {
  const targets = [];
  for (const marketplace of await readDirNames(cacheRoot)) {
    if (filters.marketplaceName && marketplace !== filters.marketplaceName) {
      continue;
    }
    const pluginRoot = path.join(cacheRoot, marketplace, filters.pluginName);
    for (const version of await readDirNames(pluginRoot)) {
      if (filters.version && version !== filters.version) {
        continue;
      }
      const target = path.join(pluginRoot, version);
      if (await looksLikeInstalledPlugin(target)) {
        targets.push({ marketplace, plugin: filters.pluginName, version, path: target });
      }
    }
  }
  return targets;
}

async function readDirNames(dir) {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch (error) {
    if (isMissing(error)) {
      return [];
    }
    throw error;
  }
}

async function looksLikeInstalledPlugin(dir) {
  try {
    await readFile(path.join(dir, ".codex-plugin", "plugin.json"), "utf8");
    return true;
  } catch (error) {
    if (!isMissing(error)) {
      throw error;
    }
  }
  try {
    await readFile(path.join(dir, "mcp-bootstrap.mjs"), "utf8");
    return true;
  } catch (error) {
    if (isMissing(error)) {
      return false;
    }
    throw error;
  }
}

async function replaceDirectory(sourceDir, targetDir) {
  const parent = path.dirname(targetDir);
  const tempDir = path.join(parent, `.retinue-sync-${process.pid}-${Date.now()}`);
  await rm(tempDir, { recursive: true, force: true });
  await mkdir(parent, { recursive: true });
  await cp(sourceDir, tempDir, { recursive: true });
  await rm(targetDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  await rename(tempDir, targetDir);
}

function isMissing(error) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
