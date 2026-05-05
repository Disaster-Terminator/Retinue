# OpenCode Backend

The OpenCode backend is a thin lifecycle adapter. It does not configure providers, models, endpoint routing, `/connect`, credentials, or permission policy. OpenCode owns those concerns.

## Server Target

The safest first integration mode is attach-only:

```text
SUPERVISOR_OPENCODE_BASE_URL=http://127.0.0.1:4096
```

The URL must be loopback HTTP. Paths are ignored and normalized to the origin.

Opt-in local server start is a later runtime path. Its command shape is:

```bash
opencode serve --hostname 127.0.0.1 --port 0
```

The corresponding environment knobs are:

```text
SUPERVISOR_OPENCODE_AUTO_SERVE=1
SUPERVISOR_OPENCODE_COMMAND=opencode
SUPERVISOR_OPENCODE_HOST=127.0.0.1
SUPERVISOR_OPENCODE_PORT=0
```

Supervisor must not auto-start OpenCode unless `SUPERVISOR_OPENCODE_AUTO_SERVE=1` is explicit.

## Current Status

Implemented:

- fake OpenCode HTTP server for deterministic tests
- narrow `OpenCodeClient`
- `OpenCodeBackend` run/result/continue/abort against the fake server
- backend metadata fields on job records
- attach/serve policy helpers
- CLI `opencode-run`, `opencode-status`, `opencode-wait`, `opencode-result`, `opencode-continue`, `opencode-kill`, and `opencode-cleanup`
- MCP `opencode_*` lifecycle tools
- deterministic CLI/MCP tests using a fake OpenCode server

Not implemented yet:

- daemon RPC routing for OpenCode jobs
- real OpenCode probe script
