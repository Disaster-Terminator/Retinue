#!/usr/bin/env node
import fs from "node:fs/promises";

const REQUIRED_PATTERNS = [
  "dist/backends/**",
  "dist/cli.*",
  "dist/mcp.*",
  "dist/daemon.*"
];

const REQUIRED_DOCS = ["README.md", "docs/OPENCODE_BACKEND.md", "docs/VERIFICATION.md", "docs/PROJECT_BOUNDARY.md"];

function fail(message) {
  throw new Error(message);
}

function parsePackEntries(raw) {
  const parsed = JSON.parse(raw);
  const payload = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!payload || !Array.isArray(payload.files)) {
    fail("Invalid pnpm pack JSON: expected an object with a files array.");
  }
  return new Set(payload.files.map((entry) => entry.path));
}

function hasRuntimeFile(paths, prefix) {
  for (const filePath of paths) {
    if (filePath.startsWith(prefix)) {
      return true;
    }
  }
  return false;
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

async function main() {
  const lockFileExists = await fs
    .access("package-lock.json")
    .then(() => true)
    .catch(() => false);
  if (lockFileExists) {
    fail("package-lock.json must not exist in this pnpm-managed repository.");
  }

  const packJsonPath = process.argv[2];
  const raw = packJsonPath ? await fs.readFile(packJsonPath, "utf8") : await readStdin();
  const packedPaths = parsePackEntries(raw);

  for (const pattern of REQUIRED_PATTERNS) {
    if (![...packedPaths].some((p) => p.startsWith(pattern.replace("**", "")) || p.startsWith(pattern.replace(".*", ".")))) {
      fail(`Packed files are missing required runtime pattern: ${pattern}`);
    }
  }

  if (!hasRuntimeFile(packedPaths, "dist/backends/")) {
    fail("Packed files are missing dist/backends runtime artifacts.");
  }
  if (![...packedPaths].some((p) => p.startsWith("dist/cli."))) {
    fail("Packed files are missing dist/cli runtime artifact.");
  }
  if (![...packedPaths].some((p) => p.startsWith("dist/mcp."))) {
    fail("Packed files are missing dist/mcp runtime artifact.");
  }
  if (![...packedPaths].some((p) => p.startsWith("dist/daemon."))) {
    fail("Packed files are missing dist/daemon runtime artifact.");
  }

  for (const doc of REQUIRED_DOCS) {
    if (!packedPaths.has(doc)) {
      fail(`Packed files are missing required documentation file: ${doc}`);
    }
  }

  console.log("Package verification passed.");
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
