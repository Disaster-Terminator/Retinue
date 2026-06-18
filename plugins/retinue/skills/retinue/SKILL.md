---
name: retinue
description: Use Retinue when Codex needs to spawn, wait for, and close local
  coding-agent subagents through the backend-selected Retinue MCP tools.
---

# Retinue

Use Retinue for bounded local subagent work when Codex should keep control through MCP job handles.

## Quick Procedure

1. Spawn with `spawn_agent`.
2. Wait with `wait_agent`.
3. Close with `close_agent` after the result is terminal or no longer needed.

For repository work, pass an absolute `cwd`. Ask the child to cite absolute
paths for file-existence claims.

## Tools

- `spawn_agent`
- `wait_agent`
- `close_agent`
- `list_agents`
- `list_permissions`
- `reply_permission`
- `stop_runtime`
- `restart_runtime`

## Wait Handling

- `completed`: Use the output as evidence only when the requested `cwd` and
  returned session directory match the task.
- `running`: Inspect `diagnostic`, `stdoutTail`, and `stderrTail`; wait again
  with the same `jobId`.
- `queued`: Keep the job handle. Later wait/list/close/spawn calls can promote
  it when slots open.
- `stalled`: Treat as non-evidence. Inspect `diagnostic.stallReason`,
  `diagnostic.stallSummary`, and artifact paths.
- `failed`, `killed`, or `timed_out`: Treat as terminal non-success. Inspect
  artifacts if needed, then close.
- `orphaned` or `abandoned`: Treat as stale/unowned local state, not current
  child-agent output.
- `backend_unreachable`, `not_found`, or `corrupted`: Treat as
  Retinue/backend infrastructure state, not child-agent evidence.
- `resource_exhausted` from spawn: No job started; wait for capacity or close
  unneeded jobs before retrying.
- Permission required: Inspect `permissionActions`, or call
  `list_permissions`; reply with `reply_permission`; then wait again.

Prefer permission reply `once` for scoped task-required access. Use `always`
only for trusted repeated patterns. Use `reject` for out-of-scope paths or
tools.

When wait output includes `requestedJobId`, `selectedAttemptJobId`, or
`attemptChain`, trust only the selected completed attempt. The original stalled
attempt remains diagnostic-only.

## Hazards

- Do not pass backend, provider, profile, model, OpenCode server,
  `access_mode`, or `bash_policy` through Retinue tool arguments.
- Do not treat `running` as terminal.
- Do not treat `stalled` output as review evidence.
- Do not treat `backend_unreachable` as a child-agent conclusion.
- Do not treat `resource_exhausted` as a queued job; it has no job handle.
- Do not trust repository-specific conclusions when returned
  `externalSessionDirectory` does not match the requested `cwd`.
- Do not use hidden backend/debug tools for normal product delegation.
- Do not use Retinue stalled child output to support a product claim.
- Use `stop_runtime` or `restart_runtime` only for Retinue-managed runtime
  maintenance, such as refreshing an auto-served OpenCode provider/profile.
  These tools do not manage external runtime URLs.

## Configuration Boundary

Backend selection and model/profile policy come from deployment configuration
and the selected local runtime. OpenCode, Claude Code, and Kilo own provider
configuration, login, model defaults, tools, permissions, plugins, and skills
where supported by that runtime.

Retinue owns:

- job handle creation
- waiting and terminal result return
- close/cleanup
- per-session and shared-machine child-agent slot accounting
- permission request surfacing and replies
- lifecycle of runtime servers it auto-serves, including safe stop/restart

Persistent Retinue overrides should use `RETINUE_*` environment variables in
Codex `[env]` or the host MCP environment. The packaged `retinue.config.json`
is a fallback that plugin refreshes can overwrite.

Reference docs:

- `docs/reference/mcp-tools.md`
- `docs/reference/configuration.md`
- `docs/reference/diagnostics.md`
- `docs/reference/backends/opencode.md`
- `docs/reference/backends/claude-code.md`
- `docs/reference/backends/kilo.md`
