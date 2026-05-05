# OpenCode Backend

The OpenCode backend is experimental/in-progress and intentionally thin. It is attach-first by default and does not configure providers, models, endpoint routing, `/connect`, credentials, or permission policy. OpenCode owns those concerns.

Current default mode is **attach-only**. There is no hidden auto-serve path: supervisor only starts a local OpenCode server when `SUPERVISOR_OPENCODE_AUTO_SERVE=1` is explicitly set and the corresponding runtime path is implemented.

Supervisor is not a provider/model router, and it does not bypass permissions for OpenCode or Claude Code paths.

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

Supervisor defaults to attach-only behavior. It must not auto-start OpenCode unless `SUPERVISOR_OPENCODE_AUTO_SERVE=1` is explicit and corresponding serve behavior is implemented.

## Current Status

Implemented:

- fake OpenCode HTTP server for deterministic, repeatable tests
- narrow `OpenCodeClient`
- `OpenCodeBackend` run/result/continue/abort against the fake server
- backend metadata fields on job records
- attach/serve policy helpers
- CLI `opencode-run`, `opencode-status`, `opencode-wait`, `opencode-result`, `opencode-continue`, `opencode-kill`, and `opencode-cleanup`
- MCP `opencode_*` lifecycle tools
- deterministic CLI/MCP tests using a fake OpenCode server only

Not implemented yet:

- daemon RPC routing for OpenCode jobs

## Guardrails

- attach-only is the default backend posture
- no hidden auto-serve defaults; auto-serve requires explicit opt-in plus implemented support
- no provider/model router is implemented in supervisor; OpenCode remains the owner
- no permission bypass behavior is exposed through supervisor inputs
- fake OpenCode server tests are deterministic and default
- real OpenCode probes are manual-only and never part of default CI gates

Real OpenCode probes are manual-only and are intentionally excluded from automated `pnpm test` gates. See [Real OpenCode Probes](REAL_OPENCODE_PROBES.md).
