import { describe, expect, it, vi, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DaemonClient } from "../src/daemon/client.js";
import { readTextTailIfExists } from "../src/core/fileTail.js";
import { auditRetinueLogs } from "../src/core/logAudit.js";
import { assertAgentMessageWithinLimit } from "../src/mcp.js";

describe("security regressions", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects direct daemon URLs that are not loopback before sending bearer tokens", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ status: "ok" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    expect(() => new DaemonClient("http://example.com:27777", { token: "secret-token" })).toThrow(/daemon url/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("caps explicit text-tail byte counts", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "retinue-tail-cap-"));
    try {
      const logPath = path.join(tempDir, "stdout.log");
      await fs.writeFile(logPath, "a".repeat(2 * 1024 * 1024), "utf8");

      const tail = await readTextTailIfExists(logPath, Number.MAX_SAFE_INTEGER);

      expect(Buffer.byteLength(tail.text, "utf8")).toBeLessThanOrEqual(1024 * 1024);
      expect(tail.truncated).toBe(true);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("caps explicit audit log byte and line counts", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "retinue-audit-cap-"));
    try {
      const tracePath = path.join(tempDir, "retinue.jsonl");
      await fs.writeFile(tracePath, `${JSON.stringify({ time: "2026-01-01T00:00:00.000Z", jobId: "job_1", status: "running" })}\n`, "utf8");

      const audit = await auditRetinueLogs({
        stateDir: tempDir,
        tracePath,
        maxBytes: Number.MAX_SAFE_INTEGER,
        maxLines: Number.MAX_SAFE_INTEGER
      });

      expect(audit.ok).toBe(true);
      expect(audit.effectiveMaxBytes).toBeLessThanOrEqual(256 * 1024 * 1024);
      expect(audit.effectiveMaxLines).toBeLessThanOrEqual(200_000);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("ignores log-derived job ids that are not safe Retinue job ids", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "retinue-audit-jobid-"));
    try {
      const tracePath = path.join(tempDir, "retinue.jsonl");
      await fs.writeFile(
        tracePath,
        `${JSON.stringify({ time: "2026-01-01T00:00:00.000Z", jobId: "../evil", status: "running" })}\n`,
        "utf8"
      );

      await expect(auditRetinueLogs({ stateDir: tempDir, tracePath })).resolves.toMatchObject({ ok: true });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects oversized MCP agent messages before they are queued or persisted", () => {
    expect(() => assertAgentMessageWithinLimit("a".repeat(1024 * 1024 + 1))).toThrow(/message/i);
  });
});
