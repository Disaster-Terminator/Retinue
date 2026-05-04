# Claude Code MCP Configuration Matrix (`supervisor-mcp`)

This guide helps choose the right `supervisor-mcp` mode in Claude Code.

## Project Boundary (Important)

`supervisor` stays inside a narrow lifecycle boundary:

- It **does not route providers** (routing remains in your Claude Code / `claude` setup).
- It **does not bypass permissions** (`bypassPermissions` / `--dangerously-skip-permissions` are intentionally not exposed).
- It **does not auto-start services** (you start `supervisor-daemon` yourself when you want daemon mode).

## Choose a Mode

| Mode | When to use | Required setting | Notes |
| --- | --- | --- | --- |
| Direct MCP (in-process) | Default local setup, fallback/debugging, no daemon dependency | none | `supervisor-mcp` runs tools directly in-process. |
| Explicit daemon URL | You already know daemon host/port and want deterministic routing | `SUPERVISOR_DAEMON_URL=http://127.0.0.1:27777` | Most explicit daemon mode. |
| Discovery (`daemon.json`) | You want CLI/MCP to discover a manually started daemon from state dir metadata | `SUPERVISOR_DAEMON_DISCOVERY=1` | Reads `<stateDir>/daemon.json`; rejects stale metadata. |

## Before Real Claude Quota: Dry Run

Run a fake-Claude probe first so you can validate wiring before spending real Claude quota:

```bash
SUPERVISOR_CLAUDE_COMMAND=node \
SUPERVISOR_CLAUDE_PREFIX_ARGS=tests/fixtures/fake-claude.mjs \
node dist/cli.js run --cwd . --prompt "hello"
```

Then use real `claude` only after that local dry run passes.

## Claude Code MCP Config Examples

> `command`/`args` should point to your local build output path for `dist/mcp.js`.

### 1) Direct MCP Mode (default)

#### Project-local config

```json
{
  "mcpServers": {
    "supervisor": {
      "command": "node",
      "args": ["/absolute/path/to/supervisor/dist/mcp.js"]
    }
  }
}
```

#### User/global config

```json
{
  "mcpServers": {
    "supervisor": {
      "command": "node",
      "args": ["/absolute/path/to/supervisor/dist/mcp.js"]
    }
  }
}
```

### 2) Explicit `SUPERVISOR_DAEMON_URL` Mode

Start daemon manually:

```bash
node dist/daemon.js --host 127.0.0.1 --port 27777
```

Then set MCP env:

```json
{
  "mcpServers": {
    "supervisor": {
      "command": "node",
      "args": ["/absolute/path/to/supervisor/dist/mcp.js"],
      "env": {
        "SUPERVISOR_DAEMON_URL": "http://127.0.0.1:27777"
      }
    }
  }
}
```

### 3) Explicit `SUPERVISOR_DAEMON_DISCOVERY=1` Mode

Start daemon manually (it writes `<stateDir>/daemon.json`):

```bash
node dist/daemon.js --host 127.0.0.1 --port 27777
```

Then set MCP env:

```json
{
  "mcpServers": {
    "supervisor": {
      "command": "node",
      "args": ["/absolute/path/to/supervisor/dist/mcp.js"],
      "env": {
        "SUPERVISOR_DAEMON_DISCOVERY": "1"
      }
    }
  }
}
```

## Local vs Project vs User Placement

Use whichever Claude Code MCP config scope you prefer:

- **Project config**: good for team-shared defaults in a repo.
- **User config**: good for personal machine-wide defaults.
- **Local/ephemeral config**: good for quick experiments.

The JSON server shape stays the same across scopes; only where you store the config changes.

## Out of Scope (for now)

Dynamic MCP tool update flows/channels are currently out of scope for `supervisor-mcp` docs and implementation. Use static config and restart/reload behavior supported by your MCP client.
