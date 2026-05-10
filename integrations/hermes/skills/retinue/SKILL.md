---
name: retinue
description: Use Retinue MCP tools from Hermes Agent to spawn, wait for, and close local OpenCode subagents.
version: 0.1.0
author: Disaster Terminator
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [MCP, OpenCode, Subagents, Development]
    requires_toolsets: [retinue]
---

# Retinue

Retinue lets Hermes Agent delegate a bounded coding task to a local OpenCode child agent through MCP.

## When to Use

Use this when Hermes Agent needs a separate local coding agent to inspect code, run a narrow task, or provide an independent review while Hermes remains the master agent.

## Tool Surface

Hermes registers Retinue MCP tools with the `mcp_retinue_` prefix:

- `mcp_retinue_retinue_spawn_agent`
- `mcp_retinue_retinue_wait_agent`
- `mcp_retinue_retinue_close_agent`

Retinue selects the backend from deployment configuration. The default Hermes integration uses OpenCode with the `plan` agent and Retinue-managed OpenCode server lifecycle. Do not pass backend, model, provider, profile, permission, or OpenCode server choices in tool arguments.

## Procedure

1. Spawn a child agent with `mcp_retinue_retinue_spawn_agent`.
2. Include a concrete `message` and, when useful, `cwd` and `task_name`.
3. Wait with `mcp_retinue_retinue_wait_agent`.
4. If wait returns `running`, use the returned `stateDir` and `tracePath` to inspect Retinue logs before retrying.
5. Close the job with `mcp_retinue_retinue_close_agent` when the result is terminal or the child should be stopped.

## Verification

Ask the child to reply with a deterministic marker, then confirm `retinue_wait_agent` returns a completed result containing that marker.
