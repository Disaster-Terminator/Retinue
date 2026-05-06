---
name: retinue
description: Use Retinue when Codex needs to run, monitor, continue, stop, or clean up local Claude Code or OpenCode coding-agent jobs through Retinue MCP tools.
---

# Retinue

Retinue is a local subagent execution plugin for Codex. Use its MCP tools when Codex should hand work to Claude Code or OpenCode, receive a job handle, and later inspect, wait, read results, continue the same external session, stop the job, or clean local artifacts.

## Boundary

Retinue is not a provider router. OpenCode owns provider configuration, login, endpoint routing, model defaults, agents, and runtime policy. Retinue owns:

- `run`
- `status`
- `wait`
- `result`
- `continue`
- `stop`
- `cleanup`

## OpenCode Defaults

Prefer explicit user configuration. If a production OpenCode model should be selected by default, set:

```text
SUPERVISOR_OPENCODE_BASE_URL=http://127.0.0.1:4096
SUPERVISOR_OPENCODE_MODEL=litellm/pro-router
SUPERVISOR_OPENCODE_AGENT=build
```

If `SUPERVISOR_OPENCODE_MODEL` is unset and the MCP call does not include `model`, Retinue omits the model field and lets OpenCode choose its default.

## Tool Use

Use these OpenCode tools for new work:

- `opencode_run`
- `opencode_status`
- `opencode_wait`
- `opencode_result`
- `opencode_continue`
- `opencode_cleanup`

Use the Claude tools for Claude Code work:

- `claude_run`
- `claude_status`
- `claude_wait`
- `claude_result`
- `claude_continue`
- `claude_peek`
- `claude_cleanup`

## Production E2E Gate

Before saying the plugin is production-ready, verify the real environment. Static tests are not enough for OpenCode server contract drift.

Minimum OpenCode E2E:

1. Confirm the OpenCode server is reachable at `SUPERVISOR_OPENCODE_BASE_URL`.
2. Run `opencode_run` with a prompt that has a deterministic reply.
3. Wait with `opencode_wait`.
4. Read with `opencode_result`.
5. Continue the same session with `opencode_continue`.
6. Verify the continued result is not the previous assistant answer.
7. Exercise cleanup.
8. Record only redacted provider/model metadata, job id, session id, and result. Do not record API keys.
