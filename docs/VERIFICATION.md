# Verification Notes

This document records the current hardening baseline. Keep it factual and update it when the contract changes.

## Deterministic Suites

Run these before any real Claude Code integration test:

```bash
npm run typecheck
npm test
npm run build
```

Current baseline:

- Windows: `npm run typecheck`, `npm test`, and `npm run build` pass.
- WSL/Linux: fresh clone, `npm ci`, `npm run typecheck`, `npm test`, and `npm run build` pass.
- Fake Claude suite covers spawn/close/error ordering, permission mode validation, atomic state writes, structured `not_found` and `corrupted` states, disk-backed concurrency, durable kill status, and running-job peek/tail.

## Real Windows Claude Code Probe

Date: 2026-05-03

Environment:

- `claude.exe` resolved from `C:\Users\Disas\.local\bin\claude.exe`.
- Claude Code settings contained `ANTHROPIC_AUTH_TOKEN=PROXY_MANAGED`.
- Claude Code settings contained `ANTHROPIC_BASE_URL=http://127.0.0.1:15723`.
- `Test-NetConnection 127.0.0.1 -Port 15723` returned `TcpTestSucceeded: True`.

Probe:

```bash
node dist/cli.js run --cwd . --prompt "Reply exactly: SUPERVISOR_REAL_OK"
node dist/cli.js wait <jobId> --timeout-ms 90000
node dist/cli.js result <jobId>
```

Observed result:

- Job reached `completed`.
- Exit code was `0`.
- Parsed Claude result was `SUPERVISOR_REAL_OK`.
- `sessionId` was persisted from Claude JSON output.
- stdout and stderr artifact paths were returned.

This verifies the supervisor boundary: it calls the system `claude` command and lets the existing Claude Code configuration decide provider/routing behavior. The project does not call or configure cc-switch directly.

## Remaining Integration Boundary

There is no separate `cc-switch` executable on PATH in the current Windows session. The tested integration point is the Claude Code configuration managed by the local setup. If a future setup adds a distinct cc-switch CLI or daemon contract, add a separate probe here instead of teaching supervisor to route providers.
