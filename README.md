# supervisor

Local MCP and CLI supervisor for spawning Claude Code as managed background jobs.

See [Project Boundary and Long-Term Vision](docs/PROJECT_BOUNDARY.md) before changing the architecture. The current stdio MCP implementation is a hardening phase; the long-term lifecycle owner is a durable local daemon. See [Verification Notes](docs/VERIFICATION.md) for the current Windows, WSL, and real Claude Code baseline.
See [Service Lifecycle](docs/SERVICE_LIFECYCLE.md) for the current manual daemon start, inspect, and stop workflow. See [CI Contract](docs/CI.md) for authoritative deterministic gates versus manual-only real Claude probes.
See [Claude Code MCP Configuration](docs/CLAUDE_CODE_MCP.md) for direct mode, explicit daemon URL mode, and explicit daemon discovery mode examples.
See [Operator Quickstart](docs/OPERATOR_QUICKSTART.md) for concise post-hardening operator steps.

The repository targets a Codex-like lifecycle:

- `claude_run`: start Claude Code and return a job handle quickly
- `claude_status`: inspect current job metadata
- `claude_wait`: wait briefly for a terminal state
- `claude_result`: read stdout, stderr, parsed JSON, and exit metadata
- `claude_continue`: start a new job from a persisted Claude Code session id
- `claude_kill`: kill the process tree
- `claude_cleanup`: remove terminal job directories while preserving running jobs

## Quickstart

Install, build, and run the deterministic gate:

```bash
npm install
npm run build
npm run typecheck
npm test
```

Run a fake-Claude CLI job before spending real Claude Code quota:

```bash
SUPERVISOR_CLAUDE_COMMAND=node SUPERVISOR_CLAUDE_PREFIX_ARGS=tests/fixtures/fake-claude.mjs node dist/cli.js run --cwd . --prompt "hello"
node dist/cli.js wait <jobId> --timeout-ms 30000
node dist/cli.js result <jobId>
```

PowerShell users can set the same overrides with `$env:SUPERVISOR_CLAUDE_COMMAND = "node"` and `$env:SUPERVISOR_CLAUDE_PREFIX_ARGS = "tests/fixtures/fake-claude.mjs"`.

## Safety Defaults

The supervisor calls the system `claude` command by default and does not add permission-bypass flags. It intentionally does not expose Claude Code `bypassPermissions` / `--dangerously-skip-permissions`. If local `claude` is managed by cc-switch, routing and quota remain controlled by that existing Claude Code setup.

Prompts are written to job-local `prompt.md` and sent to Claude Code over stdin. They are not passed as command-line arguments and are not returned by default in `status`; metadata stores only `promptPath`, `promptPreview`, and `promptSha256`.

Jobs are stored under:

```text
%LOCALAPPDATA%\supervisor
```

on Windows, or:

```text
$XDG_STATE_HOME/supervisor
~/.local/state/supervisor
```

on Linux/WSL. Set `SUPERVISOR_STATE_DIR` to override this.

## Install

```bash
npm install
npm run build
```

## CLI

```bash
npm run build
node dist/cli.js run --cwd . --prompt "Reply exactly: OK"
node dist/cli.js status <jobId>
node dist/cli.js wait <jobId> --timeout-ms 30000
node dist/cli.js result <jobId>
node dist/cli.js continue --cwd . --job-id <jobId> --prompt "Follow up"
node dist/cli.js kill <jobId>
node dist/cli.js cleanup --older-than-ms 86400000
node dist/cli.js daemon-health --daemon-url http://127.0.0.1:27777
```

For deterministic tests, override the Claude command:

```bash
SUPERVISOR_CLAUDE_COMMAND=node
SUPERVISOR_CLAUDE_PREFIX_ARGS=/path/to/fake-claude.mjs
```

`SUPERVISOR_CLAUDE_PREFIX_ARGS` can also be a JSON string array.

## Entrypoints

After `npm run build`, package bins point at:

| Bin | Built file | Purpose |
| --- | --- | --- |
| `supervisor` | `dist/cli.js` | Local CLI for run/status/wait/result/continue/peek/kill/cleanup |
| `supervisor-mcp` | `dist/mcp.js` | Stdio MCP server exposing Claude lifecycle tools |
| `supervisor-daemon` | `dist/daemon.js` | Manual loopback daemon for durable lifecycle ownership |

## Environment Variables

| Variable | Used by | Purpose |
| --- | --- | --- |
| `SUPERVISOR_STATE_DIR` | CLI, MCP, daemon | Override the state directory for job metadata and artifacts |
| `SUPERVISOR_CLAUDE_COMMAND` | CLI, MCP, daemon | Override the executable, usually for fake-Claude tests |
| `SUPERVISOR_CLAUDE_PREFIX_ARGS` | CLI, MCP, daemon | Add fixed arguments before supervisor's Claude Code arguments |
| `SUPERVISOR_DAEMON_URL` | CLI, MCP | Explicit daemon URL for adapter mode |
| `SUPERVISOR_DAEMON_DISCOVERY` | CLI, MCP | Set to `1` to read `<stateDir>/daemon.json` explicitly |
| `SUPERVISOR_DEFAULT_RUNTIME_TIMEOUT_MS` | CLI, MCP, daemon | Default runtime timeout for jobs that do not pass `timeoutMs` |
| `SUPERVISOR_MAX_CONCURRENT_JOBS` | CLI, MCP, daemon | Limit concurrent running jobs for that supervisor process |

## Daemon

The first daemon milestone is manual and loopback-only by default:

```bash
npm run build
node dist/daemon.js --host 127.0.0.1 --port 27777
```

The daemon prints one JSON readiness line and then serves:

```text
GET  /health
POST /v1/jobs/run
POST /v1/jobs/status
POST /v1/jobs/wait
POST /v1/jobs/result
POST /v1/jobs/continue
POST /v1/jobs/peek
POST /v1/jobs/kill
POST /v1/jobs/cleanup
```

`GET /health` returns readiness metadata:

```json
{
  "status": "ok",
  "version": "0.1.0",
  "pid": 12345,
  "stateDir": "..."
}
```

Daemon errors use a stable object shape:

```json
{
  "error": {
    "code": "invalid_request",
    "message": "Missing required jobId"
  }
}
```

Current daemon error codes are `not_found`, `bad_json`, `body_too_large`, `invalid_request`, and `internal_error`. JSON request bodies are limited to 1 MiB by default.

This is not service installation or auto-start. It is the first step toward the long-term architecture where the daemon owns job lifecycle and CLI/MCP become adapters.

The CLI delegates to a running daemon only when configured explicitly:

```bash
SUPERVISOR_DAEMON_URL=http://127.0.0.1:27777 node dist/cli.js run --cwd . --prompt "Reply exactly: OK"
node dist/cli.js --daemon-url http://127.0.0.1:27777 status <jobId>
node dist/cli.js daemon-health --daemon-url http://127.0.0.1:27777
```

The daemon also writes a discovery file at `<stateDir>/daemon.json` after it binds. CLI discovery is still explicit:

```bash
node dist/cli.js --discover-daemon status <jobId>
node dist/cli.js --discover-daemon daemon-health
SUPERVISOR_DAEMON_DISCOVERY=1 node dist/cli.js status <jobId>
```

Without `SUPERVISOR_DAEMON_URL` or `--daemon-url`, CLI keeps the direct local supervisor path.

## MCP

After `npm run build`, configure an MCP client to run:

```bash
node G:/repository/supervisor/dist/mcp.js
```

Environment overrides:

```text
SUPERVISOR_DAEMON_URL
SUPERVISOR_DAEMON_DISCOVERY
SUPERVISOR_STATE_DIR
SUPERVISOR_CLAUDE_COMMAND
SUPERVISOR_CLAUDE_PREFIX_ARGS
```

When `SUPERVISOR_DAEMON_URL` is set, MCP tools delegate to the running daemon. When `SUPERVISOR_DAEMON_DISCOVERY=1` is set, MCP reads `<stateDir>/daemon.json` and rejects stale daemon metadata. Without either setting, MCP keeps the direct in-process supervisor path for fallback and debugging.

Example MCP configuration using explicit daemon discovery:

```json
{
  "mcpServers": {
    "supervisor": {
      "command": "node",
      "args": ["G:/repository/supervisor/dist/mcp.js"],
      "env": {
        "SUPERVISOR_DAEMON_DISCOVERY": "1"
      }
    }
  }
}
```

Use `SUPERVISOR_DAEMON_URL` instead of discovery when the daemon URL is fixed and known.

`claude_result` returns bounded stdout/stderr by default, plus `stdoutPath`, `stderrPath`, byte counts, and truncation flags. Read the files directly only when a full local artifact is needed.

## Result Artifacts And Cleanup

`claude_result` and `claude_peek` return bounded stdout/stderr text for client safety. Full local artifacts remain available at `stdoutPath` and `stderrPath`.

Clean terminal jobs with:

```bash
node dist/cli.js cleanup --older-than-ms 86400000
```

Cleanup removes terminal job directories and reports removed temp files. It preserves `running` and `abandoned` jobs.

## Reliability Notes

- Job finalization is handled from the child `close` event so stdout/stderr pipes have closed before metadata is finalized.
- Completed Claude JSON `session_id` is persisted to `meta.json` as `sessionId`.
- New job metadata is written with `schemaVersion: 1`; older metadata without a schema version remains readable.
- Running jobs can be limited with `maxConcurrentJobs` in code and `timeoutMs` per run.
- If a previous MCP process exited and left stale `running` metadata, status reconciliation marks a missing PID as `orphaned`.
- If stale `running` metadata points at a live PID that the current supervisor instance does not own, status reconciliation marks it as `abandoned` rather than reporting normal `running`.
- Cleanup removes terminal job directories and reports temp JSON files removed with those directories; it preserves `running` and `abandoned` job directories.
- Windows and WSL should not share one `node_modules` directory. Run `npm ci` separately inside WSL before Linux-side tests because packages such as Rollup install OS-specific optional dependencies.

## Troubleshooting

- `Unknown command: ...`: run `node dist/cli.js <command>` after `npm run build`; package bins also require built `dist/` files.
- `Stale daemon discovery`: stop the old PID if it is still running, or start a new daemon so `<stateDir>/daemon.json` is refreshed.
- `Cannot find module` after moving between Windows and WSL: run `npm ci` separately in that environment.
- `claude` is missing or routes unexpectedly: check `where.exe claude` on Windows or `which claude` on WSL/Linux. Supervisor does not route providers itself.
- Job output looks truncated: use `stdoutPath` and `stderrPath` from `claude_result` for full artifacts.

## Verify

```bash
npm run typecheck
npm test
npm run build
```

Manual and opt-in real Claude Code probes are documented in [Real Claude Code Probes](docs/REAL_CLAUDE_PROBES.md). They are not part of the default deterministic test suite.

