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
- Daemon suite covers `GET /health`, HTTP `run` -> `wait` -> `result`, structured route errors, package `supervisor-daemon` bin exposure, and CLI delegation through `SUPERVISOR_DAEMON_URL`.
- MCP suite covers stable Claude tool names, direct server construction, explicit daemon-backed supervisor construction, and MCP client tool calls through daemon RPC.

## Service Lifecycle Design Baseline

Date: 2026-05-04

Milestone:

- Manual foreground daemon start remains the current recommended lifecycle.
- `docs/SERVICE_LIFECYCLE.md` explains how to start, inspect, use, and stop the daemon.
- The design compares manual daemon, Windows service, Windows scheduled task, systemd user service, and shell startup script.
- Windows service, scheduled task, systemd unit, and shell startup installation are not automated.
- Future service installation must be explicit, inspectable, and reversible.

Verified commands:

```bash
npm run typecheck
npm test
npm run build
```

Observed Windows result:

- `npm run typecheck` passed.
- `npm test` passed with 13 test files and 45 tests.
- `npm run build` passed.

Observed WSL/Linux result from a fresh clone:

- `npm ci` passed.
- `npm run typecheck` passed.
- `npm test` passed with 13 test files and 45 tests.
- `npm run build` passed.

## Durable State Reconciliation Baseline

Date: 2026-05-04

Milestone:

- New `meta.json` writes include `schemaVersion: 1`.
- Old job metadata without `schemaVersion` remains readable.
- Running metadata with a missing PID is reconciled to `orphaned`.
- Running metadata with a live PID not owned by the current supervisor instance is reconciled to `abandoned`.
- `abandoned` jobs do not count against current supervisor concurrency limits.
- Cleanup reports temp JSON files removed as part of terminal job directory removal.
- Cleanup preserves temp JSON files under running job directories.

Verified commands:

```bash
npm run typecheck
npm test
npm run build
```

Observed Windows result:

- `npm run typecheck` passed.
- `npm test` passed with 13 test files and 45 tests.
- `npm run build` passed.

Observed WSL/Linux result from a fresh clone:

- `npm ci` passed.
- `npm run typecheck` passed.
- `npm test` passed with 13 test files and 45 tests.
- `npm run build` passed.

## Explicit Daemon Discovery Baseline

Date: 2026-05-04

Milestone:

- Daemon discovery metadata is stored at `<stateDir>/daemon.json`.
- Discovery metadata includes `url`, `pid`, `startedAt`, and `version`.
- Discovery reads reject stale PID metadata.
- `supervisor-daemon` writes discovery metadata after binding.
- CLI uses discovery only with `--discover-daemon` or `SUPERVISOR_DAEMON_DISCOVERY=1`.
- MCP uses discovery only with `SUPERVISOR_DAEMON_DISCOVERY=1`.
- Direct fallback remains available when URL/discovery is not configured.

Verified commands:

```bash
npm run typecheck
npm test
npm run build
```

Observed Windows result:

- `npm run typecheck` passed.
- `npm test` passed with 13 test files and 42 tests.
- `npm run build` passed.

Observed WSL/Linux result from a fresh clone:

- `npm ci` passed.
- `npm run typecheck` passed.
- `npm test` passed with 13 test files and 42 tests.
- `npm run build` passed.

## Daemon RPC Contract Baseline

Date: 2026-05-04

Milestone:

- Daemon errors return `{ "error": { "code": string, "message": string } }`.
- Unknown routes return HTTP `404` with `code: "not_found"`.
- Malformed JSON returns HTTP `400` with `code: "bad_json"`.
- Invalid request bodies return HTTP `400` with `code: "invalid_request"`.
- Oversized JSON bodies return HTTP `413` with `code: "body_too_large"`.
- `GET /health` returns `status`, `version`, `pid`, and `stateDir`.
- `DaemonClient` can read both old string errors and the new structured error shape.

Verified commands:

```bash
npm run typecheck
npm test
npm run build
```

Observed Windows result:

- `npm run typecheck` passed.
- `npm test` passed with 12 test files and 36 tests.
- `npm run build` passed.

Observed WSL/Linux result from a fresh clone:

- `npm ci` passed.
- `npm run typecheck` passed.
- `npm test` passed with 12 test files and 36 tests.
- `npm run build` passed.

## MCP Daemon Adapter Baseline

Date: 2026-05-04

Milestone:

- `SupervisorApi` is the shared boundary implemented by `ClaudeSupervisor` and `DaemonClient`.
- MCP constructs a daemon-backed supervisor when `SUPERVISOR_DAEMON_URL` is set.
- MCP keeps direct in-process supervisor fallback when `SUPERVISOR_DAEMON_URL` is not set.
- MCP tool names and JSON text response shape remain unchanged.
- An in-memory MCP client/server test calls `claude_run`, `claude_wait`, and `claude_result` through daemon RPC with fake Claude.

Verified commands:

```bash
npm run typecheck
npm test
npm run build
```

Observed Windows result:

- `npm run typecheck` passed.
- `npm test` passed with 11 test files and 31 tests.
- `npm run build` passed.

Observed WSL/Linux result from a fresh clone:

- `npm ci` passed.
- `npm run typecheck` passed.
- `npm test` passed with 11 test files and 31 tests.
- `npm run build` passed.

## Daemon Baseline

Date: 2026-05-04

Milestone:

- `supervisor-daemon` is exposed as `./dist/daemon.js`.
- The daemon binds to `127.0.0.1` by default.
- The daemon prints one JSON readiness line after binding.
- The daemon exposes JSON endpoints for the existing job operations.
- CLI direct mode remains the default.
- CLI delegates to daemon RPC only when `SUPERVISOR_DAEMON_URL` or `--daemon-url` is set.

Verified commands:

```bash
npm run typecheck
npm test
npm run build
```

Observed Windows result:

- `npm run typecheck` passed.
- `npm test` passed with 10 test files and 28 tests.
- `npm run build` passed.

Observed WSL/Linux result from a fresh clone:

- `npm ci` passed.
- `npm run typecheck` passed.
- `npm test` passed with 10 test files and 28 tests.
- `npm run build` passed.

Remaining daemon limitations:

- No auto-start.
- No Windows service or systemd unit.
- No auth token or socket discovery.
- MCP still constructs an in-process `ClaudeSupervisor`; MCP-to-daemon migration is a later milestone.

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
