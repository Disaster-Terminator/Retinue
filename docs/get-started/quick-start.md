# Quick Start

This tutorial verifies the normal Retinue product path: Codex starts a local OpenCode child agent, waits for a textual result, and closes the job.

## 1. Install Prerequisites

Use Node.js 20 or newer and Codex CLI 0.128 or newer.

Install OpenCode with the official script:

```bash
curl -fsSL https://opencode.ai/install | bash
```

Retinue first uses `RETINUE_OPENCODE_COMMAND` when it is set, then `PATH`, then common OpenCode install locations such as `$HOME/.opencode/bin/opencode`.

## 2. Install The Codex Plugin

Add the plugin marketplace:

```bash
codex plugin marketplace add Disaster-Terminator/Retinue
```

In Codex, run `/plugins`, select `[Retinue Local]`, open `Retinue`, and choose `Install plugin`. Restart Codex so the MCP server and skill load from the installed plugin cache.

## 3. Run A Real Child Task

Ask Codex:

```text
Use Retinue to spawn an OpenCode explore subagent in this repository.
Ask it to inspect README.md and docs/README.md, summarize whether the docs entry points are clear, wait for the result, then close the child agent.
```

The expected flow is:

1. `retinue_spawn_agent` returns a `jobId`.
2. `retinue_wait_agent` returns a terminal result or an action-required permission event.
3. `retinue_close_agent` closes the child after the result is no longer needed.

Treat `stalled` as non-evidence. It means Retinue classified a backend/model/tool-call failure and preserved diagnostics for inspection.

## 4. Next Steps

- Product tool contract: [MCP tools](../reference/mcp-tools.md)
- Configuration: [Configuration reference](../reference/configuration.md)
- Runtime issues: [Diagnostics reference](../reference/diagnostics.md)
- Full install and npm runtime paths: [Install plugin](../how-to/install-plugin.md)
