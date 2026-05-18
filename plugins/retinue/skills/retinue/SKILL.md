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
RETINUE_OPENCODE_AGENT=explore
```

The 0.1.0 default OpenCode agent is the built-in `explore` subagent. When `access_mode` is omitted, Retinue follows OpenCode agent semantics: `explore`, `scout`, and `general` use Retinue's read-only framework, while `plan` and `build` follow the active OpenCode profile. In read-only mode, Retinue creates OpenCode sessions with non-interactive permissions that deny edits, deny patch mode, deny nested OpenCode `task` delegation, deny `doom_loop` and interactive `question` prompts, and restrict `bash` to a small read-only git inspection allowlist even when the local OpenCode profile is more permissive. The packaged default does not inject an extra Retinue prompt contract and does not send prompt-level `tools: false` overrides; those stricter layers are available through `opencode.readOnlyPromptContract` and `opencode.readOnlyToolDeny` when needed. A single spawn may pass `agent` to select an OpenCode agent for that child, `bash_policy: "none"` for stricter no-bash read-only work, or `access_mode` to force `"read_only"` or `"profile"` for that spawn. Hermes and custom MCP deployments can set `RETINUE_OPENCODE_ACCESS_MODE=profile` or the older `RETINUE_OPENCODE_READ_ONLY=0` as a global override. Retinue manages the default OpenCode server lifecycle and falls back across local ports `4097` through `4127` when the preferred port `4096` is occupied by an external service. Each Retinue MCP server session keeps up to 5 active child agents by default. A spawn beyond the limit closes the oldest active child and returns `evictedJobId`; deployments can tune this with `RETINUE_MAX_CONCURRENT_AGENTS`. Use `RETINUE_BACKEND=claude-code` only when the deployment should route the same `retinue_*` tools to Claude Code. Do not pass backend, profile, model, or OpenCode server choices in `retinue_*` tool arguments.

## Tool Use

Use these Retinue tools for normal Codex subagent work:

- `retinue_spawn_agent`
- `retinue_wait_agent`
- `retinue_close_agent`
- `retinue_list_agents`

When spawning read-only exploration work, pass an explicit absolute `cwd` and ask the child to include path evidence for file-existence claims. `retinue_spawn_agent` returns the requested `cwd`, OpenCode `externalSessionDirectory`, and job artifact directory; compare them to catch workspace drift early. Pass `access_mode: "profile"` only for tasks where child-agent edits are intended and acceptable.

If `retinue_wait_agent` returns `running`, treat it as a workflow event, not a dead end. The response includes `diagnostic`, `stateDir`, `tracePath`, `jobDir`, `promptPath`, `stdoutPath`, `stderrPath`, and bounded stdout/stderr tails. Inspect `diagnostic` first, then the tail fields; they usually contain recent backend state without requiring a separate filesystem read. Complex OpenCode jobs can still spend time in tool-call rounds, but Retinue bounds blank, zero-progress, incomplete, pending-read, and no-final-text loops so they become diagnostic `stalled` results instead of hanging indefinitely. Recoverable no-final-text stalls are deferred while the current wait call still has time, and Retinue submits one no-tools final-answer recovery prompt through OpenCode's `build` agent so a late final answer can still become `completed`. Read-only patch/write intent is also recovered once by asking OpenCode for a no-tools prose-only answer and trusting only messages after that recovery point; if recovery emits another patch/write intent, the job remains `stalled`. Provider errors still return `stalled` immediately. If the result is `stalled`, treat it as attention-required terminal output rather than success; terminal stalled responses also include compact `diagnostic.stallReason` and `diagnostic.stallSummary` when Retinue can classify the backend failure. Do not count a stalled child as review evidence. It no longer occupies the active MCP session slot, but the job artifacts remain available for inspection until explicit close/cleanup.

Backend-specific `opencode_*` and `claude_*` tools are adapter/debug surfaces and are hidden by default in plugin deployments. If a developer explicitly enables `RETINUE_EXPOSE_BACKEND_TOOLS=1`, do not prefer those tools for product-level Codex subagent delegation unless debugging a backend-specific issue.

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
