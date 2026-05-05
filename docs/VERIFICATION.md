# Verification Notes

This document records the current hardening baseline. Keep it factual and update it when the contract changes.

## Deterministic Suites

Run these before any real Claude Code integration test:

```bash
pnpm run typecheck
pnpm test
pnpm run build
```

Current baseline:

- Windows: `pnpm run typecheck`, `pnpm test`, and `pnpm run build` pass.
- WSL/Linux: fresh clone, `pnpm install --frozen-lockfile`, `pnpm run typecheck`, `pnpm test`, and `pnpm run build` pass.
- Fake Claude suite covers spawn/close/error ordering, permission mode validation, atomic state writes, structured `not_found` and `corrupted` states, disk-backed concurrency, durable kill status, and running-job peek/tail.
- Daemon suite covers `GET /health`, HTTP `run` -> `wait` -> `result`, structured route errors, package `supervisor-daemon` bin exposure, and CLI delegation through `SUPERVISOR_DAEMON_URL`.
- MCP suite covers stable Claude tool names, direct server construction, explicit daemon-backed supervisor construction, MCP client tool calls through daemon RPC, and daemon job truth after MCP adapter reconnect.

## Claude Freeze And Review Absorption Baseline

Date: 2026-05-05

Milestone:

- Claude Code is the frozen compatibility backend.
- The repository standard is pnpm with `packageManager: pnpm@10.33.2`.
- `package-lock.json` was removed and `pnpm-lock.yaml` was added.
- Only backend-neutral hardening was absorbed from `review/codex-web-nightly-2026-05-04`.
- Absorbed hardening: typed daemon client errors, daemon discovery URL/timestamp validation, read-only daemon health diagnostics, and MCP input schema validation tests.
- Probe helper tests import TypeScript helpers instead of importing the executable `.mjs` probe script directly.
- Rejected as-is: npm GitHub Actions, package-lock based package verifier, npm command documentation, and Claude Code MCP matrix as a new product direction.
- No provider/model routing and no permission bypass surface were added.

Verified commands:

```bash
pnpm run typecheck
pnpm test
pnpm run build
pnpm pack --dry-run --json
```

Observed Windows result:

- `pnpm run typecheck` passed.
- `pnpm test` passed with 15 test files and 85 tests.
- `pnpm run build` passed.
- `pnpm pack --dry-run --json` passed and included runtime entrypoints, docs, probe script, and the fake-Claude fixture.

Observed WSL/Linux result from a fresh clone:

- `pnpm install --frozen-lockfile` passed using pnpm v10.33.2.
- `pnpm run typecheck` passed.
- `pnpm test` passed with 15 test files and 85 tests.
- `pnpm run build` passed.
- Fresh clone path: `/tmp/supervisor-main-pnpm-wsl-test-L4utS4`.


## CI Guardrails (pnpm + package verification)

Date: 2026-05-05

- Default CI uses pnpm only (`pnpm/action-setup`) and installs with `pnpm install --frozen-lockfile`.
- Default CI runs `typecheck`, `test`, `build`, and `verify:package`.
- `verify:package` fails if `package-lock.json` exists.
- `verify:package` enforces packaged runtime files for `dist/backends/**`, `dist/cli.*`, `dist/mcp.*`, `dist/daemon.*`, and required docs (`docs/VERIFICATION.md`, `docs/OPENCODE_BACKEND.md`).
- Real Claude/OpenCode probes remain opt-in scripts and are not run by default CI.

## OpenCode Backend Branch Baseline

Date: 2026-05-05

Branch: `feature/spawn-opencode`

Milestone:

- Added fake OpenCode HTTP server for deterministic tests.
- Added narrow `OpenCodeClient` over loopback HTTP.
- Added `OpenCodeBackend` run/result/continue/abort/cleanup against fake OpenCode server.
- Added backend metadata fields for `backend`, `externalSessionId`, `externalServerUrl`, `externalMessageId`, `model`, `agent`, and `title`.
- Added attach/serve policy helpers. Auto-serve remains opt-in policy and is not silently started by CLI/MCP.
- Added CLI `opencode-*` commands and MCP `opencode_*` tools for explicit server attach.
- Added `dist/backends/**` to package files so OpenCode runtime is included.
- No provider/model routing and no permission bypass surface were added.

Verified commands:

```bash
pnpm run typecheck
pnpm test
pnpm run build
pnpm pack --dry-run --json
```

Observed Windows result:

- `pnpm run typecheck` passed.
- `pnpm test` passed with 18 test files and 102 tests.
- `pnpm run build` passed.
- `pnpm pack --dry-run --json` passed and included `dist/backends/**`.

Observed WSL/Linux result from a fresh clone:

- `pnpm install --frozen-lockfile` passed using pnpm v10.33.2.
- `pnpm run typecheck` passed.
- `pnpm test` passed with 18 test files and 102 tests.
- `pnpm run build` passed.
- Fresh clone path: `/tmp/supervisor-opencode-wsl-test-C7hVR1`.

## Completion Audit Baseline

Date: 2026-05-04

Milestone:

- Added deterministic coverage for MCP adapter reconnect against a daemon-owned job.
- The first MCP adapter starts a job through daemon RPC, disconnects, and a second MCP adapter waits for and reads the same job through daemon RPC.
- This proves the Codex/MCP adapter process can disconnect/reconnect without becoming the lifecycle owner.

Verified commands:

```bash
pnpm run typecheck
pnpm test
pnpm run build
pnpm pack --dry-run --json
```

Observed Windows result:

- `pnpm run typecheck` passed.
- `pnpm test` passed with 14 test files and 51 tests.
- `pnpm run build` passed.
- `pnpm pack --dry-run --json` passed with 52 package entries.

Observed WSL/Linux result from a fresh clone:

- `pnpm install --frozen-lockfile` passed.
- `pnpm run typecheck` passed.
- `pnpm test` passed with 14 test files and 51 tests.
- `pnpm run build` passed.

## User-Facing Polish Baseline

Date: 2026-05-04

Milestone:

- README includes quickstart, package entrypoints, environment variables, MCP configuration, bounded output, cleanup, and troubleshooting guidance.
- `docs/SERVICE_LIFECYCLE.md` includes PowerShell and Bash daemon inspect/stop commands.
- `package.json` uses a `files` whitelist for runtime entrypoints, docs, probe scripts, and the fake-Claude fixture.
- No service auto-start, provider routing, or permission bypass was added.

Verified commands:

```bash
pnpm run typecheck
pnpm test
pnpm run build
pnpm pack --dry-run --json
```

Observed Windows result:

- `pnpm run typecheck` passed.
- `pnpm test` passed with 14 test files and 50 tests.
- `pnpm run build` passed.
- `pnpm pack --dry-run --json` passed with 52 package entries.
- The package includes `dist/cli.js`, `dist/mcp.js`, `dist/daemon.js`, runtime `dist/core/**`, runtime `dist/daemon/**`, docs, `scripts/probe-real-claude.mjs`, and `tests/fixtures/fake-claude.mjs`.
- The package excludes stale `dist/src/**` and `dist/tests/**` build outputs.

Observed WSL/Linux result from a fresh clone:

- `pnpm install --frozen-lockfile` passed.
- `pnpm run typecheck` passed.
- `pnpm test` passed with 14 test files and 50 tests.
- `pnpm run build` passed.

## Real Probe Runner Baseline

Date: 2026-05-04

Milestone:

- `scripts/probe-real-claude.mjs` provides opt-in direct CLI, daemon CLI, and MCP-to-daemon probes.
- `pnpm run probe:real:direct`, `pnpm run probe:real:daemon`, and `pnpm run probe:real:mcp-daemon` are explicit scripts only.
- Default deterministic gates do not run real Claude Code probes.
- `docs/REAL_CLAUDE_PROBES.md` documents Windows real CLI, WSL fresh clone, daemon mode, MCP-to-daemon, fake dry-run, and cc-switch boundary probes.
- The probe runner validates `parsedStdout.result` and supports fake-Claude dry runs through `SUPERVISOR_CLAUDE_COMMAND` and `SUPERVISOR_CLAUDE_PREFIX_ARGS`.

Verified commands:

```bash
pnpm run typecheck
pnpm test
pnpm run build
```

Observed Windows result:

- `pnpm run typecheck` passed.
- `pnpm test` passed with 14 test files and 50 tests.
- `pnpm run build` passed.

Observed Windows fake dry-run result:

- `probe:real:direct` passed with fake Claude and returned `ok: true`.
- `probe:real:daemon` passed with fake Claude and returned `ok: true`.
- `probe:real:mcp-daemon` passed with fake Claude and returned `ok: true`.

Observed WSL/Linux result from a fresh clone:

- `pnpm install --frozen-lockfile` passed.
- `pnpm run typecheck` passed.
- `pnpm test` passed with 14 test files and 50 tests.
- `pnpm run build` passed.

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
pnpm run typecheck
pnpm test
pnpm run build
```

Observed Windows result:

- `pnpm run typecheck` passed.
- `pnpm test` passed with 13 test files and 45 tests.
- `pnpm run build` passed.

Observed WSL/Linux result from a fresh clone:

- `pnpm install --frozen-lockfile` passed.
- `pnpm run typecheck` passed.
- `pnpm test` passed with 13 test files and 45 tests.
- `pnpm run build` passed.

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
pnpm run typecheck
pnpm test
pnpm run build
```

Observed Windows result:

- `pnpm run typecheck` passed.
- `pnpm test` passed with 13 test files and 45 tests.
- `pnpm run build` passed.

Observed WSL/Linux result from a fresh clone:

- `pnpm install --frozen-lockfile` passed.
- `pnpm run typecheck` passed.
- `pnpm test` passed with 13 test files and 45 tests.
- `pnpm run build` passed.

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
pnpm run typecheck
pnpm test
pnpm run build
```

Observed Windows result:

- `pnpm run typecheck` passed.
- `pnpm test` passed with 13 test files and 42 tests.
- `pnpm run build` passed.

Observed WSL/Linux result from a fresh clone:

- `pnpm install --frozen-lockfile` passed.
- `pnpm run typecheck` passed.
- `pnpm test` passed with 13 test files and 42 tests.
- `pnpm run build` passed.

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
pnpm run typecheck
pnpm test
pnpm run build
```

Observed Windows result:

- `pnpm run typecheck` passed.
- `pnpm test` passed with 12 test files and 36 tests.
- `pnpm run build` passed.

Observed WSL/Linux result from a fresh clone:

- `pnpm install --frozen-lockfile` passed.
- `pnpm run typecheck` passed.
- `pnpm test` passed with 12 test files and 36 tests.
- `pnpm run build` passed.

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
pnpm run typecheck
pnpm test
pnpm run build
```

Observed Windows result:

- `pnpm run typecheck` passed.
- `pnpm test` passed with 11 test files and 31 tests.
- `pnpm run build` passed.

Observed WSL/Linux result from a fresh clone:

- `pnpm install --frozen-lockfile` passed.
- `pnpm run typecheck` passed.
- `pnpm test` passed with 11 test files and 31 tests.
- `pnpm run build` passed.

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
pnpm run typecheck
pnpm test
pnpm run build
```

Observed Windows result:

- `pnpm run typecheck` passed.
- `pnpm test` passed with 10 test files and 28 tests.
- `pnpm run build` passed.

Observed WSL/Linux result from a fresh clone:

- `pnpm install --frozen-lockfile` passed.
- `pnpm run typecheck` passed.
- `pnpm test` passed with 10 test files and 28 tests.
- `pnpm run build` passed.

Remaining daemon limitations:

- No auto-start.
- No Windows service or systemd unit.
- No auth token or socket discovery.
- MCP still constructs an in-process `ClaudeSupervisor`; MCP-to-daemon migration is a later milestone.

## Manual And Opt-In Real Probes

Real Claude Code probes are documented in [Real Claude Code Probes](REAL_CLAUDE_PROBES.md).

These probes are not part of `pnpm test`, `pnpm run typecheck`, or `pnpm run build`. They must be run explicitly:

```bash
pnpm run probe:real:direct
pnpm run probe:real:daemon
pnpm run probe:real:mcp-daemon
```

The probe runner also supports fake-Claude dry runs through `SUPERVISOR_CLAUDE_COMMAND=node` and `SUPERVISOR_CLAUDE_PREFIX_ARGS=tests/fixtures/fake-claude.mjs`.

Real probes validate supervisor's boundary only: supervisor calls the system `claude` command and lets local Claude Code configuration, including any cc-switch setup, decide provider, model, quota, and proxy behavior.

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
