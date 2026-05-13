---
name: retinue
description: Use Retinue MCP tools from Hermes Agent to spawn, wait for, and close local OpenCode subagents.
version: 0.1.0
author: Disaster Terminator
license: Apache-2.0
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
- `mcp_retinue_retinue_list_agents`

Retinue selects the backend from deployment configuration. The default Hermes integration uses OpenCode with the `plan` agent, a prompt-level read-only override for `edit`, `write`, `apply_patch`, and `bash`, and Retinue-managed OpenCode server lifecycle. Set `RETINUE_OPENCODE_ACCESS_MODE=profile` or the older `RETINUE_OPENCODE_READ_ONLY=0` only when child-agent writes are intentionally acceptable. A single spawn may pass `access_mode: "profile"` for the same purpose. Each Retinue MCP server session keeps up to 3 active child agents by default. A spawn beyond the limit closes the oldest active child and returns `evictedJobId`; deployments can tune this with `RETINUE_MAX_CONCURRENT_AGENTS`. Do not pass backend, model, provider, profile, or OpenCode server choices in tool arguments.

## Procedure

1. Spawn a child agent with `mcp_retinue_retinue_spawn_agent`.
2. Include a concrete `message`, an explicit absolute `cwd` for repository/file work, and a useful `task_name`. Include `access_mode: "profile"` only when child-agent edits are intended and acceptable.
3. Compare the returned `cwd` and `externalSessionDirectory`. Treat a mismatch as workspace drift and do not trust repository-specific conclusions until the job is closed and re-spawned with the correct directory.
4. Wait with `mcp_retinue_retinue_wait_agent`.
5. If wait returns `running`, first inspect the returned `stdoutTail` and `stderrTail`; then use `stateDir`, `tracePath`, `jobDir`, `stdoutPath`, and `stderrPath` when deeper diagnosis is needed. Complex OpenCode `plan` jobs can spend several minutes in tool-call rounds before producing final text, so poll again unless the task reaches a terminal state.
6. Close the job with `mcp_retinue_retinue_close_agent` when the result is terminal or the child should be stopped.

For read-only review tasks, require the child to state its working directory and use absolute paths for file-existence claims. Treat "file not found" or "missing documentation" conclusions as candidates until independently checked.

## Verification

Ask the child to reply with a deterministic marker, then confirm `retinue_wait_agent` returns a completed result containing that marker.
