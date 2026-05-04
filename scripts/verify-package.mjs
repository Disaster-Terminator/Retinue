#!/usr/bin/env node
import { readFileSync, existsSync } from 'node:fs';

const REQUIRED_BINS = {
  supervisor: 'dist/cli.js',
  'supervisor-mcp': 'dist/mcp.js',
  'supervisor-daemon': 'dist/daemon.js'
};

const REQUIRED_PACKED_PATHS = [
  'README.md',
  'docs/',
  'dist/',
  'scripts/',
  'tests/fixtures/'
];

function fail(message) {
  console.error(`❌ ${message}`);
  process.exit(1);
}

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const packOutputPath = process.argv[2] ?? 'pack-output.json';
const packJson = JSON.parse(readFileSync(packOutputPath, 'utf8'));

if (!Array.isArray(packJson) || packJson.length === 0) {
  fail('npm pack --dry-run --json output was empty or malformed');
}

const bins = packageJson.bin ?? {};
for (const [name, relativePath] of Object.entries(REQUIRED_BINS)) {
  if (bins[name] !== `./${relativePath}`) {
    fail(`package.json bin.${name} must be ./${relativePath}, got ${bins[name] ?? 'undefined'}`);
  }

  if (!existsSync(new URL(`../${relativePath}`, import.meta.url))) {
    fail(`Built bin target is missing: ${relativePath}`);
  }
}

const packedFiles = new Set(packJson[0].files?.map((file) => file.path) ?? []);
if (packedFiles.size === 0) {
  fail('Packed file list was empty in npm pack output');
}

const hasPath = (expected) => {
  if (expected.endsWith('/')) {
    return [...packedFiles].some((filePath) => filePath.startsWith(expected));
  }
  return packedFiles.has(expected);
};

for (const expected of REQUIRED_PACKED_PATHS) {
  if (!hasPath(expected)) {
    fail(`Packed file list is missing expected path coverage: ${expected}`);
  }
}

console.log('✅ Package metadata, built bins, and packed-file coverage look good.');
