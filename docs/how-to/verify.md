# Verification

This is the maintainer verification entry point. Historical milestone notes live in
[../archive/VERIFICATION_HISTORY.md](../archive/VERIFICATION_HISTORY.md).

## Default Gates

Run this for a fast workflow check while iterating:

```bash
pnpm run gate:fast
```

Run this before merging ordinary code or docs changes:

```bash
pnpm run gate:local
```

Default tests are deterministic. They do not require real Claude Code or a live OpenCode server.
The default Vitest scripts cap worker counts conservatively so local gates do not multiply into a
machine-level process storm when several Codex/Retinue/Hermes threads are active at the same time.
`gate:local` intentionally does not run `check:generated`; generated artifact drift is checked
after commits and in release gates so development runs do not fail just because fresh build output
has not been staged yet.

Use grouped test scripts instead of ad hoc single-file Vitest commands:

```bash
pnpm run test:core
pnpm run test:daemon
pnpm run test:opencode
pnpm run test:mcp
pnpm run test:package
pnpm run test:probes
pnpm run test:cli
```

If a change repeatedly needs a single test file to be run by hand, add or adjust a group script
first. The workflow should make the useful verification slice explicit so agents and humans do
not keep rediscovering the same command.

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
The installed `pre-commit` hook runs `pnpm run gate:commit`, currently typecheck plus the core
test group. The installed `pre-push` hook runs `pnpm run gate:local` so tests, package smoke, and
package verification are checked before pushing. Use
`RETINUE_SKIP_GIT_HOOKS=1` only for an explicit emergency local bypass; CI and release gates still
run the same deterministic checks.

## Manual E2E

Use the runbooks only when validating real local agent runtimes:

- [Production OpenCode E2E](../runbooks/production-opencode-e2e.md)
- [Kilo backend](../reference/backends/kilo.md)
- [Real Claude Code probes](../runbooks/real-claude-probes.md)
- [Real OpenCode probes](../runbooks/real-opencode-probes.md)

The release OpenCode slot probe is:

```bash
RETINUE_REAL_OPENCODE_SLOT_PROBE=1 RETINUE_MAX_CONCURRENT_AGENTS=1 pnpm run probe:real:retinue-opencode-slots
```

The Retinue dogfood pressure probe is:

```bash
pnpm run gate:dogfood
```

By default this uses OpenCode's built-in `explore` subagent, matching the packaged Retinue plugin
default. This probe runs concurrent read-only OpenCode review jobs through the Retinue MCP surface and exits
nonzero unless every child returns a completed textual answer, reports a `PASS` verdict, and includes
its requested completion marker. `FAIL` verdicts, `stalled`, `running`,
`read_tool_invalid_input`, `tool_invalid_input`, provider/router zero-progress, and missing-marker results are release-blocking dogfood failures, not
review evidence. The JSON output includes job ids, provider/model metadata, stdout/stderr paths,
`stallReason`, `stallSummary`, running tool counts/summaries, and `tracePath` for
follow-up. If a run reports `read_tool_stalled`, `read_tool_invalid_input`, or
`tool_invalid_input`, inspect the failed job entry first; it should identify the
active tool call ids and malformed input preview before you fall back to the full
Retinue JSONL log.
Provider/API failures are grouped under provider-specific `failureReason` values when Retinue can
recognize them, for example `provider_error:deepseek_reasoning_content`; treat those as backend route
or provider compatibility failures before investigating Retinue lifecycle code.

When comparing OpenCode root binding modes, keep both modes in the same Retinue MCP probe and let the
output separate them:

```bash
RETINUE_DOGFOOD_OPENCODE_ROOT_BINDING_MODE_LIST=shared_root,per_spawn pnpm run gate:dogfood
```

The default product path is `shared_root`. `per_spawn` remains a legacy/fallback mode for isolation
checks and debugging. The dogfood JSON records
`externalRunnerMode`, `externalRootAgent`, `externalRootSessionId`, `externalParentSessionId`, and the
child `externalSessionId` for this comparison.

Use the cross-session probe when validating the edge case where two independent Retinue MCP sessions
target the same cwd:

```bash
pnpm run probe:real:opencode-shared-root-cross-session
RETINUE_CROSS_SESSION_WRITABLE=1 pnpm run probe:real:opencode-shared-root-cross-session
```

The writable variant uses a temporary probe workspace unless `RETINUE_CROSS_SESSION_CWD` is explicitly
set.

Use the OpenCode agent A/B probe only when comparing runtime behavior across built-in agents:

```bash
RETINUE_REAL_OPENCODE_AGENT_AB_PROBE=1 RETINUE_OPENCODE_AGENT_LIST=plan,explore pnpm run probe:real:retinue-opencode-agent-ab
```

### Backend candidate probes

Use `pnpm run probe:real:backend-candidates` to inspect Kilo CLI and Crush command surfaces before backend implementation. Model-backed candidate runs require `RETINUE_BACKEND_CANDIDATE_REAL_PROBE=1` and default to `intentmux`; see [Backend candidate probes](../runbooks/backend-candidate-probes.md).

The A/B probe is a compatibility diagnostic, not a substitute for `gate:dogfood`.

`gate:dogfood` is intentionally separate from `gate:release` because it uses the real local OpenCode
provider/router instead of deterministic fixtures. Run both before publishing a release.

Do not record API keys, provider secrets, tokens, or account credentials. Record only backend
metadata, job/session ids, non-secret provider/model metadata, and observed results.
