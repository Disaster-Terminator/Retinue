import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const ciWorkflowPath = path.resolve(".github/workflows/ci.yml");
const packageJsonPath = path.resolve("package.json");

function loadCiWorkflow() {
  return readFileSync(ciWorkflowPath, "utf8");
}

function loadPackageJson() {
  return JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
    packageManager?: string;
    scripts?: Record<string, string>;
  };
}

describe("CI workflow guardrails", () => {
  it("uses pnpm setup and required pnpm commands", () => {
    const workflow = loadCiWorkflow();

    expect(workflow).toContain("uses: pnpm/action-setup@v4");
    expect(workflow).toContain("run: pnpm install --frozen-lockfile");
    expect(workflow).toContain("run: pnpm run typecheck");
    expect(workflow).toContain("run: pnpm test");
    expect(workflow).toContain("run: pnpm run build");
    expect(workflow).toContain("run: pnpm run verify:package");
  });

  it("does not run real probes or npm/package-lock flows", () => {
    const workflow = loadCiWorkflow();

    expect(workflow).not.toMatch(/probe:real:/);
    expect(workflow).not.toMatch(/\bnpm\s+install\b/);
    expect(workflow).not.toMatch(/\bnpm\s+ci\b/);
    expect(workflow).not.toMatch(/package-lock/i);
  });
});

describe("package.json guardrails", () => {
  it("pins pnpm as package manager and defines verify:package", () => {
    const pkg = loadPackageJson();

    expect(pkg.packageManager).toMatch(/^pnpm@/);
    expect(pkg.scripts?.["verify:package"]).toBeDefined();
  });

  it("keeps real probes explicit scripts only", () => {
    const pkg = loadPackageJson();
    const scripts = pkg.scripts ?? {};

    const realProbeScriptNames = Object.keys(scripts).filter((name) => name.startsWith("probe:real:"));

    expect(realProbeScriptNames.length).toBeGreaterThan(0);
    for (const scriptName of realProbeScriptNames) {
      expect(scriptName).toMatch(/^probe:real:/);
    }
  });
});
