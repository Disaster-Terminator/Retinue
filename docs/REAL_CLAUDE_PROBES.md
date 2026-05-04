# Real Claude Code Probes

These probes are manual and opt-in. They may consume Claude Code quota because they call the system `claude` command through supervisor. The default deterministic suite still uses fake Claude only.

Run the deterministic gates first:

```bash
npm run typecheck
npm test
npm run build
```

## GitHub Manual Workflow (Quota-Risk)

GitHub Actions real probes are **manual only** and never run on `push` or `pull_request`. Use `.github/workflows/manual-real-probes.yml` from the Actions UI, choose `probe_mode` (`direct`, `daemon`, or `mcp-daemon`), and set `confirm_real_claude` to exactly:

`I_UNDERSTAND_THIS_MAY_USE_REAL_CLAUDE_QUOTA`

If the confirmation string is missing or incorrect, the job fails before probe execution. The workflow then runs:

- `npm ci`
- `npm run build`
- `npm run probe:real:<probe_mode>`

## Fake Dry Run

Use this before a real probe to verify the probe runner, daemon path, and MCP-to-daemon path without calling real Claude Code.

PowerShell:

```powershell
$env:SUPERVISOR_CLAUDE_COMMAND = "node"
$env:SUPERVISOR_CLAUDE_PREFIX_ARGS = "tests/fixtures/fake-claude.mjs"
npm run probe:real:direct -- --expect "fake result: Reply exactly: SUPERVISOR_REAL_OK"
npm run probe:real:daemon -- --expect "fake result: Reply exactly: SUPERVISOR_REAL_OK"
npm run probe:real:mcp-daemon -- --expect "fake result: Reply exactly: SUPERVISOR_REAL_OK"
Remove-Item Env:\SUPERVISOR_CLAUDE_COMMAND
Remove-Item Env:\SUPERVISOR_CLAUDE_PREFIX_ARGS
```

Bash:

```bash
SUPERVISOR_CLAUDE_COMMAND=node SUPERVISOR_CLAUDE_PREFIX_ARGS=tests/fixtures/fake-claude.mjs npm run probe:real:direct -- --expect "fake result: Reply exactly: SUPERVISOR_REAL_OK"
SUPERVISOR_CLAUDE_COMMAND=node SUPERVISOR_CLAUDE_PREFIX_ARGS=tests/fixtures/fake-claude.mjs npm run probe:real:daemon -- --expect "fake result: Reply exactly: SUPERVISOR_REAL_OK"
SUPERVISOR_CLAUDE_COMMAND=node SUPERVISOR_CLAUDE_PREFIX_ARGS=tests/fixtures/fake-claude.mjs npm run probe:real:mcp-daemon -- --expect "fake result: Reply exactly: SUPERVISOR_REAL_OK"
```

Each command should print JSON with `ok: true`, a `jobId`, the validated `result`, and the probe `stateDir`.

## Windows Real CLI Probe

Build first, then verify that Windows resolves the intended Claude Code executable:

```powershell
npm run build
where.exe claude
npm run probe:real:direct
```

Expected result:

- the probe prints `ok: true`
- `mode` is `direct`
- `result` is `SUPERVISOR_REAL_OK`
- `stateDir` points at the local probe artifacts

## WSL Fresh Clone Gate

This is deterministic and does not require real Claude Code:

```bash
set -euo pipefail
d=$(mktemp -d /tmp/supervisor-wsl-test-XXXXXX)
git clone /mnt/g/repository/supervisor "$d" >/dev/null
cd "$d"
git checkout feature/spawn-claude-code >/dev/null
npm ci
npm run typecheck
npm test
npm run build
echo "WSL_TEST_DIR=$d"
```

If WSL has a separate Claude Code installation and quota path, run the real probes from inside that fresh clone after the deterministic gate.

## Daemon Mode Real Probe

This starts a temporary foreground daemon process from the probe runner, calls the CLI through `SUPERVISOR_DAEMON_URL`, validates the result, and stops the daemon process:

```bash
npm run probe:real:daemon
```

Expected result:

- `ok: true`
- `mode` is `daemon`
- `daemonUrl` is a loopback URL
- `result` is `SUPERVISOR_REAL_OK`

## MCP-To-Daemon Real Probe

This starts a temporary daemon, starts `dist/mcp.js` through MCP stdio, calls `claude_run`, `claude_wait`, and `claude_result`, then stops the child processes:

```bash
npm run probe:real:mcp-daemon
```

Expected result:

- `ok: true`
- `mode` is `mcp-daemon`
- `daemonUrl` is a loopback URL
- `result` is `SUPERVISOR_REAL_OK`

## Custom Probe Inputs

All modes support:

```bash
node scripts/probe-real-claude.mjs direct --cwd . --prompt "Reply exactly: SUPERVISOR_REAL_OK" --expect SUPERVISOR_REAL_OK --timeout-ms 90000
node scripts/probe-real-claude.mjs daemon --host 127.0.0.1 --port 0 --state-dir /tmp/supervisor-real-probe
node scripts/probe-real-claude.mjs mcp-daemon --timeout-ms 120000
```

Use `--state-dir` when you want probe artifacts in a known location. Without it, the script creates a temporary state directory and prints it.

## Boundary Statement

The probes verify supervisor's lifecycle boundary. Supervisor invokes only the system `claude` command. Provider routing, model choice, quota, proxy behavior, and cc-switch behavior remain owned by the local Claude Code configuration. The probe runner does not install a service, does not auto-start a persistent daemon, and does not add permission-bypass flags.
