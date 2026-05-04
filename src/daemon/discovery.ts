import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { getDaemonDiscoveryPath } from "../core/paths.js";

export interface DaemonDiscovery {
  url: string;
  pid: number;
  startedAt: string;
  version: string;
}

export async function writeDaemonDiscovery(stateDir: string, value: DaemonDiscovery): Promise<void> {
  const filePath = getDaemonDiscoveryPath(stateDir);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(tempPath, filePath);
}

export async function readDaemonDiscovery(stateDir: string): Promise<DaemonDiscovery> {
  const filePath = getDaemonDiscoveryPath(stateDir);
  const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as Partial<DaemonDiscovery>;
  const discovery = validateDiscovery(parsed);
  if (!isPidAlive(discovery.pid)) {
    throw new Error(`Stale daemon discovery: pid ${discovery.pid} is not alive`);
  }
  return discovery;
}

function validateDiscovery(value: Partial<DaemonDiscovery>): DaemonDiscovery {
  if (typeof value.url !== "string" || !value.url) {
    throw new Error("Invalid daemon discovery: missing url");
  }
  if (typeof value.pid !== "number" || !Number.isInteger(value.pid)) {
    throw new Error("Invalid daemon discovery: missing pid");
  }
  if (typeof value.startedAt !== "string" || !value.startedAt) {
    throw new Error("Invalid daemon discovery: missing startedAt");
  }
  if (typeof value.version !== "string" || !value.version) {
    throw new Error("Invalid daemon discovery: missing version");
  }
  return {
    url: value.url,
    pid: value.pid,
    startedAt: value.startedAt,
    version: value.version
  };
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
