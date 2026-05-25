#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";

const requiredDocs = [
  "README.md",
  "README.en.md",
  "docs/README.md",
  "docs/LONG_TERM_VISION.md",
  "docs/backends/OPENCODE.md",
  "docs/development/SOURCE_INSTALL.md",
  "docs/deployment/PLUGIN_DEPLOYMENT.md",
  "docs/integrations/HERMES.md",
  "docs/release/0.1.0_HARDENING_ISSUES.md",
  "docs/release/0.1.0_RELEASE_PLAN.md",
  "docs/release/0.2.0_RELEASE_PLAN.md",
  "docs/release/v0.2.0_RELEASE_NOTES.md",
  "docs/release/v0.2.0_RELEASE_NOTES.zh-CN.md",
  "docs/VERIFICATION.md",
  "docs/architecture/PROJECT_BOUNDARY.md"
];

const requiredPluginFiles = [
  ".agents/plugins/marketplace.json",
  "plugins/retinue/.codex-plugin/plugin.json",
  "plugins/retinue/.mcp.json",
  "plugins/retinue/mcp-bootstrap.mjs",
  "plugins/retinue/skills/retinue/SKILL.md",
  "integrations/hermes/mcp-retinue.yaml",
  "integrations/hermes/skills/retinue/SKILL.md",
  "plugins/retinue/dist/mcp.js"
];

const requiredRuntimePatterns = ["dist/backends/", "dist/core/", "dist/cli.", "dist/mcp.", "dist/daemon."];
const requiredPluginRuntimePatterns = [
  "plugins/retinue/dist/backends/",
  "plugins/retinue/dist/core/",
  "plugins/retinue/dist/cli.",
  "plugins/retinue/dist/daemon.",
  "plugins/retinue/dist/daemon/",
  "plugins/retinue/dist/mcp."
];

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
  const hasPattern = [...packagedPaths].some((item) => item.startsWith(requiredRuntimePattern));
  if (!hasPattern) {
    fail(`missing required runtime pattern: ${requiredRuntimePattern}`);
  }
}

for (const requiredPluginRuntimePattern of requiredPluginRuntimePatterns) {
  const hasPattern = [...packagedPaths].some((item) => item.startsWith(requiredPluginRuntimePattern));
  if (!hasPattern) {
    fail(`missing required plugin runtime pattern: ${requiredPluginRuntimePattern}`);
  }
}

for (const requiredDoc of requiredDocs) {
  if (!packagedPaths.has(requiredDoc)) {
    fail(`missing required doc: ${requiredDoc}`);
  }
}

for (const requiredPluginFile of requiredPluginFiles) {
  if (!packagedPaths.has(requiredPluginFile)) {
    fail(`missing required plugin file: ${requiredPluginFile}`);
  }
}

console.log("Package verification passed.");
