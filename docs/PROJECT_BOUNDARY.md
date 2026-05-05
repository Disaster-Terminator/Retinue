# Project Boundary and Long-Term Vision

## Product Boundary

`supervisor` is a local agent job supervisor for spawning external coding agents from Codex-like clients.

It is not a model router, provider switcher, replacement agent client, or PAL wrapper. Each backend calls or attaches to the locally installed agent runtime and lets that runtime own provider, model, quota, proxy, and permission policy.

The project exists to provide lifecycle semantics that a one-shot MCP tool cannot provide:

- start an external agent job and return a handle quickly
- inspect status without blocking the main agent
- wait or poll for completion
- retrieve bounded results and local artifact paths
- continue from a persisted external session id when the backend supports it
- kill, time out, and clean up jobs
- survive enough local state ambiguity to avoid lying about job status

## Current Phase

The current implementation is a hardened Claude Code backend:

```text
Codex / MCP client
  -> supervisor-mcp over stdio
    -> in-process ClaudeSupervisor core
      -> system claude process
      -> job files on disk
```

This phase is useful for proving the API, state model, safety defaults, and Windows/WSL process behavior. It is not the final durable architecture because the MCP stdio server lifetime is still tied to the client process.

Claude Code remains a supported backend, but it is no longer the only product shape. After the current hardening review is absorbed, the Claude Code backend should be frozen as a compatibility baseline while new work moves to backend-neutral lifecycle APIs and an OpenCode backend.

## Target Phase

The long-term target is a durable local daemon:

```text
supervisor-daemon
  owns job lifecycle, process tracking, external session mapping, state reconciliation, limits, and cleanup

agent backend adapters
  own runtime-specific launch, attach, prompt, abort, and result extraction

supervisor-mcp
  thin adapter from MCP tools to daemon RPC

supervisor-cli
  inspect/debug/admin adapter, not the lifecycle owner
```

The daemon is the eventual lifecycle owner. MCP and CLI should become adapters only.

## Backend Strategy

Backends must be thin adapters over mature local agent runtimes:

- `claude-code`: calls the system `claude` executable and preserves the existing fake-Claude deterministic test model.
- `opencode`: prefers the official OpenCode headless server and SDK/API. `opencode run --attach` is acceptable for probes or fallback behavior, not as the only durable integration path.

The project should not parse interactive TUI output or reimplement upstream provider/model selection. For OpenCode, provider login, `/connect`, model selection, agent configuration, and endpoint routing remain OpenCode-owned.

## Non-Goals

The project should not expand into these areas unless explicitly re-scoped:

- multi-provider routing
- multi-machine queues
- cloud orchestration
- a general-purpose process manager
- interactive PTY control as the first solution
- default permission bypass
- support for every agent CLI before the backend contract is stable

## Safety Rules

- Never add `--dangerously-skip-permissions` by default.
- Do not expose Claude Code `bypassPermissions` through normal MCP or CLI inputs.
- Do not expose OpenCode permission bypass flags through normal MCP or CLI inputs.
- Keep prompts out of process argv.
- Keep full prompts out of default `status` responses.
- Return bounded logs to MCP clients by default; provide file paths for full artifacts.
- Treat stale, missing, or corrupted state as explicit status, not as success.
- Prefer local, deterministic tests with fake runtimes before real agent testing.

## Near-Term Goal Scope

The near-term work is split into two tracks.

First, freeze the Claude Code backend:

- absorb only the useful backend-neutral hardening from `review/codex-web-nightly-2026-05-04`
- migrate the repository standard from npm commands to pnpm commands
- keep the existing Claude Code public behavior compatible
- document that Claude Code provider/model routing remains outside supervisor

Second, build the OpenCode backend:

- introduce backend-neutral metadata for external session ids and backend kind
- manage or attach to OpenCode headless server explicitly
- use official OpenCode SDK/API as the primary integration surface
- use CLI JSON mode only for probes or compatibility fallback
- add `opencode_*` MCP/CLI surfaces without breaking existing `claude_*` surfaces
