# Retinue Plugin

This Codex plugin exposes Retinue as an agent-facing product surface:

- skill instructions under `skills/`
- MCP server configuration in `.mcp.json`
- runtime entrypoint from `mcp-bootstrap.mjs`, which loads the release-shipped `dist/mcp.js`

Users install it through the Codex plugin marketplace:

```bash
codex plugin marketplace add Disaster-Terminator/Retinue
```

Then open Codex, run `/plugins`, press the keyboard Right Arrow key until `[Retinue Local]` is selected, press Enter to open the `Retinue` details page, then choose `Install plugin`.

Contributors should build and verify before tagging a release:

```bash
pnpm run build
pnpm run verify:package
```

For production OpenCode E2E, see `../../docs/runbooks/PRODUCTION_OPENCODE_E2E.md`.

Codex-facing product delegation should use:

- `retinue_spawn_agent`
- `retinue_wait_agent`
- `retinue_close_agent`
- `retinue_list_agents`
- `retinue_list_permissions`
- `retinue_reply_permission`

The default deployment uses OpenCode `explore` and lets Retinue manage the local OpenCode server lifecycle. Each Retinue MCP server session keeps a small active child-agent pool; the default limit is 3 active children, and a new spawn beyond the limit closes the oldest active child and returns `evictedJobId`.

When `retinue_wait_agent` returns `running`, inspect the returned stdout/stderr tails and trace path before closing the child. Complex OpenCode jobs can still spend time in tool-call rounds, but Retinue bounds blank, zero-progress, incomplete, pending-read, and no-final-text loops so they become diagnostic `stalled` results instead of hanging indefinitely. Recoverable no-final-text stalls are deferred within the active wait timeout, and Retinue submits one no-tools final-answer recovery prompt through OpenCode's `build` agent so late final answers can still complete. Malformed read output or a failed finalization rescue can start one fresh task-level attempt; the original stalled job remains non-evidence, and the wait response includes `requestedJobId`, `selectedAttemptJobId`, and `attemptChain` when it re-keys to the new attempt. Provider errors and read-only patch/write intent still return `stalled` immediately.

When OpenCode reports a pending permission request, use `retinue_list_permissions` and `retinue_reply_permission` as the agent-facing bridge to OpenCode's native permission API. Retinue surfaces request ids and replies with OpenCode's `once`, `always`, or `reject` values; it does not invent a separate permission policy.

Backend-specific `opencode_*` and `claude_*` tools are hidden by default. Set `RETINUE_EXPOSE_BACKEND_TOOLS=1` only for adapter debugging and runbook probes; product delegation should stay on the `retinue_*` tools above.
