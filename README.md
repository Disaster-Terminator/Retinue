# supervisor

Local MCP and CLI supervisor for spawning Claude Code as managed background jobs.

See [Project Boundary and Long-Term Vision](docs/PROJECT_BOUNDARY.md) before changing the architecture. The current stdio MCP implementation is a hardening phase; the long-term lifecycle owner is a durable local daemon.

The repository targets a Codex-like lifecycle:

- `claude_run`: start Claude Code and return a job handle quickly
- `claude_status`: inspect current job metadata
- `claude_wait`: wait briefly for a terminal state
- `claude_result`: read stdout, stderr, parsed JSON, and exit metadata
- `claude_continue`: start a new job from a persisted Claude Code session id
- `claude_kill`: kill the process tree
- `claude_cleanup`: remove terminal job directories while preserving running jobs

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
```

For deterministic tests, override the Claude command:

```bash
SUPERVISOR_CLAUDE_COMMAND=node
SUPERVISOR_CLAUDE_PREFIX_ARGS=/path/to/fake-claude.mjs
```

`SUPERVISOR_CLAUDE_PREFIX_ARGS` can also be a JSON string array.

## MCP

After `npm run build`, configure an MCP client to run:

```bash
node G:/repository/supervisor/dist/mcp.js
```

Environment overrides:

```text
SUPERVISOR_STATE_DIR
SUPERVISOR_CLAUDE_COMMAND
SUPERVISOR_CLAUDE_PREFIX_ARGS
```

The MCP server is the intended spawn surface. It stays alive while child jobs run, so it can record exit status and final metadata.

`claude_result` returns bounded stdout/stderr by default, plus `stdoutPath`, `stderrPath`, byte counts, and truncation flags. Read the files directly only when a full local artifact is needed.

## Reliability Notes

- Job finalization is handled from the child `close` event so stdout/stderr pipes have closed before metadata is finalized.
- Completed Claude JSON `session_id` is persisted to `meta.json` as `sessionId`.
- Running jobs can be limited with `maxConcurrentJobs` in code and `timeoutMs` per run.
- If a previous MCP process exited and left stale `running` metadata, status reconciliation marks a missing PID as `orphaned`.
- Windows and WSL should not share one `node_modules` directory. Run `npm ci` separately inside WSL before Linux-side tests because packages such as Rollup install OS-specific optional dependencies.

## Verify

```bash
npm run typecheck
npm test
npm run build
```

