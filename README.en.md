# Retinue

<p align="left">
  <img alt="runtime Node.js 20+" src="https://img.shields.io/badge/runtime-Node.js%2020%2B-339933">
  <img alt="language TypeScript" src="https://img.shields.io/badge/language-TypeScript-3178C6">
  <img alt="package manager pnpm" src="https://img.shields.io/badge/package%20manager-pnpm-F69220">
  <img alt="interface MCP + CLI" src="https://img.shields.io/badge/interface-MCP%20%2B%20CLI-4B5563">
  <img alt="backends Claude Code and OpenCode" src="https://img.shields.io/badge/backends-Claude%20Code%20%2B%20OpenCode-111827">
  <img alt="scope local first" src="https://img.shields.io/badge/scope-local--first-0F766E">
</p>

[中文](README.md)

**Retinue lets Codex run local coding agents as controllable subagents.**

Codex submits a coding job, Retinue returns a job handle immediately, and the caller can later inspect status, wait for completion, read results, continue an external session, kill work, or clean local artifacts. Claude Code and OpenCode still own their provider, model, quota, proxy, login, and runtime policy; Retinue makes those local agent runtimes callable, trackable, and recoverable from Codex.

```text
Codex / MCP client
  -> Retinue MCP or CLI
    -> backend adapter
      -> Claude Code / OpenCode
    -> local job state + bounded result artifacts
```

## Core capabilities

| Capability | Description |
| --- | --- |
| Start subagents | Start Claude Code or OpenCode coding jobs from Codex and return a `jobId` quickly |
| Inspect status | Read running, completed, failed, stopped, orphaned, abandoned, and related states |
| Wait or poll | Wait within a short timeout window without blocking the main agent's whole task |
| Read results | Return bounded stdout/stderr, exit metadata, external session ids, and local artifact paths |
| Continue sessions | Continue an existing Claude/OpenCode session when the backend supports it |
| Kill and clean up | Kill selected jobs and remove terminal job directories while preserving running or ambiguous jobs |

## Boundary

Retinue is a local subagent execution surface. It is not a model gateway or provider router.

- It does not select or switch model providers.
- It does not own Claude Code or OpenCode login, quota, proxy, model defaults, or runtime policy.
- It does not put prompts into process argv.
- It does not return full prompts from default `status` responses.
- It does not try to become a general process manager or cloud queue.

## Quickstart

```bash
pnpm install
pnpm run build
pnpm run typecheck
pnpm test
```

Run a deterministic fake-Claude job before spending real Claude Code quota:

```bash
SUPERVISOR_CLAUDE_COMMAND=node \
SUPERVISOR_CLAUDE_PREFIX_ARGS=tests/fixtures/fake-claude.mjs \
node dist/cli.js run --cwd . --prompt "hello"

node dist/cli.js wait <jobId> --timeout-ms 30000
node dist/cli.js result <jobId>
```

PowerShell:

```powershell
$env:SUPERVISOR_CLAUDE_COMMAND = "node"
$env:SUPERVISOR_CLAUDE_PREFIX_ARGS = "tests/fixtures/fake-claude.mjs"
node dist/cli.js run --cwd . --prompt "hello"
node dist/cli.js wait <jobId> --timeout-ms 30000
node dist/cli.js result <jobId>
```

## CLI

```bash
pnpm run build

node dist/cli.js run --cwd . --prompt "Reply exactly: OK"
node dist/cli.js status <jobId>
node dist/cli.js wait <jobId> --timeout-ms 30000
node dist/cli.js result <jobId>
node dist/cli.js continue --cwd . --job-id <jobId> --prompt "Follow up"
node dist/cli.js kill <jobId>
node dist/cli.js cleanup --older-than-ms 86400000
```

Connect the OpenCode backend to a local loopback server:

```bash
SUPERVISOR_OPENCODE_BASE_URL=http://127.0.0.1:4096 \
node dist/cli.js opencode-run \
  --cwd . \
  --prompt "Reply exactly: RETINUE_OPENCODE_OK"

node dist/cli.js opencode-wait <jobId> --timeout-ms 180000
node dist/cli.js opencode-result <jobId>
node dist/cli.js opencode-kill <jobId>
```

Optional model and agent defaults are passed to OpenCode through environment variables. When unset, Retinue omits those fields and lets OpenCode use its own configuration:

```bash
SUPERVISOR_OPENCODE_MODEL=litellm/pro-router
SUPERVISOR_OPENCODE_AGENT=build
```

## MCP tools

After building, configure an MCP client to run:

```bash
node /path/to/Retinue/dist/mcp.js
```

Claude Code tools: `claude_run`, `claude_status`, `claude_wait`, `claude_result`, `claude_continue`, `claude_peek`, `claude_kill`, `claude_cleanup`.

OpenCode tools: `opencode_run`, `opencode_status`, `opencode_wait`, `opencode_result`, `opencode_continue`, `opencode_kill`, `opencode_cleanup`.

## State directory

Windows:

```text
%LOCALAPPDATA%\supervisor
```

Linux / WSL:

```text
$XDG_STATE_HOME/supervisor
~/.local/state/supervisor
```

Set `SUPERVISOR_STATE_DIR` to override the state directory.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `SUPERVISOR_STATE_DIR` | Override the state directory for job metadata and artifacts |
| `SUPERVISOR_CLAUDE_COMMAND` | Override the Claude Code executable, usually for fake runtime tests |
| `SUPERVISOR_CLAUDE_PREFIX_ARGS` | Add fixed arguments before Retinue-generated Claude Code arguments |
| `SUPERVISOR_DEFAULT_RUNTIME_TIMEOUT_MS` | Default runtime timeout when `timeoutMs` is not provided |
| `SUPERVISOR_MAX_CONCURRENT_JOBS` | Limit concurrently running jobs in the current process |
| `SUPERVISOR_OPENCODE_BASE_URL` | Attach to a local OpenCode loopback server |
| `SUPERVISOR_OPENCODE_MODEL` | Optional OpenCode default model in `provider/model` form |
| `SUPERVISOR_OPENCODE_AGENT` | Optional OpenCode default agent |
| `SUPERVISOR_DAEMON_URL` | Make CLI/MCP explicitly connect to a local loopback daemon |
| `SUPERVISOR_DAEMON_DISCOVERY` | Set to `1` to discover a daemon from `<stateDir>/daemon.json` |

## Safety and reliability defaults

- Prompts are written to job-local `prompt.md` and sent to the backend agent over stdin.
- `status` exposes only `promptPath`, `promptPreview`, and `promptSha256` by default.
- `result` and `peek` return bounded stdout/stderr by default, plus `stdoutPath`, `stderrPath`, byte counts, and truncation flags.
- Missing PIDs, stale state files, or corrupted metadata are reported as explicit states instead of success.
- Windows and WSL should not share one `node_modules` directory; run `pnpm install --frozen-lockfile` separately in each environment.

## Optional daemon mode

Retinue can run directly inside the CLI/MCP process, or explicitly connect to a local loopback daemon:

```bash
pnpm run build
node dist/daemon.js --host 127.0.0.1 --port 27777
```

Without `SUPERVISOR_DAEMON_URL`, `--daemon-url`, `SUPERVISOR_DAEMON_DISCOVERY=1`, or `--discover-daemon`, CLI/MCP uses the direct local path.

## Verification

```bash
pnpm run typecheck
pnpm test
pnpm run build
```

Real backend probes are manual and opt-in; they are not part of CI or the deterministic test suite:

- [Real Claude Code Probes](docs/runbooks/REAL_CLAUDE_PROBES.md)
- [Real OpenCode Probes](docs/runbooks/REAL_OPENCODE_PROBES.md)
- [Production OpenCode E2E](docs/runbooks/PRODUCTION_OPENCODE_E2E.md)

More details:

- [Docs Index](docs/README.md)
- [Long-Term Vision](docs/LONG_TERM_VISION.md)
- [Project Boundary](docs/architecture/PROJECT_BOUNDARY.md)
- [Service Lifecycle](docs/deployment/SERVICE_LIFECYCLE.md)
- [Plugin Deployment](docs/deployment/PLUGIN_DEPLOYMENT.md)
