import { describe, expect, it } from "vitest";
import { verifyPackageSmoke } from "../scripts/verify-package.mjs";

const validPackageJson = {
  bin: {
    supervisor: "dist/cli.js",
    "supervisor-mcp": "dist/mcp.js",
    "supervisor-daemon": "dist/daemon.js"
  }
};

const validLockJson = {
  packages: {
    "": {
      bin: {
        supervisor: "dist/cli.js",
        "supervisor-mcp": "dist/mcp.js",
        "supervisor-daemon": "dist/daemon.js"
      }
    }
  }
};

const validPackRaw = JSON.stringify([
  {
    files: [
      { path: "README.md" },
      { path: "dist/cli.js" },
      { path: "dist/mcp.js" },
      { path: "dist/daemon.js" },
      { path: "docs/CI.md" },
      { path: "scripts/verify-package.mjs" },
      { path: "tests/fixtures/fake-claude.mjs" }
    ]
  }
]);

describe("verify-package script", () => {
  it("passes for valid package metadata and pack output", () => {
    expect(() => verifyPackageSmoke(baseInputs())).not.toThrow();
  });

  it("fails when supervisor bin is missing", () => {
    const packageJson = structuredClone(validPackageJson);
    delete packageJson.bin.supervisor;
    expectError(
      () => verifyPackageSmoke(baseInputs({ packageJson })),
      "package.json bin.supervisor expected \"dist/cli.js\", got \"<missing>\""
    );
  });

  it("fails when supervisor-mcp bin is missing", () => {
    const packageJson = structuredClone(validPackageJson);
    delete packageJson.bin["supervisor-mcp"];
    expectError(
      () => verifyPackageSmoke(baseInputs({ packageJson })),
      "package.json bin.supervisor-mcp expected \"dist/mcp.js\", got \"<missing>\""
    );
  });

  it("fails when supervisor-daemon bin is missing", () => {
    const lockJson = structuredClone(validLockJson);
    delete lockJson.packages[""].bin["supervisor-daemon"];
    expectError(
      () => verifyPackageSmoke(baseInputs({ lockJson })),
      "package-lock.json root bin.supervisor-daemon expected \"dist/daemon.js\", got \"<missing>\""
    );
  });

  it("fails when a built dist entrypoint is missing", () => {
    expectError(() => verifyPackageSmoke(baseInputs({ fileExists: (p) => p !== "dist/mcp.js" })), "Built bin file missing: dist/mcp.js");
  });

  it("fails when README package file is missing", () => {
    const files = packFiles().filter((file) => file.path !== "README.md");
    expectError(
      () => verifyPackageSmoke(baseInputs({ packRaw: JSON.stringify([{ files }]) })),
      "Packed files missing required entry: README.md"
    );
  });

  it("fails when docs package files are missing", () => {
    const files = packFiles().filter((file) => !file.path.startsWith("docs/"));
    expectError(
      () => verifyPackageSmoke(baseInputs({ packRaw: JSON.stringify([{ files }]) })),
      "Packed files missing expected path prefix: docs/"
    );
  });

  it("fails for malformed npm pack json", () => {
    expectError(() => verifyPackageSmoke(baseInputs({ packRaw: "not-json" })), "Unable to parse npm pack --dry-run --json output");
  });

  it("fails for empty npm pack stdin", () => {
    expectError(() => verifyPackageSmoke(baseInputs({ packRaw: "   " })), "Expected npm pack --dry-run --json output on stdin");
  });

  it("fails for empty npm pack entries", () => {
    expectError(() => verifyPackageSmoke(baseInputs({ packRaw: "[]" })), "npm pack output had no package entries");
  });
});

function baseInputs(overrides: Partial<Parameters<typeof verifyPackageSmoke>[0]> = {}): Parameters<typeof verifyPackageSmoke>[0] {
  return {
    packageJson: structuredClone(validPackageJson),
    lockJson: structuredClone(validLockJson),
    packRaw: validPackRaw,
    fileExists: () => true,
    ...overrides
  };
}

function packFiles(): Array<{ path: string }> {
  return [
    { path: "README.md" },
    { path: "dist/cli.js" },
    { path: "dist/mcp.js" },
    { path: "dist/daemon.js" },
    { path: "docs/CI.md" },
    { path: "scripts/verify-package.mjs" },
    { path: "tests/fixtures/fake-claude.mjs" }
  ];
}

function expectError(fn: () => void, message: string) {
  expect(fn).toThrowError(message);
}
