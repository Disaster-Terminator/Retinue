# Daemon RPC Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden the daemon HTTP layer from a minimal wrapper into a stable local RPC contract with deterministic error behavior and readiness metadata.

**Architecture:** Keep `ClaudeRetinue` unchanged where possible. Harden `src/daemon/server.ts` around the core with structured errors, request body limits, and health metadata; update `DaemonClient` only to consume the new error shape.

**Tech Stack:** Node built-in `http`, TypeScript NodeNext, Vitest, existing fake-Claude fixture.

---

## Scope

This milestone implements the first P2 slice:

- structured error objects instead of string-only `{ "error": string }`
- deterministic bad JSON handling
- deterministic unknown route and wrong method handling
- JSON request body size limit
- daemon health response that includes `version`, `pid`, and `stateDir`
- docs for response shape

This milestone does not implement auth, discovery, auto-start, full endpoint-by-endpoint validation schemas, or service lifecycle.

## Task 1: Structured Error Contract

**Files:**
- Create: `tests/daemon-rpc-contract.test.ts`
- Modify: `src/daemon/server.ts`
- Modify: `src/daemon/client.ts`

- [ ] **Step 1: Write failing tests**

Create tests for:

```ts
expect(await postRaw("/v1/jobs/missing", "")).toMatchObject({
  status: 404,
  body: { error: { code: "not_found" } }
});

expect(await postRaw("/v1/jobs/status", "{")).toMatchObject({
  status: 400,
  body: { error: { code: "bad_json" } }
});

expect(await postRaw("/v1/jobs/status", "{}")).toMatchObject({
  status: 400,
  body: { error: { code: "invalid_request" } }
});
```

Run:

```bash
npm test -- tests/daemon-rpc-contract.test.ts
```

Expected: fail because daemon currently returns string-only errors.

- [ ] **Step 2: Implement structured errors**

Define daemon error codes:

```ts
type DaemonErrorCode = "not_found" | "bad_json" | "body_too_large" | "invalid_request" | "internal_error";
```

Return:

```json
{ "error": { "code": "invalid_request", "message": "Missing required jobId" } }
```

- [ ] **Step 3: Update client error parsing**

Make `DaemonClient` throw `message` when `error` is either string or structured object, preserving compatibility with older daemon responses.

- [ ] **Step 4: Verify and commit**

Run:

```bash
npm run typecheck
npm test -- tests/daemon-rpc-contract.test.ts tests/daemon.test.ts tests/cli.test.ts tests/mcp-tools.test.ts
```

Expected: pass.

Commit:

```bash
git add tests/daemon-rpc-contract.test.ts src/daemon/server.ts src/daemon/client.ts
git commit -m "feat: structure daemon rpc errors"
```

## Task 2: Body Size Limit

**Files:**
- Modify: `tests/daemon-rpc-contract.test.ts`
- Modify: `src/daemon/server.ts`

- [ ] **Step 1: Write failing body limit test**

Add a test creating `createDaemonServer(retinue, { maxBodyBytes: 16 })` and POSTing a larger JSON body. Expected response:

```json
{ "error": { "code": "body_too_large" } }
```

with HTTP status `413`.

- [ ] **Step 2: Implement limit**

Stop reading the request once the accumulated byte count exceeds `maxBodyBytes`. Default to `1048576` bytes.

- [ ] **Step 3: Verify and commit**

Run:

```bash
npm test -- tests/daemon-rpc-contract.test.ts
npm test
```

Expected: pass.

Commit:

```bash
git add tests/daemon-rpc-contract.test.ts src/daemon/server.ts
git commit -m "feat: limit daemon json request bodies"
```

## Task 3: Health Metadata

**Files:**
- Modify: `tests/daemon-rpc-contract.test.ts`
- Modify: `src/daemon/server.ts`
- Modify: `src/daemon.ts`
- Modify: `src/core/retinue.ts`

- [ ] **Step 1: Write failing health test**

Add a test expecting:

```ts
expect(health).toMatchObject({
  status: "ok",
  version: "0.1.0",
  pid: process.pid,
  stateDir: tempDir
});
```

- [ ] **Step 2: Expose state dir safely**

Add `getStateDir(): string` to `ClaudeRetinue` so daemon health can report the actual state directory without duplicating resolution logic.

- [ ] **Step 3: Implement health metadata**

`createDaemonServer(retinue)` should return health with `pid: process.pid` and `stateDir: retinue.getStateDir()`.

- [ ] **Step 4: Verify and commit**

Run:

```bash
npm run typecheck
npm test
npm run build
```

Expected: pass.

Commit:

```bash
git add tests/daemon-rpc-contract.test.ts src/daemon/server.ts src/daemon.ts src/core/retinue.ts
git commit -m "feat: expose daemon health metadata"
```

## Task 4: Documentation And Cross-Platform Verification

**Files:**
- Modify: `README.md`
- Modify: `docs/VERIFICATION.md`

- [ ] **Step 1: Document RPC error shape**

Add a short daemon RPC contract section to README with the structured error object and body limit.

- [ ] **Step 2: Update verification notes**

Record deterministic coverage for structured errors, bad JSON, body limit, and health metadata.

- [ ] **Step 3: Run Windows gate**

```bash
npm run typecheck
npm test
npm run build
```

- [ ] **Step 4: Run WSL fresh clone gate**

```bash
rtk wsl.exe -e bash -lc 'set -euo pipefail; d=$(mktemp -d /tmp/retinue-daemon-rpc-wsl-test-XXXXXX); git clone /mnt/g/repository/retinue "$d" >/dev/null; cd "$d"; git checkout feature/spawn-claude-code >/dev/null; npm ci; npm run typecheck; npm test; npm run build; echo WSL_TEST_DIR="$d"'
```

- [ ] **Step 5: Commit and push**

```bash
git add README.md docs/VERIFICATION.md
git commit -m "docs: record daemon rpc contract verification"
git push origin feature/spawn-claude-code
```
