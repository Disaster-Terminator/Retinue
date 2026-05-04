import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const REQUIRED_CI_COMMANDS = [
  'npm ci',
  'npm run typecheck',
  'npm test',
  'npm run build',
  'npm pack --dry-run --json'
];

function hasAnyTrigger(content, triggers) {
  return triggers.some((trigger) => new RegExp(`\\n\\s*${trigger}:`, 'm').test(content));
}

function assertContains(content, needle, message, errors) {
  if (!content.includes(needle)) {
    errors.push(message);
  }
}

export function verifyWorkflows(repoRoot = process.cwd()) {
  const errors = [];
  const workflowsDir = join(repoRoot, '.github', 'workflows');
  const ciPath = join(workflowsDir, 'ci.yml');
  const manualPath = join(workflowsDir, 'manual-real-probes.yml');

  const ciContent = readFileSync(ciPath, 'utf8');
  const manualContent = readFileSync(manualPath, 'utf8');

  for (const cmd of REQUIRED_CI_COMMANDS) {
    assertContains(ciContent, cmd, `ci.yml must include \`${cmd}\``, errors);
  }

  if (!/\bon:\s*\n\s*workflow_dispatch:/m.test(manualContent)) {
    errors.push('manual-real-probes.yml must be triggered by workflow_dispatch');
  }

  if (hasAnyTrigger(manualContent, ['pull_request', 'push', 'schedule'])) {
    errors.push('manual-real-probes.yml must not include pull_request, push, or schedule triggers');
  }

  assertContains(
    manualContent,
    'confirm_real_claude',
    'manual-real-probes.yml must require explicit confirm_real_claude input',
    errors
  );
  assertContains(
    manualContent,
    'I_UNDERSTAND_THIS_MAY_USE_REAL_CLAUDE_QUOTA',
    'manual-real-probes.yml must enforce an explicit quota-risk confirmation value',
    errors
  );

  const workflowFiles = readdirSync(workflowsDir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));

  for (const wfFile of workflowFiles) {
    const wfContent = readFileSync(join(workflowsDir, wfFile), 'utf8');
    if (!hasAnyTrigger(wfContent, ['pull_request', 'push'])) {
      continue;
    }

    if (wfContent.includes('probe:real:') || wfContent.includes('probe-real-claude.mjs')) {
      errors.push(`${wfFile} must not run real Claude probes on pull_request/push workflows`);
    }
  }

  return errors;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const errors = verifyWorkflows();
  if (errors.length > 0) {
    console.error('Workflow contract verification failed:');
    for (const error of errors) {
      console.error(`- ${error}`);
    }
    process.exit(1);
  }
  console.log('Workflow contract verification passed.');
}
