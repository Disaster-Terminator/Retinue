# Retinue Codex Plugin Deployment

Retinue ships as a Codex plugin. The plugin contains:

- `.codex-plugin/plugin.json` for discovery and product metadata
- `.mcp.json` for MCP tool exposure
- `skills/anchorpoint/SKILL.md` for agent-facing operating guidance
- the built Retinue runtime under `dist/`

The plugin identity is `retinue`. User-facing docs should call the product Retinue.

## User Install Path

The primary 0.1.0 install path is the Codex plugin marketplace:

```bash
codex plugin marketplace add Disaster-Terminator/Retinue
codex plugin marketplace upgrade retinue-local
```

The marketplace metadata sets Retinue to `INSTALLED_BY_DEFAULT`. Codex CLI 0.128 exposes marketplace add/upgrade/remove, not a separate `codex plugin install` command.

The plugin MCP config starts the runtime shipped inside the plugin directory:

```json
{
  "mcpServers": {
    "retinue": {
      "command": "node",
      "args": ["./dist/mcp.js"],
      "cwd": ".",
      "startup_timeout_sec": 30,
      "env": {
        "SUPERVISOR_RETINUE_BACKEND": "opencode",
        "SUPERVISOR_OPENCODE_AUTO_SERVE": "1",
        "SUPERVISOR_OPENCODE_HOST": "127.0.0.1",
        "SUPERVISOR_OPENCODE_AGENT": "plan"
      }
    }
  }
}
```

This is intentional for 0.1.0: marketplace installs copy the plugin directory into Codex's plugin cache, so the MCP runtime must be self-contained under that directory.
The `mcpServers` wrapper is required for Codex plugin MCP discovery. The explicit `cwd: "."` is required so Codex starts `node ./dist/mcp.js` from the installed plugin cache instead of from the current conversation working directory.

The default plugin path manages the local OpenCode server lifecycle. It prefers `127.0.0.1:4096` and tries `4097` when the preferred port is occupied by an external service. Set `SUPERVISOR_OPENCODE_BASE_URL` only for deployments that intentionally attach to an externally managed OpenCode server.

## npm Runtime Path

The npm package is `@disaster-terminator/retinue`. It exposes:

```text
retinue
retinue-mcp
retinued
```

Use this path for custom MCP configuration:

```bash
npm install -g @disaster-terminator/retinue@0.1.0
codex mcp add retinue \
  --env SUPERVISOR_RETINUE_BACKEND=opencode \
  --env SUPERVISOR_OPENCODE_BASE_URL=http://127.0.0.1:4096 \
  --env SUPERVISOR_OPENCODE_AGENT=plan \
  -- retinue-mcp
```

The npm path installs runtime only. It does not install the Retinue skill; the plugin marketplace remains the preferred user path.

## Build Gate

Before tagging a release, build and verify:

```bash
pnpm install
pnpm run typecheck
pnpm run check:generated
pnpm test
pnpm run verify:package
```

`verify:package` checks that package contents include the plugin manifest, MCP config, skill, required docs, npm runtime files, and plugin-local runtime files.

## OpenCode Production E2E

Before calling the plugin production-ready, run the real OpenCode lifecycle through the product `retinue_*` MCP tools:

1. Confirm the installed plugin cache starts the bundled MCP server.
2. Set `SUPERVISOR_RETINUE_BACKEND=opencode`.
3. Use `retinue_spawn_agent` with a deterministic prompt.
4. Use `retinue_wait_agent` and verify the terminal result.
5. Use `retinue_close_agent`.
6. Confirm tool arguments did not include backend, profile, model, agent, or permission selection.
7. Run the fake Claude parity path with `SUPERVISOR_RETINUE_BACKEND=claude-code`.
8. When Claude Code is locally usable, run the best-effort real Retinue Claude probe.

The Claude real probe is allowed to fail on upstream model, quota, proxy, or Claude Code runtime instability. Treat a failure there as a local backend readiness signal, not as permission to skip fake Claude parity or the OpenCode production E2E.

Backend-specific `opencode_*` and `claude_*` tools remain available for adapter debugging and older runbooks, but they are not the primary Codex delegation surface.

Record only redacted backend/profile metadata, job id, session id, and observed result. Do not record API keys or provider secrets.

## User Acceptance Boundary

The final WSL Codex plugin smoke should be run by the user in their own WSL Codex environment. It may modify the user's Codex plugin state, so it is not an agent-side automated test.
