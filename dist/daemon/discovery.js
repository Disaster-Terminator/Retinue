import { randomUUID } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { getDaemonDiscoveryPath } from "../core/paths.js";
export async function writeDaemonDiscovery(stateDir, value) {
    const filePath = getDaemonDiscoveryPath(stateDir);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
    await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await fs.rename(tempPath, filePath);
}
export async function readDaemonDiscovery(stateDir) {
    const filePath = getDaemonDiscoveryPath(stateDir);
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8"));
    return normalizeDiscovery(parsed);
}
export function readDaemonDiscoverySync(stateDir) {
    const filePath = getDaemonDiscoveryPath(stateDir);
    const parsed = JSON.parse(fsSync.readFileSync(filePath, "utf8"));
    return normalizeDiscovery(parsed);
}
function normalizeDiscovery(parsed) {
    const discovery = validateDiscovery(parsed);
    if (!isPidAlive(discovery.pid)) {
        throw new Error(`Stale daemon discovery: pid ${discovery.pid} is not alive`);
    }
    return discovery;
}
function validateDiscovery(value) {
    const url = validateDiscoveryUrl(value.url);
    if (typeof value.pid !== "number" || !Number.isInteger(value.pid)) {
        throw new Error("Invalid daemon discovery: missing pid");
    }
    if (typeof value.startedAt !== "string" || !value.startedAt) {
        throw new Error("Invalid daemon discovery: missing startedAt");
    }
    validateCanonicalStartedAt(value.startedAt);
    if (typeof value.version !== "string" || !value.version) {
        throw new Error("Invalid daemon discovery: missing version");
    }
    return {
        url,
        pid: value.pid,
        startedAt: value.startedAt,
        version: value.version,
        token: validateDiscoveryToken(value.token)
    };
}
function validateDiscoveryToken(value) {
    if (value === undefined) {
        return undefined;
    }
    if (typeof value !== "string" || !value.trim()) {
        throw new Error("Invalid daemon discovery: invalid token");
    }
    return value;
}
function validateDiscoveryUrl(value) {
    if (typeof value !== "string" || !value.trim()) {
        throw new Error("Invalid daemon discovery: missing url");
    }
    let parsed;
    try {
        parsed = new URL(value);
    }
    catch {
        throw new Error("Invalid daemon discovery: invalid url");
    }
    if (parsed.protocol !== "http:") {
        throw new Error("Invalid daemon discovery: unsupported url protocol");
    }
    if (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost") {
        throw new Error("Invalid daemon discovery: unsupported url host");
    }
    return parsed.origin;
}
function validateCanonicalStartedAt(value) {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
        throw new Error("Invalid daemon discovery: invalid startedAt");
    }
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
        throw new Error("Invalid daemon discovery: invalid startedAt");
    }
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
//# sourceMappingURL=discovery.js.map