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

Install Kilo with pnpm for the lowest-friction local deployment:

```bash
pnpm add -g @kilocode/cli
```

`RETINUE_KILO_COMMAND` may point at a different executable. `RETINUE_KILO_PREFIX_ARGS` exists for wrapper commands such as package-manager `dlx` probes, but production deployments should prefer a normal installed `kilo` binary so config, auth, cache, and session storage are stable.

Kilo server attach follows the same local safety rules as OpenCode attach: loopback HTTP only by default, with non-loopback hosts requiring an explicit `RETINUE_KILO_ALLOW_NON_LOOPBACK=1`.

## Model And Agent

Kilo owns default model routing through its own OpenCode-compatible config. Retinue does not send a Kilo model override unless the deployment explicitly sets one:

```text
RETINUE_KILO_MODEL=litellm/intentmux
```

When `RETINUE_KILO_MODEL` is set, Retinue sends Kilo's `provider/model` shape:

```json
{
  "model": {
    "providerID": "litellm",
    "modelID": "intentmux"
  }
}
```

Retinue does not route providers itself; `litellm/intentmux` must resolve in Kilo's OpenCode-compatible config. Kilo can reuse the same provider shape as OpenCode, but it reads its own config directory such as `~/.config/kilo/opencode.json`. Do not copy API keys into that file. Use environment variables or file references, and put the default model in Kilo config:

```json
{
  "$schema": "https://app.kilo.ai/config.json",
  "model": "litellm/intentmux",
  "provider": {
    "litellm": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "litellm",
      "options": {
        "baseURL": "http://localhost:4000/v1",
        "apiKey": "{env:LITELLM_API_KEY}"
      },
      "models": {
        "intentmux": {
          "name": "intentmux"
        }
      }
    }
  }
}
```

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
- `prompt_async` accepts the selected agent and `litellm/intentmux` model
- message polling returns final assistant text
- abort closes the child session
- permission requests are visible through `/permission` and replyable through `/permission/:requestID/reply`

## Current Evidence

Kilo 7.3.1 exposes the required `serve`, `run`, `session`, `export`, and `agent` command surfaces. A transient `@kilocode/cli` server accepted `GET /global/health`, `POST /session`, `GET /session/:id`, `GET /session/:id/message`, and `POST /session/:id/abort`.

The global pnpm Kilo 7.3.1 install resolved `kilo` on PATH and `kilo models litellm` listed `litellm/intentmux` after Kilo config reused the OpenCode LiteLLM provider with file references for secrets. The CLI `kilo run --auto --format json --model litellm/intentmux --dir /home/raystorm/projects/Retinue "Reply exactly: RETINUE_KILO_LITELLM_INTENTMUX_OK"` completed with the expected text.

The Retinue Kilo MCP probe also completed through the real backend:

```bash
RETINUE_REAL_KILO_PROBE=1 pnpm run probe:real:retinue-kilo
```

Evidence: `backend=kilo`, `mode=auto-serve`, `status=completed`, `result=RETINUE_KILO_REAL_OK`, and `closeStatus=completed`.
