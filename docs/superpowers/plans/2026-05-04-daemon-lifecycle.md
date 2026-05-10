# Daemon Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the first daemon lifecycle milestone: a manually started local HTTP daemon and an opt-in CLI daemon adapter.

**Architecture:** `retinue-daemon` owns one `ClaudeRetinue` instance behind a loopback HTTP JSON API. `retinue-cli` keeps direct mode by default and delegates to daemon RPC only when a daemon URL is explicitly configured.

**Tech Stack:** Node.js built-in `http`, TypeScript NodeNext, Vitest, existing fake Claude fixture.

---

### Task 1: Daemon HTTP Contract

**Files:**
- Create: `tests/daemon.test.ts`
- Create: `src/daemon/server.ts`
- Modify: `src/core/types.ts`

- [ ] **Step 1: Write failing daemon lifecycle test**

Create `tests/daemon.test.ts` with a test that starts a daemon server on port `0`, calls `GET /health`, then calls `POST /v1/jobs/run`, `POST /v1/jobs/wait`, and `POST /v1/jobs/result` using fake Claude.

- [ ] **Step 2: Verify RED**

Run: `npm test -- tests/daemon.test.ts`

Expected: FAIL because `src/daemon/server.ts` does not exist.

- [ ] **Step 3: Implement minimal server**

Create `src/daemon/server.ts` exporting `createDaemonServer(retinue, options?)`. Route the listed endpoints to existing `ClaudeRetinue` methods. Return JSON and structured `{ "error": string }` responses.

- [ ] **Step 4: Verify GREEN**

Run: `npm test -- tests/daemon.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/daemon.test.ts src/daemon/server.ts src/core/types.ts
git commit -m "feat: add retinue daemon http contract"
```

### Task 2: Daemon Entrypoint

**Files:**
- Create: `src/daemon.ts`
- Modify: `package.json`
- Modify: `README.md`

- [ ] **Step 1: Write failing bin/build expectation**

Extend daemon tests or package checks so the package exposes `retinue-daemon` and TypeScript builds `src/daemon.ts`.

- [ ] **Step 2: Verify RED**

Run: `npm run build`

Expected: FAIL until `src/daemon.ts` exists or package bin points to a missing build output.

- [ ] **Step 3: Implement entrypoint**

Create `src/daemon.ts` that parses `--host` and `--port`, constructs `ClaudeRetinue` from the same environment variables as CLI/MCP, starts the daemon, and prints one JSON readiness line.

- [ ] **Step 4: Verify GREEN**

Run: `npm run build`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/daemon.ts package.json README.md
git commit -m "feat: add retinue daemon entrypoint"
```

### Task 3: CLI Daemon Adapter

**Files:**
- Create: `src/daemon/client.ts`
- Modify: `src/cli.ts`
- Modify: `tests/cli.test.ts`

- [ ] **Step 1: Write failing CLI daemon adapter test**

Add a CLI test that starts `createDaemonServer`, sets `RETINUE_DAEMON_URL`, runs CLI `run`, `wait`, and `result`, and verifies fake Claude output.

- [ ] **Step 2: Verify RED**

Run: `npm test -- tests/cli.test.ts`

Expected: FAIL because CLI ignores `RETINUE_DAEMON_URL`.

- [ ] **Step 3: Implement daemon client**

Create `src/daemon/client.ts` with methods matching the retinue interface used by CLI. Use `fetch`, JSON bodies, and throw on non-2xx responses.

- [ ] **Step 4: Wire CLI**

Update `src/cli.ts` so `--daemon-url` or `RETINUE_DAEMON_URL` creates a daemon client instead of a local `ClaudeRetinue`.

- [ ] **Step 5: Verify GREEN**

Run: `npm test -- tests/cli.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/daemon/client.ts src/cli.ts tests/cli.test.ts
git commit -m "feat: let cli use retinue daemon"
```

### Task 4: Final Verification

**Files:**
- Modify: `docs/VERIFICATION.md`

- [ ] **Step 1: Run Windows gates**

Run:

```bash
npm run typecheck
npm test
npm run build
```

Expected: all PASS.

- [ ] **Step 2: Run WSL gates**

Use a fresh clone or clean WSL install path and run:

```bash
npm ci
npm run typecheck
npm test
npm run build
```

Expected: all PASS.

- [ ] **Step 3: Update verification notes**

Record daemon baseline and any remaining daemon limitations in `docs/VERIFICATION.md`.

- [ ] **Step 4: Commit and push**

```bash
git add docs/VERIFICATION.md
git commit -m "docs: record daemon verification baseline"
git push origin feature/spawn-claude-code
```
