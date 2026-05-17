import { describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const scriptPath = path.resolve("scripts/sync-installed-plugin-cache.mjs");

describe("sync-installed-plugin-cache script", () => {
  it("dry-runs only installed Retinue cache targets", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "retinue-cache-sync-test-"));
    try {
      const sourceDir = path.join(tempDir, "source", "retinue");
      const cacheRoot = path.join(tempDir, "cache");
      createPlugin(sourceDir, { marker: "new-retinue" });
      createPlugin(path.join(cacheRoot, "retinue-local", "retinue", "0.1.0"), { marker: "old-retinue" });
      createPlugin(path.join(cacheRoot, "other-local", "other-plugin", "0.1.0"), {
        name: "other-plugin",
        marker: "old-other"
      });

      const result = spawnSync(process.execPath, [scriptPath, "--source-dir", sourceDir, "--cache-root", cacheRoot, "--json"], {
        encoding: "utf8"
      });

      expect(result.status).toBe(0);
      const output = JSON.parse(result.stdout);
      expect(output).toMatchObject({ ok: true, dryRun: true, pluginName: "retinue" });
      expect(output.targets).toHaveLength(1);
      expect(output.targets[0].targets).toEqual([
        {
          marketplace: "retinue-local",
          plugin: "retinue",
          version: "0.1.0",
          path: path.join(cacheRoot, "retinue-local", "retinue", "0.1.0")
        }
      ]);
      expect(readFileSync(path.join(cacheRoot, "retinue-local", "retinue", "0.1.0", "marker.txt"), "utf8")).toBe("old-retinue\n");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("replaces only the requested installed plugin cache target when applied", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "retinue-cache-sync-apply-test-"));
    try {
      const sourceDir = path.join(tempDir, "source", "retinue");
      const cacheRoot = path.join(tempDir, "cache");
      createPlugin(sourceDir, { marker: "new-retinue" });
      createPlugin(path.join(cacheRoot, "retinue-local", "retinue", "0.1.0"), { marker: "old-retinue" });
      createPlugin(path.join(cacheRoot, "retinue-local", "retinue", "old"), { marker: "old-version" });

      const result = spawnSync(
        process.execPath,
        [scriptPath, "--source-dir", sourceDir, "--cache-root", cacheRoot, "--version", "0.1.0", "--apply", "--json"],
        { encoding: "utf8" }
      );

      expect(result.status).toBe(0);
      const output = JSON.parse(result.stdout);
      expect(output).toMatchObject({ ok: true, dryRun: false, pluginName: "retinue" });
      expect(await readFile(path.join(cacheRoot, "retinue-local", "retinue", "0.1.0", "marker.txt"), "utf8")).toBe("new-retinue\n");
      expect(await readFile(path.join(cacheRoot, "retinue-local", "retinue", "old", "marker.txt"), "utf8")).toBe("old-version\n");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("prints compact human output by default", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "retinue-cache-sync-compact-test-"));
    try {
      const sourceDir = path.join(tempDir, "source", "retinue");
      const cacheRoot = path.join(tempDir, "cache");
      createPlugin(sourceDir, { marker: "new-retinue" });
      createPlugin(path.join(cacheRoot, "retinue-local", "retinue", "0.1.0"), { marker: "old-retinue" });

      const result = spawnSync(process.execPath, [scriptPath, "--source-dir", sourceDir, "--cache-root", cacheRoot], {
        encoding: "utf8"
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Retinue plugin cache would sync 1 target(s) for retinue");
      expect(result.stdout).toContain("retinue-local/retinue@0.1.0");
      expect(() => JSON.parse(result.stdout)).toThrow();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

function createPlugin(dir: string, options: { name?: string; marker: string }): void {
  const name = options.name ?? "retinue";
  mkdirSync(path.join(dir, ".codex-plugin"), { recursive: true });
  writeFileSync(
    path.join(dir, ".codex-plugin", "plugin.json"),
    `${JSON.stringify(
      {
        name,
        version: "0.1.0",
        description: `${name} test plugin`
      },
      null,
      2
    )}\n`
  );
  writeFileSync(path.join(dir, "mcp-bootstrap.mjs"), "#!/usr/bin/env node\n");
  writeFileSync(path.join(dir, "marker.txt"), `${options.marker}\n`);
}
