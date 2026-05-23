# Real OpenCode Probes

This probe is **manual-only** and **opt-in**. It is not part of default CI or deterministic tests.

Real OpenCode probes may consume provider/model quota depending on your local OpenCode configuration.

## Product MCP probe

Use this probe for the default Retinue product path. It exercises Retinue MCP tools with OpenCode auto-serve enabled unless the deployment explicitly sets `RETINUE_OPENCODE_BASE_URL`.

```bash
RETINUE_REAL_OPENCODE_PROBE=1 \
pnpm run probe:real:retinue-opencode
```

Set `RETINUE_OPENCODE_BASE_URL` only when intentionally validating attach mode against an externally managed OpenCode server.

## Dogfood root binding comparison

Use this when comparing Retinue's default per-spawn OpenCode root container against the experimental shared-root container. The probe still goes through the Retinue MCP surface; it does not treat the low-level OpenCode HTTP probe as product evidence.

```bash
RETINUE_DOGFOOD_OPENCODE_ROOT_BINDING_MODE_LIST=per_spawn,shared_root \
RETINUE_DOGFOOD_OPENCODE_ACCESS_MODE=profile \
pnpm run probe:dogfood:opencode
```

`RETINUE_OPENCODE_ROOT_BINDING_MODE=shared_root` is an experimental opt-in. The default remains `per_spawn`, where each Retinue job gets its own unprompted OpenCode root session plus one prompted child session. In `shared_root`, jobs in the same Retinue MCP server session with the same OpenCode server URL, cwd, and root agent reuse one unprompted root session and create separate prompted child sessions under it. Separate MCP server sessions do not share roots.

The default root agent is `build`. Set `RETINUE_OPENCODE_ROOT_AGENT=<agent>` only when validating a different OpenCode primary/root agent as the unprompted container; the Retinue child agent still comes from `RETINUE_OPENCODE_AGENT` or the MCP `agent` argument.

The probe output includes `externalRunnerMode`, `externalRootAgent`, `externalRootSessionId`, `externalParentSessionId`, and the child `externalSessionId` so per-spawn and shared-root logs do not get mixed.

## Low-level OpenCode HTTP probe

Script path:

- `scripts/probe-real-opencode.mjs`

The script is blocked unless you explicitly opt in with:

- `RETINUE_REAL_OPENCODE_PROBE=1`

The low-level HTTP script accepts a loopback OpenCode server URL from either:

- `RETINUE_OPENCODE_BASE_URL`, or
- CLI flag: `--base-url`

Non-loopback URLs are rejected.

## Operations probed

When available, the script probes:

- `GET /global/health`
- `POST /session`
- `GET /session/:id`
- `POST /session/:id/prompt_async`
- `GET /session/:id/message`
- session status endpoint (`GET /session/:id/status` when available; fallback detection)
- `POST /session/:id/abort`

OpenCode 1.14.35 may return the web app HTML for `/session/:id/status`; the probe treats non-JSON status responses as unavailable and falls back to `GET /session/:id`.

Output is concise JSON intended for copying into docs or issue comments.

## Examples

Bash using environment URL:

```bash
RETINUE_REAL_OPENCODE_PROBE=1 \
RETINUE_OPENCODE_BASE_URL=http://127.0.0.1:4096 \
node scripts/probe-real-opencode.mjs
```

Bash using CLI URL flag:

```bash
RETINUE_REAL_OPENCODE_PROBE=1 \
node scripts/probe-real-opencode.mjs --base-url http://localhost:4096
```

## CI and tests

- Default CI does **not** run this probe.
- `pnpm test` does **not** require a live OpenCode server.
- No provider/model routing changes are introduced by this probe.
- No permission-bypass behavior is introduced by this probe.

For the production-style CLI/MCP lifecycle flow, including optional `RETINUE_OPENCODE_MODEL=litellm/pro-router`, see [Production OpenCode E2E](PRODUCTION_OPENCODE_E2E.md).
