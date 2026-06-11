# Retinue Plugin

This Codex plugin exposes the Retinue MCP tools and Codex skill:

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

For production OpenCode E2E, see `../../docs/runbooks/production-opencode-e2e.md`.

Codex-facing product delegation should use:

- `spawn_agent`
- `wait_agent`
- `close_agent`
- `list_agents`
- `list_permissions`
- `reply_permission`

The default deployment uses OpenCode `explore` and lets Retinue manage the local OpenCode server lifecycle. Keep behavior details in the shared docs instead of duplicating them here:

- Tool contract: `../../docs/reference/mcp-tools.md`
- Configuration: `../../docs/reference/configuration.md`
- Diagnostics: `../../docs/reference/diagnostics.md`
- OpenCode backend: `../../docs/reference/backends/opencode.md`
- Claude Code backend: `../../docs/reference/backends/claude-code.md`
- Kilo backend: `../../docs/reference/backends/kilo.md`
