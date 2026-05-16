import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { getJobPaths, getOpenCodeServerDiscoveryPath, getOpenCodeServerLockPath, getRetinueTracePath } from "../../core/paths.js";
import { killProcessTree, killProcessTreeSync } from "../../core/processTree.js";

const DEFAULT_OPENCODE_HOST = "127.0.0.1";
const DEFAULT_OPENCODE_PORT = 4096;
const DEFAULT_OPENCODE_FALLBACK_PORTS = buildPortRange(4097, 4127);
const DEFAULT_HEALTH_TIMEOUT_MS = 10_000;
const DEFAULT_HEALTH_POLL_MS = 250;
const DEFAULT_LOCK_TIMEOUT_MS = 10_000;
const DEFAULT_LOCK_STALE_MS = 1_000;
const managedServers = new Map<string, OpenCodeServerTarget>();
const managedServerIdleTimers = new Map<string, NodeJS.Timeout>();
const WINDOWS_EXECUTABLE_EXTENSIONS = [".EXE", ".CMD", ".BAT", ""];

class OpenCodeStartupError extends Error {
  constructor(
    message: string,
    readonly kind: "spawn-error" | "early-exit"
  ) {
    super(message);
    this.name = "OpenCodeStartupError";
  }
}

export interface OpenCodeServerConfig {
  baseUrl?: string;
  command?: string;
  prefixArgs?: string[];
  autoServe?: boolean;
  host?: string;
  port?: number;
  fallbackPorts?: number[];
  allowNonLoopbackHost?: boolean;
}

export type OpenCodeServeResolution = {
  mode: "serve";
  command: string;
  args: string[];
  host: string;
  port: number;
  fallbackPorts: number[];
};

export type OpenCodeServerResolution = { mode: "attach"; baseUrl: string; fallbackServe?: OpenCodeServeResolution } | OpenCodeServeResolution;

export interface OpenCodeServerTarget {
  baseUrl: string;
  started: boolean;
  child?: ChildProcess;
  cwd?: string;
}

type RetinueTraceEvent =
  | { event: "opencode_server_reused"; baseUrl: string; source: "memory" | "discovery"; cwd?: string }
  | { event: "opencode_server_attach_unreachable"; baseUrl: string; cwd?: string; fallbackBaseUrl?: string }
  | { event: "opencode_server_port_occupied"; host: string; port: number; baseUrl: string }
  | { event: "opencode_server_idle_shutdown_scheduled"; baseUrl: string; delayMs: number; cwd?: string }
  | { event: "opencode_server_idle_shutdown_skipped"; baseUrl: string; reason: "running_jobs"; cwd?: string }
  | { event: "opencode_server_stopped"; baseUrl: string; pid?: number; reason: "idle" | "startup_failed" | "process_exit"; cwd?: string }
  | { event: "opencode_server_stop_failed"; baseUrl: string; pid?: number; reason: "idle" | "startup_failed" | "process_exit"; error: string; cwd?: string }
  | {
      event: "opencode_server_spawn";
      requestedCommand: string;
      resolvedCommand: string;
      shell: boolean;
      host: string;
      port: number;
      baseUrl: string;
      args: string[];
      cwd?: string;
    }
  | { event: "opencode_server_ready"; requestedCommand: string; resolvedCommand: string; pid?: number; baseUrl: string; cwd?: string }
  | { event: "opencode_server_start_failed"; requestedCommand: string; resolvedCommand?: string; baseUrl: string; error: string; cwd?: string };

export interface OpenCodeSpawnCommand {
  command: string;
  shell: boolean;
}

interface ManagedOpenCodeDiscovery {
  baseUrl: string;
  pid: number;
  startedAt: string;
  version: string;
  cwd?: string;
}

export function resolveOpenCodeServer(config: OpenCodeServerConfig): OpenCodeServerResolution {
  const fallbackServe = resolveOpenCodeAutoServe(config);
  if (config.baseUrl?.trim()) {
    return {
      mode: "attach",
      baseUrl: normalizeBaseUrl(config.baseUrl),
      ...(fallbackServe ? { fallbackServe } : {})
    };
  }
  if (fallbackServe) {
    return fallbackServe;
  }
  throw new Error("OpenCode server target missing: provide RETINUE_OPENCODE_BASE_URL or enable RETINUE_OPENCODE_AUTO_SERVE=1");
}

function resolveOpenCodeAutoServe(config: OpenCodeServerConfig): OpenCodeServeResolution | undefined {
  if (!config.autoServe) {
    return undefined;
  }
  const host = config.host ?? DEFAULT_OPENCODE_HOST;
  assertOpenCodeHostAllowed(host, config);
  const port = config.port ?? DEFAULT_OPENCODE_PORT;
  const fallbackPorts = config.fallbackPorts ?? (config.port === undefined ? DEFAULT_OPENCODE_FALLBACK_PORTS : []);
  return {
    mode: "serve",
    command: config.command ?? "opencode",
    args: [...(config.prefixArgs ?? []), ...buildServeArgs({ host, port })],
    host,
    port,
    fallbackPorts
  };
}

export function resolveOpenCodeServerFromEnv(env: NodeJS.ProcessEnv | Record<string, string | undefined>): OpenCodeServerResolution {
  assertNoStaleSupervisorOpenCodeEnv(env);
  return resolveOpenCodeServer({
    baseUrl: env.RETINUE_OPENCODE_BASE_URL,
    command: env.RETINUE_OPENCODE_COMMAND,
    prefixArgs: parsePrefixArgs(env.RETINUE_OPENCODE_PREFIX_ARGS),
    autoServe: env.RETINUE_OPENCODE_AUTO_SERVE === "1",
    host: env.RETINUE_OPENCODE_HOST,
    port: parseOptionalPort(env.RETINUE_OPENCODE_PORT),
    fallbackPorts: parseOptionalPorts(env.RETINUE_OPENCODE_FALLBACK_PORTS),
    allowNonLoopbackHost: env.RETINUE_OPENCODE_ALLOW_NON_LOOPBACK === "1"
  });
}

export function assertOpenCodeHostAllowed(host: string, config: Pick<OpenCodeServerConfig, "allowNonLoopbackHost"> = {}): void {
  if (host === "127.0.0.1" || host === "localhost") {
    return;
  }
  if (config.allowNonLoopbackHost === true) {
    return;
  }
  throw new Error(
    "Refusing to bind managed OpenCode server to a non-loopback host. Set RETINUE_OPENCODE_ALLOW_NON_LOOPBACK=1 to override."
  );
}

function assertNoStaleSupervisorOpenCodeEnv(env: NodeJS.ProcessEnv | Record<string, string | undefined>): void {
  const hasRetinueOpenCodeTarget = Boolean(env.RETINUE_OPENCODE_BASE_URL?.trim()) || env.RETINUE_OPENCODE_AUTO_SERVE === "1";
  if (hasRetinueOpenCodeTarget) {
    return;
  }
  const legacyKeys = [
    "SUPERVISOR_RETINUE_BACKEND",
    "SUPERVISOR_OPENCODE_BASE_URL",
    "SUPERVISOR_OPENCODE_AUTO_SERVE",
    "SUPERVISOR_OPENCODE_HOST",
    "SUPERVISOR_OPENCODE_PORT",
    "SUPERVISOR_OPENCODE_AGENT"
  ].filter((key) => Boolean(env[key]));
  if (legacyKeys.length === 0) {
    return;
  }
  throw new Error(
    `OpenCode server target missing: Retinue received legacy SUPERVISOR_* environment (${legacyKeys.join(
      ", "
    )}) but no RETINUE_OPENCODE_BASE_URL or RETINUE_OPENCODE_AUTO_SERVE=1. Reload or restart the MCP host so it reads the current Retinue env config.`
  );
}

export function buildServeArgs(options: { host: string; port: number }): string[] {
  return ["serve", "--hostname", options.host, "--port", String(options.port)];
}

export async function resolveOpenCodeCommandForSpawn(
  command: string,
  options: {
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
    exists?: (candidate: string) => Promise<boolean>;
  } = {}
): Promise<OpenCodeSpawnCommand> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const exists = options.exists ?? fileExists;

  if (command !== "opencode") {
    return { command, shell: shouldUseShellForCommand(platform, command) };
  }

  for (const candidate of buildOpenCodeCommandCandidates(platform, env)) {
    if (await exists(candidate)) {
      return { command: candidate, shell: shouldUseShellForCommand(platform, candidate) };
    }
  }

  return { command, shell: shouldUseShellForCommand(platform, command) };
}

export async function ensureOpenCodeServer(
  resolution: OpenCodeServerResolution,
  options: { stateDir?: string; healthTimeoutMs?: number; healthPollMs?: number; lockTimeoutMs?: number; cwd?: string } = {}
): Promise<OpenCodeServerTarget> {
  if (resolution.mode === "attach") {
    if (resolution.fallbackServe) {
      const health = await readOpenCodeHealth(resolution.baseUrl, options.healthPollMs ?? DEFAULT_HEALTH_POLL_MS);
      if (!health.reachable || !health.ok) {
        await writeRetinueTrace(options.stateDir, {
          event: "opencode_server_attach_unreachable",
          baseUrl: resolution.baseUrl,
          fallbackBaseUrl: `http://${resolution.fallbackServe.host}:${resolution.fallbackServe.port}`,
          cwd: normalizeServerCwd(options.cwd)
        });
        return ensureOpenCodeServer(resolution.fallbackServe, options);
      }
    }
    return { baseUrl: resolution.baseUrl, started: false };
  }
  const cwd = normalizeServerCwd(options.cwd);

  const discovered = options.stateDir ? await readReusableDiscovery(options.stateDir, cwd) : undefined;
  if (discovered) {
    await writeRetinueTrace(options.stateDir, { event: "opencode_server_reused", baseUrl: discovered.baseUrl, source: "discovery", cwd });
    return discovered;
  }

  const lock = options.stateDir ? await acquireOpenCodeServerLock(options.stateDir, options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS, cwd) : undefined;
  try {
    const discoveredAfterLock = options.stateDir ? await readReusableDiscovery(options.stateDir, cwd) : undefined;
    if (discoveredAfterLock) {
      await writeRetinueTrace(options.stateDir, { event: "opencode_server_reused", baseUrl: discoveredAfterLock.baseUrl, source: "discovery", cwd });
      return discoveredAfterLock;
    }
    return await startManagedOpenCodeServer(resolution, { ...options, cwd });
  } finally {
    await lock?.release();
  }
}

async function startManagedOpenCodeServer(
  resolution: Extract<OpenCodeServerResolution, { mode: "serve" }>,
  options: { stateDir?: string; healthTimeoutMs?: number; healthPollMs?: number; cwd?: string }
): Promise<OpenCodeServerTarget> {
  const ports = [resolution.port, ...resolution.fallbackPorts];
  const occupiedPorts: number[] = [];
  const startupFailures: string[] = [];

  for (const [index, port] of ports.entries()) {
    const baseUrl = `http://${resolution.host}:${port}`;
    const managed = managedServers.get(baseUrl);
    if (managed?.child && managed.child.exitCode === null && managed.cwd === options.cwd) {
      await writeRetinueTrace(options.stateDir, { event: "opencode_server_reused", baseUrl, source: "memory", cwd: options.cwd });
      return managed;
    }
    const initial = await readOpenCodeHealth(baseUrl, options.healthPollMs ?? DEFAULT_HEALTH_POLL_MS);
    if (initial.reachable) {
      occupiedPorts.push(port);
      await writeRetinueTrace(options.stateDir, { event: "opencode_server_port_occupied", host: resolution.host, port, baseUrl });
      continue;
    }

    const prefixArgs = resolution.args.slice(0, -buildServeArgs({ host: resolution.host, port: resolution.port }).length);
    const spawnCommand = await resolveOpenCodeCommandForSpawn(resolution.command);
    const args = [...prefixArgs, ...buildServeArgs({ host: resolution.host, port })];
    await writeRetinueTrace(options.stateDir, {
      event: "opencode_server_spawn",
      requestedCommand: resolution.command,
      resolvedCommand: spawnCommand.command,
      shell: spawnCommand.shell,
      host: resolution.host,
      port,
      baseUrl,
      args,
      cwd: options.cwd
    });
    const child = spawn(spawnCommand.command, args, {
      stdio: "ignore",
      shell: spawnCommand.shell,
      windowsHide: true,
      cwd: options.cwd
    });
    const startupFailure = waitForStartupFailure(child, resolution.command);
    const cleanup = () => stopChildProcessTreeSync(child);
    process.once("exit", cleanup);

    try {
      await Promise.race([
        waitForOpenCodeHealth(baseUrl, {
          timeoutMs: options.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS,
          pollMs: options.healthPollMs ?? DEFAULT_HEALTH_POLL_MS
        }),
        startupFailure
      ]);
    } catch (error) {
      await stopChildProcessTree(baseUrl, child, {
        stateDir: options.stateDir,
        cwd: options.cwd,
        reason: "startup_failed"
      });
      process.removeListener("exit", cleanup);
      const message = error instanceof Error ? error.message : String(error);
      await writeRetinueTrace(options.stateDir, {
        event: "opencode_server_start_failed",
        requestedCommand: resolution.command,
        resolvedCommand: spawnCommand.command,
        baseUrl,
        error: message,
        cwd: options.cwd
      });
      if (error instanceof OpenCodeStartupError && error.kind === "early-exit" && index < ports.length - 1) {
        startupFailures.push(`${baseUrl}: ${message}`);
        continue;
      }
      throw error;
    }

    const target = { baseUrl, started: true, child, cwd: options.cwd };
    await writeRetinueTrace(options.stateDir, {
      event: "opencode_server_ready",
      requestedCommand: resolution.command,
      resolvedCommand: spawnCommand.command,
      pid: child.pid,
      baseUrl,
      cwd: options.cwd
    });
    managedServers.set(baseUrl, target);
    cancelManagedOpenCodeServerIdleShutdown(baseUrl);
    if (options.stateDir && child.pid) {
      await writeOpenCodeServerDiscovery(options.stateDir, {
        baseUrl,
        pid: child.pid,
        startedAt: new Date().toISOString(),
        version: "0.1.0",
        cwd: options.cwd
      });
    }
    child.once("exit", () => {
      managedServers.delete(baseUrl);
      cancelManagedOpenCodeServerIdleShutdown(baseUrl);
      process.removeListener("exit", cleanup);
      if (options.stateDir && child.pid) {
        void removeDiscoveryIfMatches(options.stateDir, child.pid, options.cwd);
      }
    });
    return target;
  }

  throw new Error(
    `OpenCode auto-serve could not start because candidate port${ports.length === 1 ? "" : "s"} ${ports.join(", ")} on ${resolution.host} ${
      occupiedPorts.length === ports.length ? "are already in use by non-OpenCode services" : "were unavailable"
    }${startupFailures.length > 0 ? `. Startup failures: ${startupFailures.join("; ")}` : ""}`
  );
}

export function scheduleManagedOpenCodeServerIdleShutdown(
  baseUrl: string,
  options: { stateDir?: string; cwd?: string; delayMs?: number; reason?: "idle" } = {}
): void {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  const managed = managedServers.get(normalizedBaseUrl);
  if (!managed?.child) {
    return;
  }

  const delayMs = Math.max(0, options.delayMs ?? 0);
  cancelManagedOpenCodeServerIdleShutdown(normalizedBaseUrl);
  const timer = setTimeout(() => {
    managedServerIdleTimers.delete(normalizedBaseUrl);
    void (async () => {
      const cwd = options.cwd ?? managed.cwd;
      if (await hasRunningOpenCodeJobsForServer(options.stateDir, normalizedBaseUrl)) {
        await writeRetinueTrace(options.stateDir, {
          event: "opencode_server_idle_shutdown_skipped",
          baseUrl: normalizedBaseUrl,
          reason: "running_jobs",
          cwd
        });
        return;
      }
      await stopManagedOpenCodeServer(normalizedBaseUrl, {
        stateDir: options.stateDir,
        cwd,
        reason: options.reason ?? "idle"
      });
    })();
  }, delayMs);
  timer.unref?.();
  managedServerIdleTimers.set(normalizedBaseUrl, timer);
  void writeRetinueTrace(options.stateDir, {
    event: "opencode_server_idle_shutdown_scheduled",
    baseUrl: normalizedBaseUrl,
    delayMs,
    cwd: options.cwd ?? managed.cwd
  });
}

function cancelManagedOpenCodeServerIdleShutdown(baseUrl: string): void {
  const timer = managedServerIdleTimers.get(baseUrl);
  if (!timer) {
    return;
  }
  clearTimeout(timer);
  managedServerIdleTimers.delete(baseUrl);
}

async function stopManagedOpenCodeServer(
  baseUrl: string,
  options: { stateDir?: string; cwd?: string; reason: "idle" | "startup_failed" | "process_exit" }
): Promise<boolean> {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  const managed = managedServers.get(normalizedBaseUrl);
  if (!managed?.child) {
    return false;
  }
  await stopChildProcessTree(normalizedBaseUrl, managed.child, options);
  managedServers.delete(normalizedBaseUrl);
  if (options.stateDir && managed.child.pid) {
    await removeDiscoveryIfMatches(options.stateDir, managed.child.pid, options.cwd ?? managed.cwd);
  }
  return true;
}

async function hasRunningOpenCodeJobsForServer(stateDir: string | undefined, baseUrl: string): Promise<boolean> {
  if (!stateDir) {
    return false;
  }
  const jobsDir = getJobPaths(stateDir, "placeholder").dir.replace(/[\\/]placeholder$/, "");
  for (const entry of await readDirIfExists(jobsDir)) {
    if (!entry.isDirectory()) {
      continue;
    }
    try {
      const meta = JSON.parse(await fs.readFile(path.join(jobsDir, entry.name, "meta.json"), "utf8")) as {
        backend?: string;
        status?: string;
        externalServerUrl?: string;
      };
      if (meta.backend === "opencode" && meta.status === "running" && normalizeBaseUrl(meta.externalServerUrl ?? "") === baseUrl) {
        return true;
      }
    } catch {
      // Corrupted job metadata should not keep managed servers alive forever.
    }
  }
  return false;
}

async function stopChildProcessTree(
  baseUrl: string,
  child: ChildProcess,
  options: { stateDir?: string; cwd?: string; reason: "idle" | "startup_failed" | "process_exit" }
): Promise<void> {
  const pid = child.pid;
  try {
    if (pid && child.exitCode === null) {
      await killProcessTree(pid);
    }
    await writeRetinueTrace(options.stateDir, {
      event: "opencode_server_stopped",
      baseUrl,
      pid,
      reason: options.reason,
      cwd: options.cwd
    });
  } catch (error) {
    await writeRetinueTrace(options.stateDir, {
      event: "opencode_server_stop_failed",
      baseUrl,
      pid,
      reason: options.reason,
      error: error instanceof Error ? error.message : String(error),
      cwd: options.cwd
    });
  }
}

function stopChildProcessTreeSync(child: ChildProcess): void {
  const pid = child.pid;
  if (pid && child.exitCode === null) {
    killProcessTreeSync(pid);
  }
}

async function writeRetinueTrace(stateDir: string | undefined, event: RetinueTraceEvent): Promise<void> {
  if (!stateDir) {
    return;
  }
  const tracePath = getRetinueTracePath(stateDir);
  try {
    await fs.mkdir(path.dirname(tracePath), { recursive: true });
    await fs.appendFile(tracePath, `${JSON.stringify({ time: new Date().toISOString(), pid: process.pid, ...event })}\n`, "utf8");
  } catch {
    // Diagnostics must never make Retinue tool calls fail.
  }
}

function waitForStartupFailure(child: ChildProcess, command: string): Promise<never> {
  return new Promise((_, reject) => {
    child.once("error", (error) => {
      reject(new OpenCodeStartupError(`Failed to start OpenCode server command "${command}": ${error.message}`, "spawn-error"));
    });
    child.once("exit", (code, signal) => {
      reject(new OpenCodeStartupError(`OpenCode server command "${command}" exited before becoming healthy: ${formatExit(code, signal)}`, "early-exit"));
    });
  });
}

function shouldUseShellForCommand(platform: NodeJS.Platform, command: string): boolean {
  return platform === "win32" && /\.(?:cmd|bat)$/i.test(command);
}

async function fileExists(candidate: string): Promise<boolean> {
  try {
    await fs.access(candidate);
    return true;
  } catch {
    return false;
  }
}

function buildOpenCodeCommandCandidates(platform: NodeJS.Platform, env: NodeJS.ProcessEnv | Record<string, string | undefined>): string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();
  const add = (candidate: string | undefined) => {
    if (!candidate || seen.has(candidate)) {
      return;
    }
    seen.add(candidate);
    candidates.push(candidate);
  };

  if (platform === "win32") {
    for (const directory of getPathEntries(env, ";")) {
      for (const extension of WINDOWS_EXECUTABLE_EXTENSIONS) {
        add(path.win32.join(directory, `opencode${extension}`));
      }
    }
    for (const directory of getWindowsOpenCodeFallbackDirectories(env)) {
      for (const extension of WINDOWS_EXECUTABLE_EXTENSIONS) {
        add(path.win32.join(directory, `opencode${extension}`));
      }
    }
    return candidates;
  }

  for (const directory of getPathEntries(env, ":")) {
    add(path.join(directory, "opencode"));
  }
  for (const directory of getPosixOpenCodeFallbackDirectories(env)) {
    add(path.join(directory, "opencode"));
  }
  return candidates;
}

function getPathEntries(env: NodeJS.ProcessEnv | Record<string, string | undefined>, delimiter: string): string[] {
  const value = env.PATH ?? env.Path ?? env.path ?? "";
  return value
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function getWindowsOpenCodeFallbackDirectories(env: NodeJS.ProcessEnv | Record<string, string | undefined>): string[] {
  const userProfile = env.USERPROFILE;
  const localAppData = env.LOCALAPPDATA;
  const appData = env.APPDATA;
  return [
    userProfile ? path.win32.join(userProfile, ".opencode", "bin") : undefined,
    userProfile ? path.win32.join(userProfile, ".local", "pnpm-global") : undefined,
    localAppData ? path.win32.join(localAppData, "pnpm") : undefined,
    appData ? path.win32.join(appData, "npm") : undefined,
    userProfile ? path.win32.join(userProfile, "AppData", "Local", "pnpm") : undefined,
    userProfile ? path.win32.join(userProfile, ".bun", "bin") : undefined
  ].filter((entry): entry is string => Boolean(entry));
}

function getPosixOpenCodeFallbackDirectories(env: NodeJS.ProcessEnv | Record<string, string | undefined>): string[] {
  const home = env.HOME;
  return [home ? path.join(home, ".opencode", "bin") : undefined].filter((entry): entry is string => Boolean(entry));
}

function formatExit(code: number | null, signal: NodeJS.Signals | null): string {
  if (code !== null) {
    return `exit code ${code}`;
  }
  if (signal !== null) {
    return `signal ${signal}`;
  }
  return "unknown exit";
}

async function readReusableDiscovery(stateDir: string, cwd: string | undefined): Promise<OpenCodeServerTarget | undefined> {
  let discovery: ManagedOpenCodeDiscovery;
  try {
    discovery = normalizeOpenCodeServerDiscovery(JSON.parse(await fs.readFile(getScopedOpenCodeServerDiscoveryPath(stateDir, cwd), "utf8")) as Partial<ManagedOpenCodeDiscovery>);
  } catch {
    return undefined;
  }
  if (normalizeServerCwd(discovery.cwd) !== cwd) {
    return undefined;
  }
  if (!isPidAlive(discovery.pid)) {
    await removeDiscoveryIfMatches(stateDir, discovery.pid, cwd);
    return undefined;
  }
  const health = await readOpenCodeHealth(discovery.baseUrl);
  if (health.timedOut) {
    return { baseUrl: discovery.baseUrl, started: false, cwd };
  }
  if (!health.ok) {
    await removeDiscoveryIfMatches(stateDir, discovery.pid, cwd);
    return undefined;
  }
  return { baseUrl: discovery.baseUrl, started: false, cwd };
}

async function writeOpenCodeServerDiscovery(stateDir: string, value: ManagedOpenCodeDiscovery): Promise<void> {
  const filePath = getScopedOpenCodeServerDiscoveryPath(stateDir, normalizeServerCwd(value.cwd));
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(tempPath, filePath);
}

async function removeDiscoveryIfMatches(stateDir: string, pid: number, cwd: string | undefined): Promise<void> {
  try {
    const filePath = getScopedOpenCodeServerDiscoveryPath(stateDir, cwd);
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as Partial<ManagedOpenCodeDiscovery>;
    if (parsed.pid === pid) {
      await fs.rm(filePath, { force: true });
    }
  } catch {
    // Best-effort cleanup only.
  }
}

async function acquireOpenCodeServerLock(stateDir: string, timeoutMs: number, cwd: string | undefined): Promise<{ release(): Promise<void> }> {
  const lockPath = getScopedOpenCodeServerLockPath(stateDir, cwd);
  const deadline = Date.now() + timeoutMs;
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  for (;;) {
    try {
      const handle = await fs.open(lockPath, "wx");
      await handle.writeFile(`${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`, "utf8");
      await handle.close();
      return {
        release: async () => {
          await fs.rm(lockPath, { force: true });
        }
      };
    } catch (error) {
      if (!isFileExistsError(error)) {
        throw error;
      }
      await removeStaleLock(lockPath);
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for OpenCode server startup lock at ${lockPath}`);
      }
      await sleep(DEFAULT_HEALTH_POLL_MS);
    }
  }
}

async function removeStaleLock(lockPath: string): Promise<void> {
  try {
    const parsed = JSON.parse(await fs.readFile(lockPath, "utf8")) as { pid?: unknown };
    if (typeof parsed.pid === "number" && Number.isInteger(parsed.pid) && !isPidAlive(parsed.pid)) {
      await fs.rm(lockPath, { force: true });
    }
  } catch {
    try {
      const stat = await fs.stat(lockPath);
      if (Date.now() - stat.mtimeMs > DEFAULT_LOCK_STALE_MS) {
        await fs.rm(lockPath, { force: true });
      }
    } catch {
      // Best-effort cleanup only.
    }
  }
}

function normalizeOpenCodeServerDiscovery(value: Partial<ManagedOpenCodeDiscovery>): ManagedOpenCodeDiscovery {
  if (typeof value.baseUrl !== "string" || !value.baseUrl) {
    throw new Error("Invalid OpenCode server discovery: missing baseUrl");
  }
  const baseUrl = normalizeBaseUrl(value.baseUrl);
  if (typeof value.pid !== "number" || !Number.isInteger(value.pid)) {
    throw new Error("Invalid OpenCode server discovery: missing pid");
  }
  if (typeof value.startedAt !== "string" || !value.startedAt) {
    throw new Error("Invalid OpenCode server discovery: missing startedAt");
  }
  if (typeof value.version !== "string" || !value.version) {
    throw new Error("Invalid OpenCode server discovery: missing version");
  }
  return {
    baseUrl,
    pid: value.pid,
    startedAt: value.startedAt,
    version: value.version,
    cwd: typeof value.cwd === "string" && value.cwd ? value.cwd : undefined
  };
}

function getScopedOpenCodeServerDiscoveryPath(stateDir: string, cwd: string | undefined): string {
  if (!cwd) {
    return getOpenCodeServerDiscoveryPath(stateDir);
  }
  return path.join(path.dirname(getOpenCodeServerDiscoveryPath(stateDir)), `opencode-server-${hashCwd(cwd)}.json`);
}

function getScopedOpenCodeServerLockPath(stateDir: string, cwd: string | undefined): string {
  if (!cwd) {
    return getOpenCodeServerLockPath(stateDir);
  }
  return path.join(path.dirname(getOpenCodeServerLockPath(stateDir)), `opencode-server-${hashCwd(cwd)}.lock`);
}

function hashCwd(cwd: string): string {
  return createHash("sha256").update(cwd).digest("hex").slice(0, 16);
}

function normalizeServerCwd(cwd: string | undefined): string | undefined {
  if (!cwd?.trim()) {
    return undefined;
  }
  return path.resolve(cwd);
}

async function waitForOpenCodeHealth(baseUrl: string, options: { timeoutMs: number; pollMs: number }): Promise<void> {
  const deadline = Date.now() + options.timeoutMs;
  for (;;) {
    const health = await readOpenCodeHealth(baseUrl, Math.min(options.pollMs, Math.max(1, deadline - Date.now())));
    if (health.ok) {
      return;
    }
    if (health.reachable && !health.timedOut) {
      throw new Error(`Port ${new URL(baseUrl).port} on ${new URL(baseUrl).hostname} is already in use by a non-OpenCode service`);
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for OpenCode server at ${baseUrl}`);
    }
    await sleep(options.pollMs);
  }
}

async function readOpenCodeHealth(baseUrl: string, requestTimeoutMs = DEFAULT_HEALTH_POLL_MS): Promise<{ ok: boolean; reachable: boolean; timedOut?: boolean }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1, requestTimeoutMs));
  try {
    const response = await fetch(`${baseUrl}/global/health`, { signal: controller.signal });
    const text = await response.text();
    const parsed = parseJson(text);
    if (!response.ok || typeof parsed !== "object" || parsed === null) {
      return { ok: false, reachable: true };
    }
    if ("healthy" in parsed && parsed.healthy === true) {
      return { ok: true, reachable: true };
    }
    if ("status" in parsed && parsed.status === "ok") {
      return { ok: true, reachable: true };
    }
    return { ok: false, reachable: true };
  } catch {
    if (controller.signal.aborted) {
      return { ok: false, reachable: true, timedOut: true };
    }
    return { ok: false, reachable: false };
  } finally {
    clearTimeout(timeout);
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isPidAlive(pid: number): boolean {
  if (pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isFileExistsError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

async function readDirIfExists(dirPath: string) {
  try {
    return await fs.readdir(dirPath, { withFileTypes: true });
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

function normalizeBaseUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Invalid OpenCode server URL");
  }
  if (parsed.protocol !== "http:") {
    throw new Error("OpenCode server URL must use http");
  }
  if (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost") {
    throw new Error("OpenCode server URL must be loopback");
  }
  return parsed.origin;
}

function parseOptionalPort(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error("RETINUE_OPENCODE_PORT must be a port between 1 and 65535");
  }
  return parsed;
}

function parseOptionalPorts(value: string | undefined): number[] | undefined {
  if (!value?.trim()) {
    return undefined;
  }
  return value.split(",").map((entry) => parseRequiredPort(entry.trim()));
}

function buildPortRange(start: number, endInclusive: number): number[] {
  const ports: number[] = [];
  for (let port = start; port <= endInclusive; port += 1) {
    ports.push(port);
  }
  return ports;
}

function parsePrefixArgs(value: string | undefined): string[] | undefined {
  if (!value?.trim()) {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.startsWith("[")) {
    return JSON.parse(trimmed) as string[];
  }
  return [trimmed];
}

function parseRequiredPort(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error("RETINUE_OPENCODE_FALLBACK_PORTS must contain ports between 1 and 65535");
  }
  return parsed;
}
