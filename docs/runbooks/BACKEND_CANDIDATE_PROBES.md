# Backend Candidate Probes

Use this runbook before implementing another Retinue backend. The probe is evidence-only: it captures local command surfaces and, when explicitly opted in, can run one model-backed prompt.

## Command Surface

The default probe does not call a model:

```bash
pnpm run probe:real:backend-candidates
pnpm run probe:real:backend-candidates -- --candidate kilo
pnpm run probe:real:backend-candidates -- --candidate crush
```

It checks `--version`, top-level help, run help, server/serve help, and session help. Kilo uses `serve`; Crush uses `server`.

## Model-Backed Run

Real runs are opt-in and default to `intentmux`:

```bash
RETINUE_BACKEND_CANDIDATE_REAL_PROBE=1 \
pnpm run probe:real:backend-candidates -- --candidate kilo --real-run
```

Override the model only when intentionally testing a different route:

```bash
RETINUE_BACKEND_CANDIDATE_REAL_PROBE=1 \
pnpm run probe:real:backend-candidates -- --candidate crush --real-run --model intentmux
```

Kilo is invoked as:

```text
kilo run --auto --format json --model intentmux --dir <cwd> <prompt>
```

Crush is invoked as:

```text
crush --cwd <cwd> --yolo run --model intentmux --quiet <prompt>
```

## Command Overrides

Use command overrides for local installs, shims, or fixtures:

```bash
RETINUE_KILO_COMMAND=/path/to/kilo \
RETINUE_KILO_PREFIX_ARGS='["arg-before-kilo-command"]' \
pnpm run probe:real:backend-candidates -- --candidate kilo
```

Available overrides:

- `RETINUE_KILO_COMMAND`
- `RETINUE_KILO_PREFIX_ARGS`
- `RETINUE_CRUSH_COMMAND`
- `RETINUE_CRUSH_PREFIX_ARGS`

Prefix args may be a JSON string array or one literal argument.

For a transient Kilo CLI check without installing `kilo` globally:

```bash
RETINUE_KILO_COMMAND=pnpm \
RETINUE_KILO_PREFIX_ARGS='["--package=@kilocode/cli","dlx","kilo"]' \
pnpm run probe:real:backend-candidates -- --candidate kilo
```

This validates the published CLI package surface. Prefer a normal `kilo` install before model-backed runs so config, auth, cache, and session storage match the target runtime.

## Kilo Server Contract

Kilo also exposes an OpenCode-compatible server:

```bash
kilo serve --hostname 127.0.0.1 --port 41987 --pure
```

The local 7.3.1 probe accepted:

- `GET /global/health`
- `POST /session`
- `GET /session/:id`
- `GET /session/:id/message`
- `POST /session/:id/abort`

That is enough to justify a thin Retinue backend adapter reusing the OpenCode HTTP client and job lifecycle. It is not enough to declare production readiness; a model-backed `prompt_async` completion and permission request/reply behavior still need real-runtime dogfood.

## Decision Rule

Do not start backend implementation from command presence alone. A candidate needs evidence for:

- non-interactive run
- server or attach mode
- session identity and continuation
- machine-readable session data
- abort/close behavior
- permission request/reply semantics, or a clear reason the backend cannot support `AgentPermissionBridge`
