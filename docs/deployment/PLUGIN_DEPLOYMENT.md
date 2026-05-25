# Retinue Codex Plugin Deployment

Retinue ships as a Codex plugin. The plugin contains:

- `.codex-plugin/plugin.json` for discovery and product metadata
- `.mcp.json` for MCP tool exposure
- `skills/retinue/SKILL.md` for agent-facing operating guidance
- the built Retinue runtime under `dist/`

The plugin identity is `retinue`. User-facing docs should call the product Retinue.

## User Install Path

The primary v0.2.0 install path is the Codex plugin marketplace:

```bash
codex plugin marketplace add Disaster-Terminator/Retinue
```

Then open Codex, run `/plugins`, press the keyboard Right Arrow key until `[Retinue Local]` is selected, press Enter to open the `Retinue` details page, then choose `Install plugin`.

Codex CLI 0.128 exposes marketplace add/upgrade/remove, not a separate `codex plugin install` command. `codex plugin marketplace upgrade retinue-local` updates a marketplace that has already been added; it is not an install command and can fail if another installed local plugin has a broken cache or restrictive file permissions.

The default OpenCode prerequisite is the official OpenCode install script:

```bash
curl -fsSL https://opencode.ai/install | bash
```

Retinue auto-serve looks for the installed `opencode` command through the inherited `PATH` and common default locations. On Windows, `%USERPROFILE%\.opencode\bin\opencode` is treated as the primary fallback, followed by package-manager shims.

Managed OpenCode auto-serve binds to loopback only by default. Keep `RETINUE_OPENCODE_HOST=127.0.0.1` for normal plugin deployments. Non-loopback hosts such as `0.0.0.0` are rejected unless `RETINUE_OPENCODE_ALLOW_NON_LOOPBACK=1` is set for an explicitly isolated environment, because Retinue does not add authentication to the OpenCode server it starts.

## Local Diagnostics

Retinue writes local diagnostic events to:

```text
<stateDir>/logs/retinue.jsonl
```

The default state directory is `%LOCALAPPDATA%\retinue` on Windows, `$XDG_STATE_HOME/retinue` when set, or `$HOME/.local/state/retinue` on Unix-like systems. Set `RETINUE_STATE_DIR` for E2E runs when you want artifacts in a known directory.

The trace records OpenCode auto-serve events such as command resolution, port fallback, server readiness, and startup failures. It also records OpenCode job diagnostics when a wait times out while the child agent is still running: session state, abort flag, baseline and current message counts, completed assistant counts, last message role, message info keys, part types, and text byte counts. It does not write full prompt or model output text to the global trace.

Job-level artifacts remain under `<stateDir>/jobs/<jobId>/`. When an OpenCode wait times out, Retinue also appends the same diagnostic snapshot to that job's `stderr.log` so E2E failures can be inspected from the job directory alone.

`retinue_spawn_agent` returns after Retinue creates the OpenCode session and persists job metadata. If OpenCode `prompt_async` is slow to return, Retinue keeps submitting the prompt in the background instead of blocking the MCP spawn response. A later prompt-submission failure moves the job to `failed` and records `opencode_job_prompt_failed` diagnostics.

The plugin MCP config starts the runtime shipped inside the plugin directory:

```json
{
  "mcpServers": {
    "retinue": {
      "command": "node",
      "args": ["./mcp-bootstrap.mjs"],
      "cwd": ".",
      "startup_timeout_sec": 30,
      "env": {
        "RETINUE_BACKEND": "opencode",
        "RETINUE_OPENCODE_AUTO_SERVE": "1",
        "RETINUE_OPENCODE_HOST": "127.0.0.1"
      }
    }
  }
}
```

This is intentional for plugin releases: marketplace installs copy the plugin directory into Codex's plugin cache, so the MCP runtime must be self-contained under that directory.
The `mcpServers` wrapper is required for Codex plugin MCP discovery. The explicit `cwd: "."` is required so Codex starts `node ./mcp-bootstrap.mjs` from the installed plugin cache instead of from the current conversation working directory. The bootstrap resolves the real bundled `dist/mcp.js` from its own plugin directory, then moves the process cwd to Retinue state before starting stdio so Windows cache refresh and uninstall paths are less likely to be blocked by an MCP process holding the plugin cache directory as its cwd.

The default plugin path manages the local OpenCode server lifecycle. It prefers `127.0.0.1:4096` and tries fallback ports `4097` through `4127` when earlier ports are occupied by external services. Set `RETINUE_OPENCODE_BASE_URL` only for deployments that intentionally attach to an externally managed OpenCode server.

Retinue HTTP calls to the local daemon or OpenCode server have a 30-second timeout by default. Set `RETINUE_HTTP_TIMEOUT_MS` to tune this for unusual local runtimes, or `0` to disable the client-side timeout.

The Codex plugin ships `retinue.config.json` beside the bootstrap as a package default:

```json
{
  "maxConcurrentAgents": 3,
  "opencode": {
    "agent": "explore"
  }
}
```

OpenCode profile configuration stays in OpenCode. The cached `retinue.config.json` is not persistent user state: plugin updates, reinstalls, and development cache syncs may restore the packaged copy. Persistent Retinue overrides should use environment variables. In Codex plugin deployments, `mcp-bootstrap.mjs` reads `RETINUE_*` values from `$CODEX_HOME/config.toml` under `[env]` before starting the MCP runtime, so workstation-level overrides survive plugin cache refreshes that restore the packaged `retinue.config.json` defaults.

## npm Runtime Path

The npm package is `@disaster-terminator/retinue`. It exposes:

```text
retinue
retinue-mcp
retinued
```

Use this path for custom MCP configuration:

```bash
npm install -g @disaster-terminator/retinue@0.2.0
codex mcp add retinue \
  --env RETINUE_BACKEND=opencode \
  --env RETINUE_OPENCODE_BASE_URL=http://127.0.0.1:4096 \
  --env RETINUE_OPENCODE_AGENT=explore \
  -- retinue-mcp
```

The npm path installs runtime only. It does not install the Retinue skill; the plugin marketplace remains the preferred user path.

`retinued` binds to loopback addresses only by default because the daemon API is unauthenticated local control-plane traffic. Use `--host 127.0.0.1` or `--host localhost` for normal deployments. `RETINUE_DAEMON_ALLOW_NON_LOOPBACK=1` exists only for explicitly isolated environments that intentionally expose the daemon host.

## Hermes Agent Runtime Path

Hermes Agent uses `~/.hermes/config.yaml` under the `mcp_servers` key, not Codex's `mcpServers` plugin wrapper. For Hermes, install the npm runtime and configure:

```yaml
mcp_servers:
  retinue:
    command: "retinue-mcp"
    env:
      RETINUE_BACKEND: "opencode"
      RETINUE_OPENCODE_AUTO_SERVE: "1"
      RETINUE_OPENCODE_HOST: "127.0.0.1"
    timeout: 180
    connect_timeout: 30
```

See [Hermes Agent Integration](../integrations/HERMES.md) for the full Hermes master-agent setup and probe commands.

## Build Gate

Before tagging a release, build and verify:

```bash
pnpm install
pnpm run gate:release
```

`verify:package` checks that package contents include the plugin manifest, MCP config, skill, required docs, npm runtime files, and plugin-local runtime files.

## OpenCode Production E2E

Before calling the plugin production-ready, run the real OpenCode lifecycle through the product `retinue_*` MCP tools:

1. Confirm the installed plugin cache starts the bundled MCP server.
2. Set `RETINUE_BACKEND=opencode`.
3. Use `retinue_spawn_agent` with a deterministic prompt.
4. Use `retinue_wait_agent` and verify the terminal result.
5. Use `retinue_close_agent`.
6. Confirm tool arguments did not include backend, profile, model, OpenCode server, `access_mode`, or `bash_policy` selection. `agent` may be present only when the probe intentionally exercises a specific OpenCode child agent.
7. Run the fake Claude parity path with `RETINUE_BACKEND=claude-code`.
8. When Claude Code is locally usable, run the best-effort real Retinue Claude probe.

The Claude real probe is allowed to fail on upstream model, quota, proxy, or Claude Code runtime instability. Treat a failure there as a local backend readiness signal, not as permission to skip fake Claude parity or the OpenCode production E2E.

Backend-specific `opencode_*` and `claude_*` MCP tools are hidden by default in plugin deployments. Developers can opt into them with `RETINUE_EXPOSE_BACKEND_TOOLS=1` for adapter debugging and older runbooks, but they are raw backend surfaces rather than the primary Codex delegation contract. Product use should stay on `retinue_spawn_agent`, `retinue_wait_agent`, `retinue_close_agent`, `retinue_list_agents`, `retinue_list_permissions`, and `retinue_reply_permission`.

Record only redacted backend/profile metadata, job id, session id, and observed result. Do not record API keys or provider secrets.

## User Acceptance Boundary

The final WSL Codex plugin smoke should be run by the user in their own WSL Codex environment. It may modify the user's Codex plugin state, so it is not an agent-side automated test.
