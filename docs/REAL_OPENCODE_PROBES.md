# Real OpenCode Probes

These probes are **manual-only** and **opt-in**. They are intentionally excluded from default CI and deterministic test suites.

Real OpenCode probes can consume provider/model quota depending on your OpenCode backend configuration.

## Guardrails

- Requires explicit opt-in: `SUPERVISOR_REAL_OPENCODE_PROBE=1`
- Requires loopback OpenCode URL only (`localhost`, `127.0.0.1`, `127.*`, or `::1`)
- Does not change ClaudeCode behavior
- Does not add provider/model routing
- Does not add permission bypass flags

## Endpoints Probed

The script attempts these operations in order:

1. `GET /global/health`
2. `POST /session`
3. `GET /session/:id`
4. `POST /session/:id/prompt_async`
5. `GET /session/:id/message`
6. Session status endpoint, when explicitly provided
7. `POST /session/:id/abort`

## Usage

From repo root:

```bash
SUPERVISOR_REAL_OPENCODE_PROBE=1 \
SUPERVISOR_OPENCODE_BASE_URL=http://127.0.0.1:4096 \
pnpm run probe:real:opencode
```

Or pass URL by CLI flag:

```bash
SUPERVISOR_REAL_OPENCODE_PROBE=1 \
pnpm run probe:real:opencode -- --base-url http://127.0.0.1:4096
```

Optional session status probe path (examples):

```bash
SUPERVISOR_REAL_OPENCODE_PROBE=1 \
pnpm run probe:real:opencode -- \
  --base-url http://127.0.0.1:4096 \
  --session-status-path /session/:id/status
```

The probe prints concise JSON to stdout for easy copy/paste into notes or docs.

## Boundary Statement

This probe is a manual integration check only. It is not part of CI, does not run by default during `pnpm test`, and does not require OpenCode for normal development or deterministic validation.
