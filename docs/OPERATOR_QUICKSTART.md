# Operator Quickstart

Use this after CI hardening when operating supervisor as a local CLI + MCP adapter.

## 1) Build + deterministic verification

```bash
npm install
npm run build
npm run typecheck
npm test
```

These are the deterministic checks used for normal validation. Real Claude runs are excluded.

## 2) Direct CLI smoke path (no real Claude quota)

Use the fake-Claude fixture to verify local lifecycle commands without calling real Claude:

```bash
SUPERVISOR_CLAUDE_COMMAND=node \
SUPERVISOR_CLAUDE_PREFIX_ARGS=tests/fixtures/fake-claude.mjs \
node dist/cli.js run --cwd . --prompt "hello"

node dist/cli.js wait <jobId> --timeout-ms 30000
node dist/cli.js result <jobId>
```

## 3) Manual daemon start + health check

Daemon lifecycle is manual and loopback-oriented:

```bash
node dist/daemon.js --host 127.0.0.1 --port 27777
```

In another shell, inspect daemon health:

```bash
node dist/cli.js daemon-health --daemon-url http://127.0.0.1:27777
```

Optional direct HTTP check:

```bash
curl http://127.0.0.1:27777/health
```

## 4) MCP configuration pointer

Use the MCP setup patterns in:

- `docs/CLAUDE_CODE_MCP.md`

That document covers direct mode, explicit daemon URL mode, and explicit discovery mode.

## 5) Real Claude probes (manual-only, quota-risk)

Run only when intentionally validating real Claude integration:

```bash
npm run probe:real:direct
npm run probe:real:daemon
npm run probe:real:mcp-daemon
```

These probes are manual-only and are not part of deterministic CI checks.
