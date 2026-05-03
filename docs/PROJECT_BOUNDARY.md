# Project Boundary and Long-Term Vision

## Product Boundary

`supervisor` is a local job supervisor for spawning Claude Code from Codex-like clients.

It is not a model router, provider switcher, replacement Claude client, or PAL wrapper. The supervisor calls the system `claude` command and lets the existing Claude Code configuration, permissions, and cc-switch setup decide model/provider behavior.

The project exists to provide lifecycle semantics that a one-shot MCP tool cannot provide:

- start an external Claude Code job and return a handle quickly
- inspect status without blocking the main agent
- wait or poll for completion
- retrieve bounded results and local artifact paths
- continue from a persisted Claude session id
- kill, time out, and clean up jobs
- survive enough local state ambiguity to avoid lying about job status

## Current Phase

The current implementation is a hardened stdio MCP supervisor:

```text
Codex / MCP client
  -> supervisor-mcp over stdio
    -> in-process ClaudeSupervisor core
      -> system claude process
      -> job files on disk
```

This phase is useful for proving the API, state model, safety defaults, and Windows/WSL process behavior. It is not the final durable architecture because the MCP stdio server lifetime is still tied to the client process.

## Target Phase

The long-term target is a durable local daemon:

```text
supervisor-daemon
  owns job lifecycle, process tracking, state reconciliation, limits, and cleanup

supervisor-mcp
  thin adapter from MCP tools to daemon RPC

supervisor-cli
  inspect/debug/admin adapter, not the lifecycle owner
```

The daemon is the eventual lifecycle owner. MCP and CLI should become adapters only.

## Non-Goals

The project should not expand into these areas unless explicitly re-scoped:

- multi-provider routing
- multi-machine queues
- cloud orchestration
- a general-purpose process manager
- interactive PTY control as the first solution
- default permission bypass
- support for every agent CLI before Claude Code is reliable

## Safety Rules

- Never add `--dangerously-skip-permissions` by default.
- Do not expose Claude Code `bypassPermissions` through normal MCP or CLI inputs.
- Keep prompts out of process argv.
- Keep full prompts out of default `status` responses.
- Return bounded logs to MCP clients by default; provide file paths for full artifacts.
- Treat stale, missing, or corrupted state as explicit status, not as success.
- Prefer local, deterministic tests with fake Claude before real Claude Code testing.

## First Goal Scope

Before daemonization, the current stdio MCP implementation must be hardened enough for real Windows Claude Code plus cc-switch integration testing.

This means:

- listener registration must not race fast process exit or spawn errors
- permission mode must be validated in core, not only in MCP schemas
- job metadata and exit status writes must be atomic enough to avoid half-written JSON
- `not_found` and `corrupted` states must be structured
- global concurrency checks must scan state on disk, not only the current process map
- `kill` must not report `killed` before that state is durable
- running jobs need a peek/tail path
- Windows Claude Code plus cc-switch must be verified with a small real job

Only after that should daemonization become the main development track.

