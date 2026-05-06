# OpenCode Backend

The OpenCode backend is a thin lifecycle adapter. It does not configure providers, models, endpoint routing, `/connect`, credentials, or permission policy. OpenCode owns those concerns.

For local production smoke testing, OpenCode is the preferred first backend. Retinue should reuse the installed OpenCode profile/config/login/permission state instead of creating a separate child-agent profile.

## Server Target

The safest first integration mode is attach-only:

```text
SUPERVISOR_OPENCODE_BASE_URL=http://127.0.0.1:4096
```

The URL must be loopback HTTP. Paths are ignored and normalized to the origin.

Model and agent overrides are optional:

```text
SUPERVISOR_OPENCODE_MODEL=litellm/pro-router
SUPERVISOR_OPENCODE_AGENT=build
```

CLI/MCP request fields win over environment variables. If neither CLI/MCP input nor environment variable is set, supervisor does not send `model` or `agent`; OpenCode keeps ownership of default model and agent selection.

## Permissions

OpenCode permissions are OpenCode-owned. Retinue should not expose permission mode as a normal Codex-facing tool argument.

Phase 1 should make the local E2E run reliably with the effective OpenCode deployment policy. If the default OpenCode permission prompts block unattended child-agent execution, use an explicit deployment-level OpenCode permission configuration, such as OpenCode's `permission` config or `OPENCODE_PERMISSION`, and record it in the local runbook without committing secrets or machine-specific credentials.

OpenCode MCP config uses the top-level `mcp` key. Do not copy Claude/Codex-style `mcpServers` into `opencode.json`; current OpenCode rejects it as an unrecognized key.

When a model override is provided, supervisor accepts the OpenCode CLI-style `provider/model` string and sends the server API shape:

```json
{
  "model": {
    "providerID": "litellm",
    "modelID": "pro-router"
  }
}
```

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
- model and agent defaults via `SUPERVISOR_OPENCODE_MODEL` and `SUPERVISOR_OPENCODE_AGENT`
- OpenCode 1.14.35 request compatibility for `prompt_async` structured parts, 204 responses, object-shaped model overrides, and sessions without a `state` field
- backend metadata fields on job records
- attach/serve policy helpers
- CLI `opencode-run`, `opencode-status`, `opencode-wait`, `opencode-result`, `opencode-continue`, `opencode-kill`, and `opencode-cleanup`
- MCP `opencode_*` lifecycle tools
- deterministic CLI/MCP tests using a fake OpenCode server
- manual real OpenCode probe script

Not implemented yet:

- daemon RPC routing for OpenCode jobs
