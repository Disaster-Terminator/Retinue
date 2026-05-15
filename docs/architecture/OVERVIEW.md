# Architecture Overview

Retinue is a local subagent lifecycle layer for Codex-like MCP clients. The host agent delegates a coding task to an installed local agent runtime, gets a job handle quickly, and later polls, reads, closes, or cleans that job.

Retinue is intentionally narrow:

- more durable than a one-shot MCP wrapper, because it keeps job state and artifacts;
- smaller than a platform, because it does not route providers, choose models, host queues, or replace OpenCode / Claude Code.

For the formal scope, see [Project Boundary](PROJECT_BOUNDARY.md).

## Runtime Shape

```text
Codex or another MCP client
  -> Retinue skill and MCP tools
    -> Retinue lifecycle API
      -> backend adapter
        -> OpenCode server or Claude Code CLI
      -> local state and bounded artifacts
```

Backend choice is deployment configuration. The caller should use the product `retinue_*` tools rather than choosing OpenCode or Claude Code from each request.

## Product Tool Surface

| Tool | Purpose |
| --- | --- |
| `retinue_spawn_agent` | Start a child job through the configured backend and return a `jobId` with metadata. |
| `retinue_wait_agent` | Wait within a host-safe window and return either terminal output or running diagnostics. |
| `retinue_close_agent` | Close a child job and remove it from the active MCP-session pool. |
| `retinue_list_agents` | List active child jobs tracked by the current MCP server session. |

Backend-specific `opencode_*` and `claude_*` tools are adapter/debug surfaces. They should stay hidden in normal plugin deployments unless `RETINUE_EXPOSE_BACKEND_TOOLS=1` is deliberately enabled.

## Components

| Component | Owns | Does not own |
| --- | --- | --- |
| MCP host | Deciding what to delegate and when to poll or close the child. | Backend profile, provider login, model routing. |
| Retinue MCP server | Product tools, wait limits, active child-agent slots. | Cloud orchestration or provider choice. |
| Lifecycle API | Job metadata, status, result, continuation, close, cleanup. | Agent-runtime internals. |
| Backend adapter | Translating lifecycle operations to OpenCode or Claude Code. | Reimplementing a full agent client. |
| OpenCode / Claude Code | Provider credentials, model defaults, profile policy, plugins, permissions. | Retinue job-state semantics. |
| State directory | Metadata, stdout/stderr logs, traces, artifact paths. | Long-term memory or credential storage. |

## Job Lifecycle

A normal product flow is:

1. The host calls `retinue_spawn_agent` with a prompt, task name, and preferably an absolute `cwd`.
2. Retinue records job metadata and starts or attaches to the configured backend runtime.
3. Retinue returns a `jobId` without blocking the root agent on the whole child task.
4. The host calls `retinue_wait_agent` until the job reaches a terminal state.
5. Running responses include bounded output tails, artifact paths, and compact diagnostics.
6. Terminal responses include the result or an attention-required status such as failure or stall.
7. The host calls `retinue_close_agent` when the child is no longer needed.

Each MCP server session keeps a small active child-agent pool. The default is 3 active children, matching the practical shape of three children plus one root thread.

## Backend Notes

OpenCode is the default 0.1.0 backend. The plugin deployment starts or attaches to a loopback OpenCode server and asks OpenCode to use the `plan` agent by default:

```text
RETINUE_BACKEND=opencode
RETINUE_OPENCODE_AUTO_SERVE=1
RETINUE_OPENCODE_HOST=127.0.0.1
RETINUE_OPENCODE_AGENT=plan
```

Retinue-managed OpenCode prefers `127.0.0.1:4096` and can fall back through `4097` to `4127` when earlier ports are already used by external services. OpenCode still owns provider configuration, login, model defaults, endpoint routing, plugins, skills, and profile policy. See [OpenCode Backend](../backends/OPENCODE.md).

Claude Code is available as an alternate backend for deployments that set:

```text
RETINUE_BACKEND=claude-code
```

Claude Code still owns its own model, endpoint, quota, permission, and profile behavior.

## Safety And Observability Defaults

Retinue defaults to local, bounded behavior:

- prompts are kept out of process arguments;
- default status responses do not include full prompts;
- MCP responses return bounded output tails and artifact paths instead of unbounded logs;
- OpenCode product spawns are read-only by default;
- managed local services bind to loopback by default;
- stale or corrupted state should become an explicit status rather than fake success;
- real backend probes are still required because static tests cannot catch every local runtime contract drift.

Common diagnostic paths under `RETINUE_STATE_DIR`:

```text
<stateDir>/logs/retinue.jsonl
<stateDir>/jobs/<jobId>/meta.json
<stateDir>/jobs/<jobId>/stdout.log
<stateDir>/jobs/<jobId>/stderr.log
```

## What To Read Next

- [Project Boundary](PROJECT_BOUNDARY.md)
- [OpenCode Backend](../backends/OPENCODE.md)
- [Plugin Deployment](../deployment/PLUGIN_DEPLOYMENT.md)
- [Source Install And Development](../development/SOURCE_INSTALL.md)
- [Hermes Agent Integration](../integrations/HERMES.md)
- [Documentation Governance](../DOCUMENTATION_GOVERNANCE.md)
