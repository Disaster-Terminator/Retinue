# RunLatch Plugin

This repo-local Codex plugin exposes RunLatch as an agent-facing product surface:

- skill instructions under `skills/`
- MCP server configuration in `.mcp.json`
- runtime entrypoint from the repository build output at `dist/mcp.js`

The current plugin directory remains `plugins/anchorpoint` as a transitional compatibility path. A follow-up package/runtime rename should move the plugin directory and skill name to `runlatch` after `runlatch-mcp` exists as a package alias.

Build the repository before installing or enabling the plugin:

```bash
pnpm install
pnpm run build
pnpm run verify:package
```

For production OpenCode E2E, see `../../docs/PRODUCTION_OPENCODE_E2E.md`.
