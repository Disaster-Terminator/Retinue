# Real OpenCode Probes

This probe is **manual-only** and **opt-in**. It is not part of default CI or deterministic tests.

Real OpenCode probes may consume provider/model quota depending on your local OpenCode configuration.

## Manual probe script

Script path:

- `scripts/probe-real-opencode.mjs`

The script is blocked unless you explicitly opt in with:

- `SUPERVISOR_REAL_OPENCODE_PROBE=1`

It accepts a loopback OpenCode server URL from either:

- `SUPERVISOR_OPENCODE_BASE_URL`, or
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
SUPERVISOR_REAL_OPENCODE_PROBE=1 \
SUPERVISOR_OPENCODE_BASE_URL=http://127.0.0.1:4096 \
node scripts/probe-real-opencode.mjs
```

Bash using CLI URL flag:

```bash
SUPERVISOR_REAL_OPENCODE_PROBE=1 \
node scripts/probe-real-opencode.mjs --base-url http://localhost:4096
```

## CI and tests

- Default CI does **not** run this probe.
- `pnpm test` does **not** require a live OpenCode server.
- No provider/model routing changes are introduced by this probe.
- No permission-bypass behavior is introduced by this probe.

For the production-style CLI/MCP lifecycle flow, including optional `SUPERVISOR_OPENCODE_MODEL=litellm/pro-router`, see [Production OpenCode E2E](PRODUCTION_OPENCODE_E2E.md).
