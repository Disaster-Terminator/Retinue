# OpenCode Backend

The OpenCode backend is a thin lifecycle adapter. It does not configure providers, models, endpoint routing, `/connect`, credentials, agents, plugins, skills, or permissions. OpenCode owns those concerns through its active profile.

For local production smoke testing, OpenCode is the preferred first backend. Retinue should reuse the installed OpenCode profile instead of creating a separate child-agent profile.

## Install Assumption

The default v0.2.0 user path assumes the official OpenCode install script:

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

Model override is optional, and persistent deployment defaults should come from environment variables:

```text
RETINUE_OPENCODE_MODEL=litellm/pro-router
```

CLI/MCP request fields win over environment variables, and environment variables win over the packaged Retinue JSON defaults. If none is set, retinue does not send `model`; for plugin installs, the packaged fallback may provide an OpenCode `agent`.

Retinue v0.2.0 plugin deployments ship `opencode.agent: "explore"` in `retinue.config.json` as an installation-cache fallback. Do not edit the cached file for persistent deployment state; plugin refreshes can overwrite it. Use `RETINUE_OPENCODE_AGENT` when a deployment needs a persistent default. Retinue follows the active OpenCode profile and selected OpenCode agent semantics. `retinue_spawn_agent` can override the OpenCode agent for one child with `agent`; it does not expose a separate Retinue access-mode layer.

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
RETINUE_OPENCODE_SOFT_STALL_RESCUE_AGENT=build
```

When `RETINUE_OPENCODE_PORT` is explicit, Retinue does not silently fall back to another port. Set it to a concrete loopback port in the `1..65535` range; `0` is rejected because Retinue cannot discover the random port that `opencode serve --port 0` would bind.

MCP hosts commonly enforce their own per-tool timeout. Retinue therefore clamps `retinue_wait_agent` and `opencode_wait` calls to a host-safe maximum of 180 seconds by default. This gives the default 45-second OpenCode soft-stall detectors enough room to submit one final-answer rescue prompt and wait for the rescue to complete before the MCP wait returns `stalled`. Complex OpenCode tasks can still be polled with repeated wait calls; set `RETINUE_MCP_WAIT_MAX_MS` only when the host timeout is known to be different.

Retinue's local HTTP clients also apply a 30-second transport timeout to OpenCode and daemon requests. Set `RETINUE_HTTP_TIMEOUT_MS` when a deployment needs a different local request ceiling; set it to `0` only when another layer already enforces a reliable timeout.

Product `retinue_spawn_agent` calls are agent-aware on the OpenCode backend. OpenCode owns the effective profile, permissions, tools, plugins, and agent behavior. Retinue does not inject a read-only prompt contract, does not send prompt-level tool overrides, and does not expose `access_mode` or `bash_policy` on the product MCP tool.

Retinue does not submit OpenCode `SubtaskPartInput` as the normal spawn path because that path runs inside the parent prompt loop and can wake the parent agent/model after the subtask completes. Instead, Retinue keeps a direct child session topology and mirrors the important OpenCode `TaskTool` permission behavior: it reads `/agent` metadata, creates the requested child session under the parent, inherits parent edit denies plus parent-session deny/external-directory rules, and denies child `todowrite`/`task` unless the requested OpenCode subagent explicitly allows them.

The Codex plugin ships an installation-cache `retinue.config.json` for package defaults such as `maxConcurrentAgents` and `opencode.agent`. Treat it as read-only packaged fallback, not user configuration. Persistent deployment choices should use environment variables such as `RETINUE_MAX_CONCURRENT_AGENTS`, `RETINUE_GLOBAL_AGENT_BUDGET`, and `RETINUE_OPENCODE_AGENT`. `RETINUE_MAX_CONCURRENT_AGENTS` is scoped to one MCP server session. `RETINUE_GLOBAL_AGENT_BUDGET` is scoped to the shared `RETINUE_STATE_DIR` and prevents multiple Codex/Hermes sessions from multiplying local child-agent budgets; when omitted it follows the session limit. A single `retinue_spawn_agent` call may still pass `agent` to choose another OpenCode agent for that child. Backend, profile, model, provider, OpenCode server, `access_mode`, and `bash_policy` are not normal product tool arguments.

If a wait call returns `status: "running"`, keep the same `jobId` and call wait again. Do not spawn a replacement job only because one wait window elapsed.

OpenCode `prompt_async` can spend time in upstream tool-call setup before the HTTP call returns. Retinue therefore persists job metadata and returns the `jobId` after creating the OpenCode session, while the prompt submission continues in the background if it does not complete immediately. If prompt submission fails immediately, the spawn response returns the updated `failed` job. If prompt submission later fails after the spawn response has returned, the job moves to `failed` and writes `opencode_job_prompt_failed` diagnostics under the job directory and global trace.

If OpenCode returns assistant rounds with no visible text, Retinue keeps them out of successful results and separates recoverable soft stalls from hard stalls. Recoverable no-final-text stalls include blank provider placeholders, zero-progress assistant placeholders, incomplete latest assistant rounds, completed tool-call loops, and empty `finish=stop` assistant rounds. While the current `retinue_wait_agent` call still has time, Retinue defers those soft stalls, submits one no-tools final-answer recovery prompt to the same OpenCode session, and continues polling so a late final answer can still become `completed`. The recovery prompt defaults to OpenCode's `build` agent because `plan` can also stall while summarizing; set `RETINUE_OPENCODE_SOFT_STALL_RESCUE_AGENT` to another agent name for experiments, or to `none`, `0`, or `false` to keep the original agent. Retinue records `opencode_job_soft_stall_deferred` and `opencode_job_soft_stall_rescue_submitted` for this path. If that same-session rescue or a malformed read call proves the execution chain is unreliable, Retinue may start one fresh task-level attempt with a new OpenCode child job/session. The original job remains `stalled` and non-evidence; the wait response is re-keyed to the selected attempt and includes `requestedJobId`, `selectedAttemptJobId`, and `attemptChain` provenance. Set `RETINUE_OPENCODE_TASK_ATTEMPT_MAX=0` to disable fresh task attempts, or raise it only for controlled experiments. If the wait window expires without usable final text or a selected attempt, the job returns `stalled` with diagnostics so the caller can inspect logs or close the child agent.

Blank provider placeholders, zero-progress assistant placeholders, incomplete latest assistant rounds, pending/running `read` tool calls, and completed tool-call loops with no final text use 45-second default windows. Empty `finish=stop` assistant rounds are classified after one empty round by default. Deployments that need a different cutoff can set `RETINUE_OPENCODE_STALL_BLANK_ASSISTANT_MS`, `RETINUE_OPENCODE_STALL_ZERO_PROGRESS_ASSISTANT_MS`, `RETINUE_OPENCODE_STALL_INCOMPLETE_ASSISTANT_MS`, `RETINUE_OPENCODE_STALL_READ_TOOL_MS`, `RETINUE_OPENCODE_STALL_COMPLETED_TOOL_LOOP_MS`, or `RETINUE_OPENCODE_STALL_EMPTY_ASSISTANT_ROUNDS`. If OpenCode attaches a provider/API error to an assistant message, Retinue classifies it as `provider_error` and includes the redacted error preview in the stalled result, so authentication or router failures are not mislabeled as child write intent. Read-only write intent is limited to actual write-capable tool calls (`write`, `edit`, or `apply_patch`). OpenCode may attach `patch` parts from its snapshot system; Retinue reports those in diagnostics but does not treat a `patch` part alone as write intent. If a read-only job attempts a write-capable tool, Retinue quarantines that history, submits one no-tools prose-only recovery prompt, and trusts only final assistant text produced after the recovery boundary. A clean recovery can complete the job with `diagnostic.recoveredFromReadOnlyWriteIntent=true`; a second write-capable tool attempt keeps the job `stalled`. `stalled` jobs are attention-required terminal jobs for MCP slot accounting: they do not occupy Retinue's active child-agent pool, but cleanup still preserves their artifacts until the caller explicitly closes or removes them. If only `status` has observed a recoverable stall, a later OpenCode final answer can still promote the job to `completed`; once `result` has persisted a stalled stdout, later OpenCode messages do not promote that same Retinue job to `completed` or overwrite the persisted stalled result.

Stall diagnostics include a compact `stallReason` and `stallSummary` when Retinue can classify the failure. Current reason values are `read_only_write_intent`, `provider_error`, `provider_blank_assistant`, `provider_zero_progress`, `read_tool_stalled`, `read_tool_invalid_input`, `incomplete_assistant_round`, `backend_no_final_text`, and `tool_loop_no_completion`. A `read_tool_stalled` diagnostic also includes `runningReadToolParts`, `runningReadToolCallIds`, and `runningReadToolPartSummaries` so the operator can identify the stuck OpenCode read call without first expanding the full message history. `read_tool_invalid_input` means the provider/model emitted a malformed `read` tool call, such as input `{}` with no usable `filePath`; treat it as stalled provider/tool-call output, not review evidence. Stalled result diagnostics also expose `selectedAssistantTextBytes` and `selectedAssistantSha256` when Retinue captured visible assistant text. If read-only write-tool recovery does not produce trusted final text, Retinue can still return the visible child text as advisory stdout while keeping the job `stalled`; diagnostics mark this with `readOnlyAdvisoryText`, and `readOnlyTextWarning` / `readOnlyTextWarningSummary` tell callers not to treat it as executable or trusted review evidence. These are backend-observation labels, not provider-specific configuration; for example, `provider_zero_progress` can describe any OpenCode provider or model router that produces zero useful assistant text after tool calls.

Soft stall reasons are deferred within the active wait timeout: `provider_blank_assistant`, `provider_zero_progress`, `incomplete_assistant_round`, `backend_no_final_text`, and `tool_loop_no_completion`. `read_only_write_intent` is recoverable once through the no-tools final-answer prompt, then becomes a hard stall if recovery repeats the write intent. `read_tool_stalled`, `read_tool_invalid_input`, and `provider_error` return as stalled diagnostics without a no-tools rescue prompt. `read_tool_invalid_input` and failed finalization rescue paths can trigger the separate fresh task-level attempt policy; this creates a new job rather than promoting the original stalled job.

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

OpenCode permission requests remain OpenCode-owned. Retinue exposes them through an MCP bridge for supervising agents: `retinue_wait_agent` marks pending permission work with `attentionRequired.kind: "permission"` plus compatibility fields `permissionRequired: true` and `permissions`; `retinue_list_permissions` lists pending request ids for a Retinue job or all known jobs when `jobId` is omitted; and `retinue_reply_permission` replies through OpenCode's native permission API with `once`, `always`, or `reject`. Each listed permission includes an `approval` object with a title, display lines, guidance, and reply option semantics so the supervising agent can make an explicit decision without treating the child output as evidence. Retinue validates that the request belongs to the job's OpenCode session or child sessions before replying. It does not auto-approve external directories and does not define a separate permission DSL.

## Raw Adapter Surfaces

The `opencode-*` CLI commands and opt-in `opencode_*` MCP tools are raw backend adapter surfaces. They exist for development probes, backend debugging, and compatibility runbooks. They are not the product-level Codex or Hermes delegation contract.

Normal agent delegation should use `retinue_spawn_agent`, `retinue_wait_agent`, `retinue_close_agent`, `retinue_list_agents`, `retinue_list_permissions`, and `retinue_reply_permission`. Those tools apply the deployment-selected backend, Retinue-managed OpenCode server lifecycle, bounded diagnostics, optional per-spawn OpenCode `agent`, active child-agent pool semantics, and the OpenCode-native permission bridge. Only expose backend tools with `RETINUE_EXPOSE_BACKEND_TOOLS=1` when intentionally debugging an adapter-specific issue.

## Current Status

Implemented:

- fake OpenCode HTTP server for deterministic tests
- narrow `OpenCodeClient`
- `OpenCodeBackend` run/result/continue/abort against the fake server
- model override via `RETINUE_OPENCODE_MODEL` and persistent agent default via `RETINUE_OPENCODE_AGENT`
- OpenCode 1.14.35 request compatibility for `prompt_async` structured parts, 204 responses, object-shaped model overrides, and sessions without a `state` field
- backend metadata fields on job records
- attach/serve policy helpers
- CLI `opencode-run`, `opencode-status`, `opencode-wait`, `opencode-result`, `opencode-continue`, `opencode-kill`, and `opencode-cleanup`
- opt-in MCP `opencode_*` lifecycle tools for adapter debugging when `RETINUE_EXPOSE_BACKEND_TOOLS=1`
- deterministic CLI/MCP tests using a fake OpenCode server
- manual real OpenCode probe script

Not implemented yet:

- daemon RPC routing for OpenCode jobs
