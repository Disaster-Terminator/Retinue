# Retinue Plugin

This repo-local Codex plugin exposes Retinue as an agent-facing product surface:

- skill instructions under `skills/`
- MCP server configuration in `.mcp.json`
- runtime entrypoint from the repository build output at `dist/mcp.js`

Build the repository before installing or enabling the plugin:

```bash
pnpm install
pnpm run build
pnpm run verify:package
```

For production OpenCode E2E, see `../../docs/PRODUCTION_OPENCODE_E2E.md`.
