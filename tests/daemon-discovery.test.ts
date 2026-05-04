import { beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getDaemonDiscoveryPath } from "../src/core/paths.js";
import { readDaemonDiscovery, writeDaemonDiscovery } from "../src/daemon/discovery.js";

describe("daemon discovery", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "supervisor-discovery-test-"));
  });

  it("stores discovery metadata at the state directory root", () => {
    expect(getDaemonDiscoveryPath(tempDir)).toBe(path.join(tempDir, "daemon.json"));
  });

  it("writes and reads daemon discovery metadata", async () => {
    await writeDaemonDiscovery(tempDir, {
      url: "http://127.0.0.1:27777",
      pid: process.pid,
      startedAt: "2026-05-04T00:00:00.000Z",
      version: "0.1.0"
    });

    await expect(readDaemonDiscovery(tempDir)).resolves.toMatchObject({
      url: "http://127.0.0.1:27777",
      pid: process.pid,
      version: "0.1.0"
    });
  });


  it("rejects discovery metadata with invalid startedAt", async () => {
    await writeDaemonDiscovery(tempDir, {
      url: "http://127.0.0.1:27777",
      pid: process.pid,
      startedAt: "not-a-date",
      version: "0.1.0"
    });

    await expect(readDaemonDiscovery(tempDir)).rejects.toThrow(/startedAt/i);
  });

  it("rejects stale daemon discovery metadata", async () => {
    await writeDaemonDiscovery(tempDir, {
      url: "http://127.0.0.1:27777",
      pid: 99999999,
      startedAt: "2026-05-04T00:00:00.000Z",
      version: "0.1.0"
    });

    await expect(readDaemonDiscovery(tempDir)).rejects.toThrow(/stale/i);
  });
});
