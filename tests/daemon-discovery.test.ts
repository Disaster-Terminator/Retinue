import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
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

  it("fails when discovery file is missing", async () => {
    await expect(readDaemonDiscovery(tempDir)).rejects.toThrow();
  });

  it("fails when discovery file is empty", async () => {
    await fs.writeFile(getDaemonDiscoveryPath(tempDir), "\n", "utf8");
    await expect(readDaemonDiscovery(tempDir)).rejects.toThrow();
  });

  it("rejects discovery metadata with missing or empty url", async () => {
    await fs.writeFile(
      getDaemonDiscoveryPath(tempDir),
      JSON.stringify({ pid: process.pid, startedAt: "2026-05-04T00:00:00.000Z", version: "0.1.0" })
    );
    await expect(readDaemonDiscovery(tempDir)).rejects.toThrow(/url/i);

    await writeDaemonDiscovery(tempDir, {
      url: "",
      pid: process.pid,
      startedAt: "2026-05-04T00:00:00.000Z",
      version: "0.1.0"
    });
    await expect(readDaemonDiscovery(tempDir)).rejects.toThrow(/url/i);
  });

  it("rejects discovery metadata with invalid url syntax", async () => {
    await writeDaemonDiscovery(tempDir, {
      url: "http://[::1",
      pid: process.pid,
      startedAt: "2026-05-04T00:00:00.000Z",
      version: "0.1.0"
    });

    await expect(readDaemonDiscovery(tempDir)).rejects.toThrow(/url/i);
  });

  it("rejects discovery metadata with unsupported url protocol", async () => {
    await writeDaemonDiscovery(tempDir, {
      url: "file:///tmp/supervisor.sock",
      pid: process.pid,
      startedAt: "2026-05-04T00:00:00.000Z",
      version: "0.1.0"
    });

    await expect(readDaemonDiscovery(tempDir)).rejects.toThrow(/url/i);
  });

  it("rejects discovery metadata with ws url protocol", async () => {
    await writeDaemonDiscovery(tempDir, {
      url: "ws://127.0.0.1:27777",
      pid: process.pid,
      startedAt: "2026-05-04T00:00:00.000Z",
      version: "0.1.0"
    });

    await expect(readDaemonDiscovery(tempDir)).rejects.toThrow(/url/i);
  });

  it("normalizes loopback ipv4 discovery urls with a trailing slash", async () => {
    await writeDaemonDiscovery(tempDir, {
      url: "http://127.0.0.1:27777/",
      pid: process.pid,
      startedAt: "2026-05-04T00:00:00.000Z",
      version: "0.1.0"
    });

    await expect(readDaemonDiscovery(tempDir)).resolves.toMatchObject({
      url: "http://127.0.0.1:27777"
    });
  });

  it("allows loopback localhost discovery urls", async () => {
    await writeDaemonDiscovery(tempDir, {
      url: "http://localhost:27777",
      pid: process.pid,
      startedAt: "2026-05-04T00:00:00.000Z",
      version: "0.1.0"
    });

    await expect(readDaemonDiscovery(tempDir)).resolves.toMatchObject({
      url: "http://localhost:27777"
    });
  });

  it("normalizes localhost discovery urls with a trailing slash", async () => {
    await writeDaemonDiscovery(tempDir, {
      url: "http://localhost:27777/",
      pid: process.pid,
      startedAt: "2026-05-04T00:00:00.000Z",
      version: "0.1.0"
    });

    await expect(readDaemonDiscovery(tempDir)).resolves.toMatchObject({
      url: "http://localhost:27777"
    });
  });

  it("rejects non-loopback discovery hosts", async () => {
    await writeDaemonDiscovery(tempDir, {
      url: "http://example.com:27777",
      pid: process.pid,
      startedAt: "2026-05-04T00:00:00.000Z",
      version: "0.1.0"
    });

    await expect(readDaemonDiscovery(tempDir)).rejects.toThrow(/host|url/i);
  });

  it("rejects https discovery urls", async () => {
    await writeDaemonDiscovery(tempDir, {
      url: "https://127.0.0.1:27777",
      pid: process.pid,
      startedAt: "2026-05-04T00:00:00.000Z",
      version: "0.1.0"
    });

    await expect(readDaemonDiscovery(tempDir)).rejects.toThrow(/protocol|url/i);
  });

  it("rejects ipv6 loopback discovery urls", async () => {
    await writeDaemonDiscovery(tempDir, {
      url: "http://[::1]:27777",
      pid: process.pid,
      startedAt: "2026-05-04T00:00:00.000Z",
      version: "0.1.0"
    });

    await expect(readDaemonDiscovery(tempDir)).rejects.toThrow(/host|url/i);
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

  it("rejects discovery metadata with non-canonical startedAt", async () => {
    await writeDaemonDiscovery(tempDir, {
      url: "http://127.0.0.1:27777",
      pid: process.pid,
      startedAt: "2026-05-04",
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
