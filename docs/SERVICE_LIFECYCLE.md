# Service Lifecycle

`supervisor-daemon` is currently manual and explicit. The project does not install a Windows service, scheduled task, systemd unit, or shell startup hook automatically.

## Start

Build first:

```bash
npm install
npm run build
```

Start the daemon in the foreground:

```bash
node dist/daemon.js --host 127.0.0.1 --port 27777
```

The daemon writes discovery metadata to:

```text
<stateDir>/daemon.json
```

## Inspect

Health:

```bash
curl http://127.0.0.1:27777/health
```

Discovery metadata contains:

```json
{
  "url": "http://127.0.0.1:27777",
  "pid": 12345,
  "startedAt": "2026-05-04T00:00:00.000Z",
  "version": "0.1.0"
}
```

## Use

CLI with explicit discovery:

```bash
node dist/cli.js --discover-daemon status <jobId>
```

MCP with explicit discovery:

```text
SUPERVISOR_DAEMON_DISCOVERY=1
```

Direct URL mode:

```text
SUPERVISOR_DAEMON_URL=http://127.0.0.1:27777
```

## Stop

Stop the daemon by terminating the PID in `daemon.json`.

On Windows PowerShell:

```powershell
Stop-Process -Id <pid>
```

On WSL/Linux:

```bash
kill <pid>
```

## Windows And WSL Notes

- Run separate installs for Windows and WSL; do not share one `node_modules` directory.
- Use the state directory for the environment where the daemon runs.
- WSL systemd support varies by distribution and settings.
- Service installation is intentionally not automated yet.

## Future Service Options

Windows service, Windows scheduled task, systemd user service, and shell startup scripts are future options. Any future installer must be explicit, inspectable, and reversible, with a matching uninstall path.
