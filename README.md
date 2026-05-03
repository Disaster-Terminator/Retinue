# supervisor

Local MCP and CLI supervisor for spawning Claude Code as managed background jobs.

The repository targets a Codex-like lifecycle:

- `claude_run`: start Claude Code and return a job handle quickly
- `claude_status`: inspect current job metadata
- `claude_wait`: wait briefly for a terminal state
- `claude_result`: read stdout, stderr, parsed JSON, and exit metadata
- `claude_kill`: kill the process tree
- `claude_cleanup`: remove terminal job directories while preserving running jobs

## Safety Defaults

The supervisor calls the system `claude` command by default and does not add permission-bypass flags. If local `claude` is managed by cc-switch, routing and quota remain controlled by that existing Claude Code setup.

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

## Verify

```bash
npm run typecheck
npm test
npm run build
```

