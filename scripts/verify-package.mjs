import { readFile } from 'node:fs/promises';
import path from 'node:path';

function fail(message) {
  console.error(`verify-package: ${message}`);
  process.exit(1);
}

function getArg(name) {
  const index = process.argv.indexOf(name);
  if (index === -1 || index === process.argv.length - 1) return null;
  return process.argv[index + 1];
}

const packJsonPath = getArg('--pack-json');
if (!packJsonPath) {
  fail('missing required --pack-json <path> argument');
}

const root = process.cwd();
const packageLockPath = path.join(root, 'package-lock.json');
try {
  await readFile(packageLockPath, 'utf8');
  fail('package-lock.json must not exist (pnpm-only repository)');
} catch (error) {
  if (error && error.code !== 'ENOENT') {
    throw error;
  }
}

const raw = await readFile(packJsonPath, 'utf8');
let parsed;
try {
  parsed = JSON.parse(raw);
} catch {
  fail(`invalid JSON in ${packJsonPath}`);
}

const packResult = Array.isArray(parsed) ? parsed[0] : parsed;
if (!packResult || !Array.isArray(packResult.files)) {
  fail('pack JSON did not include files array');
}

const fileList = new Set(packResult.files.map((entry) => entry.path));

const requiredExact = ['dist/cli.js', 'dist/mcp.js', 'dist/daemon.js', 'docs/VERIFICATION.md', 'docs/OPENCODE_BACKEND.md'];
for (const file of requiredExact) {
  if (!fileList.has(file)) {
    fail(`package is missing required file: ${file}`);
  }
}

const requiredPrefixes = ['dist/backends/'];
for (const prefix of requiredPrefixes) {
  if (![...fileList].some((file) => file.startsWith(prefix))) {
    fail(`package is missing required runtime files under: ${prefix}**`);
  }
}

console.log('verify-package: package guardrails OK');
