---
name: retinue
description: Use Retinue when Codex needs to spawn, wait for, and close local coding-agent subagents through the backend-selected Retinue MCP tools.
---

# Retinue

Retinue is a local subagent execution plugin for Codex. Use its `retinue_*` MCP tools when Codex should hand work to the deployment-selected backend, receive a job handle, wait for terminal output, and close the child agent.

## Boundary

Retinue is not a provider router and does not select backend profiles from tool calls. OpenCode and Claude Code own provider configuration, login, endpoint routing, model defaults, agents, permissions, plugins, skills, and runtime policy through their active profiles. Retinue owns:

- `spawn`
- `wait`
- terminal result return through `wait`
- `close`

## Deployment Defaults

Backend selection is deployment state, not a Codex tool argument:

```text
SUPERVISOR_RETINUE_BACKEND=opencode
SUPERVISOR_OPENCODE_BASE_URL=http://127.0.0.1:4096
SUPERVISOR_OPENCODE_AGENT=plan
```

The 0.1.0 default OpenCode agent is `plan`. Use `SUPERVISOR_RETINUE_BACKEND=claude-code` only when the deployment should route the same `retinue_*` tools to Claude Code. Do not pass backend, profile, model, agent, or permission choices in `retinue_*` tool arguments.

## Tool Use

Use these Retinue tools for normal Codex subagent work:

- `retinue_spawn_agent`
- `retinue_wait_agent`
- `retinue_close_agent`

Backend-specific `opencode_*` and `claude_*` tools are adapter/debug surfaces. Do not prefer them for product-level Codex subagent delegation unless debugging a backend-specific issue.

## Production E2E Gate

Before saying the plugin is production-ready, verify the real environment. Static tests are not enough for OpenCode server contract drift.

Minimum product E2E:

1. Confirm the OpenCode server is reachable at `SUPERVISOR_OPENCODE_BASE_URL`.
2. Set `SUPERVISOR_RETINUE_BACKEND=opencode`.
3. Run `retinue_spawn_agent` with a deterministic prompt.
4. Wait with `retinue_wait_agent` and verify the result.
5. Close with `retinue_close_agent`.
6. Run the same fake E2E against `SUPERVISOR_RETINUE_BACKEND=claude-code`.
7. Record only redacted backend/profile metadata, job id, session id, and result. Do not record API keys.
