# MCP Daemon Adapter Next Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make MCP optionally use the local daemon while preserving direct in-process MCP fallback and stable tool names/response shapes.

**Architecture:** Introduce a shared supervisor API boundary implemented by both `ClaudeSupervisor` and `DaemonClient`. `supervisor-mcp` should construct `DaemonClient` when `SUPERVISOR_DAEMON_URL` is configured, otherwise keep constructing `ClaudeSupervisor`.

**Tech Stack:** TypeScript NodeNext, `@modelcontextprotocol/sdk`, Node built-in `http`, Vitest, existing fake-Claude fixture.

---

## P0 Baseline Map

Baseline commands run on 2026-05-04 in `G:\repository\supervisor\.worktrees\spawn-claude-code`:

```bash
npm run typecheck
npm test
npm run build
```

Observed result:

- `npm run typecheck`: pass.
- `npm test`: pass, 10 test files and 28 tests.
- `npm run build`: pass.

Current daemon coverage:

- `src/daemon/server.ts` exposes `GET /health` and JSON `POST /v1/jobs/*` routes for `run`, `status`, `wait`, `result`, `continue`, `peek`, `kill`, and `cleanup`.
- `tests/daemon.test.ts` covers health, HTTP `run` -> `wait` -> `result`, and unknown route errors.
- `tests/daemon-entrypoint.test.ts` covers `supervisor-daemon` package bin exposure.

Current MCP direct-core behavior:

- `src/mcp.ts` constructs `new ClaudeSupervisor(...)` in `createSupervisorFromEnv()`.
- `createMcpServer(supervisor = createSupervisorFromEnv())` accepts an injected supervisor for tests.
- `tests/mcp-tools.test.ts` verifies tool names and server construction only.
- There is no test that invokes MCP tools through an MCP client/transport.

CLI direct vs daemon behavior:

- `src/cli.ts` uses direct `ClaudeSupervisor` by default.
- `src/cli.ts` uses `DaemonClient` when `SUPERVISOR_DAEMON_URL` or `--daemon-url` is set.
- `tests/cli.test.ts` covers both direct fake-Claude CLI mode and daemon-delegated CLI mode.

State directory layout:

- `resolveStateDir()` prefers explicit `stateDir`, then `SUPERVISOR_STATE_DIR`, then `%LOCALAPPDATA%\supervisor` on Windows, then `$XDG_STATE_HOME/supervisor`, then `~/.local/state/supervisor`.
- Job files live under `<stateDir>/jobs/<jobId>/`.
- Per-job files are `meta.json`, `stdout.log`, `stderr.log`, `exit-status.json`, and `prompt.md`.

Job metadata schema:

- `JobMeta` stores `jobId`, `pid`, `status`, `cwd`, `promptPath`, `promptPreview`, `promptSha256`, optional naming/session fields, runtime timeout, Claude args, and timestamps.
- Terminal status is `completed`, `failed`, `killed`, or `timed_out`.
- Problem status is `not_found` or `corrupted`.
- `orphaned` represents stale running metadata where the process is no longer alive.

Test coverage gaps:

- MCP tools are not invoked end-to-end through MCP transport.
- MCP has no `SUPERVISOR_DAEMON_URL` path.
- Daemon errors are string-only; there are no structured error codes yet.
- Daemon request validation is minimal and route coverage is not exhaustive.
- Daemon health does not include state directory or pid.
- Discovery/readiness files are not implemented.

Known remaining daemon limitations:

- Manual daemon only; no auto-start.
- No daemon discovery file.
- No auth token.
- No service install for Windows service, scheduled task, or systemd user service.
- MCP still owns an in-process `ClaudeSupervisor` unless a test injects a fake instance.

## P1 Implementation Tasks: MCP Optional Daemon Mode

### Task 1: Define The Shared Supervisor API

**Files:**
- Modify: `src/core/types.ts`
- Modify: `src/cli.ts`
- Modify: `src/mcp.ts`
- Modify: `src/daemon/client.ts`

- [ ] **Step 1: Write the failing type-level usage change**

Edit `src/mcp.ts` locally so `createMcpServer()` can accept a supervisor value that is not specifically a `ClaudeSupervisor`. Run:

```bash
npm run typecheck
```

Expected: fail because there is no shared interface exported for `ClaudeSupervisor` and `DaemonClient`.

- [ ] **Step 2: Add the shared interface**

Add this interface to `src/core/types.ts`:

```ts
export interface SupervisorApi {
  run(options: RunOptions): Promise<JobMeta>;
  status(jobId: string): Promise<JobStatusResult>;
  wait(jobId: string, options?: WaitOptions): Promise<WaitResult>;
  result(jobId: string): Promise<JobResult>;
  continueJob(options: ContinueOptions): Promise<JobMeta>;
  peek(jobId: string, options?: PeekOptions): Promise<PeekResult>;
  kill(jobId: string): Promise<KillResult>;
  cleanup(options?: CleanupOptions): Promise<CleanupResult>;
}
```

Then update CLI and MCP local supervisor variables to use `SupervisorApi`.

- [ ] **Step 3: Verify**

Run:

```bash
npm run typecheck
npm test -- tests/cli.test.ts tests/mcp-tools.test.ts
```

Expected: pass.

- [ ] **Step 4: Commit**

```bash
git add src/core/types.ts src/cli.ts src/mcp.ts src/daemon/client.ts
git commit -m "refactor: define supervisor api boundary"
```

### Task 2: Add MCP Daemon URL Construction

**Files:**
- Modify: `src/mcp.ts`
- Modify: `tests/mcp-tools.test.ts`

- [ ] **Step 1: Write failing construction test**

Add a test in `tests/mcp-tools.test.ts` that imports a new `createMcpSupervisorFromEnv(env)` helper from `src/mcp.ts`, sets `SUPERVISOR_DAEMON_URL`, and asserts the returned object is a daemon client by checking it has daemon-client behavior without constructing `ClaudeSupervisor`.

Use this test shape:

```ts
it("creates a daemon-backed supervisor when SUPERVISOR_DAEMON_URL is set", () => {
  const supervisor = createMcpSupervisorFromEnv({
    SUPERVISOR_DAEMON_URL: "http://127.0.0.1:27777"
  });

  expect(supervisor.constructor.name).toBe("DaemonClient");
});
```

Run:

```bash
npm test -- tests/mcp-tools.test.ts
```

Expected: fail because `createMcpSupervisorFromEnv` is not exported and MCP ignores `SUPERVISOR_DAEMON_URL`.

- [ ] **Step 2: Implement helper**

In `src/mcp.ts`, export `createMcpSupervisorFromEnv(env = process.env): SupervisorApi`. It should return:

```ts
if (env.SUPERVISOR_DAEMON_URL) {
  return new DaemonClient(env.SUPERVISOR_DAEMON_URL);
}
return new ClaudeSupervisor({
  stateDir: env.SUPERVISOR_STATE_DIR,
  claudeCommand: env.SUPERVISOR_CLAUDE_COMMAND,
  claudePrefixArgs: parsePrefixArgs(env.SUPERVISOR_CLAUDE_PREFIX_ARGS),
  env,
  defaultRuntimeTimeoutMs: parseOptionalNumber(env.SUPERVISOR_DEFAULT_RUNTIME_TIMEOUT_MS),
  maxConcurrentJobs: parseOptionalNumber(env.SUPERVISOR_MAX_CONCURRENT_JOBS)
});
```

Make `createMcpServer(supervisor = createMcpSupervisorFromEnv())` use that helper.

- [ ] **Step 3: Verify**

Run:

```bash
npm run typecheck
npm test -- tests/mcp-tools.test.ts
```

Expected: pass.

- [ ] **Step 4: Commit**

```bash
git add src/mcp.ts tests/mcp-tools.test.ts
git commit -m "feat: let mcp use configured supervisor daemon"
```

### Task 3: Prove MCP Tool Calls Through Daemon RPC

**Files:**
- Modify: `tests/mcp-tools.test.ts`
- Modify: `src/mcp.ts` if the test exposes missing seams

- [ ] **Step 1: Identify SDK test harness**

Inspect `node_modules/@modelcontextprotocol/sdk` for an in-memory or stdio client/server test transport.

Run:

```bash
rg -n "InMemory|Client|Transport|callTool" node_modules/@modelcontextprotocol/sdk
```

Expected: find the supported client/transport path for invoking registered tools.

- [ ] **Step 2: Write failing daemon-backed MCP tool test**

Add a test that:

1. Starts `createDaemonServer(new ClaudeSupervisor({ stateDir, claudeCommand: process.execPath, claudePrefixArgs: [fixturePath] }))` on port `0`.
2. Creates an MCP server through the daemon-backed helper.
3. Calls `claude_run`, `claude_wait`, and `claude_result` through the MCP client/transport.
4. Asserts the result contains `fake result: mcp daemon`.

Run:

```bash
npm test -- tests/mcp-tools.test.ts
```

Expected: fail until MCP helper and test harness are correctly wired.

- [ ] **Step 3: Implement the smallest seam needed**

Keep tool names and JSON result shape unchanged. If the SDK test harness requires exported helpers, export only narrow helpers from `src/mcp.ts`.

- [ ] **Step 4: Verify**

Run:

```bash
npm test -- tests/mcp-tools.test.ts
npm test
```

Expected: pass, with existing direct MCP server construction still covered.

- [ ] **Step 5: Commit**

```bash
git add src/mcp.ts tests/mcp-tools.test.ts
git commit -m "test: cover mcp daemon tool flow"
```

### Task 4: Documentation And Baseline Verification

**Files:**
- Modify: `README.md`
- Modify: `docs/VERIFICATION.md`

- [ ] **Step 1: Document MCP daemon mode**

Add `SUPERVISOR_DAEMON_URL` to the MCP environment overrides in `README.md` and state that MCP uses daemon mode only when explicitly configured.

- [ ] **Step 2: Update verification notes**

Add a new section to `docs/VERIFICATION.md` recording that MCP daemon mode is deterministic-tested with fake Claude and that direct MCP fallback remains available.

- [ ] **Step 3: Run full Windows gate**

Run:

```bash
npm run typecheck
npm test
npm run build
```

Expected: all pass.

- [ ] **Step 4: Run WSL fresh clone gate**

Run from Windows:

```bash
rtk wsl.exe -e bash -lc 'set -euo pipefail; d=$(mktemp -d /tmp/supervisor-mcp-daemon-wsl-test-XXXXXX); git clone /mnt/g/repository/supervisor "$d" >/dev/null; cd "$d"; git checkout feature/spawn-claude-code >/dev/null; npm ci; npm run typecheck; npm test; npm run build; echo WSL_TEST_DIR="$d"'
```

Expected: all pass.

- [ ] **Step 5: Commit and push**

```bash
git add README.md docs/VERIFICATION.md
git commit -m "docs: record mcp daemon adapter verification"
git push origin feature/spawn-claude-code
```
