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

Retinue 0.1.0 defaults to OpenCode and asks OpenCode to use its `plan` agent. Users do not need to clone, install dependencies, or compile Retinue. Retinue targets Windows, WSL/Linux, and macOS; this round's acceptance path uses WSL.

Requirements:

- Node.js 20+
- Codex CLI 0.128+
- OpenCode 1.14+, preferably from the official install script:

```bash
curl -fsSL https://opencode.ai/install | bash
```

The official script installs OpenCode under `$HOME/.opencode/bin/opencode`. Retinue also checks common npm/pnpm/bun global install paths, but the 0.1.0 quickstart and smoke path assume the official script install.

Add the Retinue plugin marketplace to Codex:

```bash
codex plugin marketplace add Disaster-Terminator/Retinue
```

Open Codex, run `/plugins`, press the keyboard Right Arrow key until `[Retinue Local]` is selected, press Enter to open the `Retinue` details page, then choose `Install plugin`. After installation, restart Codex, then ask:

```text
Use Retinue to spawn an OpenCode plan subagent. Ask it to reply exactly: RETINUE_OK. Wait for the result and close the child agent.
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
- WSL / Linux: current 0.1.0 acceptance path. The default plugin config prefers `127.0.0.1:4096` and tries `4097` through `4127` when earlier ports are occupied by external services.
- macOS: uses the same Node.js, Codex CLI, and OpenCode prerequisites; it is not the primary validation path for this round.

## Default Plugin Config

The plugin MCP config lives at `plugins/retinue/.mcp.json`. Retinue 0.1.0 defaults to:

```json
{
  "RETINUE_BACKEND": "opencode",
  "RETINUE_OPENCODE_AUTO_SERVE": "1",
  "RETINUE_OPENCODE_HOST": "127.0.0.1",
  "RETINUE_OPENCODE_AGENT": "plan"
}
```

This means:

- Codex calls Retinue and does not choose the concrete backend.
- Retinue manages the OpenCode server lifecycle by default. It prefers `127.0.0.1:4096` and tries `4097` through `4127` when earlier ports are occupied by external services.
- OpenCode uses the active local profile for provider, model, login, plugins, and skills.
- `plan` is the 0.1.0 default agent. Retinue product spawns are read-only by default: Retinue sends an OpenCode prompt-level override denying `edit`, `write`, `apply_patch`, and nested `task` delegation even when the local OpenCode profile allows them. `bash` is restricted to a small read-only git inspection allowlist for commands such as `git status --short`, `git diff --cached`, `git diff --staged`, targeted `git diff -- <path>`, and `git show --stat`.
- Read-only review prompts also ask OpenCode to return findings as plain text and avoid unified diffs or patch blocks. If OpenCode still emits patch/write intent, Retinue marks the job `stalled` and the result should be treated as non-evidence.
- If the user prompt already provides enough facts, the default read-only child is instructed to answer from those facts instead of opening repository tools. Repository inspection is bounded to a small number of `read`/`grep`/`glob` or allowed read-only git calls before a final text answer.
- Default read-only children cannot run arbitrary shell, write-capable git commands, shell composition, or patch/edit tools. Use `bash_policy: "none"` for one stricter no-bash child, or `access_mode: "profile"` only when the child should intentionally follow the active OpenCode profile.
- Codex plugin installs read their default access mode from the installation-scoped `retinue.config.json` shipped with the plugin. It defaults to `{ "opencode": { "defaultAccessMode": "read_only", "readOnlyBashPolicy": "readonly_git" } }`.
- `retinue_spawn_agent` can override that default per child with `access_mode: "read_only"` or `access_mode: "profile"`. Use `"profile"` only when the child is intentionally allowed to follow the active OpenCode profile, including write-capable tools if that profile allows them.
- Hermes and custom MCP deployments can keep using environment configuration. `RETINUE_OPENCODE_ACCESS_MODE=profile` or the older `RETINUE_OPENCODE_READ_ONLY=0` selects profile permissions when child-agent writes are intentionally acceptable.
- `retinue_wait_agent` keeps each MCP wait call inside a host-safe window, 90 seconds by default. Long jobs should be polled by calling wait again; deployments can tune the cap with `RETINUE_MCP_WAIT_MAX_MS`.
- Each Retinue MCP server session keeps up to 3 active child agents by default, matching the Codex v2 shape of "4 threads including root." The 4th active spawn closes the oldest still-running child and returns `evictedJobId`; deployments can tune this with `RETINUE_MAX_CONCURRENT_AGENTS`.

A long child-agent task is still running when `retinue_wait_agent` returns `status: "running"`. Call `retinue_wait_agent` again with the same `jobId`; do not respawn unless the job reaches `failed`, `killed`, `stalled`, or another terminal status.

When a wait returns `running`, the response includes `stdoutTail`, `stderrTail`, `tracePath`, and job artifact paths. Inspect the tail fields first. Complex OpenCode `plan` tasks can spend several minutes in tool-call rounds before producing final text, so a timeout from one wait call is not by itself a failed child.

Retinue reports OpenCode empty-output or incomplete assistant loops as `stalled` only after diagnostic thresholds are crossed. The default long stall threshold is 10 minutes; deployments can tune `RETINUE_OPENCODE_STALL_MS`, `RETINUE_OPENCODE_STALL_INCOMPLETE_ASSISTANT_MS`, `RETINUE_OPENCODE_STALL_TOOL_CALL_ROUNDS`, and `RETINUE_OPENCODE_STALL_EMPTY_ASSISTANT_ROUNDS`.

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

The Claude Code backend has fake E2E and best-effort real E2E coverage. It is not enabled by default in 0.1.0. To switch a deployment:

```bash
RETINUE_BACKEND=claude-code
```

Claude Code still owns its model, endpoint, permission, and profile behavior.

## npm Install

The npm package installs the Retinue runtime directly. Use it for custom MCP configuration or development setups:

```bash
npm install -g @disaster-terminator/retinue@0.1.0
codex mcp add retinue \
  --env RETINUE_BACKEND=opencode \
  --env RETINUE_OPENCODE_BASE_URL=http://127.0.0.1:4096 \
  --env RETINUE_OPENCODE_AGENT=plan \
  -- retinue-mcp
```

Normal Codex users should prefer the plugin marketplace path. The npm path does not install the Retinue skill.

## Hermes Agent

Hermes Agent can use Retinue as a master-agent MCP integration. Hermes is not a Retinue backend; Hermes loads Retinue under `mcp_servers`, then calls the prefixed tools `mcp_retinue_retinue_spawn_agent`, `mcp_retinue_retinue_wait_agent`, `mcp_retinue_retinue_close_agent`, and `mcp_retinue_retinue_list_agents`.

Install the npm runtime and merge `integrations/hermes/mcp-retinue.yaml` into `~/.hermes/config.yaml`, or see [Hermes Agent Integration](docs/integrations/HERMES.md). The default remains OpenCode `plan` with Retinue-managed OpenCode server lifecycle.

## Verification

Before the 0.1.0 release, Retinue passed:

- Retinue OpenCode fake E2E
- Retinue OpenCode real E2E
- Retinue Claude Code fake E2E
- Retinue Claude Code best-effort real E2E
- `pnpm test`
- `pnpm run typecheck`
- `pnpm run build`
- `pnpm run verify:package`

Real OpenCode probe:

```bash
RETINUE_REAL_OPENCODE_PROBE=1 \
RETINUE_BACKEND=opencode \
pnpm run probe:real:retinue-opencode
```

Hermes MCP shape probe:

```bash
pnpm run probe:hermes-retinue
```

## Developer Docs

- [Source install and development](docs/development/SOURCE_INSTALL.md)
- [0.1.0 Release Notes](docs/release/v0.1.0_RELEASE_NOTES.md)
- [0.1.0 Release Notes zh-CN](docs/release/v0.1.0_RELEASE_NOTES.zh-CN.md)
- [0.1.0 Release Readiness](docs/release/0.1.0_RELEASE_PLAN.md)
- [Docs index](docs/README.md)
- [Long-Term Vision](docs/LONG_TERM_VISION.md)
- [Project Boundary](docs/architecture/PROJECT_BOUNDARY.md)
- [Service Lifecycle](docs/deployment/SERVICE_LIFECYCLE.md)
- [Plugin Deployment](docs/deployment/PLUGIN_DEPLOYMENT.md)
- [Hermes Agent Integration](docs/integrations/HERMES.md)
