# Project Boundary

## Product Boundary

Retinue is a local subagent execution surface for Codex-like clients. It runs external coding agents such as Claude Code and OpenCode, returns job handles, and preserves enough local state for later status, wait, result, continue, termination, and cleanup operations.

It is not a model router, provider switcher, replacement agent client, or PAL wrapper. Each backend calls or attaches to the locally installed agent runtime and lets that runtime own provider, model, quota, proxy, login, and runtime policy.

Retinue exists to provide lifecycle semantics that a one-shot MCP tool cannot provide:

- start an external agent job and return a handle quickly
- inspect status without blocking the main agent
- wait or poll for completion
- retrieve bounded results and local artifact paths
- continue from a persisted external session id when the backend supports it
- terminate, time out, and clean up jobs
- survive enough local state ambiguity to avoid lying about job status

## Runtime Shape

```text
Codex / MCP client
  -> Retinue MCP or CLI
    -> backend-neutral lifecycle API
      -> backend adapter
        -> Claude Code or OpenCode
      -> local job state and artifacts
```

The local daemon mode uses the same lifecycle API through loopback RPC. In that mode, CLI and MCP act as adapters to a running local process instead of owning all job state in-process.

## Backend Strategy

Backends must be thin adapters over mature local agent runtimes:

- `claude-code`: calls the system `claude` executable and preserves the fake-Claude deterministic test model.
- `opencode`: attaches to a loopback OpenCode server and uses OpenCode's API surface. CLI-based probing is acceptable for compatibility checks, but provider/model behavior remains OpenCode-owned.

Retinue should not parse interactive TUI output or reimplement upstream provider/model selection. For OpenCode, provider login, `/connect`, model selection, agent configuration, and endpoint routing remain OpenCode-owned.

## Non-Goals

Retinue should not expand into these areas unless explicitly re-scoped:

- multi-provider routing
- multi-machine queues
- cloud orchestration
- a general-purpose process manager
- interactive PTY control as the first solution
- default permission bypass
- support for every agent CLI before the backend contract is stable

## Safety Rules

- Do not expose backend permission bypass flags through normal MCP or CLI inputs.
- Keep prompts out of process argv.
- Keep full prompts out of default `status` responses.
- Return bounded logs to MCP clients by default; provide file paths for full artifacts.
- Treat stale, missing, or corrupted state as explicit status, not as success.
- Prefer local, deterministic tests with fake runtimes before real agent testing.
