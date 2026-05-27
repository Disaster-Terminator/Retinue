# MCP Tools Reference

The product MCP surface is backend-neutral. Retinue selects the backend from deployment configuration and exposes one normal tool family to Codex or Hermes.

## Tools

| Tool | Purpose |
| --- | --- |
| `retinue_spawn_agent` | Start a child agent and return a job handle. |
| `retinue_wait_agent` | Poll or wait for a result, queued promotion, stalled diagnostic, or permission event. |
| `retinue_close_agent` | Stop or close a child agent and release active slot accounting. |
| `retinue_list_agents` | List jobs known to the current Retinue MCP server session. |
| `retinue_list_permissions` | List pending backend permission requests for one job or all known jobs. |
| `retinue_reply_permission` | Reply to a pending backend permission request with `once`, `always`, or `reject`. |

Hidden adapter/debug tools are not part of the normal product contract. Expose them only with `RETINUE_EXPOSE_BACKEND_TOOLS=1` while investigating Retinue or a backend adapter.

## Spawn

Pass:

- `message`: the task for the child agent.
- `cwd`: an absolute repository or workspace directory for file work.
- `taskName` / `task_name` / `title`: a short label for diagnostics.
- `agent`: optional OpenCode/Kilo child agent for this one spawn.

Do not pass backend, provider, profile, model, OpenCode server, `access_mode`, or `bash_policy` choices through normal product tool calls.

`retinue_spawn_agent` returns identifiers and path metadata such as `jobId`, `cwd`, `jobDir`, backend, and when available OpenCode session fields including `externalSessionId`, `externalSessionDirectory`, `externalRootSessionId`, `externalParentSessionId`, and `externalRunnerMode`.

Compare requested `cwd` with returned `externalSessionDirectory` for repository-sensitive work. A mismatch is workspace drift; close the child and re-spawn with the right directory before trusting file claims.

## Wait States

| State | Meaning | Caller action |
| --- | --- | --- |
| `completed` | Retinue has terminal child text or structured output. | Use as evidence if the task and source paths match. |
| `running` | The child is still active or one wait window elapsed. | Inspect `diagnostic`, `stdoutTail`, `stderrTail`, and wait again with the same `jobId`. |
| `queued` | The job is waiting for session or global active budget. | Wait/list/close/spawn calls can promote it when slots open. |
| `stalled` | Retinue classified backend/model/tool-call failure or untrusted output. | Treat as non-evidence; inspect `diagnostic.stallReason` and close when done. |
| `failed` | Prompt submission or backend call failed terminally. | Use returned error and artifact paths for diagnosis. |
| `killed` | The job was stopped. | Do not treat output as complete. |

When Retinue starts a fresh task-level attempt, wait output can include `requestedJobId`, `selectedAttemptJobId`, and `attemptChain`. The original stalled attempt remains non-evidence even when the selected attempt completes.

## Permissions

OpenCode permission requests stay OpenCode-owned. Retinue surfaces them so the supervising agent can decide:

1. `retinue_wait_agent` returns `attentionRequired.kind: "permission"` or compatibility field `permissionRequired: true`.
2. Inspect `permissionActions` first when present. Use `retinue_list_permissions` when full approval details are needed.
3. Reply with `retinue_reply_permission`.
4. Wait again.

Prefer `once` for narrowly scoped task-required access. Use `always` only for trusted repeated patterns. Use `reject` for out-of-scope paths or tools.

## Evidence Rules

- Do not count stalled output as review evidence.
- Do not count advisory text after read-only write intent as trusted evidence unless diagnostics say recovery completed cleanly.
- Ask child agents to cite absolute paths for file-existence claims.
- Close terminal jobs when their result is no longer needed.
