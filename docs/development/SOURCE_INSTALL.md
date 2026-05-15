# Source Install And Development

This page is for Retinue contributors. Normal Codex users should follow the README plugin marketplace path.

## Setup

```bash
pnpm install
pnpm run build
pnpm test
```

Retinue uses pnpm. Do not add `package-lock.json`.

## Local MCP Runtime

From a source checkout, the MCP runtime is:

```bash
node dist/mcp.js
```

The repo-local plugin config points to the plugin-local bootstrap at `./mcp-bootstrap.mjs` inside `plugins/retinue/.mcp.json`. Keep the config under the top-level `mcpServers` key for Codex plugin MCP discovery, and keep `cwd: "."` so Codex starts the bootstrap from the installed plugin cache instead of from the current conversation working directory. The bootstrap resolves `dist/mcp.js` from its own plugin directory, then changes cwd to Retinue state before starting stdio so Windows cache refresh and uninstall operations are less likely to be blocked by a running MCP process. `pnpm run build` compiles the npm runtime under the repository root `dist/` and then syncs a copy into `plugins/retinue/dist/`, so the plugin marketplace install can start Retinue after copying only the plugin directory.

## Development Verification

Run deterministic gates:

```bash
pnpm run gate:local
```

Install repository-scoped Git hooks to avoid repeating the deterministic gates manually:

```bash
pnpm run dev:install-hooks
```

The `pre-commit` hook runs the fast commit gate, currently `pnpm run typecheck`. The `post-commit`
hook checks generated artifact drift after generated files can be part of the commit. The
`pre-push` hook runs the ordinary deterministic local gate before changes leave the workstation.
Use `pnpm run gate:release` before tagging or publishing.

For fast Codex plugin reloads during development, see [Plugin Reload Workflow](PLUGIN_RELOAD.md). The short version is: build and smoke the source first, then use `pnpm run dev:sync-plugin-cache -- --apply` only when the installed Codex plugin cache must consume the new bundle.

Run the real OpenCode product probe only when the local OpenCode CLI is installed and configured:

```bash
RETINUE_REAL_OPENCODE_PROBE=1 \
RETINUE_BACKEND=opencode \
pnpm run probe:real:retinue-opencode
```

Run the Claude Code real probe only when the local Claude Code profile is known to work:

```bash
pnpm run probe:real:retinue-claude
```

## npm Runtime

The npm package name is:

```text
@disaster-terminator/retinue
```

It exposes:

```text
retinue
retinue-mcp
retinued
```

Legacy `retinue*` bin aliases remain for compatibility but should not be used in user-facing Retinue docs.
