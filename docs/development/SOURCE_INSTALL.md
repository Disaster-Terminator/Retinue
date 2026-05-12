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
pnpm run typecheck
pnpm run check:generated
pnpm test
pnpm run verify:package
```

Run the real OpenCode product probe only when a local OpenCode server is running:

```bash
opencode serve --hostname 127.0.0.1 --port 4096

RETINUE_REAL_OPENCODE_PROBE=1 \
RETINUE_BACKEND=opencode \
RETINUE_OPENCODE_BASE_URL=http://127.0.0.1:4096 \
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
