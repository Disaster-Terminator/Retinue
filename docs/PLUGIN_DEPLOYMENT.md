# RunLatch Codex Plugin Deployment

RunLatch's deployable product shape is a Codex plugin. The plugin contains:

- `.codex-plugin/plugin.json` for discovery and product metadata
- `.mcp.json` for MCP tool exposure
- `skills/anchorpoint/SKILL.md` for agent-facing operating guidance
- the repository runtime built under `dist/`

The current plugin directory and skill name still use `anchorpoint` as transitional compatibility names. A follow-up package/runtime rename should move them to `runlatch` after `runlatch`, `runlatch-mcp`, and `runlatchd` aliases exist.

## Build Gate

Build and verify the package before enabling the plugin:

```bash
pnpm install
pnpm run typecheck
pnpm test
pnpm run build
pnpm run verify:package
```

`verify:package` checks that the package includes the plugin manifest, MCP config, skill, required docs, and runtime files.

## Repo-Local Plugin

The repo-local plugin is currently:

```text
plugins/anchorpoint
```

The repo-local marketplace entry is:

```text
.agents/plugins/marketplace.json
```

This is the source of truth for PR review and packaging. It keeps plugin assets versioned with the runtime they start.

## Home-Local Plugin Install

For local Codex use, copy or sync the plugin directory into the user's plugin root:

```text
C:\Users\Disas\plugins\anchorpoint
```

Then add or update the local marketplace entry:

```json
{
  "name": "anchorpoint",
  "source": {
    "source": "local",
    "path": "./plugins/anchorpoint"
  },
  "policy": {
    "installation": "INSTALLED_BY_DEFAULT",
    "authentication": "ON_USE"
  },
  "category": "Coding"
}
```

These local names are transitional. They should move to `runlatch` in the same follow-up that adds `runlatch-mcp` runtime aliases.

The plugin expects the built runtime to remain available relative to the plugin MCP config. For repo-local testing, build the repository first and use `plugins/anchorpoint/.mcp.json` directly.

The plugin does not enable daemon discovery by default. Add `SUPERVISOR_DAEMON_URL` or `SUPERVISOR_DAEMON_DISCOVERY=1` only when a daemon is already running and discoverable. Without those variables, the MCP server starts in direct fallback mode.

## OpenCode Production E2E

Before calling the plugin production-ready, run the real OpenCode lifecycle from the plugin-exposed MCP tools:

1. Set `SUPERVISOR_OPENCODE_BASE_URL` to the loopback OpenCode server.
2. Optionally set `SUPERVISOR_OPENCODE_MODEL=litellm/pro-router`.
3. Use `opencode_run` with a deterministic prompt.
4. Use `opencode_wait`.
5. Use `opencode_result`.
6. Use `opencode_continue` against the same `externalSessionId`.
7. Verify the continued result is the new assistant answer, not an earlier assistant answer or the user prompt.
8. Exercise `opencode_kill` and `opencode_cleanup`.

Record only redacted provider/model metadata, job id, session id, and observed result. Do not record API keys or provider secrets.
