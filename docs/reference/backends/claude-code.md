# Claude Code Backend

The Claude Code backend lets the same `retinue_*` MCP tools run local Claude Code jobs. It is not the default v0.2.0 plugin path, but it remains a supported backend for deployments that already have Claude Code configured.

## Backend Selection

```text
RETINUE_BACKEND=claude-code
```

`RETINUE_BACKEND=claude` is accepted as a compatibility alias and resolves to `claude-code`.

## Runtime Selection

Retinue prefers the Claude Agent SDK path unless a legacy CLI override is configured.

```text
RETINUE_CLAUDE_RUNTIME=sdk
RETINUE_CLAUDE_RUNTIME=cli
```

Compatibility toggles are still recognized:

```text
RETINUE_CLAUDE_USE_SDK=1
RETINUE_CLAUDE_USE_SDK=0
```

If `RETINUE_CLAUDE_COMMAND` or `RETINUE_CLAUDE_PREFIX_ARGS` is set and SDK mode is not forced, Retinue uses the legacy CLI runner. This is useful for fake deterministic probes and older deployments.

## Model And Profile

Claude Code owns account state, provider routing, model defaults, proxy behavior, quota, and profile policy. Retinue does not pass a Claude model by default.

Use `RETINUE_CLAUDE_MODEL` only when a deployment intentionally wants Retinue to pass an explicit model to the Claude Agent SDK:

```text
RETINUE_CLAUDE_MODEL=claude-sonnet-test
```

If the local Claude Code default model is wrong, fix the Claude Code profile/runtime configuration before adding a Retinue override.

`retinue_spawn_agent` may pass `agent` for one Claude Code SDK job. Retinue forwards that value to the SDK `agent` option, equivalent to Claude Code's `--agent` main-thread profile selection. Claude Code owns the available agent definitions through its settings; Retinue does not enumerate or validate Claude agent names.

Retinue does not set a Claude Code agent by default and does not reuse OpenCode/Kilo agent defaults such as `explore`. Use `RETINUE_CLAUDE_AGENT` only when a deployment intentionally wants a persistent Claude Code SDK agent/profile selection:

```text
RETINUE_CLAUDE_AGENT=repo-explorer
```

If the local Claude Code default agent/profile is wrong, fix the Claude Code runtime configuration before adding a Retinue override.

## Permission Flow

The SDK backend records Claude Code SDK permission requests and exposes them through the same product tools as other backends:

```text
retinue_list_permissions
retinue_reply_permission
```

Permission replies use the Retinue reply options `once`, `always`, and `reject`. Retinue does not add permission-bypass flags.

## Legacy CLI Compatibility

Legacy CLI configuration:

```text
RETINUE_CLAUDE_COMMAND=claude
RETINUE_CLAUDE_PREFIX_ARGS='["arg-before-command"]'
RETINUE_DEFAULT_RUNTIME_TIMEOUT_MS=...
RETINUE_MAX_CONCURRENT_JOBS=...
```

The legacy CLI runner uses the older Retinue core process lifecycle. New product-path work should prefer the SDK backend unless the deployment explicitly needs CLI compatibility.

## Verification

Use [Real Claude Code probes](../../runbooks/real-claude-probes.md) for opt-in local validation. The default deterministic test suite uses fake Claude behavior and does not consume Claude quota.
