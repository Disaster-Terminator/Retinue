import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { getOpenCodeServerDiscoveryPath, getOpenCodeServerLockPath, getRetinueTracePath } from "../../core/paths.js";
const DEFAULT_OPENCODE_HOST = "127.0.0.1";
const DEFAULT_OPENCODE_PORT = 4096;
const DEFAULT_OPENCODE_FALLBACK_PORTS = buildPortRange(4097, 4127);
const DEFAULT_HEALTH_TIMEOUT_MS = 10_000;
const DEFAULT_HEALTH_POLL_MS = 250;
const DEFAULT_LOCK_TIMEOUT_MS = 10_000;
const managedServers = new Map();
const WINDOWS_EXECUTABLE_EXTENSIONS = [".EXE", ".CMD", ".BAT", ""];
export function resolveOpenCodeServer(config) {
    if (config.baseUrl?.trim()) {
        return { mode: "attach", baseUrl: normalizeBaseUrl(config.baseUrl) };
    }
    if (!config.autoServe) {
        throw new Error("OpenCode server target missing: provide SUPERVISOR_OPENCODE_BASE_URL or enable SUPERVISOR_OPENCODE_AUTO_SERVE=1");
    }
    const host = config.host ?? DEFAULT_OPENCODE_HOST;
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
export function resolveOpenCodeServerFromEnv(env) {
    return resolveOpenCodeServer({
        baseUrl: env.SUPERVISOR_OPENCODE_BASE_URL,
        command: env.SUPERVISOR_OPENCODE_COMMAND,
        prefixArgs: parsePrefixArgs(env.SUPERVISOR_OPENCODE_PREFIX_ARGS),
        autoServe: env.SUPERVISOR_OPENCODE_AUTO_SERVE === "1",
        host: env.SUPERVISOR_OPENCODE_HOST,
        port: parseOptionalPort(env.SUPERVISOR_OPENCODE_PORT),
        fallbackPorts: parseOptionalPorts(env.SUPERVISOR_OPENCODE_FALLBACK_PORTS)
    });
}
export function buildServeArgs(options) {
    return ["serve", "--hostname", options.host, "--port", String(options.port)];
}
export async function resolveOpenCodeCommandForSpawn(command, options = {}) {
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
export async function ensureOpenCodeServer(resolution, options = {}) {
    if (resolution.mode === "attach") {
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
    }
    finally {
        await lock?.release();
    }
}
async function startManagedOpenCodeServer(resolution, options) {
    const ports = [resolution.port, ...resolution.fallbackPorts];
    const occupiedPorts = [];
    for (const port of ports) {
        const baseUrl = `http://${resolution.host}:${port}`;
        const managed = managedServers.get(baseUrl);
        if (managed?.child && managed.child.exitCode === null && managed.cwd === options.cwd) {
            await writeRetinueTrace(options.stateDir, { event: "opencode_server_reused", baseUrl, source: "memory", cwd: options.cwd });
            return managed;
        }
        const initial = await readOpenCodeHealth(baseUrl);
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
        const cleanup = () => {
            try {
                if (!child.killed && child.exitCode === null) {
                    child.kill();
                }
            }
            catch {
                // Treat a never-started or already-exited process as gone.
            }
        };
        process.once("exit", cleanup);
        try {
            await Promise.race([
                waitForOpenCodeHealth(baseUrl, {
                    timeoutMs: options.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS,
                    pollMs: options.healthPollMs ?? DEFAULT_HEALTH_POLL_MS
                }),
                startupFailure
            ]);
        }
        catch (error) {
            cleanup();
            process.removeListener("exit", cleanup);
            await writeRetinueTrace(options.stateDir, {
                event: "opencode_server_start_failed",
                requestedCommand: resolution.command,
                resolvedCommand: spawnCommand.command,
                baseUrl,
                error: error instanceof Error ? error.message : String(error),
                cwd: options.cwd
            });
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
            process.removeListener("exit", cleanup);
            if (options.stateDir && child.pid) {
                void removeDiscoveryIfMatches(options.stateDir, child.pid, options.cwd);
            }
        });
        return target;
    }
    throw new Error(`OpenCode auto-serve could not start because candidate port${ports.length === 1 ? "" : "s"} ${ports.join(", ")} on ${resolution.host} ${occupiedPorts.length === ports.length ? "are already in use by non-OpenCode services" : "were unavailable"}`);
}
async function writeRetinueTrace(stateDir, event) {
    if (!stateDir) {
        return;
    }
    const tracePath = getRetinueTracePath(stateDir);
    try {
        await fs.mkdir(path.dirname(tracePath), { recursive: true });
        await fs.appendFile(tracePath, `${JSON.stringify({ time: new Date().toISOString(), pid: process.pid, ...event })}\n`, "utf8");
    }
    catch {
        // Diagnostics must never make Retinue tool calls fail.
    }
}
function waitForStartupFailure(child, command) {
    return new Promise((_, reject) => {
        child.once("error", (error) => {
            reject(new Error(`Failed to start OpenCode server command "${command}": ${error.message}`));
        });
        child.once("exit", (code, signal) => {
            reject(new Error(`OpenCode server command "${command}" exited before becoming healthy: ${formatExit(code, signal)}`));
        });
    });
}
function shouldUseShellForCommand(platform, command) {
    return platform === "win32" && /\.(?:cmd|bat)$/i.test(command);
}
async function fileExists(candidate) {
    try {
        await fs.access(candidate);
        return true;
    }
    catch {
        return false;
    }
}
function buildOpenCodeCommandCandidates(platform, env) {
    const candidates = [];
    const seen = new Set();
    const add = (candidate) => {
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
    return candidates;
}
function getPathEntries(env, delimiter) {
    const value = env.PATH ?? env.Path ?? env.path ?? "";
    return value
        .split(delimiter)
        .map((entry) => entry.trim())
        .filter(Boolean);
}
function getWindowsOpenCodeFallbackDirectories(env) {
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
    ].filter((entry) => Boolean(entry));
}
function formatExit(code, signal) {
    if (code !== null) {
        return `exit code ${code}`;
    }
    if (signal !== null) {
        return `signal ${signal}`;
    }
    return "unknown exit";
}
async function readReusableDiscovery(stateDir, cwd) {
    let discovery;
    try {
        discovery = normalizeOpenCodeServerDiscovery(JSON.parse(await fs.readFile(getScopedOpenCodeServerDiscoveryPath(stateDir, cwd), "utf8")));
    }
    catch {
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
    if (!health.ok) {
        await removeDiscoveryIfMatches(stateDir, discovery.pid, cwd);
        return undefined;
    }
    return { baseUrl: discovery.baseUrl, started: false, cwd };
}
async function writeOpenCodeServerDiscovery(stateDir, value) {
    const filePath = getScopedOpenCodeServerDiscoveryPath(stateDir, normalizeServerCwd(value.cwd));
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
    await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await fs.rename(tempPath, filePath);
}
async function removeDiscoveryIfMatches(stateDir, pid, cwd) {
    try {
        const filePath = getScopedOpenCodeServerDiscoveryPath(stateDir, cwd);
        const parsed = JSON.parse(await fs.readFile(filePath, "utf8"));
        if (parsed.pid === pid) {
            await fs.rm(filePath, { force: true });
        }
    }
    catch {
        // Best-effort cleanup only.
    }
}
async function acquireOpenCodeServerLock(stateDir, timeoutMs, cwd) {
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
        }
        catch (error) {
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
async function removeStaleLock(lockPath) {
    try {
        const parsed = JSON.parse(await fs.readFile(lockPath, "utf8"));
        if (typeof parsed.pid === "number" && Number.isInteger(parsed.pid) && !isPidAlive(parsed.pid)) {
            await fs.rm(lockPath, { force: true });
        }
    }
    catch {
        await fs.rm(lockPath, { force: true });
    }
}
function normalizeOpenCodeServerDiscovery(value) {
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
function getScopedOpenCodeServerDiscoveryPath(stateDir, cwd) {
    if (!cwd) {
        return getOpenCodeServerDiscoveryPath(stateDir);
    }
    return path.join(path.dirname(getOpenCodeServerDiscoveryPath(stateDir)), `opencode-server-${hashCwd(cwd)}.json`);
}
function getScopedOpenCodeServerLockPath(stateDir, cwd) {
    if (!cwd) {
        return getOpenCodeServerLockPath(stateDir);
    }
    return path.join(path.dirname(getOpenCodeServerLockPath(stateDir)), `opencode-server-${hashCwd(cwd)}.lock`);
}
function hashCwd(cwd) {
    return createHash("sha256").update(cwd).digest("hex").slice(0, 16);
}
function normalizeServerCwd(cwd) {
    if (!cwd?.trim()) {
        return undefined;
    }
    return path.resolve(cwd);
}
async function waitForOpenCodeHealth(baseUrl, options) {
    const deadline = Date.now() + options.timeoutMs;
    for (;;) {
        const health = await readOpenCodeHealth(baseUrl);
        if (health.ok) {
            return;
        }
        if (health.reachable) {
            throw new Error(`Port ${new URL(baseUrl).port} on ${new URL(baseUrl).hostname} is already in use by a non-OpenCode service`);
        }
        if (Date.now() >= deadline) {
            throw new Error(`Timed out waiting for OpenCode server at ${baseUrl}`);
        }
        await sleep(options.pollMs);
    }
}
async function readOpenCodeHealth(baseUrl) {
    let response;
    try {
        response = await fetch(`${baseUrl}/global/health`);
    }
    catch {
        return { ok: false, reachable: false };
    }
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
}
function parseJson(text) {
    try {
        return JSON.parse(text);
    }
    catch {
        return undefined;
    }
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
function isPidAlive(pid) {
    if (pid <= 0) {
        return false;
    }
    try {
        process.kill(pid, 0);
        return true;
    }
    catch {
        return false;
    }
}
function isFileExistsError(error) {
    return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}
function normalizeBaseUrl(value) {
    let parsed;
    try {
        parsed = new URL(value);
    }
    catch {
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
function parseOptionalPort(value) {
    if (!value) {
        return undefined;
    }
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
        throw new Error("SUPERVISOR_OPENCODE_PORT must be a port between 0 and 65535");
    }
    return parsed;
}
function parseOptionalPorts(value) {
    if (!value?.trim()) {
        return undefined;
    }
    return value.split(",").map((entry) => parseRequiredPort(entry.trim()));
}
function buildPortRange(start, endInclusive) {
    const ports = [];
    for (let port = start; port <= endInclusive; port += 1) {
        ports.push(port);
    }
    return ports;
}
function parsePrefixArgs(value) {
    if (!value?.trim()) {
        return undefined;
    }
    const trimmed = value.trim();
    if (trimmed.startsWith("[")) {
        return JSON.parse(trimmed);
    }
    return [trimmed];
}
function parseRequiredPort(value) {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
        throw new Error("SUPERVISOR_OPENCODE_FALLBACK_PORTS must contain ports between 0 and 65535");
    }
    return parsed;
}
//# sourceMappingURL=serverManager.js.map