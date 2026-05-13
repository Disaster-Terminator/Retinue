@/home/raystorm/.codex/RTK.md

# Retinue Project Instructions

## Plugin Reload Discipline

After changing code or packaged plugin behavior, do not stop at source tests. Compile first, then sync the installed Retinue plugin cache yourself so the next Codex restart/new thread can consume the new bundle without uninstalling and reinstalling the plugin.

Default local flow:

```bash
pnpm run build
pnpm run smoke:package
pnpm run dev:sync-plugin-cache:all -- --apply
```

Use `dev:sync-plugin-cache:all` only for Retinue. It syncs the installed Retinue cache for WSL and, when detectable from WSL, Windows. It does not install Retinue, uninstall Retinue, update marketplaces, or touch other plugin projects.

Existing Codex threads are not a plugin reload proof. After cache sync, the user may still need to restart the relevant Codex host and open a new thread.

For docs-only or test-only edits that do not need the installed plugin bundle, cache sync is optional. For any change under `src/`, `plugins/retinue/`, `integrations/hermes/skills/retinue/`, or packaged runtime scripts, run the reload flow unless blocked and state the blocker.
