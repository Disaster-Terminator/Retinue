---
name: anchorpoint
description: Use Anchorpoint when Codex needs to spawn, monitor, continue, kill, or clean up local Claude Code or OpenCode coding-agent jobs through the Anchorpoint MCP tools.
---

# Anchorpoint

Anchorpoint is a local lifecycle plugin for coding-agent jobs. Use its MCP tools when a task should keep running outside the current Codex turn, when a job handle is needed, or when OpenCode should own provider/model/login while Codex owns job supervision.

## Product Boundary

Anchorpoint is not a provider router. OpenCode owns provider configuration, login, endpoint routing, model defaults, agents, and permission policy. Anchorpoint owns:

- `run`
- `status`
- `wait`
- `result`
- `continue`
- `kill`
- `cleanup`

## OpenCode Defaults

Prefer explicit user configuration. If a production OpenCode model should be selected by default, set:

```text
SUPERVISOR_OPENCODE_BASE_URL=http://127.0.0.1:4096
SUPERVISOR_OPENCODE_MODEL=litellm/pro-router
SUPERVISOR_OPENCODE_AGENT=build
```

If `SUPERVISOR_OPENCODE_MODEL` is unset and the MCP call does not include `model`, Anchorpoint omits the model field and lets OpenCode choose its default.

## Tool Use

Use these OpenCode tools for new work:

- `opencode_run`
- `opencode_status`
- `opencode_wait`
- `opencode_result`
- `opencode_continue`
- `opencode_kill`
- `opencode_cleanup`

Use the Claude tools only for the frozen Claude Code compatibility backend:

- `claude_run`
- `claude_status`
- `claude_wait`
- `claude_result`
- `claude_continue`
- `claude_peek`
- `claude_kill`
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
7. Exercise `opencode_kill` and `opencode_cleanup`.
8. Record only redacted provider/model metadata, job id, session id, and result. Do not record API keys.
