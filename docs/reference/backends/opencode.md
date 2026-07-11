# OpenCode Backend

The OpenCode backend is a thin lifecycle adapter. It does not configure providers,
models, endpoint routing, `/connect`, credentials, agents, plugins, skills, or
permissions. OpenCode owns those concerns through its active profile.

For local production smoke testing, OpenCode is the preferred first backend. Retinue
should reuse the installed OpenCode profile instead of creating a separate child-agent
profile.

Recovery follows the product boundary in
[Retinue Attempt Recovery](../../explanation/attempt-recovery.md). Retinue may send
steering prompts or start bounded fresh attempts through OpenCode's existing session
APIs, but it does not require OpenCode source changes, duplicate OpenCode's session
model, or treat stalled child text as trusted evidence.

## Install Assumption

The default v0.2.0 user path assumes the official OpenCode install script:

```bash
curl -fsSL https://opencode.ai/install | bash
```

The script installs the CLI under `$HOME/.opencode/bin/opencode`. Retinue first honors
an explicit `RETINUE_OPENCODE_COMMAND`, then the inherited `PATH`, then common default
install locations. On Windows that fallback includes
`%USERPROFILE%\.opencode\bin\opencode` before package-manager shims such as
pnpm/npm/bun.

On POSIX systems, including WSL and macOS, Retinue also checks
`$HOME/.opencode/bin/opencode` even when the installer did not add it to `PATH`.

## Server Target

The default plugin integration mode is Retinue-managed auto-serve:

```text
RETINUE_OPENCODE_AUTO_SERVE=1
RETINUE_OPENCODE_HOST=127.0.0.1
```

Retinue prefers `127.0.0.1:4096` and tries local fallback ports `4097` through `4127`
when the preferred port is occupied by an external service. A running OpenCode server
from another environment is treated as external unless the deployment sets
`RETINUE_OPENCODE_BASE_URL`.

Managed OpenCode auto-serve binds to loopback only by default.
`RETINUE_OPENCODE_HOST=0.0.0.0` or another non-loopback host is rejected unless
`RETINUE_OPENCODE_ALLOW_NON_LOOPBACK=1` is set for an explicitly isolated environment.
Retinue does not add authentication to the OpenCode server it starts.

Retinue-managed OpenCode servers are not intended to live forever. After the last job
using a managed server becomes terminal, Retinue schedules an idle shutdown; the default
grace period is 30 seconds and can be changed with `RETINUE_OPENCODE_SERVER_IDLE_MS`.
Shutdown uses process-tree termination so OpenCode helper processes such as language
servers do not keep repository folders locked after the top-level `opencode serve`
process exits. The trace records `opencode_server_idle_shutdown_scheduled`,
`opencode_server_stopped`, or `opencode_server_stop_failed` for lifecycle debugging.

Retinue also exposes agent-facing runtime lifecycle tools for servers it auto-served.
Use `restart_runtime` with an absolute `cwd` to refresh an OpenCode server after
provider/profile changes. Use `stop_runtime` with `cwd` or `all: true` for maintenance
stops. Both tools refuse to stop a server with running or unresolved stalled Retinue
jobs unless `force: true` is set; forced stops mark matching running or stalled job
metadata as `killed`.

Explicit attach remains available:

```text
RETINUE_OPENCODE_BASE_URL=http://127.0.0.1:4096
```

The explicit URL must be loopback HTTP. Paths are ignored and normalized to the origin.
If both `RETINUE_OPENCODE_BASE_URL` and `RETINUE_OPENCODE_AUTO_SERVE=1` are set, Retinue
treats the explicit URL as the preferred attach target and falls back to managed
auto-serve when that target is unreachable or does not look like OpenCode. Set only
`RETINUE_OPENCODE_BASE_URL` for strict externally managed attach mode.

Model override is optional, and persistent deployment defaults should come from
environment variables:

```text
RETINUE_OPENCODE_MODEL=litellm/pro-router
```

CLI/MCP request fields win over environment variables, and environment variables win
over the packaged Retinue JSON defaults. If none is set, retinue does not send `model`;
for plugin installs, the packaged fallback may provide an OpenCode `agent`.

Retinue v0.2.0 plugin deployments ship `opencode.agent: "explore"` in
`retinue.config.json` as an installation-cache fallback. Do not edit the cached file for
persistent deployment state; plugin refreshes can overwrite it. Use
`RETINUE_OPENCODE_AGENT` when a deployment needs a persistent default. Retinue follows
the active OpenCode profile and selected OpenCode agent semantics. `spawn_agent` can
override the OpenCode agent for one child with `agent`; it does not expose a separate
Retinue access-mode layer. For OpenCode-native semantics, `explore` is the default
read-only subagent and `general` is the built-in writable subagent for multi-step work.
`build` is a primary agent/root candidate, not the default writable subagent. If the
runtime exposes `/agent`, Retinue validates the requested OpenCode agent before creating
the child session and rejects unknown values such as Codex model or Codex native
subagent names.

## Profile

OpenCode profile state is OpenCode-owned. Permissions, plugins, skills, model defaults,
provider config, and agent defaults are profile details, not separate Retinue product
controls.

Phase 1 should make the local E2E run reliably with the effective OpenCode deployment
profile. If the active profile blocks unattended child-agent execution, adjust the
deployment-level OpenCode profile and record the non-sensitive fact in the local
runbook. Do not expose profile selection or permission mode as a normal Codex-facing
tool argument.

OpenCode MCP config uses the top-level `mcp` key. Do not copy Claude/Codex-style
`mcpServers` into `opencode.json`; current OpenCode rejects it as an unrecognized key.

When a model override is provided, retinue accepts the OpenCode CLI-style
`provider/model` string and sends the server API shape:

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

When `RETINUE_OPENCODE_PORT` is explicit, Retinue does not silently fall back to another
port. Set it to a concrete loopback port in the `1..65535` range; `0` is rejected
because Retinue cannot discover the random port that `opencode serve --port 0` would
bind.

MCP hosts commonly enforce their own per-tool timeout. Retinue therefore clamps
`wait_agent` and `opencode_wait` calls to a host-safe maximum of 180 seconds by default.
This gives the default 45-second OpenCode soft-stall detectors enough room to submit one
final-answer rescue prompt and wait for the rescue to complete before the MCP wait
returns `stalled`. Complex OpenCode tasks can still be polled with repeated wait calls;
set `RETINUE_MCP_WAIT_MAX_MS` only when the host timeout is known to be different.

Retinue's local HTTP clients also apply a 30-second transport timeout to OpenCode and
daemon requests. Set `RETINUE_HTTP_TIMEOUT_MS` when a deployment needs a different local
request ceiling; set it to `0` only when another layer already enforces a reliable
timeout.

Product `spawn_agent` calls are agent-aware on the OpenCode backend. OpenCode owns the
effective profile, permissions, tools, plugins, and agent behavior. Retinue does not
inject a read-only prompt contract, does not send prompt-level tool overrides, and does
not expose `access_mode` or `bash_policy` on the product MCP tool. The normal OpenCode
child-agent choices are OpenCode's own subagents: `explore` for read-only research and
`general` for writable multi-step work.

Retinue does not submit OpenCode `SubtaskPartInput` as the normal spawn path because
that path runs inside the parent prompt loop and can wake the parent agent/model after
the subtask completes. Instead, Retinue keeps a direct child session topology and
mirrors the observable OpenCode `TaskTool` child-session behavior: it reads `/agent`
metadata, creates the requested child session under the shared root parent, inherits
the parent session's deny and `external_directory` rules, and denies child
`todowrite`/`task` unless the requested OpenCode subagent explicitly allows them. Parent
agent restrictions do not transfer to the child; the selected OpenCode subagent owns its
own capabilities. OpenCode `TaskTool` features that depend on the parent prompt loop,
such as native `background` and `task_id`, are not exposed as Retinue equivalents.
Retinue job handles and task-level recovery attempts belong to the MCP lifecycle and
must not be described as OpenCode task continuation.

The OpenCode backend defaults to `shared_root`: one Retinue MCP server session reuses
one inert OpenCode root session for multiple child jobs with the same server URL and
cwd. The structural root has no agent binding. Set
`RETINUE_OPENCODE_ROOT_BINDING_MODE=per_spawn` only for legacy
compatibility, isolation probes, or debugging. In `per_spawn`, each Retinue child job
creates its own unprompted root session plus one prompted child session.

The Codex plugin ships an installation-cache `retinue.config.json` for package defaults
such as `maxConcurrentAgents` and `opencode.agent`. Treat it as read-only packaged
fallback, not user configuration. Persistent deployment choices should use environment
variables such as `RETINUE_MAX_CONCURRENT_AGENTS`, `RETINUE_GLOBAL_AGENT_BUDGET`,
`RETINUE_OVERFLOW_STRATEGY`, `RETINUE_MAX_QUEUED_AGENTS`, and `RETINUE_OPENCODE_AGENT`.
`RETINUE_MAX_CONCURRENT_AGENTS` is scoped to one MCP server session and defaults to `3`.
`RETINUE_GLOBAL_AGENT_BUDGET` is scoped to the shared `RETINUE_STATE_DIR` and prevents
multiple Codex/Hermes sessions from multiplying local child-agent budgets; when omitted
it defaults to `max(5, RETINUE_MAX_CONCURRENT_AGENTS)`. The default overflow strategy is
`queue`: when session or global active slots are full, `spawn_agent` returns a `queued`
job handle and later `wait/list/close/spawn` calls opportunistically promote queued jobs
when slots open. Set `RETINUE_OVERFLOW_STRATEGY=evict` only when the deployment
explicitly wants the old same-session oldest-running eviction behavior.
`RETINUE_MAX_QUEUED_AGENTS` bounds queued jobs and defaults to `20`; queue exhaustion
returns `resource_exhausted` with `reason: "queue_full"`. A single `spawn_agent` call
may still pass `agent` to choose another OpenCode agent for that child. Backend,
profile, model, provider, OpenCode server, `access_mode`, and `bash_policy` are not
normal product tool arguments.

If a wait call returns `status: "running"`, keep the same `jobId` and call wait again.
Do not spawn a replacement job only because one wait window elapsed.

OpenCode `prompt_async` can spend time in upstream tool-call setup before the HTTP call
returns. Retinue therefore persists job metadata and returns the `jobId` after creating
the OpenCode session, while the prompt submission continues in the background if it does
not complete immediately. If prompt submission fails immediately, the spawn response
returns the updated `failed` job. If prompt submission later fails after the spawn
response has returned, the job moves to `failed` and writes `opencode_job_prompt_failed`
diagnostics under the job directory and global trace.

If OpenCode returns assistant rounds with no visible text, Retinue keeps them out of
successful results. No-final-text stalls include blank provider placeholders,
zero-progress assistant placeholders, incomplete latest assistant rounds, completed
tool-call loops, and empty `finish=stop` assistant rounds.

Retinue does not submit a same-session no-tools recovery prompt, does not switch the
OpenCode agent behind the caller's back, and does not override the child's tool set to
simulate read-only behavior. OpenCode owns the active session, agent profile,
permission engine, and tool availability. Retinue observes the resulting session and,
when configured retry policy allows it, may start bounded fresh task-level attempts with
new OpenCode child jobs/sessions. The original job remains `stalled` and non-evidence;
the wait response is re-keyed to the selected attempt and includes `requestedJobId`,
`selectedAttemptJobId`, and `attemptChain` provenance.

If `RETINUE_OPENCODE_TASK_ATTEMPT_MAX` is unset, malformed tool-call stalls get up to
2 fresh attempts and other recoverable stalls get up to 1. Set
`RETINUE_OPENCODE_TASK_ATTEMPT_MAX=0` to disable fresh task attempts, or set an explicit
number to override the reason-specific defaults for controlled experiments. If the
selected fresh attempt also exhausts the budget, the stalled result states that no
usable child-agent conclusion is available. If the wait window expires without usable
final text or a selected attempt, the job returns `stalled` with diagnostics so the
caller can inspect logs or close the child agent.

Blank provider placeholders, incomplete latest assistant rounds,
pending/running `read` tool calls, and completed tool-call loops with no final text
use 45-second default windows. Zero-progress assistant placeholders also use a
45-second default window unless they are the latest round after completed tool-call
progress. That finalization-after-tool-progress case uses a 120-second default window
so Retinue does not interrupt a normal OpenCode tool chain while the final answer is
still being generated.

Empty `finish=stop` assistant rounds are classified after one empty round by default.
Deployments that need a different cutoff can set
`RETINUE_OPENCODE_STALL_BLANK_ASSISTANT_MS`,
`RETINUE_OPENCODE_STALL_ZERO_PROGRESS_ASSISTANT_MS`,
`RETINUE_OPENCODE_STALL_FINALIZATION_AFTER_TOOL_PROGRESS_MS`,
`RETINUE_OPENCODE_STALL_INCOMPLETE_ASSISTANT_MS`,
`RETINUE_OPENCODE_STALL_READ_TOOL_MS`,
`RETINUE_OPENCODE_STALL_COMPLETED_TOOL_LOOP_MS`, or
`RETINUE_OPENCODE_STALL_EMPTY_ASSISTANT_ROUNDS`. Non-empty `reasoning` parts are
treated as OpenCode/provider progress for an unfinished assistant round, even when
visible `text` has not started yet. Retinue still does not return reasoning text as
trusted stdout; it only avoids interrupting the active OpenCode chain with a
final-answer classification while reasoning is the only observed progress. An
unfinished assistant round that already contains completed tool parts is also treated
as OpenCode tool-chain finalization progress and uses the longer finalization window
instead of the shorter incomplete-round window. If OpenCode
attaches a provider/API error to an assistant message, Retinue classifies it as
`provider_error` and includes the redacted error preview in the stalled result, so
authentication or router failures are not mislabeled as child write intent. OpenCode
may attach `patch` parts from its snapshot system or report write-capable tool parts
in its message stream. Retinue reports those as neutral diagnostics (`patchPartCount`,
`writeIntentToolPartCount`) but does not enforce a separate read-only policy on top of
OpenCode's native agent/profile permissions.
`stalled` jobs are attention-required terminal jobs for MCP
slot accounting: they do not occupy Retinue's active child-agent pool, but cleanup still
preserves their artifacts until the caller explicitly closes or removes them. If only
`status` has observed a recoverable stall, a later OpenCode final answer can still
promote the job to `completed`; once `result` has persisted a stalled stdout, later
OpenCode messages do not promote that same Retinue job to `completed` or overwrite the
persisted stalled result.

Stall diagnostics include a compact `stallReason` and `stallSummary` when Retinue can
classify the failure. Current reason values are `provider_error`,
`provider_reasoning_content_error`, `provider_blank_assistant`,
`provider_zero_progress`, `read_tool_stalled`, `read_tool_invalid_input`,
`tool_invalid_input`,
`incomplete_assistant_round`, `backend_no_final_text`, `tool_loop_no_completion`, and
`external_directory_permission_pending`. A `read_tool_stalled` diagnostic also includes
`runningReadToolParts`, `runningReadToolCallIds`, and `runningReadToolPartSummaries` so
the operator can identify the stuck OpenCode read call without first expanding the full
message history. `read_tool_invalid_input` means the provider/model emitted a malformed
`read` tool call, such as input `{}` with no usable `filePath`. `tool_invalid_input`
means a non-read tool call, such as `grep`, had explicitly empty or null input. Treat
both as stalled provider/tool-call output, not review evidence. `provider_reasoning_content_error` means
a thinking-mode route rejected missing `reasoning_content` continuity and should be
handled as provider/router configuration evidence. When `provider_blank_assistant` or
`provider_zero_progress` also has `finalizationAfterToolProgress: true`, it means
OpenCode made tool-call progress and then did not produce a final answer inside the
longer finalization window; it is not evidence that the provider returned an empty
final answer. Retinue also treats OpenCode `step-start` plus empty `text` assistant
messages after completed tool calls, and unfinished assistant rounds with completed
tool parts, as finalization placeholders for this window. If a
selected fresh attempt also
stalls, the result keeps `status: "stalled"` and includes the attempt-exhausted
explanation in stdout/stderr rather than manufacturing a trusted answer from incomplete
evidence. Stalled result diagnostics also expose `selectedAssistantTextBytes` and
`selectedAssistantSha256` when Retinue captured visible assistant text. These are
backend-observation labels, not provider-specific
configuration; for example, `provider_zero_progress` can describe any OpenCode provider
or model router that produces zero useful assistant text after tool calls.

Provider/no-final-text and malformed-tool stall reasons may trigger the separate fresh
task-level attempt policy when the attempt budget allows it. `read_tool_stalled`,
`provider_error`, and `provider_reasoning_content_error` return as stalled diagnostics
without a recovery prompt. Fresh attempts create new jobs rather than promoting the
original stalled job.

## Diagnostics

Retinue writes OpenCode backend diagnostics to the Retinue state directory:

```text
<stateDir>/logs/retinue.jsonl
<stateDir>/jobs/<jobId>/meta.json
<stateDir>/jobs/<jobId>/stdout.log
<stateDir>/jobs/<jobId>/stderr.log
```

If `RETINUE_STATE_DIR` is unset, Linux/WSL/macOS defaults to `$XDG_STATE_HOME/retinue`
or `$HOME/.local/state/retinue`; Windows defaults to `%LOCALAPPDATA%\retinue`.

When `wait_agent` returns `running` or `stalled`, its response includes a compact
`diagnostic` object plus `tracePath` or job artifact paths where available. Use
`diagnostic` for the immediate decision, then inspect the trace path for full OpenCode
message summaries, selected model/provider metadata, server URL, and stall diagnostics.

OpenCode permission requests remain OpenCode-owned. Retinue exposes them through an MCP
bridge for supervising agents: `wait_agent` marks pending permission work with
`attentionRequired.kind: "permission"` plus compatibility fields `permissionRequired:
true` and `permissions`; `list_permissions` lists pending request ids for a Retinue job
or all known jobs when `jobId` is omitted; and `reply_permission` replies through
OpenCode's native permission API with `once`, `always`, or `reject`. Each listed
permission includes an `approval` object with a title, display lines, guidance, and
reply option semantics so the supervising agent can make an explicit decision without
treating the child output as evidence. Permission wait responses keep raw stderr compact
and rely on paths plus structured diagnostics for deeper inspection, so permission
events do not drown out the required supervisor action. Retinue validates that the
request belongs to the job's OpenCode session or child sessions before replying. It does
not auto-approve external directories and does not define a separate permission DSL.

## Raw Adapter Surfaces

The `opencode-*` CLI commands and opt-in `opencode_*` MCP tools are raw backend adapter
surfaces. They exist for development probes, backend debugging, and compatibility
runbooks. They are not the product-level Codex or Hermes delegation contract.

Normal agent delegation should use `spawn_agent`, `wait_agent`, `close_agent`,
`list_agents`, `list_permissions`, and `reply_permission`. Those tools apply the
deployment-selected backend, Retinue-managed OpenCode server lifecycle, bounded
diagnostics, optional per-spawn OpenCode `agent`, active child-agent pool semantics, and
the OpenCode-native permission bridge. Only expose backend tools with
`RETINUE_EXPOSE_BACKEND_TOOLS=1` when intentionally debugging an adapter-specific issue.

## Verification

Use [Verification](../../how-to/verify.md) for deterministic gates and real backend
probes. Keep real OpenCode evidence in runbooks or release planning notes, not in this
backend reference.
