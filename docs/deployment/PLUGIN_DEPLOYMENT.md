# Retinue Codex Plugin Deployment

Retinue ships as a repo-local Codex plugin. The plugin contains:

- `.codex-plugin/plugin.json` for discovery and product metadata
- `.mcp.json` for MCP tool exposure
- `skills/anchorpoint/SKILL.md` for agent-facing operating guidance
- the repository runtime built under `dist/`

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

The repo-local plugin is:

```text
plugins/anchorpoint
```

The repo-local directory name remains `plugins/anchorpoint` for compatibility with the current package layout. The plugin identity inside the manifest and marketplace entry is `retinue`.

The repo-local marketplace entry is:

```text
.agents/plugins/marketplace.json
```

This keeps plugin assets versioned with the runtime they start.

## Home-Local Plugin Install

For local Codex use, copy or sync the repo-local plugin directory into the user's plugin root. If you rename the copied directory to `retinue`, point the marketplace entry at that renamed directory:

```text
C:\Users\Disas\plugins\retinue
```

Then add or update the local marketplace entry:

```json
{
  "name": "retinue",
  "source": {
    "source": "local",
    "path": "./plugins/retinue"
  },
  "policy": {
    "installation": "INSTALLED_BY_DEFAULT",
    "authentication": "ON_USE"
  },
  "category": "Coding"
}
```

The plugin expects the built runtime to remain available relative to the plugin MCP config. For repo-local testing, build the repository first and use `plugins/anchorpoint/.mcp.json` directly.

If you keep the copied directory name as `anchorpoint`, keep the marketplace `name` as `retinue` but set `source.path` to `./plugins/anchorpoint` instead.

The plugin does not enable daemon discovery by default. Add `SUPERVISOR_DAEMON_URL` or `SUPERVISOR_DAEMON_DISCOVERY=1` only when a daemon is already running and discoverable. Without those variables, the MCP server starts in direct local mode.

## OpenCode Production E2E

Before calling the plugin production-ready, run the real OpenCode lifecycle through the product `retinue_*` MCP tools:

1. Set `SUPERVISOR_OPENCODE_BASE_URL` to the loopback OpenCode server.
2. Set `SUPERVISOR_RETINUE_BACKEND=opencode`.
3. Use `retinue_spawn_agent` with a deterministic prompt.
4. Use `retinue_wait_agent` and verify the terminal result.
5. Use `retinue_close_agent`.
6. Confirm tool arguments did not include backend, profile, model, agent, or permission selection.
7. Run the fake Claude parity path with `SUPERVISOR_RETINUE_BACKEND=claude-code`.
8. When Claude Code is locally usable, run the best-effort real Retinue Claude probe:

```powershell
pnpm run build
pnpm run probe:real:retinue-claude
```

The Claude real probe is allowed to fail on upstream model, quota, proxy, or Claude Code runtime instability. Treat a failure there as a local backend readiness signal, not as permission to skip fake Claude parity or the OpenCode production E2E.

Backend-specific `opencode_*` and `claude_*` tools remain available for adapter debugging and older runbooks, but they are not the primary Codex delegation surface.

Record only redacted backend/profile metadata, job id, session id, and observed result. Do not record API keys or provider secrets.
