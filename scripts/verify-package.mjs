#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";

const requiredDocs = [
  "README.md",
  "docs/OPENCODE_BACKEND.md",
  "docs/VERIFICATION.md",
  "docs/PROJECT_BOUNDARY.md"
];

const requiredRuntimePatterns = ["dist/backends/", "dist/cli.", "dist/mcp.", "dist/daemon."];

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (existsSync("package-lock.json")) {
  fail("package-lock.json must not exist");
}

const packJsonPath = process.argv[2];
const source = packJsonPath ? readFileSync(packJsonPath, "utf8") : readFileSync(0, "utf8");

let parsed;
try {
  parsed = JSON.parse(source);
} catch {
  fail("could not parse pnpm pack --dry-run --json output");
}

const files = Array.isArray(parsed) ? parsed[0]?.files : parsed?.files;
if (!Array.isArray(files)) {
  fail("pack output must include an array entry with files");
}

const packagedPaths = new Set(files.map((entry) => entry?.path).filter((value) => typeof value === "string"));

for (const requiredRuntimePattern of requiredRuntimePatterns) {
  const hasPattern = [...packagedPaths].some((item) => item.includes(requiredRuntimePattern));
  if (!hasPattern) {
    fail(`missing required runtime pattern: ${requiredRuntimePattern}`);
  }
}

for (const requiredDoc of requiredDocs) {
  if (!packagedPaths.has(requiredDoc)) {
    fail(`missing required doc: ${requiredDoc}`);
  }
}

console.log("Package verification passed.");
