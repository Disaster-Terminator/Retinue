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
- per-MCP-session child-agent slot tracking

## Deployment Defaults

Backend selection is deployment state, not a Codex tool argument:

```text
RETINUE_BACKEND=opencode
RETINUE_OPENCODE_AUTO_SERVE=1
RETINUE_OPENCODE_HOST=127.0.0.1
```

The installed plugin also ships `retinue.config.json` with package defaults: `maxConcurrentAgents: 3` and `opencode.agent: "explore"`. Treat this cache file as read-only packaged fallback, not persistent user configuration; plugin refreshes can overwrite it. Persistent deployment overrides should use environment variables such as `RETINUE_MAX_CONCURRENT_AGENTS`, `RETINUE_GLOBAL_AGENT_BUDGET`, `RETINUE_OVERFLOW_STRATEGY`, `RETINUE_MAX_QUEUED_AGENTS`, `RETINUE_OPENCODE_AGENT`, and `RETINUE_OPENCODE_ROOT_BINDING_MODE` in Codex `[env]` or the host MCP env. `RETINUE_MAX_CONCURRENT_AGENTS` limits one MCP server session and defaults to `3`. `RETINUE_GLOBAL_AGENT_BUDGET` limits all active Retinue children sharing the same `RETINUE_STATE_DIR`; when omitted it defaults to `max(5, RETINUE_MAX_CONCURRENT_AGENTS)`. The default overflow strategy is `queue`: when session or global active slots are full, `retinue_spawn_agent` returns a `queued` job handle instead of evicting an existing child, and later `wait/list/close/spawn` calls opportunistically promote queued jobs when slots open. Set `RETINUE_OVERFLOW_STRATEGY=evict` only when explicitly preserving the old same-session oldest-running eviction behavior. `RETINUE_MAX_QUEUED_AGENTS` bounds queued jobs and defaults to `20`; queue exhaustion returns `resource_exhausted` with `reason: "queue_full"`. The 0.2.0 default OpenCode agent is the built-in `explore` subagent. Retinue follows the active OpenCode profile and selected OpenCode agent semantics; it does not expose a product-level `access_mode` or overlay its own read-only prompt/tool policy on normal OpenCode children. A single spawn may pass `agent` to select an OpenCode agent for that child. Retinue manages the default OpenCode server lifecycle and falls back across local ports `4097` through `4127` when the preferred port `4096` is occupied by an external service. Use `RETINUE_BACKEND=claude-code` only when the deployment should route the same `retinue_*` tools to Claude Code. Do not pass backend, profile, model, OpenCode server, `access_mode`, or `bash_policy` choices in `retinue_*` tool arguments.

## Tool Use

Use these Retinue tools for normal Codex subagent work:

- `retinue_spawn_agent`
- `retinue_wait_agent`
- `retinue_close_agent`
- `retinue_list_agents`
- `retinue_list_permissions`
- `retinue_reply_permission`

When spawning exploration work, pass an explicit absolute `cwd` and ask the child to include path evidence for file-existence claims. `retinue_spawn_agent` returns the requested `cwd`, OpenCode `externalSessionDirectory`, and job artifact directory; compare them to catch workspace drift early.

If `retinue_wait_agent` returns `running`, treat it as a workflow event, not a dead end. The response includes `diagnostic`, `stateDir`, `tracePath`, `jobDir`, `promptPath`, `stdoutPath`, `stderrPath`, and bounded stdout/stderr tails. Inspect `diagnostic` first, then the tail fields; they usually contain recent backend state without requiring a separate filesystem read. Complex OpenCode jobs can still spend time in tool-call rounds, but Retinue bounds blank, zero-progress, incomplete, pending-read, and no-final-text loops so they become diagnostic `stalled` results instead of hanging indefinitely. Recoverable no-final-text stalls are deferred while the current wait call still has time, and Retinue submits one no-tools final-answer recovery prompt through OpenCode's `build` agent so a late final answer can still become `completed`. When malformed read output or a failed finalization rescue makes the original execution chain non-evidence, Retinue may start a fresh task-level attempt as a new OpenCode child job/session; the response is re-keyed to the selected attempt and includes `requestedJobId`, `selectedAttemptJobId`, and `attemptChain`. Treat the original stalled job as non-evidence even when a later attempt succeeds. Read-only patch/write intent is also recovered once by asking OpenCode for a no-tools prose-only answer and trusting only messages after that recovery point; if recovery emits another patch/write intent, the job remains `stalled`. Provider errors still return `stalled` immediately. If the result is `stalled`, treat it as attention-required terminal output rather than success; terminal stalled responses also include compact `diagnostic.stallReason` and `diagnostic.stallSummary` when Retinue can classify the backend failure. Do not count a stalled child as review evidence. It no longer occupies the active MCP session slot, but the job artifacts remain available for inspection until explicit close/cleanup.

If `retinue_wait_agent` returns `attentionRequired.kind: "permission"` or `permissionRequired: true`, treat it as an action-required workflow event, not failed review evidence. Use the returned `permissions` or call `retinue_list_permissions` to fetch structured OpenCode permission request ids for the job. Each permission includes an `approval` object with a title, display lines, guidance, and reply options; use that object to decide whether the request is in scope for the delegated task. Prefer `reply: "once"` for narrowly scoped task-required access, use `reply: "always"` only for trusted repeated patterns, and use `reply: "reject"` for out-of-scope paths or tools. Then call `retinue_reply_permission` and wait again. Permission wait responses intentionally keep raw stderr compact and provide artifact paths plus diagnostics for deeper inspection. Retinue does not auto-approve external paths and does not define its own permission policy.

Backend-specific `opencode_*` and `claude_*` tools are adapter/debug surfaces and are hidden by default in plugin deployments. Retinue log-audit diagnostics are also hidden by default; developers can explicitly enable `RETINUE_EXPOSE_DIAGNOSTIC_TOOLS=1` to expose `retinue_audit_logs` while dogfooding or investigating Retinue itself. Do not prefer hidden debug tools for product-level Codex subagent delegation unless debugging Retinue or a backend-specific issue.

## Production E2E Gate

Before saying the plugin is production-ready, verify the real environment. Static tests are not enough for OpenCode server contract drift.

Minimum product E2E:

1. Confirm the Retinue MCP server starts from the installed plugin cache.
2. Set `RETINUE_BACKEND=opencode`.
3. Run `retinue_spawn_agent` with a deterministic prompt.
4. Wait with `retinue_wait_agent` and verify the result.
5. Close with `retinue_close_agent`.
6. Run the same fake E2E against `RETINUE_BACKEND=claude-code`.
7. Record only redacted backend/profile metadata, job id, session id, and result. Do not record API keys.
