# Claude Freeze And OpenCode Pivot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Freeze the Claude Code backend as a pnpm-verified compatibility baseline, merge it into `main`, then start OpenCode backend work from a clean branch.

**Architecture:** Treat `review/codex-web-nightly-2026-05-04` as a patch source, not as a branch to merge. Keep existing `claude_*` public surfaces compatible while absorbing backend-neutral daemon/client/discovery/schema hardening. OpenCode work starts only after Claude freeze is merged to `main`.

**Tech Stack:** TypeScript, Node.js 20+, pnpm, Vitest, MCP SDK, local loopback daemon, Git worktrees.

---

## File Structure

- Modify: `package.json` - keep scripts stable, use pnpm in documentation and verification.
- Delete: `package-lock.json` - repository package manager becomes pnpm.
- Create: `pnpm-lock.yaml` - lock dependencies with pnpm.
- Modify: `README.md` - replace npm commands with pnpm and update product wording.
- Modify: `docs/VERIFICATION.md` - replace npm verification commands with pnpm and record the pivot.
- Modify: `docs/REAL_CLAUDE_PROBES.md` - keep probes manual but switch examples to pnpm.
- Modify: `docs/SERVICE_LIFECYCLE.md` - switch build/run examples to pnpm where applicable.
- Modify: `src/daemon/client.ts` - absorb structured daemon client errors.
- Modify: `src/daemon/discovery.ts` - absorb URL and timestamp validation.
- Modify: `src/cli.ts` - add read-only daemon health diagnostics.
- Modify: `tests/daemon-client.test.ts` - add daemon client error tests.
- Modify: `tests/daemon-discovery.test.ts` - add discovery boundary tests.
- Modify: `tests/cli.test.ts` - add daemon-health tests.
- Modify: `tests/mcp-tools.test.ts` - add MCP input schema validation tests.
- Create later on `main`: `feature/spawn-opencode` - OpenCode implementation branch.

---

### Task 1: Migrate Repository Verification To pnpm

**Files:**
- Modify: `package.json`
- Delete: `package-lock.json`
- Create: `pnpm-lock.yaml`
- Modify: `README.md`
- Modify: `docs/VERIFICATION.md`
- Modify: `docs/REAL_CLAUDE_PROBES.md`
- Modify: `docs/SERVICE_LIFECYCLE.md`

- [ ] **Step 1: Generate pnpm lockfile**

Run:

```bash
pnpm install
```

Expected:

```text
Lockfile is up to date
```

or pnpm creates `pnpm-lock.yaml` successfully.

- [ ] **Step 2: Remove npm lockfile from tracking**

Run:

```bash
git rm package-lock.json
```

Expected:

```text
rm 'package-lock.json'
```

- [ ] **Step 3: Replace documented npm commands**

Change documentation examples from:

```bash
npm install
npm run build
npm run typecheck
npm test
npm run probe:real:direct
npm run probe:real:daemon
npm run probe:real:mcp-daemon
npm ci
```

to:

```bash
pnpm install
pnpm run build
pnpm run typecheck
pnpm test
pnpm run probe:real:direct
pnpm run probe:real:daemon
pnpm run probe:real:mcp-daemon
pnpm install --frozen-lockfile
```

- [ ] **Step 4: Run pnpm gates**

Run:

```bash
pnpm run typecheck
pnpm test
pnpm run build
```

Expected: all commands exit 0.

- [ ] **Step 5: Commit**

Run:

```bash
git add package.json pnpm-lock.yaml README.md docs/VERIFICATION.md docs/REAL_CLAUDE_PROBES.md docs/SERVICE_LIFECYCLE.md
git add -u package-lock.json
git commit -m "chore: standardize supervisor on pnpm"
```

### Task 2: Absorb Daemon Client Error Fidelity

**Files:**
- Modify: `src/daemon/client.ts`
- Create or modify: `tests/daemon-client.test.ts`

- [ ] **Step 1: Add failing daemon client tests**

Create `tests/daemon-client.test.ts` with tests covering:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { DaemonClient, DaemonClientError } from "../src/daemon/client.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("DaemonClient errors", () => {
  it("classifies transport failures", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;

    const client = new DaemonClient("http://127.0.0.1:27777");

    await expect(client.status("job-1")).rejects.toMatchObject({
      code: "transport_unreachable",
      path: "/v1/jobs/status",
    });
  });

  it("preserves daemon error envelopes", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: { code: "not_found", message: "missing" } }), {
        status: 404,
        headers: { "content-type": "application/json" },
      }),
    ) as unknown as typeof fetch;

    const client = new DaemonClient("http://127.0.0.1:27777");

    await expect(client.status("job-1")).rejects.toBeInstanceOf(DaemonClientError);
    await expect(client.status("job-1")).rejects.toMatchObject({
      code: "not_found",
      status: 404,
      path: "/v1/jobs/status",
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
pnpm test -- tests/daemon-client.test.ts
```

Expected: FAIL because `DaemonClientError` or structured classification is missing.

- [ ] **Step 3: Implement daemon client error class**

In `src/daemon/client.ts`, add a `DaemonClientError` class with:

```ts
export class DaemonClientError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status?: number,
    readonly path?: string,
  ) {
    super(message);
    this.name = "DaemonClientError";
  }
}
```

Update the private request helper to:

- catch fetch transport failures as `transport_unreachable`
- classify aborted requests as `transport_aborted`
- preserve JSON daemon error envelopes with `code`, `message`, and HTTP `status`
- report malformed/empty non-2xx responses as `daemon_http_error`

- [ ] **Step 4: Run daemon client tests**

Run:

```bash
pnpm test -- tests/daemon-client.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```bash
git add src/daemon/client.ts tests/daemon-client.test.ts
git commit -m "fix: preserve daemon client error details"
```

### Task 3: Absorb Discovery Validation Hardening

**Files:**
- Modify: `src/daemon/discovery.ts`
- Modify: `tests/daemon-discovery.test.ts`

- [ ] **Step 1: Add failing discovery tests**

Add tests for:

```ts
expect(() => validateDiscovery({ url: "https://127.0.0.1:27777", pid, startedAt, version })).toThrow(
  "Invalid daemon discovery: url must use http",
);
expect(() => validateDiscovery({ url: "http://192.168.1.2:27777", pid, startedAt, version })).toThrow(
  "Invalid daemon discovery: url must be loopback",
);
expect(validateDiscovery({ url: "http://127.0.0.1:27777/path", pid, startedAt, version }).url).toBe(
  "http://127.0.0.1:27777",
);
expect(() => validateDiscovery({ url, pid, startedAt: "2026-05-05", version })).toThrow(
  "Invalid daemon discovery: invalid startedAt",
);
```

- [ ] **Step 2: Run discovery tests to verify failure**

Run:

```bash
pnpm test -- tests/daemon-discovery.test.ts
```

Expected: FAIL for the new validation expectations.

- [ ] **Step 3: Implement validation**

In `src/daemon/discovery.ts`, normalize daemon URLs through `new URL()` and enforce:

- non-empty string URL
- `http:` protocol
- host is `127.0.0.1` or `localhost`
- returned URL is `parsed.origin`
- `startedAt` is canonical ISO from `new Date(startedAt).toISOString()`

- [ ] **Step 4: Run discovery tests**

Run:

```bash
pnpm test -- tests/daemon-discovery.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```bash
git add src/daemon/discovery.ts tests/daemon-discovery.test.ts
git commit -m "fix: validate daemon discovery metadata"
```

### Task 4: Absorb Read-Only Daemon Health CLI

**Files:**
- Modify: `src/cli.ts`
- Modify: `tests/cli.test.ts`
- Modify: `README.md`
- Modify: `docs/SERVICE_LIFECYCLE.md`

- [ ] **Step 1: Add failing CLI tests**

Add tests covering:

```ts
await runCli(["daemon-health", "--daemon-url", serverUrl]);
expect(JSON.parse(stdout)).toMatchObject({ ok: true, source: "explicit", daemonUrl: serverUrl });

await runCli(["daemon-health"]);
expect(JSON.parse(stderr)).toMatchObject({ error: { code: "missing_daemon_target" } });

await runCli(["--discover-daemon", "daemon-health"]);
expect(JSON.parse(stdout)).toMatchObject({ ok: true, source: "discovery" });
```

- [ ] **Step 2: Run CLI tests to verify failure**

Run:

```bash
pnpm test -- tests/cli.test.ts
```

Expected: FAIL because `daemon-health` is unknown.

- [ ] **Step 3: Implement `daemon-health`**

In `src/cli.ts`, add a read-only command that:

- accepts `--daemon-url` or explicit discovery
- rejects missing daemon target with `missing_daemon_target`
- calls `GET /health`
- rejects invalid JSON with `daemon_invalid_json`
- rejects non-2xx responses with `daemon_http_error`
- rejects transport failures with `daemon_unreachable`
- prints JSON to stdout on success and stderr on failure

- [ ] **Step 4: Document `daemon-health`**

Add examples:

```bash
node dist/cli.js daemon-health --daemon-url http://127.0.0.1:27777
node dist/cli.js --discover-daemon daemon-health
```

- [ ] **Step 5: Run CLI tests**

Run:

```bash
pnpm test -- tests/cli.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

Run:

```bash
git add src/cli.ts tests/cli.test.ts README.md docs/SERVICE_LIFECYCLE.md
git commit -m "feat: add daemon health diagnostics"
```

### Task 5: Absorb MCP Schema Validation Tests

**Files:**
- Modify: `tests/mcp-tools.test.ts`

- [ ] **Step 1: Add MCP schema tests**

Add tests that call MCP tools with invalid inputs:

```ts
await expect(callTool("claude_run", {})).rejects.toThrow();
await expect(callTool("claude_run", { cwd: 123, prompt: "hello" })).rejects.toThrow();
await expect(callTool("claude_run", { cwd: ".", prompt: "hello", permissionMode: "bypass" })).rejects.toThrow();
```

Also assert that tool schemas declare required `cwd` and `prompt` fields for `claude_run`.

- [ ] **Step 2: Run MCP tests**

Run:

```bash
pnpm test -- tests/mcp-tools.test.ts
```

Expected: PASS if existing schemas already reject invalid inputs, or FAIL until schema validation is tightened.

- [ ] **Step 3: Tighten schemas only if needed**

If tests fail because invalid inputs are accepted, update `src/mcp.ts` schemas to enforce:

- required string `cwd`
- required non-empty string `prompt`
- supported permission modes only

- [ ] **Step 4: Run MCP tests again**

Run:

```bash
pnpm test -- tests/mcp-tools.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```bash
git add src/mcp.ts tests/mcp-tools.test.ts
git commit -m "test: cover mcp tool input schemas"
```

### Task 6: Freeze Claude Backend And Merge Main

**Files:**
- Modify: `README.md`
- Modify: `docs/VERIFICATION.md`

- [ ] **Step 1: Record freeze status**

Add a short section stating:

```text
Claude Code is the frozen compatibility backend. New agent integration work should happen behind backend adapters, starting with OpenCode.
```

- [ ] **Step 2: Run full Windows gate**

Run:

```bash
pnpm run typecheck
pnpm test
pnpm run build
```

Expected: all commands exit 0.

- [ ] **Step 3: Commit freeze docs**

Run:

```bash
git add README.md docs/VERIFICATION.md
git commit -m "docs: freeze claude code backend baseline"
```

- [ ] **Step 4: Push feature branch**

Run:

```bash
git push origin feature/spawn-claude-code
```

Expected: push succeeds.

- [ ] **Step 5: Merge into main**

Run:

```bash
git switch main
git merge --no-ff feature/spawn-claude-code -m "merge: freeze claude code backend"
git push origin main
```

Expected: `main` contains the frozen Claude backend.

### Task 7: Create OpenCode Branch

**Files:**
- No code files yet.

- [ ] **Step 1: Create branch from updated main**

Run:

```bash
git switch -c feature/spawn-opencode
```

Expected: new branch starts from updated `main`.

- [ ] **Step 2: Create OpenCode implementation plan**

Create:

```text
docs/superpowers/plans/2026-05-05-opencode-backend.md
```

The plan must cover:

- OpenCode fake HTTP server tests
- backend contract extraction
- OpenCode client wrapper
- OpenCode server discovery/start policy
- `opencode_*` MCP tools
- CLI commands
- daemon delegation
- Windows and WSL verification

- [ ] **Step 3: Commit plan**

Run:

```bash
git add docs/superpowers/plans/2026-05-05-opencode-backend.md
git commit -m "docs: plan opencode backend implementation"
git push origin feature/spawn-opencode
```

## Self-Review

- Spec coverage: The plan covers pnpm migration, selective review absorption, Claude freeze, main merge, OpenCode branch creation, no provider/model routing, no permission bypass, and milestone commits.
- Placeholder scan: No `TBD`, `TODO`, or unspecified implementation placeholders remain.
- Scope check: OpenCode implementation is intentionally split into a later branch plan so the Claude freeze milestone stays testable and reviewable.
