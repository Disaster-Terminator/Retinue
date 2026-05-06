# Verification

This is the short verification entry point. Historical milestone notes live in
[archive/VERIFICATION_HISTORY.md](archive/VERIFICATION_HISTORY.md).

## Default Gates

Run these before merging ordinary code or docs changes:

```bash
pnpm run typecheck
pnpm test
pnpm run build
pnpm run verify:package
```

Default tests are deterministic. They do not require real Claude Code or a live OpenCode server.

## Manual E2E

Use the runbooks only when validating real local agent runtimes:

- [Production OpenCode E2E](runbooks/PRODUCTION_OPENCODE_E2E.md)
- [Real Claude Code Probes](runbooks/REAL_CLAUDE_PROBES.md)
- [Real OpenCode Probes](runbooks/REAL_OPENCODE_PROBES.md)

Do not record API keys, provider secrets, tokens, or account credentials. Record only backend
metadata, job/session ids, non-secret provider/model metadata, and observed results.

