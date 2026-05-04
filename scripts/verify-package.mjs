#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const expectedBins = {
  supervisor: 'dist/cli.js',
  'supervisor-mcp': 'dist/mcp.js',
  'supervisor-daemon': 'dist/daemon.js',
};

function normalizePath(p) {
  return String(p).replace(/^\.\//, '');
}

function assert(cond, message) {
  if (!cond) {
    throw new Error(message);
  }
}

export function verifyPackageSmoke({ packageJson, lockJson, packRaw, fileExists = fs.existsSync }) {
  for (const [binName, binPath] of Object.entries(expectedBins)) {
    const packageBin = normalizePath(packageJson?.bin?.[binName] ?? '');
    assert(packageBin === binPath, `package.json bin.${binName} expected "${binPath}", got "${packageBin || '<missing>'}"`);

    const lockBin = normalizePath(lockJson?.packages?.['']?.bin?.[binName] ?? '');
    assert(lockBin === binPath, `package-lock.json root bin.${binName} expected "${binPath}", got "${lockBin || '<missing>'}"`);

    assert(fileExists(binPath), `Built bin file missing: ${binPath}`);
  }

  const trimmedPack = String(packRaw ?? '').trim();
  assert(trimmedPack, 'Expected npm pack --dry-run --json output on stdin');

  let packJson;
  try {
    packJson = JSON.parse(trimmedPack);
  } catch {
    throw new Error('Unable to parse npm pack --dry-run --json output');
  }

  assert(Array.isArray(packJson) && packJson.length > 0, 'npm pack output had no package entries');
  const files = (packJson[0]?.files ?? []).map((entry) => entry.path);
  assert(Array.isArray(files) && files.length > 0, 'npm pack output had no files list');

  const requiredExact = ['README.md', 'dist/cli.js', 'dist/mcp.js', 'dist/daemon.js'];
  for (const exact of requiredExact) {
    assert(files.includes(exact), `Packed files missing required entry: ${exact}`);
  }

  const requiredPrefixes = ['docs/', 'dist/', 'scripts/', 'tests/fixtures/'];
  for (const prefix of requiredPrefixes) {
    assert(files.some((p) => p.startsWith(prefix)), `Packed files missing expected path prefix: ${prefix}`);
  }
}

function runCli() {
  const packageJson = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const lockJson = JSON.parse(fs.readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const repoDir = path.resolve(scriptDir, '..');
  const packRaw = fs.readFileSync(0, 'utf8');

  verifyPackageSmoke({
    packageJson,
    lockJson,
    packRaw,
    fileExists: (relativePath) => fs.existsSync(path.resolve(repoDir, relativePath)),
  });

  console.log('Package smoke verification passed.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli();
}
