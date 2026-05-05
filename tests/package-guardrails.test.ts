import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

function runVerify(cwd: string, packJsonPath: string): Promise<{ code: number; output: string }> {
  return new Promise((resolve, reject) => {
    const scriptPath = path.resolve(process.cwd(), 'scripts/verify-package.mjs');
    const child = spawn(process.execPath, [scriptPath, '--pack-json', packJsonPath], { cwd });
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk.toString()));
    child.stderr.on('data', (chunk) => (output += chunk.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, output }));
  });
}

async function setupBaseTempDir() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'supervisor-pack-'));
  await mkdir(path.join(tempDir, 'docs'), { recursive: true });
  await writeFile(path.join(tempDir, 'docs', 'VERIFICATION.md'), 'x');
  await writeFile(path.join(tempDir, 'docs', 'OPENCODE_BACKEND.md'), 'x');
  return tempDir;
}

describe('package guardrails script', () => {
  it('fails when required runtime files are missing', async () => {
    const tempDir = await setupBaseTempDir();
    try {
      const packJsonPath = path.join(tempDir, 'pack.json');
      const payload = [{ files: [{ path: 'dist/cli.js' }, { path: 'dist/mcp.js' }, { path: 'dist/daemon.js' }, { path: 'docs/VERIFICATION.md' }, { path: 'docs/OPENCODE_BACKEND.md' }] }];
      await writeFile(packJsonPath, JSON.stringify(payload));
      const result = await runVerify(tempDir, packJsonPath);
      expect(result.code).toBe(1);
      expect(result.output).toContain('dist/backends/**');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('fails when package-lock.json exists', async () => {
    const tempDir = await setupBaseTempDir();
    try {
      await writeFile(path.join(tempDir, 'package-lock.json'), '{}');
      const packJsonPath = path.join(tempDir, 'pack.json');
      const payload = [{ files: [{ path: 'dist/cli.js' }, { path: 'dist/mcp.js' }, { path: 'dist/daemon.js' }, { path: 'dist/backends/opencode/backend.js' }, { path: 'docs/VERIFICATION.md' }, { path: 'docs/OPENCODE_BACKEND.md' }] }];
      await writeFile(packJsonPath, JSON.stringify(payload));
      const result = await runVerify(tempDir, packJsonPath);
      expect(result.code).toBe(1);
      expect(result.output).toContain('package-lock.json must not exist');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('passes with required package files', async () => {
    const tempDir = await setupBaseTempDir();
    try {
      const packJsonPath = path.join(tempDir, 'pack.json');
      const payload = [{ files: [{ path: 'dist/cli.js' }, { path: 'dist/mcp.js' }, { path: 'dist/daemon.js' }, { path: 'dist/backends/opencode/backend.js' }, { path: 'docs/VERIFICATION.md' }, { path: 'docs/OPENCODE_BACKEND.md' }] }];
      await writeFile(packJsonPath, JSON.stringify(payload));
      const result = await runVerify(tempDir, packJsonPath);
      expect(result.code).toBe(0);
      expect(result.output).toContain('guardrails OK');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
