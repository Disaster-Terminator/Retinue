# Service Lifecycle Design

## Context

`goal.md` requires service lifecycle work only after MCP-to-daemon and discovery are stable. That condition is now met for the current explicit-discovery design: CLI and MCP can use daemon URL or explicit discovery, and direct fallback remains available.

The next decision is how users should start, stop, and inspect `retinue-daemon` on Windows and WSL without hidden auto-start or irreversible setup.

## Options Compared

### Manual Daemon

Run:

```bash
node dist/daemon.js --host 127.0.0.1 --port 27777
```

Pros:

- lowest risk
- transparent process
- easy to stop with Ctrl+C
- ideal for development and first real integration probes

Cons:

- user must keep a terminal open or manage a background process manually
- no automatic restart after reboot

### Windows Service

Pros:

- durable across terminal closure and reboot
- standard service control tooling

Cons:

- requires elevated installation
- easy to create hidden background behavior if automated too early
- uninstall/upgrade semantics need careful design

Verdict: not for the next implementation milestone. Document later, implement only with explicit reversible installer.

### Windows Scheduled Task

Pros:

- can run at login without a permanent service wrapper
- easier to inspect than a custom service for many users

Cons:

- still persistent background behavior
- quoting, working directory, Node path, and environment handling are fragile
- requires clear uninstall instructions

Verdict: viable later as an explicit helper, not automatic.

### systemd User Service

Pros:

- natural fit for Linux/WSL distributions with systemd enabled
- inspectable through `systemctl --user status`
- restart policy can be explicit

Cons:

- WSL systemd availability varies
- user services need clear unit file paths and environment setup

Verdict: good later for WSL/Linux docs and optional helper.

### Shell Startup Script

Pros:

- simple and transparent
- works in constrained environments

Cons:

- can duplicate processes without lock/discovery checks
- shell/profile startup side effects can surprise users

Verdict: only acceptable as a documented manual pattern, not an installer default.

## Recommended Next Milestone

Do not install services yet.

Add documentation and optional inspectable helper commands first:

- show manual foreground start
- show background start examples only as copyable commands
- document how to stop by PID from discovery metadata
- document how to inspect health and discovery metadata
- document Windows and WSL differences
- explicitly state that no command auto-installs a service

This keeps the product honest while preparing for a later reversible installer milestone.

## Service Safety Rules

- No hidden auto-start.
- No service/scheduled-task/systemd installation in tests.
- Any future installer must print the exact unit/task/service it creates.
- Any future installer must have a matching uninstall command.
- Existing discovery metadata must be checked before starting another daemon.
- Stale discovery metadata must be diagnosed, not silently overwritten by clients.

## Proposed User Runbook

### Build

```bash
npm install
npm run build
```

### Start Foreground

```bash
node dist/daemon.js --host 127.0.0.1 --port 27777
```

### Inspect Health

```bash
curl http://127.0.0.1:27777/health
```

### Inspect Discovery

Discovery file:

```text
<stateDir>/daemon.json
```

It includes:

- `url`
- `pid`
- `startedAt`
- `version`

### Use From CLI

```bash
node dist/cli.js --discover-daemon status <jobId>
```

### Use From MCP

Set:

```text
RETINUE_DAEMON_DISCOVERY=1
```

or:

```text
RETINUE_DAEMON_URL=http://127.0.0.1:27777
```

### Stop

Use the PID from `daemon.json` and stop that process with the platform's normal process tools. A future helper can wrap this, but the first documented form should stay transparent.

## Acceptance Criteria For This Design Milestone

- docs compare manual daemon, Windows service, scheduled task, systemd user service, and shell startup script
- docs explain start, stop, inspect on Windows and WSL
- docs state no service is installed automatically
- no code installs a background service
- deterministic gates still pass
