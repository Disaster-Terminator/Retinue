# OpenCode Backend

The OpenCode backend is a thin lifecycle adapter. It does not configure providers, models, endpoint routing, `/connect`, credentials, agents, plugins, skills, or permissions. OpenCode owns those concerns through its active profile.

For local production smoke testing, OpenCode is the preferred first backend. Retinue should reuse the installed OpenCode profile instead of creating a separate child-agent profile.

## Install Assumption

The default 0.1.0 user path assumes the official OpenCode install script:

```bash
curl -fsSL https://opencode.ai/install | bash
```

The script installs the CLI under `$HOME/.opencode/bin/opencode`. Retinue first honors an explicit `RETINUE_OPENCODE_COMMAND`, then the inherited `PATH`, then common default install locations. On Windows that fallback includes `%USERPROFILE%\.opencode\bin\opencode` before package-manager shims such as pnpm/npm/bun.

On POSIX systems, including WSL and macOS, Retinue also checks `$HOME/.opencode/bin/opencode` even when the installer did not add it to `PATH`.

## Server Target

The default plugin integration mode is Retinue-managed auto-serve:

```text
RETINUE_OPENCODE_AUTO_SERVE=1
RETINUE_OPENCODE_HOST=127.0.0.1
```

Retinue prefers `127.0.0.1:4096` and tries local fallback ports `4097` through `4127` when the preferred port is occupied by an external service. A running OpenCode server from another environment is treated as external unless the deployment sets `RETINUE_OPENCODE_BASE_URL`.

Explicit attach remains available:

```text
RETINUE_OPENCODE_BASE_URL=http://127.0.0.1:4096
```

The explicit URL must be loopback HTTP. Paths are ignored and normalized to the origin.

Model and agent overrides are optional:

```text
RETINUE_OPENCODE_MODEL=litellm/pro-router
RETINUE_OPENCODE_AGENT=plan
```

CLI/MCP request fields win over environment variables. If neither CLI/MCP input nor environment variable is set, retinue does not send `model` or `agent`; OpenCode keeps ownership of default model and agent selection.

Retinue 0.1.0 plugin deployments set `RETINUE_OPENCODE_AGENT=plan` by default. This is a deployment default, not a `retinue_spawn_agent` argument. Use `build` only when the deployment intentionally allows OpenCode child agents to edit.

## Profile

OpenCode profile state is OpenCode-owned. Permissions, plugins, skills, model defaults, provider config, and agent defaults are profile details, not separate Retinue product controls.

Phase 1 should make the local E2E run reliably with the effective OpenCode deployment profile. If the active profile blocks unattended child-agent execution, adjust the deployment-level OpenCode profile and record the non-sensitive fact in the local runbook. Do not expose profile selection or permission mode as a normal Codex-facing tool argument.

OpenCode MCP config uses the top-level `mcp` key. Do not copy Claude/Codex-style `mcpServers` into `opencode.json`; current OpenCode rejects it as an unrecognized key.

When a model override is provided, retinue accepts the OpenCode CLI-style `provider/model` string and sends the server API shape:

```json
{
  "model": {
    "providerID": "litellm",
    "modelID": "pro-router"
  }
}
```

Local server start command shape:

```bash
opencode serve --hostname 127.0.0.1 --port 4096
```

The corresponding environment knobs are:

```text
RETINUE_OPENCODE_AUTO_SERVE=1
RETINUE_OPENCODE_COMMAND=opencode
RETINUE_OPENCODE_HOST=127.0.0.1
RETINUE_OPENCODE_PORT=4096
```

When `RETINUE_OPENCODE_PORT` is explicit, Retinue does not silently fall back to another port.

MCP hosts commonly enforce their own per-tool timeout. Retinue therefore clamps `retinue_wait_agent` and `opencode_wait` calls to a host-safe maximum of 90 seconds by default. Complex OpenCode tasks should be polled with repeated wait calls; set `RETINUE_MCP_WAIT_MAX_MS` only when the host timeout is known to be higher.

If a wait call returns `status: "running"`, keep the same `jobId` and call wait again. Do not spawn a replacement job only because one wait window elapsed.

If OpenCode returns assistant rounds with no visible text, Retinue keeps them out of successful results. Empty `finish=stop` assistant rounds and long no-text tool-call loops become `stalled` with diagnostics so the caller can inspect logs or close the child agent. When OpenCode has already produced several tool-call rounds and the latest assistant round is still incomplete, Retinue uses a shorter incomplete-round stall threshold instead of waiting for the full long-loop threshold.

## Diagnostics

Retinue writes OpenCode backend diagnostics to the Retinue state directory:

```text
<stateDir>/logs/retinue.jsonl
<stateDir>/jobs/<jobId>/meta.json
<stateDir>/jobs/<jobId>/stdout.log
<stateDir>/jobs/<jobId>/stderr.log
```

If `RETINUE_STATE_DIR` is unset, Linux/WSL/macOS defaults to `$XDG_STATE_HOME/retinue` or `$HOME/.local/state/retinue`; Windows defaults to `%LOCALAPPDATA%\retinue`.

When `retinue_wait_agent` returns `running`, its response includes `tracePath`. Use that path to inspect recent OpenCode message summaries, selected model/provider metadata, server URL, and stall diagnostics.

## Current Status

Implemented:

- fake OpenCode HTTP server for deterministic tests
- narrow `OpenCodeClient`
- `OpenCodeBackend` run/result/continue/abort against the fake server
- model and agent defaults via `RETINUE_OPENCODE_MODEL` and `RETINUE_OPENCODE_AGENT`
- OpenCode 1.14.35 request compatibility for `prompt_async` structured parts, 204 responses, object-shaped model overrides, and sessions without a `state` field
- backend metadata fields on job records
- attach/serve policy helpers
- CLI `opencode-run`, `opencode-status`, `opencode-wait`, `opencode-result`, `opencode-continue`, `opencode-kill`, and `opencode-cleanup`
- opt-in MCP `opencode_*` lifecycle tools for adapter debugging when `RETINUE_EXPOSE_BACKEND_TOOLS=1`
- deterministic CLI/MCP tests using a fake OpenCode server
- manual real OpenCode probe script

Not implemented yet:

- daemon RPC routing for OpenCode jobs
