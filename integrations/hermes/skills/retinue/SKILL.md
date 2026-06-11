---
name: retinue
description: Use Retinue MCP tools from Hermes Agent to spawn, wait for, and close local OpenCode subagents.
version: 0.2.0
author: Disaster Terminator
license: Apache-2.0
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [MCP, OpenCode, Subagents, Development]
    requires_toolsets: [retinue]
---

# Retinue

Retinue lets Hermes Agent delegate bounded local coding tasks to a backend-selected child agent through MCP.

## When To Use

Use Retinue when Hermes needs a separate local agent to inspect code, run a narrow task, or provide independent review while Hermes remains the supervising agent.

## Quick Procedure

1. Spawn with `mcp_retinue_spawn_agent`.
2. Wait with `mcp_retinue_wait_agent`.
3. Close with `mcp_retinue_close_agent`.

For repository work, pass an absolute `cwd`, a concrete `message`, and a useful `task_name`.

## Tool Surface

Hermes registers Retinue MCP tools with the `mcp_retinue_` prefix:

- `mcp_retinue_spawn_agent`
- `mcp_retinue_wait_agent`
- `mcp_retinue_close_agent`
- `mcp_retinue_list_agents`
- `mcp_retinue_list_permissions`
- `mcp_retinue_reply_permission`
- `mcp_retinue_stop_runtime`
- `mcp_retinue_restart_runtime`

## Wait Handling

| Result | Action |
| --- | --- |
| `completed` | Use the output as evidence only when the task scope and returned session directory match. |
| `running` | Inspect `diagnostic`, `stdoutTail`, and `stderrTail`; wait again with the same `jobId`. |
| `queued` | Keep the handle; queued jobs promote when session and shared-machine slots open. |
| `stalled` | Treat as non-evidence. Inspect `diagnostic.stallReason`, `diagnostic.stallSummary`, and artifact paths. |
| `failed`, `killed`, or `timed_out` | Treat as terminal non-success. Inspect artifacts if needed, then close. |
| `orphaned` or `abandoned` | Treat as stale/unowned local state, not current child-agent output. |
| `backend_unreachable`, `not_found`, or `corrupted` | Treat as Retinue/backend infrastructure state, not child-agent evidence. |
| `resource_exhausted` from spawn | No job started; wait for capacity or close unneeded jobs before retrying. |
| Permission event | Use `mcp_retinue_list_permissions` if needed, reply with `mcp_retinue_reply_permission`, then wait again. |

Prefer `once` for scoped task-required permission replies. Reserve `always` for trusted repeated patterns. Reject out-of-scope paths and tools.

## Hazards

- Do not pass backend, model, provider, profile, OpenCode server, `access_mode`, or `bash_policy` in tool arguments.
- Do not treat `running` as done.
- Do not treat `stalled` as review evidence.
- Do not treat `backend_unreachable` as a child-agent conclusion.
- Do not treat `resource_exhausted` as a queued job; it has no job handle.
- Do not trust repository conclusions when `cwd` and `externalSessionDirectory` disagree.
- Do not use hidden diagnostic or backend tools for normal delegation.
- Use runtime stop/restart tools only for Retinue-managed runtime maintenance, such as refreshing an auto-served OpenCode provider/profile. They do not manage external runtime URLs.

## Configuration Boundary

Retinue selects the backend from deployment configuration. The default Hermes integration uses OpenCode with Retinue-managed local server lifecycle. OpenCode, Claude Code, and Kilo keep ownership of profile, provider, model, tools, and permissions where supported by the selected runtime.

Persistent deployment changes belong in the Hermes MCP environment as `RETINUE_*` variables. Packaged config files are fallback defaults and may be overwritten by plugin refreshes.

Reference docs:

- `docs/reference/mcp-tools.md`
- `docs/reference/configuration.md`
- `docs/reference/diagnostics.md`
- `docs/how-to/integrate-hermes.md`
