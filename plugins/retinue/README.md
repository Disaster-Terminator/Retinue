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

Backend-specific `opencode_*` and `claude_*` tools remain available for adapter debugging and runbook probes.
