import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const scriptPath = path.resolve("scripts/verify-package.mjs");

function validPackJson() {
  return JSON.stringify([
    {
      files: [
        { path: "README.md" },
        { path: "README.en.md" },
        { path: "docs/README.md" },
        { path: "docs/get-started/quick-start.md" },
        { path: "docs/how-to/install-plugin.md" },
        { path: "docs/how-to/source-install.md" },
        { path: "docs/how-to/integrate-hermes.md" },
        { path: "docs/how-to/verify.md" },
        { path: "docs/reference/configuration.md" },
        { path: "docs/reference/mcp-tools.md" },
        { path: "docs/reference/diagnostics.md" },
        { path: "docs/reference/backends/opencode.md" },
        { path: "docs/reference/backends/claude-code.md" },
        { path: "docs/reference/backends/kilo.md" },
        { path: "docs/explanation/project-boundary.md" },
        { path: "docs/explanation/spawn-semantics.md" },
        { path: "docs/project/release-plans/0.2.0.md" },
        { path: "docs/releases/v0.2.0.md" },
        { path: "docs/releases/v0.2.0.zh-CN.md" },
        { path: ".agents/plugins/marketplace.json" },
        { path: "plugins/retinue/.codex-plugin/plugin.json" },
        { path: "plugins/retinue/.mcp.json" },
        { path: "plugins/retinue/mcp-bootstrap.mjs" },
        { path: "plugins/retinue/skills/retinue/SKILL.md" },
        { path: "integrations/hermes/mcp-retinue.yaml" },
        { path: "integrations/hermes/skills/retinue/SKILL.md" },
        { path: "plugins/retinue/dist/backends/opencode/backend.js" },
        { path: "plugins/retinue/dist/core/retinue.js" },
        { path: "plugins/retinue/dist/cli.js" },
        { path: "plugins/retinue/dist/daemon.js" },
        { path: "plugins/retinue/dist/daemon/client.js" },
        { path: "plugins/retinue/dist/mcp.js" },
        { path: "dist/backends/opencode/backend.js" },
        { path: "dist/core/retinue.js" },
        { path: "dist/cli.js" },
        { path: "dist/mcp.js" },
        { path: "dist/daemon.js" }
      ]
    }
  ]);
}

describe("verify-package script", () => {
  it("passes on valid pack output and no package-lock", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "verify-package-pass-"));
    const packJsonPath = path.join(dir, "pack.json");
    writeFileSync(packJsonPath, validPackJson());

    const result = spawnSync(process.execPath, [scriptPath, packJsonPath], { cwd: dir, encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Package verification passed.");
  });

  it("fails when package-lock.json exists", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "verify-package-lock-"));
    const packJsonPath = path.join(dir, "pack.json");
    writeFileSync(packJsonPath, validPackJson());
    writeFileSync(path.join(dir, "package-lock.json"), "{}");

    const result = spawnSync(process.execPath, [scriptPath, packJsonPath], { cwd: dir, encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("package-lock.json must not exist");
  });

  it("fails when runtime files are missing", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "verify-package-missing-runtime-"));
    const packJsonPath = path.join(dir, "pack.json");
    writeFileSync(packJsonPath, JSON.stringify([{ files: [{ path: "README.md" }, { path: "docs/reference/backends/opencode.md" }] }]));

    const result = spawnSync(process.execPath, [scriptPath, packJsonPath], { cwd: dir, encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("missing required runtime pattern");
  });

  it("fails when root core runtime files are missing", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "verify-package-missing-core-runtime-"));
    const packJsonPath = path.join(dir, "pack.json");
    const parsed = JSON.parse(validPackJson()) as Array<{ files: Array<{ path: string }> }>;
    parsed[0].files = parsed[0].files.filter((entry) => !entry.path.startsWith("dist/core/"));
    writeFileSync(packJsonPath, JSON.stringify(parsed));

    const result = spawnSync(process.execPath, [scriptPath, packJsonPath], { cwd: dir, encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("missing required runtime pattern: dist/core/");
  });

  it("fails when plugin-local runtime files are missing", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "verify-package-missing-plugin-runtime-"));
    const packJsonPath = path.join(dir, "pack.json");
    const parsed = JSON.parse(validPackJson()) as Array<{ files: Array<{ path: string }> }>;
    parsed[0].files = parsed[0].files.filter((entry) => !entry.path.startsWith("plugins/retinue/dist/"));
    writeFileSync(packJsonPath, JSON.stringify(parsed));

    const result = spawnSync(process.execPath, [scriptPath, packJsonPath], { cwd: dir, encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("missing required plugin runtime pattern");
  });

  it("fails when plugin-local CLI and daemon entrypoints are missing", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "verify-package-missing-plugin-entrypoints-"));
    const packJsonPath = path.join(dir, "pack.json");
    const parsed = JSON.parse(validPackJson()) as Array<{ files: Array<{ path: string }> }>;
    parsed[0].files = parsed[0].files.filter((entry) => entry.path !== "plugins/retinue/dist/cli.js" && entry.path !== "plugins/retinue/dist/daemon.js");
    writeFileSync(packJsonPath, JSON.stringify(parsed));

    const result = spawnSync(process.execPath, [scriptPath, packJsonPath], { cwd: dir, encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("missing required plugin runtime pattern: plugins/retinue/dist/cli.");
  });
});
