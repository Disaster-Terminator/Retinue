# Retinue Handoff: OpenCode Native Subtask Baseline

Time: 2026-05-20T15:13:45+08:00

## Current State

- Branch: `main`
- Working tree before this handoff file: clean
- Latest pushed commit: `20bf8c6 feat: use opencode native subtask runner`
- Remote archive branch for the old wrapper snapshot: `archive/pre-native-opencode-runner`
- Beads has no open issues.

## What Changed

Retinue's OpenCode backend now uses OpenCode native `subtask` semantics as the default run path:

- A Retinue OpenCode job creates a parent OpenCode `build` session.
- The requested child agent/model is passed through an OpenCode `subtask` part.
- Retinue treats the parent assistant final text as the result collection path.
- Metadata and diagnostics record `externalParentSessionId` and `externalChildSessionIds`.
- The old standalone-session wrapper is preserved only by the archive branch, not as the preferred product direction.

Key files:

- `src/backends/opencode/client.ts`
- `src/backends/opencode/backend.ts`
- `src/core/types.ts`
- `tests/fixtures/fake-opencode-server.ts`
- `tests/opencode-client.test.ts`
- `tests/opencode-backend.test.ts`
- `tests/mcp-tools.test.ts`
- `tests/cli.test.ts`
- `docs/research/2026-05-20-opencode-native-spawn-adapter.md`

## Verification Already Run

- `pnpm run probe:real:opencode-native-spawn`
- `RETINUE_REAL_OPENCODE_PROBE=1 pnpm run probe:real:retinue-opencode`
- `pnpm run gate:fast`
- `pnpm run gate:local`
- `pnpm run build`
- `pnpm run smoke:package`
- `pnpm run dev:sync-plugin-cache:all -- --apply`
- Push hook also reran `gate:local` before pushing `20bf8c6`.

Final pushed gate result: 27 test files passed, 272 tests passed, package smoke passed, package verification passed.

## Important Caveat

Installed plugin caches were synced for WSL and Windows, but existing Codex/Hermes hosts cannot prove the new plugin bundle until they are restarted. The next thread should treat restart plus real Retinue dogfood as the first live check.

The Retinue MCP tool available in the previous thread still used the old installed plugin during one cross-review and stalled with the known read-only patch/write-intent failure. That failure should be interpreted as old-wrapper evidence, not as a post-reload verdict.

## Suggested Next Thread Start

1. Confirm `git status --short --branch` is clean except this handoff file if it has not been committed.
2. If the host has been restarted, run a real Retinue dogfood task through the installed plugin.
3. Prefer checking whether results now come back through native parent/subtask behavior before adding more stall heuristics.
4. If e2e is healthy, decide whether to update README/release notes for the native-subtask baseline.
