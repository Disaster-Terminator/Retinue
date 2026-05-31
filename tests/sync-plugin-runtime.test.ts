import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const execFileAsync = promisify(execFile);
const scriptPath = path.resolve("scripts/sync-plugin-runtime.mjs");

describe("plugin runtime sync", () => {
  it("survives concurrent build syncs", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "retinue-sync-runtime-"));
    try {
      await fs.mkdir(path.join(tempDir, "dist", "core"), { recursive: true });
      await fs.mkdir(path.join(tempDir, "src"), { recursive: true });
      await fs.writeFile(path.join(tempDir, "dist", "core", "marker.js"), "export const marker = true;\n", "utf8");
      await fs.writeFile(path.join(tempDir, "src", "mcp.ts"), "export const mcp = 'ok';\n", "utf8");

      const runs = await Promise.allSettled(
        Array.from({ length: 8 }, () => execFileAsync(process.execPath, [scriptPath], { cwd: tempDir, timeout: 30_000 }))
      );

      expect(runs).toHaveLength(8);
      for (const run of runs) {
        expect(run.status === "fulfilled" ? run.value.stderr : run.reason.stderr).toBe("");
        expect(run.status).toBe("fulfilled");
      }
      await expect(fs.access(path.join(tempDir, "plugins", "retinue", "dist", "core", "marker.js"))).resolves.toBeUndefined();
      await expect(fs.access(path.join(tempDir, "plugins", "retinue", "dist", "mcp.js"))).resolves.toBeUndefined();
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
