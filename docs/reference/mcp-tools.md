# MCP Tools Reference

The product MCP surface is backend-neutral. Retinue selects the backend from deployment configuration and exposes one normal tool family to Codex or Hermes.

## Tools

| Tool | Purpose |
| --- | --- |
| `spawn_agent` | Start a child agent and return a job handle. |
| `wait_agent` | Poll or wait for a result, queued promotion, stalled diagnostic, or permission event. |
| `close_agent` | Stop or close a child agent and release active slot accounting. |
| `list_agents` | List jobs known to the current Retinue MCP server session. |
| `list_permissions` | List pending backend permission requests for one job or all known jobs. |
| `reply_permission` | Reply to a pending backend permission request with `once`, `always`, or `reject`. |
| `stop_runtime` | Stop Retinue-managed local runtime servers, currently OpenCode auto-serve. |
| `restart_runtime` | Restart a Retinue-managed runtime server for one `cwd`, currently OpenCode auto-serve. |

Hidden adapter/debug tools are not part of the normal product contract. Expose them only with `RETINUE_EXPOSE_BACKEND_TOOLS=1` while investigating Retinue or a backend adapter.

## Spawn

Pass:

- `message`: the task for the child agent.
- `cwd`: an absolute repository or workspace directory for file work.
- `taskName` / `task_name` / `title`: a short label for diagnostics.
- `agent`: optional backend-native agent/profile for this one spawn. For OpenCode/Kilo this is a child agent name such as `explore` or `general`; for Claude Code SDK this is passed as the Claude Code `agent`/`--agent` main-thread profile. It is not a Retinue backend name such as `opencode`, a Codex model name, or a Codex native subagent name.

Do not pass backend, provider, profile, model, OpenCode server, `access_mode`, or `bash_policy` choices through normal product tool calls.

When OpenCode or Kilo exposes an agent list, Retinue validates the requested `agent` before creating the child session. Unknown values such as Codex model names fail fast with the available backend agents instead of being sent to the runtime and later surfacing as a zero-progress stall.

Claude Code owns its available SDK agents through Claude Code settings. Retinue does not enumerate or validate those names; Claude Code returns the native error if the requested agent profile is unavailable.

Claude Code also owns the default agent/profile. Retinue passes no Claude SDK `agent` unless the spawn call supplies `agent` or deployment configuration sets `RETINUE_CLAUDE_AGENT`; OpenCode/Kilo defaults such as `explore` do not carry over to Claude Code.

`spawn_agent` returns identifiers and path metadata such as `jobId`, `cwd`, `jobDir`, backend, the selected `agent` when set, and when available OpenCode session fields including `externalSessionId`, `externalSessionDirectory`, `externalRootSessionId`, `externalParentSessionId`, and `externalRunnerMode`.

Compare requested `cwd` with returned `externalSessionDirectory` for repository-sensitive work. A mismatch is workspace drift; close the child and re-spawn with the right directory before trusting file claims.

If active or queued budgets are exhausted, spawn can return `status: "resource_exhausted"` instead of a `jobId`. Inspect `reason`, `activeJobIds`, `globalAgentBudget`, and queue fields, then wait for capacity or close unneeded jobs.

## Wait States

| State | Meaning | Caller action |
| --- | --- | --- |
| `completed` | Retinue has terminal child text or structured output. | Use as evidence if the task and source paths match. |
| `running` | The child is still active or one wait window elapsed. | Inspect `diagnostic`, `stdoutTail`, `stderrTail`, and wait again with the same `jobId`. |
| `queued` | The job is waiting for session or global active budget. | Wait/list/close/spawn calls can promote it when slots open. |
| `stalled` | Retinue classified backend/model/tool-call failure or untrusted output. | Treat as non-evidence; inspect `diagnostic.stallReason` and close when done. |
| `failed` | Prompt submission or backend call failed terminally. | Use returned error and artifact paths for diagnosis. |
| `killed` | The job was stopped. | Do not treat output as complete. |
| `timed_out` | The backend exceeded a configured runtime timeout. | Treat as terminal failure; inspect diagnostics and artifacts. |
| `orphaned` | Disk metadata points at a process that no longer exists. | Treat as stale local state; close or clean up when safe. |
| `abandoned` | The process appears alive but is not owned by this Retinue session. | Do not count as usable current work; inspect before cleanup. |
| `not_found` / `corrupted` | Retinue cannot read a valid job record. | Re-check the job id and local state directory. |
| `backend_unreachable` | Retinue could not reach the backend runtime while reading job state. | Treat as infrastructure failure; restart/stop only Retinue-managed runtimes. |

When Retinue starts a fresh task-level attempt, wait output can include `requestedJobId`, `selectedAttemptJobId`, and `attemptChain`. The original stalled attempt remains non-evidence even when the selected attempt completes.

## Permissions

OpenCode permission requests stay OpenCode-owned. Retinue surfaces them so the supervising agent can decide:

1. `wait_agent` returns `attentionRequired.kind: "permission"` or compatibility field `permissionRequired: true`.
2. Inspect `permissionActions` first when present. Use `list_permissions` when full approval details are needed.
3. Reply with `reply_permission`.
4. Wait again.

Prefer `once` for narrowly scoped task-required access. Use `always` only for trusted repeated patterns. Use `reject` for out-of-scope paths or tools.

## Runtime Lifecycle

Retinue owns the lifecycle only for runtime servers it started itself. For OpenCode this means servers created by `RETINUE_OPENCODE_AUTO_SERVE=1` and recorded in Retinue discovery state. Explicit `RETINUE_OPENCODE_BASE_URL` attach targets are external and are not stopped or restarted by these tools.

Use `restart_runtime` with an absolute `cwd` when OpenCode provider/profile state changed and the Retinue-managed server should be refreshed. It stops the matching managed server and starts a new one. If matching jobs are still `running` or unresolved `stalled`, the restart is blocked unless `force: true` is set. Forced stop marks matching running or stalled job metadata as `killed`.

Use `stop_runtime` with either an absolute `cwd` or `all: true`. Without `force`, it refuses to stop servers that still have running or unresolved stalled Retinue jobs. `all: true` is intended for maintenance windows where the caller wants every Retinue-managed OpenCode server stopped so later spawns reload runtime configuration.

## Evidence Rules

- Do not count stalled output as review evidence.
- Do not count advisory text after read-only write intent as trusted evidence unless diagnostics say recovery completed cleanly.
- Ask child agents to cite absolute paths for file-existence claims.
- Close terminal jobs when their result is no longer needed.
