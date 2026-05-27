# Retinue

<!-- markdownlint-disable MD033 -->
<p>
  <img alt="npm version" src="https://img.shields.io/npm/v/%40disaster-terminator%2Fretinue">
  <img alt="license Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-blue">
  <img alt="package manager pnpm" src="https://img.shields.io/badge/package%20manager-pnpm-F69220">
  <img alt="node >=20" src="https://img.shields.io/badge/node-%3E%3D20-339933">
  <img alt="backends OpenCode Claude Code and Kilo" src="https://img.shields.io/badge/backends-OpenCode%20%2B%20Claude%20Code%20%2B%20Kilo-111827">
</p>
<!-- markdownlint-enable MD033 -->

[中文](README.md)

Retinue lets Codex run local OpenCode, Claude Code, or Kilo instances as controllable subagents: the main thread gets a job handle, the child runs in the background, and results, permission requests, and failure diagnostics return through MCP.

```text
Codex / Hermes
  -> Retinue MCP tools
  -> local agent runtime: OpenCode by default, Claude Code or Kilo when configured
```

## Use Cases

| Use case | What Retinue provides |
| --- | --- |
| Parallel review | Spawn an independent local agent for read-only inspection while the main thread keeps working |
| Long task control | Wait, inspect, close, or diagnose background jobs by `jobId` |
| Permission escalation | Surface OpenCode permission requests so the supervising agent can reply explicitly |
| Local budgets | Limit and queue active children per MCP session and across the shared machine state directory |
| Runtime reuse | Reuse OpenCode / Claude Code / Kilo profiles, models, login state, quotas, and permission policy |

Retinue does not choose models, route providers, store API keys, or overlay its own read-only policy on normal OpenCode children. Models, endpoints, plugins, skills, and permission rules belong to the selected local agent runtime.

## Quick Start

Prerequisites:

- Node.js 20+
- Codex CLI 0.128+
- OpenCode 1.14+, preferably installed through the official script:

```bash
curl -fsSL https://opencode.ai/install | bash
```

Add the Retinue plugin marketplace:

```bash
codex plugin marketplace add Disaster-Terminator/Retinue
```

Then open Codex, run `/plugins`, select `[Retinue Local]`, open `Retinue`, and choose `Install plugin`. Restart Codex, then ask Codex to run a real read-only task:

```text
Use Retinue to spawn an OpenCode explore subagent in this repository.
Ask it to inspect README.md and docs/README.md, summarize whether the docs entry points are clear, wait for the result, then close the child agent.
```

Expected result:

- Codex calls `retinue_spawn_agent` and receives a `jobId`.
- `retinue_wait_agent` returns `completed`, `running`, `queued`, `stalled`, or a permission event.
- After the task is terminal, Codex calls `retinue_close_agent` to clean up the child.

For the full install guide, see [Plugin install](docs/how-to/install-plugin.md). For the first-task tutorial, see [Quick start](docs/get-started/quick-start.md).

## Defaults

The v0.2.0 plugin path defaults to:

- Backend: OpenCode
- OpenCode server: Retinue-managed local loopback server
- Default OpenCode agent: `explore`
- Active children per MCP session: 3
- Shared machine budget: `max(5, RETINUE_MAX_CONCURRENT_AGENTS)`
- Overflow strategy: queue new jobs instead of evicting older jobs

These are package defaults, not persistent user configuration. Put persistent overrides in Codex `[env]` or the host MCP environment as `RETINUE_*` variables. See [Configuration reference](docs/reference/configuration.md).

## Common Docs

- [Documentation index](docs/README.md)
- [MCP tools](docs/reference/mcp-tools.md)
- [Diagnostics](docs/reference/diagnostics.md)
- [OpenCode backend](docs/reference/backends/opencode.md)
- [Claude Code backend](docs/reference/backends/claude-code.md)
- [Kilo backend](docs/reference/backends/kilo.md)
- [Hermes integration](docs/how-to/integrate-hermes.md)
- [Verification](docs/how-to/verify.md)
- [v0.2.0 release notes](docs/releases/v0.2.0.md)

## npm Runtime

Normal Codex users should prefer the plugin marketplace. The npm package is for custom MCP configuration, Hermes integration, and direct CLI use:

```bash
npm install -g @disaster-terminator/retinue@0.2.0
retinue-mcp
```

npm installs only the runtime. It does not install the Codex plugin skill. For Hermes setup, see [Hermes integration](docs/how-to/integrate-hermes.md).
