# CI Contract for Web Codex / GPT Web

This document defines which checks are authoritative for PR review and which probes are manual-only.

## Deterministic CI Gates (authoritative)

Use these commands as the canonical CI contract:

```bash
npm ci
npm run typecheck
npm test
npm run build
npm pack --dry-run --json
```

Notes:
- `npm ci` must install from lockfile with no local drift.
- `npm run typecheck`, `npm test`, and `npm run build` are required deterministic gates.
- `npm pack --dry-run --json` is the packaging gate for published artifact metadata and bin layout.
- Fake-Claude tests are safe and expected in default CI; they do not consume real Claude quota.

## Manual-Only Probes (non-gating)

Real Claude probes are **not** default CI gates:

- They are manual verification only.
- They may consume quota and depend on local account/runtime state.
- Failures in quota-consuming probes should not block normal Web Codex docs/code PRs by default.

See `docs/REAL_CLAUDE_PROBES.md` for details on running those probes intentionally.

## Local Windows/WSL Verification

Windows and WSL verification remains useful for confidence in local operator workflows, but it is not required for every Web Codex PR.

## What Future Codex PR Bodies Should Include

Future Codex-authored PR bodies should explicitly state:

- Commands run (copy/paste exact command list).
- Whether real Claude probes were used.
- Whether package metadata or bin-target files changed (for example `package.json`, `package-lock.json`, or `bin` mappings).

Keep this reporting operational and brief so reviewers can quickly identify deterministic coverage versus manual probe coverage.
