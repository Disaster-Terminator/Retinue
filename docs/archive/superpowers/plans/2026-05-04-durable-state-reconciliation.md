# Durable State Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make job state more explicit under crash-like conditions without broad locking or service lifecycle work.

**Architecture:** Keep the existing disk layout and `ClaudeRetinue` core. Add a metadata schema version, distinguish ambiguous running metadata where the daemon lost ownership but the PID is alive, and clean stale atomic-write temp files conservatively.

**Tech Stack:** TypeScript NodeNext, Node `fs`, Vitest, existing fake-Claude fixture.

---

## Scope

This P4 slice implements:

- `schemaVersion` in newly written `meta.json`
- backward-compatible reading of old metadata without schemaVersion
- an explicit `abandoned` status for running metadata with a live PID that is not owned by the current retinue process
- cleanup of stale `*.tmp` files produced by atomic JSON writes

This P4 slice does not implement:

- job directory locks or leases
- daemon process registry
- cross-daemon coordination
- service lifecycle
- destructive cleanup of ambiguous running jobs

## Task 1: Metadata Schema Version

**Files:**
- Modify: `src/core/types.ts`
- Modify: `src/core/retinue.ts`
- Modify: `tests/core/retinue.test.ts`
- Modify: `tests/core/result-reconcile.test.ts`

- [ ] **Step 1: Write failing tests**

Add assertions that new job metadata contains `schemaVersion: 1` in both the returned `JobMeta` and persisted `meta.json`.

Add an old-fixture status test where `meta.json` has no `schemaVersion`; expected behavior remains non-corrupted and status can still be read.

Run:

```bash
npm test -- tests/core/retinue.test.ts tests/core/result-reconcile.test.ts
```

Expected: fail because new metadata does not include `schemaVersion`.

- [ ] **Step 2: Implement schema version**

Add `schemaVersion: number` to `JobMeta` and write `schemaVersion: 1` for new jobs. Do not reject old metadata that omits it.

- [ ] **Step 3: Verify and commit**

Run:

```bash
npm run typecheck
npm test -- tests/core/retinue.test.ts tests/core/result-reconcile.test.ts
```

Commit:

```bash
git add src/core/types.ts src/core/retinue.ts tests/core/retinue.test.ts tests/core/result-reconcile.test.ts
git commit -m "feat: version job metadata schema"
```

## Task 2: Abandoned Running State

**Files:**
- Modify: `src/core/types.ts`
- Modify: `src/core/retinue.ts`
- Modify: `tests/core/result-reconcile.test.ts`
- Modify: `tests/core/retinue.test.ts`

- [ ] **Step 1: Write failing tests**

Add a fixture with `status: "running"` and `pid: process.pid`, but no tracked child in the current `ClaudeRetinue`. Expected `status(jobId)` returns `abandoned`, not `running`.

Keep the existing stale missing PID test expecting `orphaned`.

Run:

```bash
npm test -- tests/core/result-reconcile.test.ts tests/core/retinue.test.ts
```

Expected: fail because current code returns `running` for live external PID metadata.

- [ ] **Step 2: Implement abandoned status**

Add `abandoned` to `JobStatus`. In `status()`:

- if metadata is running and current retinue has the process tracked, return `running`
- if metadata is running, no exit status exists, pid is alive, and current retinue does not track it, persist and return `abandoned`
- if metadata is running, no exit status exists, and pid is not alive, persist and return `orphaned`

Do not count `abandoned` as active for concurrency. Do not cleanup `abandoned` jobs unless they later become terminal through explicit user action in a later milestone.

- [ ] **Step 3: Verify and commit**

Run:

```bash
npm run typecheck
npm test -- tests/core/result-reconcile.test.ts tests/core/retinue.test.ts
npm test
```

Commit:

```bash
git add src/core/types.ts src/core/retinue.ts tests/core/result-reconcile.test.ts tests/core/retinue.test.ts
git commit -m "feat: mark unowned live jobs abandoned"
```

## Task 3: Stale Atomic Temp Cleanup

**Files:**
- Modify: `src/core/types.ts`
- Modify: `src/core/retinue.ts`
- Modify: `tests/core/kill-cleanup.test.ts`

- [ ] **Step 1: Write failing cleanup test**

Create a terminal job fixture and a stale temp file such as `meta.json.123.1.abc.tmp` in that job directory. Run `cleanup({ olderThanMs: 0 })`. Expected:

- terminal job directory is removed
- `removedTempFiles` includes the temp file path or count

Create a running job fixture with a stale temp file. Expected cleanup preserves the running job directory and does not remove its temp file.

Run:

```bash
npm test -- tests/core/kill-cleanup.test.ts
```

Expected: fail because `CleanupResult` only returns `removedJobIds`.

- [ ] **Step 2: Implement temp cleanup result**

Extend `CleanupResult` with `removedTempFiles: string[]`.

When cleaning a terminal job directory, include any `*.tmp` files removed as part of that directory removal in `removedTempFiles`. Do not remove temp files under running or abandoned job directories.

- [ ] **Step 3: Verify and commit**

Run:

```bash
npm run typecheck
npm test -- tests/core/kill-cleanup.test.ts
npm test
```

Commit:

```bash
git add src/core/types.ts src/core/retinue.ts tests/core/kill-cleanup.test.ts
git commit -m "feat: report stale temp cleanup"
```

## Task 4: Documentation And Gates

**Files:**
- Modify: `README.md`
- Modify: `docs/VERIFICATION.md`

- [ ] **Step 1: Document state semantics**

Add `abandoned` to documented statuses and explain that it means the process appears alive but is not owned by the current retinue instance.

- [ ] **Step 2: Update verification notes**

Record schema version, abandoned/orphaned distinction, and temp cleanup coverage.

- [ ] **Step 3: Run Windows gate**

```bash
npm run typecheck
npm test
npm run build
```

- [ ] **Step 4: Run WSL fresh clone gate**

```bash
rtk wsl.exe -e bash -lc 'set -euo pipefail; d=$(mktemp -d /tmp/retinue-durable-state-wsl-test-XXXXXX); git clone /mnt/g/repository/retinue "$d" >/dev/null; cd "$d"; git checkout feature/spawn-claude-code >/dev/null; npm ci; npm run typecheck; npm test; npm run build; echo WSL_TEST_DIR="$d"'
```

- [ ] **Step 5: Commit and push**

```bash
git add README.md docs/VERIFICATION.md
git commit -m "docs: record durable state verification"
git push origin feature/spawn-claude-code
```
