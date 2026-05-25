# Retinue

<p align="left">
  <img alt="runtime Node.js 20+" src="https://img.shields.io/badge/runtime-Node.js%2020%2B-339933">
  <img alt="language TypeScript" src="https://img.shields.io/badge/language-TypeScript-3178C6">
  <img alt="package manager pnpm" src="https://img.shields.io/badge/package%20manager-pnpm-F69220">
  <img alt="interface MCP + CLI" src="https://img.shields.io/badge/interface-MCP%20%2B%20CLI-4B5563">
  <img alt="backends Claude Code and OpenCode" src="https://img.shields.io/badge/backends-Claude%20Code%20%2B%20OpenCode-111827">
  <img alt="scope local first" src="https://img.shields.io/badge/scope-local--first-0F766E">
</p>

[中文](README.md)

**Retinue lets Codex run local coding agents as controllable subagents.**

Codex submits a coding job, Retinue returns a job handle immediately, and the caller can later inspect status, wait for completion, read results, continue an external session, kill work, or clean local artifacts. Claude Code and OpenCode still own their provider, model, quota, proxy, login, and runtime policy; Retinue makes those local agent runtimes callable, trackable, and recoverable from Codex.

```text
Codex / MCP client
  -> Retinue MCP or CLI
    -> backend adapter
      -> Claude Code / OpenCode
    -> local job state + bounded result artifacts
```

## Core capabilities

| Capability | Description |
| --- | --- |
| Start subagents | Start Claude Code or OpenCode coding jobs from Codex and return a `jobId` quickly |
| Inspect status | Read running, completed, failed, stopped, orphaned, abandoned, and related states |
| Wait or poll | Wait within a short timeout window without blocking the main agent's whole task |
| Read results | Return bounded stdout/stderr, exit metadata, external session ids, and local artifact paths |
| Continue sessions | Continue an existing Claude/OpenCode session when the backend supports it |
| Run concurrent children | Keep a small per-MCP-session child-agent slot pool and evict the oldest active child when the pool is full |
| Kill and clean up | Kill selected jobs and remove terminal job directories while preserving running or ambiguous jobs |

## Boundary

Retinue is a local subagent execution surface. It is not a model gateway or provider router.

- It does not select or switch model providers.
- It does not own Claude Code or OpenCode login, quota, proxy, model defaults, or runtime policy.
- It does not put prompts into child-agent process argv; avoid CLI `--prompt` for sensitive debugging prompts.
- It does not return full prompts from default `status` responses.
- It does not try to become a general process manager or cloud queue.

## Quick Start

Retinue 0.2.0 defaults to OpenCode and asks OpenCode to use its `explore` agent. Users do not need to clone, install dependencies, or compile Retinue. Retinue targets Windows, WSL/Linux, and macOS; documentation examples focus on WSL/Linux.

Requirements:

- Node.js 20+
- Codex CLI 0.128+
- OpenCode 1.14+, preferably from the official install script:

```bash
curl -fsSL https://opencode.ai/install | bash
```

The official script installs OpenCode under `$HOME/.opencode/bin/opencode`. Retinue also checks common npm/pnpm/bun global install paths, but the 0.2.0 quickstart and smoke path assume the official script install.

Add the Retinue plugin marketplace to Codex:

```bash
codex plugin marketplace add Disaster-Terminator/Retinue
```

Open Codex, run `/plugins`, press the keyboard Right Arrow key until `[Retinue Local]` is selected, press Enter to open the `Retinue` details page, then choose `Install plugin`. After installation, restart Codex, then ask:

```text
Use Retinue to spawn an OpenCode explore subagent. Ask it to reply exactly: RETINUE_OK. Wait for the result and close the child agent.
```

Expected result:

- Codex sees the Retinue skill.
- Codex can call `retinue_spawn_agent`.
- `retinue_wait_agent` returns a result containing `RETINUE_OK`.
- `retinue_close_agent` returns a terminal status.
- `retinue_list_agents` can list Retinue child agents that are still active in the current MCP session.

Note: Codex CLI 0.128 `codex plugin marketplace add/upgrade/remove` manages marketplaces only. Plugin installation happens in the Codex TUI `/plugins` screen. `codex plugin marketplace upgrade retinue-local` updates an existing marketplace; it is not an install command.

## Platform Notes

- Windows: requires local Node.js, Codex CLI, and OpenCode. Retinue first looks for the official script install at `%USERPROFILE%\.opencode\bin\opencode`, then falls back to common pnpm/npm/bun shims. The default plugin config manages the local OpenCode server lifecycle.
- WSL / Linux: the default plugin config prefers `127.0.0.1:4096` and tries `4097` through `4127` when earlier ports are occupied by external services.
- macOS: uses the same Node.js, Codex CLI, and OpenCode prerequisites; support is still being validated.

## Default Plugin Config

The plugin MCP config lives at `plugins/retinue/.mcp.json`; package defaults live at `plugins/retinue/retinue.config.json`. The 0.2.0 MCP environment only starts the backend:

```json
{
  "RETINUE_BACKEND": "opencode",
  "RETINUE_OPENCODE_AUTO_SERVE": "1",
  "RETINUE_OPENCODE_HOST": "127.0.0.1"
}
```

The packaged `retinue.config.json` defaults to:

```json
{
  "maxConcurrentAgents": 3,
  "opencode": {
    "agent": "explore"
  }
}
```

This means:

- Codex calls Retinue and does not choose the concrete backend.
- Retinue manages the OpenCode server lifecycle by default. It prefers `127.0.0.1:4096` and tries `4097` through `4127` when earlier ports are occupied by external services.
- OpenCode uses the active local profile for provider, model, login, plugins, and skills.
- Retinue calls the local OpenCode server through the official OpenCode SDK; the handwritten HTTP client remains only as a deployment diagnostic and compatibility fallback. This does not change OpenCode ownership of provider and model selection.
- `explore` is the 0.2.0 default agent. Retinue no longer exposes a product-level `access_mode`, and it no longer overlays its own read-only prompt or tool policy on normal OpenCode children.
- OpenCode uses the active profile and the selected OpenCode agent/profile semantics for tools and permissions. Retinue only derives TaskTool-compatible session permissions for direct child sessions, such as OpenCode-compatible `todowrite`/`task` deny rules.
- `retinue_spawn_agent` accepts the task, working directory, task name, and optional OpenCode `agent` choice. Do not pass backend, profile, model, OpenCode server, `access_mode`, or `bash_policy` arguments.
- `retinue_wait_agent` keeps each MCP wait call inside a host-safe window, 180 seconds by default. That window covers OpenCode's default 45-second soft-stall detection plus one final-answer rescue attempt. Long jobs can still be polled by calling wait again, and deployments can tune the cap with `RETINUE_MCP_WAIT_MAX_MS`.
- Each Retinue MCP server session keeps up to 3 active child agents by default. An active spawn beyond the limit closes the oldest still-running child and returns `evictedJobId`. `retinue.config.json` is a packaged default inside the plugin cache, and plugin updates or cache syncs can overwrite it; persistent deployments should set environment variables such as `RETINUE_MAX_CONCURRENT_AGENTS` in Codex `[env]` or the host MCP `env`.

A long child-agent task is still running when `retinue_wait_agent` returns `status: "running"`. Call `retinue_wait_agent` again with the same `jobId`; do not respawn unless the job reaches `failed`, `killed`, `stalled`, or another terminal status.

When a wait returns `running`, the response includes `stdoutTail`, `stderrTail`, `tracePath`, and job artifact paths. Inspect the tail fields first. Complex OpenCode tasks can spend several minutes in tool-call rounds before producing final text, so a timeout from one wait call is not by itself a failed child.

When the OpenCode backend does not produce trusted final text for long enough, Retinue reports the task as `stalled` with a diagnostic summary. Recoverable backend failures can start one fresh task-level attempt; the original job remains `stalled` and non-evidence, and wait responses include `requestedJobId`, `selectedAttemptJobId`, and `attemptChain` when they re-key to the selected attempt. Deployments can set `RETINUE_OPENCODE_TASK_ATTEMPT_MAX=0` to disable fresh attempts; see developer documentation for fine-grained diagnostic window variables.

`retinue_spawn_agent` returns both the requested `cwd` and OpenCode's `externalSessionDirectory`. If they differ, close the child and spawn again with the intended absolute directory before trusting repository-specific conclusions.

## Logs

Retinue writes local diagnostics under `RETINUE_STATE_DIR`. If unset, the defaults are:

- Windows: `%LOCALAPPDATA%\retinue`
- Linux/WSL/macOS: `$XDG_STATE_HOME/retinue` or `$HOME/.local/state/retinue`

Useful files:

- `<stateDir>/logs/retinue.jsonl`: Retinue trace events, including OpenCode server lifecycle and wait diagnostics.
- `<stateDir>/jobs/<jobId>/meta.json`: job metadata.
- `<stateDir>/jobs/<jobId>/stdout.log` and `stderr.log`: terminal result and per-job diagnostics.

## Claude Code Backend

The Claude Code backend uses the Claude Agent SDK path. It is not enabled by default in 0.2.0. To switch a deployment:

```bash
RETINUE_BACKEND=claude-code
```

Claude Code still owns its model, endpoint, permission, and profile behavior.

## npm Install

The npm package installs the Retinue runtime directly. Use it for custom MCP configuration or development setups:

```bash
npm install -g @disaster-terminator/retinue@0.2.0
codex mcp add retinue \
  --env RETINUE_BACKEND=opencode \
  --env RETINUE_OPENCODE_BASE_URL=http://127.0.0.1:4096 \
  --env RETINUE_OPENCODE_AGENT=explore \
  -- retinue-mcp
```

Normal Codex users should prefer the plugin marketplace path. The npm path does not install the Retinue skill.

## Hermes Agent

Hermes Agent can use Retinue as a master-agent MCP integration. Hermes is not a Retinue backend; Hermes loads Retinue under `mcp_servers`, then calls the prefixed tools `mcp_retinue_retinue_spawn_agent`, `mcp_retinue_retinue_wait_agent`, `mcp_retinue_retinue_close_agent`, and `mcp_retinue_retinue_list_agents`.

Install the npm runtime and merge `integrations/hermes/mcp-retinue.yaml` into `~/.hermes/config.yaml`, or see [Hermes Agent Integration](docs/integrations/HERMES.md). The default remains OpenCode `explore` with Retinue-managed OpenCode server lifecycle.

## Verification

Retinue's release gate covers unit tests, integration tests, package-shape checks, and real backend paths. Maintainer commands and raw validation records live in repository runbooks and release-session logs; user-facing release notes record only the product boundary and upgrade guidance.

## Developer Docs

- [Source install and development](docs/development/SOURCE_INSTALL.md)
- [0.2.0 Release Notes](docs/release/v0.2.0_RELEASE_NOTES.md)
- [0.2.0 Release Notes zh-CN](docs/release/v0.2.0_RELEASE_NOTES.zh-CN.md)
- [0.2.0 Release Readiness](docs/release/0.2.0_RELEASE_PLAN.md)
- [Docs index](docs/README.md)
- [Long-Term Vision](docs/LONG_TERM_VISION.md)
- [Project Boundary](docs/architecture/PROJECT_BOUNDARY.md)
- [Service Lifecycle](docs/deployment/SERVICE_LIFECYCLE.md)
- [Plugin Deployment](docs/deployment/PLUGIN_DEPLOYMENT.md)
- [Hermes Agent Integration](docs/integrations/HERMES.md)
