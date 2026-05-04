# Operator Quickstart

This quickstart is for local operators running supervisor after CI hardening.

## 1) Build and deterministic verification

Run the deterministic CI contract in order:

```bash
npm ci
npm run typecheck
npm test
npm run build
npm pack --dry-run --json
```

## 2) Direct CLI smoke test (fake/dry-run)

Use the fake Claude fixture to validate run/wait/result without spending quota:

```bash
SUPERVISOR_CLAUDE_COMMAND=node \
SUPERVISOR_CLAUDE_PREFIX_ARGS=tests/fixtures/fake-claude.mjs \
node dist/cli.js run --cwd . --prompt "hello"

node dist/cli.js wait <jobId> --timeout-ms 30000
node dist/cli.js result <jobId>
```

## 3) Manual daemon start and health

Daemon lifecycle is manual/explicit and loopback-oriented:

```bash
node dist/daemon.js --host 127.0.0.1 --port 27777
```

In another shell, inspect health:

```bash
node dist/cli.js daemon-health --daemon-url http://127.0.0.1:27777
```

## 4) MCP configuration pointer

Use the MCP configuration examples in `docs/CLAUDE_CODE_MCP.md` (direct mode, explicit daemon URL mode, and explicit daemon discovery mode).

## 5) Real Claude probes (manual-only, quota-risk)

Real Claude checks are opt-in manual probes and are not deterministic CI gates:

```bash
npm run probe:real:direct
npm run probe:real:daemon
npm run probe:real:mcp-daemon
```

Only run these when you intentionally want boundary validation with real quota usage.
