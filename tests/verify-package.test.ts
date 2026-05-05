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
        { path: "docs/OPENCODE_BACKEND.md" },
        { path: "docs/VERIFICATION.md" },
        { path: "docs/PROJECT_BOUNDARY.md" },
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
    writeFileSync(packJsonPath, JSON.stringify([{ files: [{ path: "README.md" }, { path: "docs/OPENCODE_BACKEND.md" }] }]));

    const result = spawnSync(process.execPath, [scriptPath, packJsonPath], { cwd: dir, encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("missing required runtime pattern");
  });
});
