# Kilo Backend

The Kilo backend is an OpenCode-compatible adapter. Retinue uses the same session, prompt, message, abort, and permission bridge shape as the OpenCode backend, but starts or attaches to a Kilo server.

This backend exists to validate whether another OpenCode-like runtime can be supported without adding a new Retinue delegation abstraction.

## Server Target

Attach to an existing local Kilo server:

```text
RETINUE_BACKEND=kilo
RETINUE_KILO_BASE_URL=http://127.0.0.1:41987
```

Or let Retinue start one:

```text
RETINUE_BACKEND=kilo
RETINUE_KILO_AUTO_SERVE=1
RETINUE_KILO_HOST=127.0.0.1
RETINUE_KILO_PORT=41987
```

Retinue invokes:

```bash
kilo serve --hostname 127.0.0.1 --port 41987
```

`RETINUE_KILO_COMMAND` may point at a different executable. `RETINUE_KILO_PREFIX_ARGS` exists for wrapper commands such as package-manager `dlx` probes, but production deployments should prefer a normal installed `kilo` binary so config, auth, cache, and session storage are stable.

Kilo server attach follows the same local safety rules as OpenCode attach: loopback HTTP only by default, with non-loopback hosts requiring an explicit `RETINUE_KILO_ALLOW_NON_LOOPBACK=1`.

## Model And Agent

Kilo model override defaults to the local gateway model name:

```text
RETINUE_KILO_MODEL=intentmux
```

If `RETINUE_KILO_MODEL` is unset, Retinue sends `intentmux`. Kilo accepts bare model ids, so Retinue sends:

```json
{
  "model": {
    "modelID": "intentmux"
  }
}
```

This is intentionally different from the OpenCode `provider/model` override shape. Retinue does not route providers itself; `intentmux` should resolve in the Kilo/OpenCode-compatible runtime profile or the local gateway behind it.

The default Kilo child agent is:

```text
RETINUE_KILO_AGENT=explore
```

A single `retinue_spawn_agent` call can still pass `agent` to choose another Kilo/OpenCode-compatible agent for that child.

## Product Boundary

Normal delegation still uses:

```text
retinue_spawn_agent
retinue_wait_agent
retinue_close_agent
retinue_list_agents
retinue_list_permissions
retinue_reply_permission
```

Retinue does not expose Kilo-specific product tools. The backend selection is deployment-level via `RETINUE_BACKEND=kilo`.

Kilo support currently depends on OpenCode-compatible HTTP behavior. Before treating a Kilo deployment as production-ready, run deterministic tests plus a real local dogfood against the installed Kilo server and confirm:

- session creation returns stable ids
- `prompt_async` accepts the selected agent and `intentmux` model
- message polling returns final assistant text
- abort closes the child session
- permission requests are visible through `/permission` and replyable through `/permission/:requestID/reply`

## Current Evidence

Kilo 7.3.1 exposes the required `serve`, `run`, `session`, `export`, and `agent` command surfaces. A transient `@kilocode/cli` server accepted `GET /global/health`, `POST /session`, `GET /session/:id`, `GET /session/:id/message`, and `POST /session/:id/abort`.

The CLI `kilo run --auto --format json --model intentmux --dir <cwd> <prompt>` has not yet produced a successful model-backed completion in local probing; it timed out without output. Treat that as a runtime/profile evidence gap, not proof that the HTTP server adapter is invalid.
