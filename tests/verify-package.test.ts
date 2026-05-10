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
        { path: "docs/LONG_TERM_VISION.md" },
        { path: "docs/backends/OPENCODE.md" },
        { path: "docs/development/SOURCE_INSTALL.md" },
        { path: "docs/deployment/PLUGIN_DEPLOYMENT.md" },
        { path: "docs/integrations/HERMES.md" },
        { path: "docs/release/0.1.0_HARDENING_ISSUES.md" },
        { path: "docs/release/0.1.0_RELEASE_PLAN.md" },
        { path: "docs/VERIFICATION.md" },
        { path: "docs/architecture/PROJECT_BOUNDARY.md" },
        { path: ".agents/plugins/marketplace.json" },
        { path: "plugins/retinue/.codex-plugin/plugin.json" },
        { path: "plugins/retinue/.mcp.json" },
        { path: "plugins/retinue/skills/retinue/SKILL.md" },
        { path: "integrations/hermes/mcp-retinue.yaml" },
        { path: "integrations/hermes/skills/retinue/SKILL.md" },
        { path: "plugins/retinue/dist/backends/opencode/backend.js" },
        { path: "plugins/retinue/dist/core/retinue.js" },
        { path: "plugins/retinue/dist/daemon/client.js" },
        { path: "plugins/retinue/dist/mcp.js" },
        { path: "dist/backends/opencode/backend.js" },
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
    writeFileSync(packJsonPath, JSON.stringify([{ files: [{ path: "README.md" }, { path: "docs/backends/OPENCODE.md" }] }]));

    const result = spawnSync(process.execPath, [scriptPath, packJsonPath], { cwd: dir, encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("missing required runtime pattern");
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
});
