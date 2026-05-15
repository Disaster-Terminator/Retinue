# Verification

This is the short verification entry point. Historical milestone notes live in
[archive/VERIFICATION_HISTORY.md](archive/VERIFICATION_HISTORY.md).

## Default Gates

Run these before merging ordinary code or docs changes:

```bash
pnpm run gate:local
```

Default tests are deterministic. They do not require real Claude Code or a live OpenCode server.
`gate:local` intentionally does not run `check:generated`; generated artifact drift is checked
after commits and in release gates so development runs do not fail just because fresh build output
has not been staged yet.

Run this before tagging or publishing:

```bash
pnpm run gate:release
```

## Local Hooks

Contributors can install repository-scoped Git hooks:

```bash
pnpm run dev:install-hooks
```

The installed `post-commit` hook runs `pnpm run check:generated` after a commit, which is the
right point to verify that generated `dist/` and `plugins/retinue/dist/` files were committed.
The installed `pre-commit` hook runs `pnpm run gate:commit`, currently a fast typecheck. The
installed `pre-push` hook runs `pnpm run gate:local` so tests, package smoke, and package
verification are checked before pushing. Use
`RETINUE_SKIP_GIT_HOOKS=1` only for an explicit emergency local bypass; CI and release gates still
run the same deterministic checks.

## Manual E2E

Use the runbooks only when validating real local agent runtimes:

- [Production OpenCode E2E](runbooks/PRODUCTION_OPENCODE_E2E.md)
- [Real Claude Code Probes](runbooks/REAL_CLAUDE_PROBES.md)
- [Real OpenCode Probes](runbooks/REAL_OPENCODE_PROBES.md)

The release OpenCode slot probe is:

```bash
RETINUE_REAL_OPENCODE_SLOT_PROBE=1 RETINUE_MAX_CONCURRENT_AGENTS=1 pnpm run probe:real:retinue-opencode-slots
```

Do not record API keys, provider secrets, tokens, or account credentials. Record only backend
metadata, job/session ids, non-secret provider/model metadata, and observed results.
