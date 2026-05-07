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

The repo-local plugin config points to the built runtime at `../../dist/mcp.js` relative to `plugins/anchorpoint/.mcp.json`. That is why release commits include `dist/`: the plugin marketplace install must not require users to compile TypeScript.

## Development Verification

Run deterministic gates:

```bash
pnpm run typecheck
pnpm test
pnpm run build
pnpm run verify:package
```

Run the real OpenCode product probe only when a local OpenCode server is running:

```bash
opencode serve --hostname 127.0.0.1 --port 4096

SUPERVISOR_REAL_OPENCODE_PROBE=1 \
SUPERVISOR_RETINUE_BACKEND=opencode \
SUPERVISOR_OPENCODE_BASE_URL=http://127.0.0.1:4096 \
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

Legacy `supervisor*` bin aliases remain for compatibility but should not be used in user-facing Retinue docs.
