# Explicit Daemon Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add explicit local daemon discovery so CLI and MCP can connect to a running daemon without hard-coding the URL, while avoiding silent auto-start.

**Architecture:** The daemon writes a small readiness file under the supervisor state directory. CLI and MCP use that file only when explicitly requested by an env var or flag; stale or invalid discovery files produce clear errors.

**Tech Stack:** Node built-in `fs`, TypeScript NodeNext, Vitest, existing daemon and supervisor core.

---

## Scope

This milestone adds:

- `daemon.json` discovery file under `SUPERVISOR_STATE_DIR` or the resolved default state directory
- discovery metadata: `url`, `pid`, `startedAt`, `version`
- stale PID detection
- explicit CLI discovery via `--discover-daemon` or `SUPERVISOR_DAEMON_DISCOVERY=1`
- explicit MCP discovery via `SUPERVISOR_DAEMON_DISCOVERY=1`

This milestone does not add:

- daemon auto-start
- service installation
- auth token
- cross-machine discovery
- background process management

## Task 1: Discovery File Helpers

**Files:**
- Create: `src/daemon/discovery.ts`
- Create: `tests/daemon-discovery.test.ts`
- Modify: `src/core/paths.ts`

- [ ] **Step 1: Write failing helper tests**

Tests should cover:

```ts
const filePath = getDaemonDiscoveryPath(tempDir);
expect(filePath).toBe(path.join(tempDir, "daemon.json"));
```

```ts
await writeDaemonDiscovery(tempDir, {
  url: "http://127.0.0.1:27777",
  pid: process.pid,
  startedAt: "2026-05-04T00:00:00.000Z",
  version: "0.1.0"
});
await expect(readDaemonDiscovery(tempDir)).resolves.toMatchObject({
  url: "http://127.0.0.1:27777",
  pid: process.pid,
  version: "0.1.0"
});
```

```ts
await writeDaemonDiscovery(tempDir, {
  url: "http://127.0.0.1:27777",
  pid: -1,
  startedAt: "2026-05-04T00:00:00.000Z",
  version: "0.1.0"
});
await expect(readDaemonDiscovery(tempDir)).rejects.toThrow(/stale/i);
```

Run:

```bash
npm test -- tests/daemon-discovery.test.ts
```

Expected: fail because discovery helpers do not exist.

- [ ] **Step 2: Implement helpers**

Create:

```ts
export interface DaemonDiscovery {
  url: string;
  pid: number;
  startedAt: string;
  version: string;
}
```

Implement `writeDaemonDiscovery(stateDir, value)` with atomic JSON write, and `readDaemonDiscovery(stateDir)` with JSON validation and `process.kill(pid, 0)` stale detection.

- [ ] **Step 3: Verify and commit**

Run:

```bash
npm run typecheck
npm test -- tests/daemon-discovery.test.ts
```

Commit:

```bash
git add src/daemon/discovery.ts src/core/paths.ts tests/daemon-discovery.test.ts
git commit -m "feat: add daemon discovery file helpers"
```

## Task 2: Daemon Writes Discovery File

**Files:**
- Modify: `src/daemon.ts`
- Modify: `tests/daemon-entrypoint.test.ts`

- [ ] **Step 1: Write failing entrypoint helper test**

Export a narrow `buildDaemonReadyPayload()` helper from `src/daemon.ts` and test that it includes `url`, `pid`, `startedAt`, and `version`.

- [ ] **Step 2: Implement daemon write**

After the server binds, `src/daemon.ts` should write discovery metadata to the resolved state directory, then print the same JSON readiness line.

- [ ] **Step 3: Verify and commit**

Run:

```bash
npm run typecheck
npm test -- tests/daemon-entrypoint.test.ts tests/daemon-discovery.test.ts
```

Commit:

```bash
git add src/daemon.ts tests/daemon-entrypoint.test.ts
git commit -m "feat: write daemon discovery metadata"
```

## Task 3: CLI Explicit Discovery

**Files:**
- Modify: `src/cli.ts`
- Modify: `tests/cli.test.ts`

- [ ] **Step 1: Write failing CLI discovery test**

Start a daemon in test, write discovery metadata, then run CLI with `--discover-daemon` and missing local Claude command. Expected: CLI delegates through daemon and returns fake Claude result.

- [ ] **Step 2: Implement CLI discovery**

`src/cli.ts` should resolve daemon URL in this order:

1. `--daemon-url`
2. `SUPERVISOR_DAEMON_URL`
3. discovery file only when `--discover-daemon` or `SUPERVISOR_DAEMON_DISCOVERY=1` is set
4. direct local supervisor fallback

- [ ] **Step 3: Verify and commit**

Run:

```bash
npm run typecheck
npm test -- tests/cli.test.ts tests/daemon-discovery.test.ts
```

Commit:

```bash
git add src/cli.ts tests/cli.test.ts
git commit -m "feat: let cli discover daemon explicitly"
```

## Task 4: MCP Explicit Discovery

**Files:**
- Modify: `src/mcp.ts`
- Modify: `tests/mcp-tools.test.ts`

- [ ] **Step 1: Write failing MCP discovery construction test**

Write discovery metadata in a temp state dir, call `createMcpSupervisorFromEnv({ SUPERVISOR_STATE_DIR: tempDir, SUPERVISOR_DAEMON_DISCOVERY: "1" })`, and expect `DaemonClient`.

- [ ] **Step 2: Implement MCP discovery**

`src/mcp.ts` should use `SUPERVISOR_DAEMON_URL` first, discovery only when `SUPERVISOR_DAEMON_DISCOVERY=1`, then direct fallback.

- [ ] **Step 3: Verify and commit**

Run:

```bash
npm run typecheck
npm test -- tests/mcp-tools.test.ts tests/daemon-discovery.test.ts
```

Commit:

```bash
git add src/mcp.ts tests/mcp-tools.test.ts
git commit -m "feat: let mcp discover daemon explicitly"
```

## Task 5: Documentation And Gates

**Files:**
- Modify: `README.md`
- Modify: `docs/VERIFICATION.md`

- [ ] **Step 1: Document discovery mode**

Explain `SUPERVISOR_DAEMON_DISCOVERY=1`, `--discover-daemon`, discovery file path, and stale file behavior.

- [ ] **Step 2: Run Windows gate**

```bash
npm run typecheck
npm test
npm run build
```

- [ ] **Step 3: Run WSL fresh clone gate**

```bash
rtk wsl.exe -e bash -lc 'set -euo pipefail; d=$(mktemp -d /tmp/supervisor-daemon-discovery-wsl-test-XXXXXX); git clone /mnt/g/repository/supervisor "$d" >/dev/null; cd "$d"; git checkout feature/spawn-claude-code >/dev/null; npm ci; npm run typecheck; npm test; npm run build; echo WSL_TEST_DIR="$d"'
```

- [ ] **Step 4: Commit and push**

```bash
git add README.md docs/VERIFICATION.md
git commit -m "docs: record daemon discovery verification"
git push origin feature/spawn-claude-code
```
