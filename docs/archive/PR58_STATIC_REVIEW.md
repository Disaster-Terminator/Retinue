# PR 58 Static Review

Date: 2026-05-06

Branch: `feature/spawn-opencode`

Base: `origin/main`

## Scope

Reviewed PR #58 as the Anchorpoint Codex plugin milestone. The product shape is a plugin that packages:

- MCP server runtime
- agent-facing skill
- plugin manifest and marketplace metadata
- production OpenCode E2E instructions

The plugin is the deployable surface; MCP and skill are plugin components.

## Findings Fixed

### User prompt exposed as OpenCode result

Severity: Important

Static review found that `opencode_result` selected the latest text message after the job baseline. In real OpenCode message streams, a running job can have a new user message before the assistant response exists. That made it possible to expose the current user prompt as `stdout`.

Fix:

- `OpenCodeBackend.result()` now extracts only assistant message text.
- The fake OpenCode server now models user and assistant messages separately.
- Regression test added: `does not expose the current user prompt as result before an assistant response exists`.

### Plugin deployment surface was missing

Severity: Important

PR #58 had MCP runtime and docs, but not a Codex plugin product surface. Since the accepted product shape is a plugin containing both MCP and skill, this was incomplete for deployment.

Fix:

- Added `plugins/anchorpoint/.codex-plugin/plugin.json`.
- Added `plugins/anchorpoint/.mcp.json`.
- Added `plugins/anchorpoint/skills/anchorpoint/SKILL.md`.
- Added `.agents/plugins/marketplace.json`.
- Added `docs/PLUGIN_DEPLOYMENT.md`.
- Extended package verification to require plugin files.

### Plugin MCP default could require a daemon

Severity: Important

The first plugin MCP config draft set `SUPERVISOR_DAEMON_DISCOVERY=1` by default. That would fail for users without an already running and discoverable daemon.

Fix:

- Removed default daemon discovery from plugin `.mcp.json`.
- Documented daemon URL/discovery as explicit opt-in.
- Added a guardrail test that the plugin MCP config does not force `SUPERVISOR_DAEMON_DISCOVERY`.

## Static Review Result

Reviewed areas:

- OpenCode backend lifecycle and message baseline behavior.
- CLI `opencode-*` commands.
- MCP `opencode_*` tools.
- Package files and package verifier.
- Plugin manifest, MCP config, skill, and marketplace metadata.
- README and deployment docs.
- PR #57 impact.

PR #57 contains broader README/package metadata repositioning. PR #58 already has the required Anchorpoint aliases and repository metadata needed for this milestone. No broad PR #57 README rewrite was absorbed; the only necessary product-shape work was the plugin packaging added directly in PR #58.

## Verification

Static gates:

```bash
pnpm run typecheck
pnpm test
pnpm run build
pnpm run verify:package
```

Observed:

- `pnpm run typecheck` passed.
- `pnpm test` passed with 21 files and 126 tests.
- `pnpm run build` passed.
- `pnpm run verify:package` passed.
- Plugin MCP relative import check passed from `plugins/anchorpoint`.

Real OpenCode E2E:

```text
OpenCode server: http://127.0.0.1:4096
OpenCode version: 1.14.35
model override: litellm/pro-router
providerID: litellm
modelID: pro-router
```

Run result:

```text
jobId: job_e69a6efb-3273-429c-9fd1-f7af8a88bf59
sessionId: ses_202bb3938ffeBGQVwiD0NWN4YV
stdout: ANCHORPOINT_E2E_RUN_OK
status: completed
```

Continue result:

```text
jobId: job_07346cfd-6876-432e-9bb8-b4528312d434
sessionId: ses_202bb3938ffeBGQVwiD0NWN4YV
baseline message count: 2
baseline completed assistant count: 1
stdout: ANCHORPOINT_E2E_CONTINUE_OK
status: completed
```

Kill and cleanup:

```text
kill jobId: job_1c0bf160-afc6-4e33-972a-33b0369f68be
kill status: killed
cleanup removed completed jobs: job_e69a6efb-3273-429c-9fd1-f7af8a88bf59, job_07346cfd-6876-432e-9bb8-b4528312d434
cleanup removed killed job on second sequential cleanup: job_1c0bf160-afc6-4e33-972a-33b0369f68be
```

Do not run `opencode_kill` and `opencode_cleanup` in parallel for acceptance. Cleanup is state-based and should run after kill has written `killed` metadata.

## Residual Risk

Remaining risks are real-environment risks:

- Codex Desktop plugin installation UI and marketplace refresh behavior can only be fully confirmed in the user's production Codex app.
- OpenCode server contract can drift across versions after 1.14.35.
- Local plugin install paths differ between repo-local and home-local deployment; production install must confirm that `.mcp.json` resolves the built runtime.

No further static issue was identified after code review, targeted regression tests, package verification, plugin guardrails, and real OpenCode lifecycle probing.
