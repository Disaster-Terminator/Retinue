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
- parent deny/external-directory rules are respected
- Retinue surfaces permission requests instead of silently approving them

Retinue does not use OpenCode's `SubtaskPartInput` as the normal spawn path because that path runs inside the parent prompt loop and can wake the parent model after the child completes. The goal is a child-agent job handle that the supervising MCP caller controls directly.

## Shared Root vs Per Spawn

`shared_root` means one supervising Codex/Hermes thread can reuse a root OpenCode session for multiple Retinue child jobs. `per_spawn` gives each child a more isolated OpenCode session topology.

The useful comparison is runtime behavior, not abstraction taste. When testing the modes, record:

- `externalRunnerMode`
- `externalRootAgent`
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
