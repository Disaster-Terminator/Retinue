# Daemon Lifecycle Design

## Context

`PROJECT_BOUNDARY.md` says the long-term lifecycle owner must be a durable local daemon, while `supervisor-mcp` and `supervisor-cli` become adapters. The previous milestone hardened the stdio MCP implementation enough to prove the job model, safety defaults, Windows/WSL behavior, and real Claude Code integration. The next milestone should move lifecycle ownership one step toward the target architecture without adding service installation, provider routing, or cross-machine behavior.

## Recommended Approach

Build a manually started local HTTP daemon first.

Alternatives considered:

- Full daemon with auto-start, service registration, and socket discovery. This is closer to the final product but too much surface for the next milestone.
- Keep only stdio MCP and improve internals. This repeats the previous phase and does not advance the long-term boundary.
- Manual local daemon with a small HTTP JSON API and opt-in CLI adapter. This proves daemon-owned lifecycle semantics while keeping startup, auth, and MCP migration separate.

The recommended third option is the smallest meaningful step.

## Scope

This milestone adds:

- `supervisor-daemon` entrypoint.
- Local HTTP server bound to `127.0.0.1` by default.
- `GET /health` for readiness.
- JSON `POST` endpoints for the existing job operations: `run`, `status`, `wait`, `result`, `continue`, `peek`, `kill`, and `cleanup`.
- A daemon client used by CLI when `SUPERVISOR_DAEMON_URL` or `--daemon-url` is set.
- Tests proving a job can be started through the daemon and inspected through the CLI adapter.

This milestone does not add:

- auto-start
- Windows service or systemd installation
- auth token management
- daemon discovery
- MCP migration to daemon RPC
- provider/model routing

## Architecture

```text
supervisor-daemon
  -> local HTTP JSON API
  -> one in-process ClaudeSupervisor
  -> system claude process
  -> job files on disk

supervisor-cli
  -> direct ClaudeSupervisor by default
  -> daemon HTTP client when --daemon-url or SUPERVISOR_DAEMON_URL is set
```

The direct CLI path remains available for compatibility and for deterministic tests. The daemon path is opt-in until startup/discovery semantics are designed.

## API Shape

All job operation endpoints use JSON request and response bodies.

- `GET /health` returns `{ "status": "ok", "version": "0.1.0" }`.
- `POST /v1/jobs/run` accepts `RunOptions`.
- `POST /v1/jobs/status` accepts `{ "jobId": string }`.
- `POST /v1/jobs/wait` accepts `{ "jobId": string, "timeoutMs"?: number }`.
- `POST /v1/jobs/result` accepts `{ "jobId": string }`.
- `POST /v1/jobs/continue` accepts `ContinueOptions`.
- `POST /v1/jobs/peek` accepts `{ "jobId": string, "stdoutTailBytes"?: number, "stderrTailBytes"?: number }`.
- `POST /v1/jobs/kill` accepts `{ "jobId": string }`.
- `POST /v1/jobs/cleanup` accepts `{ "olderThanMs"?: number }`.

Errors return non-2xx status with `{ "error": string }`.

## Safety

- Bind to loopback by default.
- Keep permission-bypass behavior unchanged; daemon calls the same `ClaudeSupervisor` core.
- Keep prompt handling unchanged; prompts are written to job-local `prompt.md` and sent over stdin.
- Keep bounded result behavior unchanged.
- Do not introduce a background service that users cannot inspect or stop.

## Testing

Tests should cover:

- health endpoint
- daemon `run` -> `wait` -> `result` against fake Claude
- structured HTTP error for unknown route or bad JSON
- CLI adapter using `SUPERVISOR_DAEMON_URL` against the daemon

Windows and WSL gates remain:

```bash
npm run typecheck
npm test
npm run build
```

## Acceptance Criteria

- `supervisor-daemon` is buildable as a package binary.
- `node dist/daemon.js --host 127.0.0.1 --port 0` can start a daemon in tests.
- CLI commands can use a daemon URL without constructing a local `ClaudeSupervisor`.
- Existing direct CLI and MCP behavior remains intact.
- Deterministic Windows and WSL test suites pass.
