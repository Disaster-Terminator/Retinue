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
- `mcp_retinue_retinue_list_permissions`
- `mcp_retinue_retinue_reply_permission`

Retinue selects the backend from deployment configuration. The default Hermes integration uses OpenCode with the built-in `explore` subagent and Retinue-managed OpenCode server lifecycle. OpenCode keeps ownership of profile, provider, model, tools, and agent permissions; Retinue does not expose a product-level `access_mode` or overlay its own read-only prompt/tool policy on normal OpenCode children. A single spawn may pass `agent` to select an OpenCode agent for that child. Each Retinue MCP server session keeps up to 3 active child agents by default. A spawn beyond the limit closes the oldest active child and returns `evictedJobId`; deployments should tune `maxConcurrentAgents` in Retinue JSON config, with `RETINUE_MAX_CONCURRENT_AGENTS` reserved as an environment override. Do not pass backend, model, provider, profile, OpenCode server, `access_mode`, or `bash_policy` choices in tool arguments.

## Procedure

1. Spawn a child agent with `mcp_retinue_retinue_spawn_agent`.
2. Include a concrete `message`, an explicit absolute `cwd` for repository/file work, and a useful `task_name`.
3. Compare the returned `cwd` and `externalSessionDirectory`. Treat a mismatch as workspace drift and do not trust repository-specific conclusions until the job is closed and re-spawned with the correct directory.
4. Wait with `mcp_retinue_retinue_wait_agent`.
5. If wait returns `running`, first inspect the returned `diagnostic`, `stdoutTail`, and `stderrTail`; then use `stateDir`, `tracePath`, `jobDir`, `stdoutPath`, and `stderrPath` when deeper diagnosis is needed. Complex OpenCode jobs can still spend time in tool-call rounds, but Retinue bounds blank, zero-progress, incomplete, pending-read, and no-final-text loops so they become diagnostic `stalled` results instead of hanging indefinitely. Recoverable no-final-text stalls are deferred while the current wait call still has time, and Retinue submits one no-tools final-answer recovery prompt through OpenCode's `build` agent so a late final answer can still become `completed`. Read-only patch/write intent is recovered once by asking OpenCode for a no-tools prose-only answer and trusting only messages after that recovery point; if recovery emits another patch/write intent, the job remains `stalled`. Provider errors still return `stalled` immediately. If `diagnostic.stallReason` is `external_directory_permission_pending`, use `mcp_retinue_retinue_list_permissions` to fetch structured OpenCode request ids and `mcp_retinue_retinue_reply_permission` to reply with `once`, `always`, or `reject`. If wait returns `stalled`, inspect `diagnostic.stallReason` and `diagnostic.stallSummary` when present, treat the child as non-evidence, and close it after preserving the returned paths for diagnosis.
6. Close the job with `mcp_retinue_retinue_close_agent` when the result is terminal or the child should be stopped.

For read-only review tasks, require the child to state its working directory and use absolute paths for file-existence claims. Treat "file not found" or "missing documentation" conclusions as candidates until independently checked.

Retinue log-audit diagnostics are hidden from the default product MCP tool surface. Developers can explicitly enable `RETINUE_EXPOSE_DIAGNOSTIC_TOOLS=1` to expose `mcp_retinue_retinue_audit_logs` while dogfooding or investigating Retinue itself; normal child-agent delegation should use the default tools above.

## Verification

Ask the child to reply with a deterministic marker, then confirm `retinue_wait_agent` returns a completed result containing that marker.
