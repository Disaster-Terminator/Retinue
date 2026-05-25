# Plugin Reload Workflow

Retinue development has three different reload scopes. Keeping them separate avoids unnecessary uninstall/reinstall cycles.

## Reload Scopes

| Scope | Use when | Fast path | Still requires |
| --- | --- | --- | --- |
| Source runtime | TypeScript, OpenCode adapter, MCP behavior | `pnpm run build` plus probes from `dist/mcp.js` | No Codex restart |
| Installed plugin cache | Codex plugin bundle, bundled skill, `.mcp.json`, bootstrap | `pnpm run dev:sync-plugin-cache -- --apply` | Restart the matching Codex host and use a new thread |
| Plugin marketplace/install state | Marketplace path, plugin name, manifest shape, install broken | `/plugins` install/uninstall or marketplace add/upgrade | Restart/new thread after install |

Existing Codex threads are not the reload proof. Plugin installation is thread-bound enough that a new thread is the minimum reliable validation surface.

## Normal Retinue Loop

For most implementation work:

```bash
pnpm run build
pnpm run smoke:package
pnpm run test:mcp
```

This validates the built MCP server and plugin bootstrap without touching the installed Codex plugin cache.

When Codex itself must consume the new plugin bundle:

```bash
pnpm run build
pnpm run smoke:package
pnpm run dev:sync-plugin-cache
pnpm run dev:sync-plugin-cache -- --apply
```

Then restart the same Codex host and open a new thread. Do not uninstall/reinstall unless the cache sync fails or the marketplace/install state itself is the thing under test.

When both WSL and Windows Codex need the same Retinue plugin bundle:

```bash
pnpm run build
pnpm run smoke:package
pnpm run dev:sync-plugin-cache:all
pnpm run dev:sync-plugin-cache:all -- --apply
```

`dev:sync-plugin-cache:all` still only syncs installed Retinue cache entries. It does not install Retinue, uninstall Retinue, refresh another plugin project, or update a marketplace. It only reduces the repeated manual cache replacement step before the unavoidable Codex restart/new-thread check.

The sync script is intentionally dry-run by default. It discovers installed Retinue cache directories under:

```text
$CODEX_HOME/plugins/cache
~/.codex/plugins/cache
%USERPROFILE%\.codex\plugins\cache when --include-windows is used from WSL
WSL ~/.codex/plugins/cache when --include-wsl is used from Windows
```

Default output is compact so reload checks do not flood agent context. Add `--json` when a test or troubleshooting step needs the full target list and paths:

```bash
pnpm run dev:sync-plugin-cache:all -- --apply --json
```

Use explicit filters when needed:

```bash
pnpm run dev:sync-plugin-cache -- --marketplace retinue-local --version 0.2.0 --apply
```

## Windows And WSL

Windows Codex and WSL Codex have separate home directories, plugin caches, Node runtimes, and OpenCode installs. Sync only the side you are testing unless you intentionally use `dev:sync-plugin-cache:all`.

For WSL CLI testing, run the sync script inside WSL and restart the WSL Codex session. If running the script from Windows, `dev:sync-plugin-cache:all` asks `wsl.exe` for the WSL Codex cache path and syncs it when available.

For Windows Codex testing from WSL, run `pnpm run dev:sync-plugin-cache:all -- --apply`. The script detects the mounted Windows `%USERPROFILE%` through `cmd.exe` and syncs that cache root when available. If detection fails, pass the Windows cache root explicitly:

```bash
pnpm run dev:sync-plugin-cache -- --cache-root /mnt/c/Users/<you>/.codex/plugins/cache --apply
```

Do not treat the WSL cache as the Windows cache.

## When To Reinstall

Use `/plugins` uninstall/install only when:

- The plugin was never installed.
- The marketplace path, plugin name, install policy, or manifest shape changed.
- Codex cannot read plugin details after restart.
- Cache replacement fails because files are locked or permissions are broken.

For ordinary TypeScript, skill, docs, or packaged runtime edits, prefer cache sync plus restart/new thread.
