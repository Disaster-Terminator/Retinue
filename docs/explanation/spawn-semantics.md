# Spawn Semantics

Retinue's product abstraction is:

```text
supervising agent -> Retinue MCP -> local agent runtime child
```

The supervising agent can be Codex, Hermes, or another MCP-capable agent host. Retinue is the adapter that provides job handles, wait semantics, permission bridging, and cleanup.

## Why Retinue Does Not Choose Models

OpenCode, Claude Code, and Kilo already own provider routing, profiles, model defaults, login state, quotas, plugins, skills, and permissions. Retinue keeps those concerns in the runtime profile instead of duplicating them as MCP arguments.

This keeps the Retinue tool surface stable:

- `spawn`
- `wait`
- `close`
- `list`
- `list permissions`
- `reply permission`

## OpenCode Topology

Retinue can bind OpenCode work to a direct child session while preserving the important semantics of OpenCode's task tool:

- child sessions are associated with the parent/root OpenCode session where configured
- OpenCode owns the selected child agent behavior
- parent session deny/external-directory rules are respected
- Retinue surfaces permission requests instead of silently approving them

Retinue does not use OpenCode's `SubtaskPartInput` as the normal spawn path because that path runs inside the parent prompt loop and can wake the parent model after the child completes. The goal is a child-agent job handle that the supervising MCP caller controls directly.

## Shared Root vs Per Spawn

`shared_root` is the default OpenCode topology. One supervising Codex/Hermes thread gets one Retinue MCP server session, which reuses one inert OpenCode root session for multiple child jobs with the same OpenCode server URL and cwd. The root is only a structural parent and never selects or runs an agent. This matches OpenCode's native parent/child session shape while keeping Retinue in charge of MCP job handles, waits, closes, permission surfacing, and resource budgets.

`per_spawn` is a legacy/fallback topology. Each Retinue child job creates its own unprompted OpenCode root session and then a prompted child session. Use it for compatibility checks, isolation probes, or debugging when shared-root behavior is suspected.

OpenCode owns child agent behavior, tools, and permissions. For OpenCode-native subagent semantics, use subagents such as `explore` for read-only exploration and `general` for writable multi-step work. `build` is a primary/root agent; Retinue can target it only when the caller explicitly asks for that OpenCode agent, but Retinue should not describe it as the default writable subagent. Retinue must not replace writable child execution with a patch-only protocol or a prompt-text write-intent blocker.

The edge case is cross-session concurrency: multiple independent Retinue MCP sessions, possibly from multiple Codex/Hermes hosts or backends, may target the same cwd. That is outside one OpenCode root's native scheduling boundary. Retinue should make this observable through explicit probes and diagnostics before adding any opt-in safety policy.

The useful comparison is runtime behavior, not abstraction taste. When testing the modes, record:

- `externalRunnerMode`
- `externalRootSessionId`
- `externalParentSessionId`
- child `externalSessionId`
- completion, permission, and stall rates

Do not mix results from different modes without those fields.

## Failure Evidence

Retinue distinguishes product evidence from backend noise:

- `completed` text from the selected attempt can be used as child-agent evidence.
- `stalled` output is diagnostic only.
- Permission waits are action-required workflow events.
- Fresh-attempt success does not make the original stalled attempt trustworthy.

This is why callers should preserve `attemptChain` and close terminal jobs deliberately.
