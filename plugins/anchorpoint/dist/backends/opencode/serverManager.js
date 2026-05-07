export function resolveOpenCodeServer(config) {
    if (config.baseUrl?.trim()) {
        return { mode: "attach", baseUrl: normalizeBaseUrl(config.baseUrl) };
    }
    if (!config.autoServe) {
        throw new Error("OpenCode server target missing: provide SUPERVISOR_OPENCODE_BASE_URL or enable SUPERVISOR_OPENCODE_AUTO_SERVE=1");
    }
    const host = config.host ?? "127.0.0.1";
    const port = config.port ?? 0;
    return {
        mode: "serve",
        command: config.command ?? "opencode",
        args: buildServeArgs({ host, port }),
        host,
        port
    };
}
export function resolveOpenCodeServerFromEnv(env) {
    return resolveOpenCodeServer({
        baseUrl: env.SUPERVISOR_OPENCODE_BASE_URL,
        command: env.SUPERVISOR_OPENCODE_COMMAND,
        autoServe: env.SUPERVISOR_OPENCODE_AUTO_SERVE === "1",
        host: env.SUPERVISOR_OPENCODE_HOST,
        port: parseOptionalPort(env.SUPERVISOR_OPENCODE_PORT)
    });
}
export function buildServeArgs(options) {
    return ["serve", "--hostname", options.host, "--port", String(options.port)];
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
//# sourceMappingURL=serverManager.js.map