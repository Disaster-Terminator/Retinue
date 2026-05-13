#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { createDaemonServer } from "./daemon/server.js";
import { writeDaemonDiscovery } from "./daemon/discovery.js";
import { ClaudeRetinue } from "./core/retinue.js";
async function main() {
    const flags = parseFlags(process.argv.slice(2));
    const host = flags.host ?? process.env.RETINUE_DAEMON_HOST ?? "127.0.0.1";
    const port = flags.port ? Number(flags.port) : Number(process.env.RETINUE_DAEMON_PORT ?? "27777");
    assertDaemonHostAllowed(host, process.env);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
        throw new Error(`Invalid --port: ${String(flags.port ?? process.env.RETINUE_DAEMON_PORT)}`);
    }
    const retinue = createRetinueFromEnv();
    const server = createDaemonServer(retinue);
    await new Promise((resolve) => server.listen(port, host, resolve));
    const address = server.address();
    const actualPort = typeof address === "object" && address ? address.port : port;
    const startedAt = new Date().toISOString();
    const ready = buildDaemonReadyPayload({
        host,
        port: actualPort,
        pid: process.pid,
        startedAt,
        version: "0.1.0"
    });
    await writeDaemonDiscovery(retinue.getStateDir(), {
        url: ready.url,
        pid: ready.pid,
        startedAt: ready.startedAt,
        version: ready.version
    });
    process.stdout.write(`${JSON.stringify(ready)}\n`);
}
export function assertDaemonHostAllowed(host, env = process.env) {
    if (host === "127.0.0.1" || host === "localhost") {
        return;
    }
    if (env.RETINUE_DAEMON_ALLOW_NON_LOOPBACK === "1") {
        return;
    }
    throw new Error("Refusing to bind unauthenticated Retinue daemon to a non-loopback host. Set RETINUE_DAEMON_ALLOW_NON_LOOPBACK=1 to override.");
}
export function buildDaemonReadyPayload(options) {
    return {
        status: "listening",
        host: options.host,
        port: options.port,
        url: `http://${options.host}:${options.port}`,
        pid: options.pid,
        startedAt: options.startedAt,
        version: options.version
    };
}
function createRetinueFromEnv() {
    return new ClaudeRetinue({
        stateDir: process.env.RETINUE_STATE_DIR,
        claudeCommand: process.env.RETINUE_CLAUDE_COMMAND,
        claudePrefixArgs: parsePrefixArgs(process.env.RETINUE_CLAUDE_PREFIX_ARGS),
        env: process.env,
        defaultRuntimeTimeoutMs: parseOptionalNumber(process.env.RETINUE_DEFAULT_RUNTIME_TIMEOUT_MS),
        maxConcurrentJobs: parseOptionalNumber(process.env.RETINUE_MAX_CONCURRENT_JOBS)
    });
}
function parseFlags(args) {
    const flags = {};
    for (let index = 0; index < args.length; index += 1) {
        const token = args[index];
        if (!token?.startsWith("--")) {
            continue;
        }
        flags[token.slice(2)] = args[index + 1];
        index += 1;
    }
    return flags;
}
function parsePrefixArgs(value) {
    if (!value) {
        return [];
    }
    const trimmed = value.trim();
    if (trimmed.startsWith("[")) {
        return JSON.parse(trimmed);
    }
    return [value];
}
function parseOptionalNumber(value) {
    if (!value) {
        return undefined;
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    main().catch((error) => {
        process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
        process.exitCode = 1;
    });
}
//# sourceMappingURL=daemon.js.map