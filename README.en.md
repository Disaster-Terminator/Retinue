# Retinue

<p align="left">
  <img alt="runtime Node.js 20+" src="https://img.shields.io/badge/runtime-Node.js%2020%2B-339933">
  <img alt="language TypeScript" src="https://img.shields.io/badge/language-TypeScript-3178C6">
  <img alt="package manager pnpm" src="https://img.shields.io/badge/package%20manager-pnpm-F69220">
  <img alt="interface MCP + CLI" src="https://img.shields.io/badge/interface-MCP%20%2B%20CLI-4B5563">
  <img alt="backends Claude Code and OpenCode" src="https://img.shields.io/badge/backends-Claude%20Code%20%2B%20OpenCode-111827">
  <img alt="scope local first" src="https://img.shields.io/badge/scope-local--first-0F766E">
</p>

[中文](README.md) · [Docs Index](docs/README.md) · [Plugin Deployment](docs/deployment/PLUGIN_DEPLOYMENT.md) · [Source Development](docs/development/SOURCE_INSTALL.md)

**Retinue lets Codex run local coding agents as controllable subagents.**

Codex submits a coding job, Retinue returns a job handle immediately, and the caller can later inspect status, wait for completion, read results, continue an external session, kill work, or clean local artifacts. Claude Code and OpenCode still own their provider, model, quota, proxy, login, and runtime policy; Retinue makes those local agent runtimes callable, trackable, and recoverable from Codex.

```text
Codex / MCP client
  -> Retinue MCP or CLI
    -> backend-neutral lifecycle API
      -> backend adapter
        -> Claude Code / OpenCode
      -> local job state + bounded result artifacts
```

## When to use it

Retinue is useful when a Codex thread needs to delegate a bounded coding task to an existing local agent while keeping lifecycle control in the main thread:

- The main Codex thread can continue planning, reviewing, and validating while the child agent investigates or implements a focused task.
- The child agent may take long enough that the main thread should receive a `jobId` first and poll or wait later.
- The caller needs local job state, external session ids, bounded stdout/stderr, and artifact paths for recovery or debugging.
- The deployment should reuse an existing local Claude Code or OpenCode profile instead of reimplementing provider routing inside an MCP tool.

## What it is not

Retinue is a local subagent execution surface. It is not a model gateway or provider router.

- It does not select or switch model providers.
- It does not own Claude Code or OpenCode login, quota, proxy, model defaults, or runtime policy.
- It does not put prompts into process argv.
- It does not return full prompts from default `status` responses.
- It does not try to become a general process manager, cloud queue, or multi-machine scheduler.

See [Project Boundary](docs/architecture/PROJECT_BOUNDARY.md) for the full boundary.

## Core tool flow

Normal Codex plugin usage focuses on three Retinue tools:

| Tool | Purpose | Typical return |
| --- | --- | --- |
| `retinue_spawn_agent` | Start a child-agent job through the deployment-selected backend | `jobId`, `status`, `backend`, session ids |
| `retinue_wait_agent` | Wait within a short timeout window for the child agent to reach a terminal state | running or terminal status; terminal responses include result |
| `retinue_close_agent` | Stop a running child agent or confirm an already terminal state | killed / completed / failed and related states |

Lower-level `opencode_*` and `claude_*` tools remain available for adapter debugging, but they are not the default Codex delegation surface.

## Quick Start: Codex plugin marketplace

Retinue 0.1.0 defaults to OpenCode and asks OpenCode to use its `plan` agent. Normal users do not need to clone, install dependencies, or compile Retinue. Retinue targets Windows, WSL/Linux, and macOS; this round's acceptance path uses WSL.

Requirements:

- Node.js 20+
- Codex CLI 0.128+
- OpenCode 1.14+

Add the Retinue plugin marketplace to Codex:

```bash
codex plugin marketplace add Disaster-Terminator/Retinue
```

Then open Codex, run `/plugins`, press the keyboard Right Arrow key until `[Retinue Local]` is selected, press Enter to open the `Retinue` details page, then choose `Install plugin`.

After installation, restart Codex, then ask:

```text
Use Retinue to spawn an OpenCode plan subagent. Ask it to reply exactly: RETINUE_OK. Wait for the result and close the child agent.
```

Expected result:

- Codex sees the Retinue skill.
- Codex can call `retinue_spawn_agent`.
- `retinue_wait_agent` returns a result containing `RETINUE_OK`.
- `retinue_close_agent` returns a terminal status.

Note: Codex CLI 0.128 `codex plugin marketplace add/upgrade/remove` manages marketplaces only. Plugin installation happens in the Codex TUI `/plugins` screen. `codex plugin marketplace upgrade retinue-local` updates an existing marketplace; it is not an install command.

## Default plugin config

The plugin MCP config lives at `plugins/anchorpoint/.mcp.json`. Retinue 0.1.0 defaults to:

```json
{
  "mcpServers": {
    "retinue": {
      "command": "node",
      "args": ["./dist/mcp.js"],
      "cwd": ".",
      "startup_timeout_sec": 30,
      "env": {
        "SUPERVISOR_RETINUE_BACKEND": "opencode",
        "SUPERVISOR_OPENCODE_AUTO_SERVE": "1",
        "SUPERVISOR_OPENCODE_HOST": "127.0.0.1",
        "SUPERVISOR_OPENCODE_AGENT": "plan"
      }
    }
  }
}
```

This means:

- Codex calls Retinue and does not choose the concrete backend on every tool call.
- Retinue manages the OpenCode server lifecycle by default. It prefers `127.0.0.1:4096` and tries `4097` when that port is occupied by an external service.
- `cwd: "."` makes Codex start `node ./dist/mcp.js` from the installed plugin cache instead of the current conversation working directory.
- OpenCode uses the active local profile for provider, model, login, permissions, plugins, and skills.
- `plan` is the 0.1.0 safety default. A future Retinue config file will allow deployments to choose `build` without exposing that choice as a per-call tool argument.

## Choosing an install path

| Path | Best for | What it installs |
| --- | --- | --- |
| Codex plugin marketplace | Normal Codex users | Retinue skill, MCP config, plugin-local runtime |
| Global npm install | Custom MCP configuration or development setups | `retinue`, `retinue-mcp`, `retinued` runtime |
| Source checkout | Contributors and debugging | TypeScript source, tests, build, and package verification scripts |

Normal Codex users should prefer the plugin marketplace path. The npm path installs runtime only; it does not install the Retinue skill.

npm install example:

```bash
npm install -g @disaster-terminator/retinue@0.1.0
codex mcp add retinue \
  --env SUPERVISOR_RETINUE_BACKEND=opencode \
  --env SUPERVISOR_OPENCODE_BASE_URL=http://127.0.0.1:4096 \
  --env SUPERVISOR_OPENCODE_AGENT=plan \
  -- retinue-mcp
```

## Platform notes

- Windows: requires local Node.js, Codex CLI, and OpenCode; configure the OpenCode server URL for the deployment.
- WSL / Linux: current 0.1.0 acceptance path. The default config connects to `http://127.0.0.1:4096`.
- macOS: uses the same Node.js, Codex CLI, and OpenCode prerequisites; it is not the primary validation path for this round.

## Backend status

### OpenCode

OpenCode is the default 0.1.0 backend. Retinue enables auto-serve by default:

```text
SUPERVISOR_OPENCODE_AUTO_SERVE=1
SUPERVISOR_OPENCODE_HOST=127.0.0.1
SUPERVISOR_OPENCODE_AGENT=plan
```

Retinue only connects to or starts the local OpenCode server and uses the OpenCode API to create, wait for, read, and close jobs. Model, provider, login, permission, plugin, and skill behavior remains owned by the active OpenCode profile.

### Claude Code

The Claude Code backend has fake E2E and best-effort real E2E coverage. It is not enabled by default in 0.1.0. To switch a deployment:

```bash
SUPERVISOR_RETINUE_BACKEND=claude-code
```

Claude Code still owns its model, endpoint, permission, and profile behavior.

## Development and verification

Run from source:

```bash
pnpm install
pnpm run build
pnpm test
```

Deterministic release gates:

```bash
pnpm run typecheck
pnpm run check:generated
pnpm test
pnpm run verify:package
```

Real OpenCode probe:

```bash
SUPERVISOR_REAL_OPENCODE_PROBE=1 \
SUPERVISOR_RETINUE_BACKEND=opencode \
SUPERVISOR_OPENCODE_BASE_URL=http://127.0.0.1:4096 \
pnpm run probe:real:retinue-opencode
```

Before the 0.1.0 release, Retinue passed:

- Retinue OpenCode fake E2E
- Retinue OpenCode real E2E
- Retinue Claude Code fake E2E
- Retinue Claude Code best-effort real E2E
- `pnpm test`
- `pnpm run typecheck`
- `pnpm run build`
- `pnpm run verify:package`

## FAQ

### Why is Retinue unavailable after `marketplace add`?

`codex plugin marketplace add Disaster-Terminator/Retinue` only adds the marketplace. You still need to open Codex, run `/plugins`, enter `[Retinue Local]`, and choose `Install plugin`.

### Why is there no Retinue skill after npm install?

The npm package installs runtime only. It does not install the Codex plugin skill. Normal Codex users should use the plugin marketplace path.

### What if the OpenCode port is already occupied?

Default auto-serve prefers `127.0.0.1:4096` and tries `4097` when that port is occupied by an external service. If you intentionally want to attach to an external OpenCode server, set `SUPERVISOR_OPENCODE_BASE_URL=http://127.0.0.1:4096`.

### Why not pass model / provider / permission in the tool call?

That is an intentional product boundary. Retinue's default entry point handles child-agent lifecycle. Model, provider, permission, and profile behavior belong to the local Claude Code or OpenCode runtime.

## Documentation

- [Docs Index](docs/README.md)
- [Project Boundary](docs/architecture/PROJECT_BOUNDARY.md)
- [OpenCode Backend](docs/backends/OPENCODE.md)
- [Plugin Deployment](docs/deployment/PLUGIN_DEPLOYMENT.md)
- [Source Install and Development](docs/development/SOURCE_INSTALL.md)
- [Service Lifecycle](docs/deployment/SERVICE_LIFECYCLE.md)
- [0.1.0 Release Plan](docs/release/0.1.0_RELEASE_PLAN.md)
- [Long-Term Vision](docs/LONG_TERM_VISION.md)
