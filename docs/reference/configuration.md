# Configuration Reference

Retinue configuration is deployment state. Product tool calls should not carry backend, provider, profile, model, server, `access_mode`, or `bash_policy` decisions.

## Precedence

From highest to lowest:

1. Per-call fields that are intentionally part of the product API, such as `agent` for one OpenCode child.
2. Environment variables supplied by Codex `[env]`, Hermes `mcp_servers.*.env`, or another MCP host.
3. `RETINUE_CONFIG_FILE`, when set.
4. Packaged fallback `plugins/retinue/retinue.config.json`.

The packaged `retinue.config.json` is not persistent user state. Plugin refresh, reinstall, or development cache sync can restore it. Use environment variables for durable workstation or host policy.

## Core Variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `RETINUE_BACKEND` | `opencode` in plugin deployments | Selects `opencode`, `claude-code`, or `kilo`. |
| `RETINUE_STATE_DIR` | `$XDG_STATE_HOME/retinue`, `$HOME/.local/state/retinue`, or `%LOCALAPPDATA%\retinue` | Shared state, job artifacts, logs, and global budget locks. |
| `RETINUE_MAX_CONCURRENT_AGENTS` | packaged fallback `3` | Active child limit for one MCP server session. |
| `RETINUE_GLOBAL_AGENT_BUDGET` | `max(5, RETINUE_MAX_CONCURRENT_AGENTS)` | Active child limit across Retinue sessions sharing the same state directory. |
| `RETINUE_OVERFLOW_STRATEGY` | `queue` | `queue` returns queued job handles; `evict` preserves the old same-session oldest-running eviction behavior. |
| `RETINUE_MAX_QUEUED_AGENTS` | `20` | Maximum queued jobs before `resource_exhausted` with `reason: "queue_full"`. |
| `RETINUE_MCP_WAIT_MAX_MS` | `180000` | Maximum duration of one MCP wait call. Repeat wait for longer jobs. |
| `RETINUE_HTTP_TIMEOUT_MS` | `30000` | Local HTTP timeout for daemon and backend calls. Set `0` only when another layer enforces timeouts. |

## OpenCode Variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `RETINUE_OPENCODE_AUTO_SERVE` | `1` in plugin deployments | Start and manage a local OpenCode server. |
| `RETINUE_OPENCODE_HOST` | `127.0.0.1` | Host for managed OpenCode server. Non-loopback requires `RETINUE_OPENCODE_ALLOW_NON_LOOPBACK=1`. |
| `RETINUE_OPENCODE_PORT` | `4096` | Preferred managed port. Explicit values do not fall back silently. |
| `RETINUE_OPENCODE_FALLBACK_PORTS` | `4097` through `4127` | Fallback ports when the preferred port is occupied by an external service. |
| `RETINUE_OPENCODE_BASE_URL` | unset | Attach to an external loopback OpenCode server. With auto-serve enabled, this is tried first. |
| `RETINUE_OPENCODE_COMMAND` | `opencode` plus common install paths | OpenCode executable. |
| `RETINUE_OPENCODE_MODEL` | unset | Optional OpenCode `provider/model` override. If unset, Retinue does not send a model and OpenCode uses its profile default. |
| `RETINUE_OPENCODE_AGENT` | packaged fallback `explore` | Default OpenCode child agent. A single spawn may override it with `agent`. |
| `RETINUE_OPENCODE_ROOT_BINDING_MODE` | `shared_root` | Controls OpenCode root/session binding. Use `per_spawn` only for legacy compatibility, isolation probes, or debugging. Record `externalRunnerMode` when comparing behavior. |
| `RETINUE_OPENCODE_SERVER_IDLE_MS` | `30000` | Idle shutdown grace for managed OpenCode server. |
| `RETINUE_OPENCODE_SOFT_STALL_RESCUE_AGENT` | `build` | Agent used for same-session final-answer rescue. Use `none`, `0`, or `false` to keep the original agent. |
| `RETINUE_OPENCODE_TASK_ATTEMPT_MAX` | implementation default | Maximum fresh task attempts after malformed read or failed finalization rescue. Set `0` to disable. |

OpenCode owns profile, provider, endpoint, login, model defaults, plugins, skills, tools, and permissions.

## Claude Code Variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `RETINUE_CLAUDE_RUNTIME` | SDK path unless legacy CLI override is configured | Set `sdk` or `cli` to force the Claude backend runtime. |
| `RETINUE_CLAUDE_USE_SDK` | unset | Compatibility toggle: `1` forces SDK, `0` forces legacy CLI. Prefer `RETINUE_CLAUDE_RUNTIME` for new deployments. |
| `RETINUE_CLAUDE_MODEL` | unset | Optional explicit model for the Claude Agent SDK path. If unset, Claude Code owns model/profile routing. |
| `RETINUE_CLAUDE_COMMAND` | `claude` for legacy CLI | Legacy CLI executable or test fixture command. Presence of this variable selects the CLI path unless SDK is forced. |
| `RETINUE_CLAUDE_PREFIX_ARGS` | unset | Extra arguments inserted before the Claude CLI command shape; mainly for wrapper/test commands. |
| `RETINUE_DEFAULT_RUNTIME_TIMEOUT_MS` | implementation default | Timeout passed to the legacy Claude CLI runner. |
| `RETINUE_MAX_CONCURRENT_JOBS` | implementation default | Legacy core concurrency limit used by the old Claude runner path. |

Claude Code owns account state, provider routing, profile defaults, proxy behavior, quota, and SDK/CLI permission semantics.

## Diagnostic Tool Exposure

These switches are for Retinue development and backend debugging, not normal product delegation:

| Variable | Default | Purpose |
| --- | --- | --- |
| `RETINUE_EXPOSE_DIAGNOSTIC_TOOLS` | unset | Exposes `retinue_audit_logs` for dogfood/debugging. |
| `RETINUE_EXPOSE_BACKEND_TOOLS` | unset | Exposes raw `opencode_*` / `claude_*` adapter tools. |

## Daemon Variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `RETINUE_DAEMON_DISCOVERY` | unset | Enables local daemon discovery file behavior. |
| `RETINUE_DAEMON_URL` | unset | Connect MCP tools to an existing Retinue daemon. |
| `RETINUE_DAEMON_TOKEN` | unset | Auth token for daemon mutation/control routes. |
| `RETINUE_DAEMON_ALLOW_NON_LOOPBACK` | unset | Allows non-loopback daemon bind only for isolated environments. |

## Kilo Variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `RETINUE_KILO_BASE_URL` | unset | Attach to a Kilo-compatible local server. |
| `RETINUE_KILO_AUTO_SERVE` | unset | Start and manage a local Kilo server. |
| `RETINUE_KILO_HOST` | `127.0.0.1` when auto-serving | Host for managed Kilo server. Non-loopback requires `RETINUE_KILO_ALLOW_NON_LOOPBACK=1`. |
| `RETINUE_KILO_PORT` | backend default | Preferred managed Kilo port. |
| `RETINUE_KILO_FALLBACK_PORTS` | backend default | Fallback ports for managed Kilo auto-serve. |
| `RETINUE_KILO_COMMAND` | `kilo` | Kilo executable. |
| `RETINUE_KILO_PREFIX_ARGS` | unset | Wrapper arguments for transient probes; production should prefer an installed `kilo` binary. |
| `RETINUE_KILO_MODEL` | unset | Optional `provider/model` override, for example `litellm/intentmux`. If unset, Kilo owns model routing. |
| `RETINUE_KILO_AGENT` | `explore` in MCP backend resolution | Select Kilo agent when supported. |
| `RETINUE_KILO_ALLOW_NON_LOOPBACK` | unset | Allows non-loopback Kilo server bind only for isolated environments. |
