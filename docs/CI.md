# CI Contract

This document defines which checks are authoritative for Web Codex / GPT Web PRs.

## Deterministic CI Gates (authoritative)

Run these commands in order:

1. `npm ci`
2. `npm run typecheck`
3. `npm test`
4. `npm run build`
5. `npm pack --dry-run --json`

These commands are the default CI contract for this repository.

## Test Boundary: Fake Claude vs Real Claude

- Default CI is **fake-Claude only** and is safe to run in automated environments.
- Real Claude probes are **manual-only** and may consume local Claude quota.
- Real Claude probes are useful for optional boundary validation, but they are not required CI gates for routine Web Codex PRs.

## Local Windows/WSL Verification

Windows and WSL verification remains useful for release confidence and environment checks.
It should not be required for every Web Codex PR when deterministic CI gates are green.

## PR Body Requirements for Future Codex Tasks

Future Codex PR bodies should include:

- the exact commands run
- whether real Claude was used
- whether package metadata or published bin files changed

Keep CI reporting operational and concise so reviewers can quickly evaluate merge readiness.
