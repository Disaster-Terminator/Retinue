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

Managed OpenCode auto-serve binds to loopback only by default. `RETINUE_OPENCODE_HOST=0.0.0.0` or another non-loopback host is rejected unless `RETINUE_OPENCODE_ALLOW_NON_LOOPBACK=1` is set for an explicitly isolated environment. Retinue does not add authentication to the OpenCode server it starts.

Retinue-managed OpenCode servers are not intended to live forever. After the last job using a managed server becomes terminal, Retinue schedules an idle shutdown; the default grace period is 30 seconds and can be changed with `RETINUE_OPENCODE_SERVER_IDLE_MS`. Shutdown uses process-tree termination so OpenCode helper processes such as language servers do not keep repository folders locked after the top-level `opencode serve` process exits. The trace records `opencode_server_idle_shutdown_scheduled`, `opencode_server_stopped`, or `opencode_server_stop_failed` for lifecycle debugging.

Explicit attach remains available:

```text
RETINUE_OPENCODE_BASE_URL=http://127.0.0.1:4096
```

The explicit URL must be loopback HTTP. Paths are ignored and normalized to the origin. If both `RETINUE_OPENCODE_BASE_URL` and `RETINUE_OPENCODE_AUTO_SERVE=1` are set, Retinue treats the explicit URL as the preferred attach target and falls back to managed auto-serve when that target is unreachable or does not look like OpenCode. Set only `RETINUE_OPENCODE_BASE_URL` for strict externally managed attach mode.

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
RETINUE_OPENCODE_SERVER_IDLE_MS=30000
```

When `RETINUE_OPENCODE_PORT` is explicit, Retinue does not silently fall back to another port.

MCP hosts commonly enforce their own per-tool timeout. Retinue therefore clamps `retinue_wait_agent` and `opencode_wait` calls to a host-safe maximum of 90 seconds by default. Complex OpenCode tasks should be polled with repeated wait calls; set `RETINUE_MCP_WAIT_MAX_MS` only when the host timeout is known to be higher.

Retinue's local HTTP clients also apply a 30-second transport timeout to OpenCode and daemon requests. Set `RETINUE_HTTP_TIMEOUT_MS` when a deployment needs a different local request ceiling; set it to `0` only when another layer already enforces a reliable timeout.

Product `retinue_spawn_agent` calls are read-only by default on the OpenCode backend. In read-only mode, Retinue creates the OpenCode session with explicit non-interactive permissions: file edits and nested `task` agents are denied, `doom_loop` and interactive `question` prompts are denied so headless runs do not wait for UI approval, and `bash` is limited to Git inspection commands such as `git show`, `git diff`, `git status`, `git log`, `git grep`, and `git blame`. Retinue still sends `tools: { edit: false, write: false, apply_patch: false, task: false }` with `prompt_async`, so local OpenCode profiles that allow edits do not leak write access into child-agent review tasks while normal code-review inspection remains usable through OpenCode's `read`, `grep`, and `glob` tools.

Codex plugin installs read the default from the installation-scoped `retinue.config.json` beside the plugin bootstrap. The shipped default is:

```json
{
  "opencode": {
    "defaultAccessMode": "read_only"
  }
}
```

`retinue_spawn_agent` can override the default for one child with `access_mode: "read_only"` or `access_mode: "profile"`. In read-only mode Retinue disables OpenCode `bash`, `edit`, `write`, `apply_patch`, and `task` at prompt level so permissive local profiles do not leak shell or write access into default child agents. `profile` means Retinue does not send that prompt-level tool deny list and the child follows the active OpenCode profile. Hermes and custom MCP deployments can set `RETINUE_OPENCODE_ACCESS_MODE=profile`, or the older `RETINUE_OPENCODE_READ_ONLY=0`, when profile-level shell or write capability is intentionally acceptable.

If a wait call returns `status: "running"`, keep the same `jobId` and call wait again. Do not spawn a replacement job only because one wait window elapsed.

OpenCode `prompt_async` can spend time in upstream tool-call setup before the HTTP call returns. Retinue therefore persists job metadata and returns the `jobId` after creating the OpenCode session, while the prompt submission continues in the background if it does not complete immediately. If prompt submission fails immediately, the spawn response returns the updated `failed` job. If prompt submission later fails after the spawn response has returned, the job moves to `failed` and writes `opencode_job_prompt_failed` diagnostics under the job directory and global trace.

If OpenCode returns assistant rounds with no visible text, Retinue keeps them out of successful results. Repeated empty `finish=stop` assistant rounds and long no-text tool-call loops become `stalled` with diagnostics so the caller can inspect logs or close the child agent. Blank, zero-progress, and incomplete latest assistant rounds use the long no-text threshold by default; this leaves room for OpenCode plan agents that continue thinking after tool use and later emit a final text answer. Deployments that need a faster probe-specific cutoff can set `RETINUE_OPENCODE_STALL_BLANK_ASSISTANT_MS`, `RETINUE_OPENCODE_STALL_ZERO_PROGRESS_ASSISTANT_MS`, or `RETINUE_OPENCODE_STALL_INCOMPLETE_ASSISTANT_MS`. If a read-only job emits a patch part, Retinue treats that as write intent, marks the job `stalled`, and returns a diagnostic result instead of trusting the child output. `stalled` jobs are attention-required terminal jobs for MCP slot accounting: they do not occupy Retinue's active child-agent pool, but cleanup still preserves their artifacts until the caller explicitly closes or removes them.

Stall diagnostics include a compact `stallReason` and `stallSummary` when Retinue can classify the failure. Current reason values are `read_only_write_intent`, `provider_blank_assistant`, `provider_zero_progress`, `read_tool_stalled`, `incomplete_assistant_round`, `backend_no_final_text`, and `tool_loop_no_completion`. These are backend-observation labels, not provider-specific configuration; for example, `provider_zero_progress` can describe any OpenCode provider or model router that produces zero useful assistant text after tool calls.

## Diagnostics

Retinue writes OpenCode backend diagnostics to the Retinue state directory:

```text
<stateDir>/logs/retinue.jsonl
<stateDir>/jobs/<jobId>/meta.json
<stateDir>/jobs/<jobId>/stdout.log
<stateDir>/jobs/<jobId>/stderr.log
```

If `RETINUE_STATE_DIR` is unset, Linux/WSL/macOS defaults to `$XDG_STATE_HOME/retinue` or `$HOME/.local/state/retinue`; Windows defaults to `%LOCALAPPDATA%\retinue`.

When `retinue_wait_agent` returns `running` or `stalled`, its response includes a compact `diagnostic` object plus `tracePath` or job artifact paths where available. Use `diagnostic` for the immediate decision, then inspect the trace path for full OpenCode message summaries, selected model/provider metadata, server URL, and stall diagnostics.

## Raw Adapter Surfaces

The `opencode-*` CLI commands and opt-in `opencode_*` MCP tools are raw backend adapter surfaces. They exist for development probes, backend debugging, and compatibility runbooks. They are not the product-level Codex or Hermes delegation contract.

Normal agent delegation should use `retinue_spawn_agent`, `retinue_wait_agent`, `retinue_close_agent`, and `retinue_list_agents`. Those tools apply the deployment-selected backend, Retinue-managed OpenCode server lifecycle, bounded diagnostics, per-spawn `access_mode`, and active child-agent pool semantics. Only expose backend tools with `RETINUE_EXPOSE_BACKEND_TOOLS=1` when intentionally debugging an adapter-specific issue.

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
