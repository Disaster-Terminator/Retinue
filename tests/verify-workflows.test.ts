import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';

import { verifyWorkflows } from '../scripts/verify-workflows.mjs';

function writeWorkflows(root: string, ci: string, manual: string, extra = ''): string {
  const workflowsDir = join(root, '.github', 'workflows');
  mkdirSync(workflowsDir, { recursive: true });
  writeFileSync(join(workflowsDir, 'ci.yml'), ci);
  writeFileSync(join(workflowsDir, 'manual-real-probes.yml'), manual);
  writeFileSync(join(workflowsDir, 'extra.yml'), extra || 'name: extra\non:\n  workflow_dispatch:\njobs: {}\n');
  return root;
}

describe('verifyWorkflows', () => {
  it('passes for the current repository workflows', () => {
    expect(verifyWorkflows()).toEqual([]);
  });

  it('fails when CI gates are missing or manual probe is unsafe', () => {
    const root = mkdtempSync(join(tmpdir(), 'workflow-check-'));
    const ci = `name: CI\non:\n  pull_request:\n  push:\njobs:\n  test:\n    steps:\n      - run: npm ci\n`;
    const manual = `name: Manual\non:\n  push:\n  workflow_dispatch:\njobs:\n  run:\n    steps:\n      - run: echo hi\n`;
    const extra = `name: bad\non:\n  pull_request:\njobs:\n  t:\n    steps:\n      - run: npm run probe:real:direct\n`;

    writeWorkflows(root, ci, manual, extra);

    const errors = verifyWorkflows(root);
    expect(errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining('npm run typecheck'),
        expect.stringContaining('npm test'),
        expect.stringContaining('npm run build'),
        expect.stringContaining('npm pack --dry-run --json'),
        expect.stringContaining('must not include pull_request, push, or schedule triggers'),
        expect.stringContaining('confirm_real_claude'),
        expect.stringContaining('quota-risk confirmation'),
        expect.stringContaining('must not run real Claude probes')
      ])
    );
  });
});
