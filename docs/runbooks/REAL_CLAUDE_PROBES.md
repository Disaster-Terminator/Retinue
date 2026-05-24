# Real Claude Code Probes

These probes are manual and opt-in. They may consume Claude Code quota because they call the system `claude` command through retinue. The default deterministic suite still uses fake Claude only.

Run the deterministic gates first:

```bash
pnpm run typecheck
pnpm test
pnpm run build
```

## Fake Dry Run

Use this before a real probe to verify the probe runner, daemon path, and MCP-to-daemon path without calling real Claude Code.

PowerShell:

```powershell
$env:RETINUE_CLAUDE_COMMAND = "node"
$env:RETINUE_CLAUDE_PREFIX_ARGS = "tests/fixtures/fake-claude.mjs"
pnpm run probe:real:direct -- --expect "fake result: Reply exactly: RETINUE_REAL_OK"
pnpm run probe:real:daemon -- --expect "fake result: Reply exactly: RETINUE_REAL_OK"
pnpm run probe:real:mcp-daemon -- --expect "fake result: Reply exactly: RETINUE_REAL_OK"
pnpm run probe:real:retinue-claude -- --expect "fake result: Reply exactly: RETINUE_REAL_OK"
Remove-Item Env:\RETINUE_CLAUDE_COMMAND
Remove-Item Env:\RETINUE_CLAUDE_PREFIX_ARGS
```

Bash:

```bash
RETINUE_CLAUDE_COMMAND=node RETINUE_CLAUDE_PREFIX_ARGS=tests/fixtures/fake-claude.mjs pnpm run probe:real:direct -- --expect "fake result: Reply exactly: RETINUE_REAL_OK"
RETINUE_CLAUDE_COMMAND=node RETINUE_CLAUDE_PREFIX_ARGS=tests/fixtures/fake-claude.mjs pnpm run probe:real:daemon -- --expect "fake result: Reply exactly: RETINUE_REAL_OK"
RETINUE_CLAUDE_COMMAND=node RETINUE_CLAUDE_PREFIX_ARGS=tests/fixtures/fake-claude.mjs pnpm run probe:real:mcp-daemon -- --expect "fake result: Reply exactly: RETINUE_REAL_OK"
RETINUE_CLAUDE_COMMAND=node RETINUE_CLAUDE_PREFIX_ARGS=tests/fixtures/fake-claude.mjs pnpm run probe:real:retinue-claude -- --expect "fake result: Reply exactly: RETINUE_REAL_OK"
```

Each command should print JSON with `ok: true`, a `jobId`, the validated `result`, and the probe `stateDir`.

## Windows Real CLI Probe

Build first, then verify that Windows resolves the intended Claude Code executable:

```powershell
pnpm run build
where.exe claude
pnpm run probe:real:direct
pnpm run probe:real:retinue-claude
```

Expected result:

- the probe prints `ok: true`
- `mode` is `direct`
- `result` is `RETINUE_REAL_OK`
- `stateDir` points at the local probe artifacts

For the Retinue product entrypoint, expected result:

- the probe prints `ok: true`
- `retinueBackend` is `claude-code`
- `backend` is `claude-code`
- `result` is `RETINUE_REAL_OK`

## WSL Fresh Clone Gate

This is deterministic and does not require real Claude Code:

```bash
set -euo pipefail
d=$(mktemp -d /tmp/retinue-wsl-test-XXXXXX)
git clone /mnt/g/repository/retinue "$d" >/dev/null
cd "$d"
git checkout feature/spawn-claude-code >/dev/null
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm test
pnpm run build
echo "WSL_TEST_DIR=$d"
```

If WSL has a separate Claude Code installation and quota path, run the real probes from inside that fresh clone after the deterministic gate.

## Daemon Mode Real Probe

This starts a temporary foreground daemon process from the probe runner, calls the CLI through `RETINUE_DAEMON_URL`, validates the result, and stops the daemon process:

```bash
pnpm run probe:real:daemon
```

Expected result:

- `ok: true`
- `mode` is `daemon`
- `daemonUrl` is a loopback URL
- `result` is `RETINUE_REAL_OK`

## MCP-To-Daemon Real Probe

This starts a temporary daemon, starts `dist/mcp.js` through MCP stdio, calls `claude_run`, `claude_wait`, and `claude_result`, then stops the child processes:

```bash
pnpm run probe:real:mcp-daemon
```

Expected result:

- `ok: true`
- `mode` is `mcp-daemon`
- `daemonUrl` is a loopback URL
- `result` is `RETINUE_REAL_OK`

## Retinue MCP Real Probe

This calls the product-facing MCP tools directly in memory: `retinue_spawn_agent`, `retinue_wait_agent`, and `retinue_close_agent`. The script sets `RETINUE_BACKEND=claude-code` for the probe process and leaves provider, model, proxy, permission, plugin, and profile behavior to the installed Claude Code runtime. When no legacy CLI override is configured, the MCP product path uses the Claude Agent SDK adapter. Set `RETINUE_CLAUDE_RUNTIME=cli`, `RETINUE_CLAUDE_USE_SDK=0`, `RETINUE_CLAUDE_COMMAND`, or `RETINUE_CLAUDE_PREFIX_ARGS` only when intentionally exercising the legacy CLI wrapper.

Retinue does not set a Claude SDK model by default and does not replace the SDK subprocess environment. If the local Claude Code default model is wrong, the real probe should fail with the model error from Claude Code; fix the Claude Code profile/runtime configuration rather than adding a Retinue default. `RETINUE_CLAUDE_MODEL` is reserved for explicit deployment override cases where the operator intentionally wants Retinue to pass a model argument to the SDK.

```bash
pnpm run probe:real:retinue-claude
```

Expected result:

- `ok: true`
- `backend` is `claude-code`
- `result` is `RETINUE_REAL_OK`
- `closeStatus` is `completed`

## Agent SDK Feasibility Probe

Use this lower-level probe when evaluating Claude Agent SDK behavior outside the Retinue MCP product path. It calls `@anthropic-ai/claude-agent-sdk` directly and leaves Claude Code provider, model, account, profile, and quota behavior to the local Claude Code runtime.

```bash
pnpm run probe:real:claude-sdk
pnpm run probe:real:claude-sdk -- --permission
```

Expected query result:

- `ok` is `true`
- `mode` is `query`
- `result` is `RETINUE_CLAUDE_SDK_OK`
- `sessionId` is present

Expected permission result:

- `ok` is `true`
- `mode` is `permission`
- `permissionRequests` contains at least one entry from `canUseTool`
- the permission entry includes the Claude SDK tool name, tool input, `toolUseID`, and any SDK-provided prompt fields such as `displayName`, `description`, `decisionReason`, or `blockedPath`

This probe is intentionally not a product MCP proof. It exists to validate the underlying Claude Agent SDK behavior separately from Retinue's `claude-code` backend adapter.

## Custom Probe Inputs

All modes support:

```bash
node scripts/probe-real-claude.mjs direct --cwd . --prompt "Reply exactly: RETINUE_REAL_OK" --expect RETINUE_REAL_OK --timeout-ms 90000
node scripts/probe-real-claude.mjs daemon --host 127.0.0.1 --port 0 --state-dir /tmp/retinue-real-probe
node scripts/probe-real-claude.mjs mcp-daemon --timeout-ms 120000
node scripts/probe-retinue-claude-mcp.mjs --timeout-ms 120000
node scripts/probe-claude-agent-sdk.mjs --cwd . --expect RETINUE_CLAUDE_SDK_OK
```

Use `--state-dir` when you want probe artifacts in a known location. Without it, the script creates a temporary state directory and prints it.

## Boundary Statement

The Retinue MCP product probe verifies the `claude-code` backend through the Claude Agent SDK adapter unless a legacy CLI override is configured. The direct CLI and daemon probes remain compatibility checks for the legacy wrapper. Provider routing, model choice, quota, proxy behavior, and cc-switch behavior remain owned by the local Claude Code configuration. Retinue should only pass a model when an explicit deployment override such as `RETINUE_CLAUDE_MODEL` is set. The probe runners do not install a service, do not auto-start a persistent daemon, and do not add permission-bypass flags.
