# Claude Code MCP configuration matrix (supervisor-mcp)

This guide helps you choose how `supervisor-mcp` connects for Claude lifecycle tools.

## Project boundary (explicit)

`supervisor` is a local lifecycle supervisor only:

- It does **not** route Claude providers or choose accounts for you.
- It does **not** bypass Claude permissions or expose bypass-permission flags.
- It does **not** auto-start daemon services; daemon start is manual and explicit.

See also: [Project Boundary and Long-Term Vision](./PROJECT_BOUNDARY.md).

## Mode matrix

| Mode | When to use | How to enable | Notes |
| --- | --- | --- | --- |
| Direct MCP mode (default) | Local debugging and simplest setup | No daemon env vars | `supervisor-mcp` runs lifecycle operations in-process. |
| Explicit daemon URL mode | Stable daemon endpoint is known | `SUPERVISOR_DAEMON_URL=http://127.0.0.1:27777` | Most explicit adapter mode; good for fixed local service wiring. |
| Discovery mode | Daemon endpoint can vary but writes discovery file | `SUPERVISOR_DAEMON_DISCOVERY=1` | Reads `<stateDir>/daemon.json`; rejects stale discovery metadata. |

> Current scope note: dynamic MCP tool list updates/channels are out of scope for now; current tools are static for this hardening phase.

## Before spending real Claude quota

Run a fake-Claude dry run first:

```bash
SUPERVISOR_CLAUDE_COMMAND=node \
SUPERVISOR_CLAUDE_PREFIX_ARGS=tests/fixtures/fake-claude.mjs \
node dist/cli.js run --cwd . --prompt "hello"
```

Only after this passes should you run probes that use real Claude Code quota. See [Real Claude Code Probes](./REAL_CLAUDE_PROBES.md).

## Claude Code MCP config examples

### 1) Local/project config: direct mode

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

### 2) Local/project config: explicit daemon URL mode

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

### 3) Local/project config: discovery mode

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

### 4) User-level variation

At user scope, keep the same `mcpServers.supervisor` object and only change the absolute `args` path and `env` values for your machine. The three modes above are identical at user scope; only file location and path resolution differ.

## Daemon reminder (manual start)

If you use URL or discovery mode, start the daemon yourself first:

```bash
node dist/daemon.js --host 127.0.0.1 --port 27777
```

`supervisor-mcp` will not install, register, or auto-start this service for you.
