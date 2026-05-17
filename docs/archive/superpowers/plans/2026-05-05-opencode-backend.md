# OpenCode Backend Implementation Plan

> Historical implementation plan. Current release behavior is documented in `docs/backends/OPENCODE.md`; `RETINUE_OPENCODE_PORT` now defaults to a concrete local port and rejects `0` because Retinue cannot discover OpenCode's randomly assigned port.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an OpenCode backend to retinue without breaking the frozen Claude Code backend.

**Architecture:** Introduce a small backend-neutral contract and implement OpenCode through an internal client abstraction tested against a fake OpenCode HTTP server. Prefer official OpenCode server/API semantics; use CLI `opencode run --attach` only for manual probes and fallback documentation. Keep provider/model routing owned by OpenCode.

**Tech Stack:** TypeScript, Node.js fetch/http, pnpm, Vitest, MCP SDK, local loopback daemon, official OpenCode server/API compatibility.

---

## File Structure

- Create: `src/backends/types.ts` - backend-neutral run/session/result contract.
- Create: `src/backends/claudeCode.ts` - adapter wrapper around existing `ClaudeRetinue` behavior where useful.
- Create: `src/backends/opencode/client.ts` - narrow HTTP client for OpenCode server endpoints.
- Create: `src/backends/opencode/backend.ts` - OpenCode backend implementation.
- Create: `src/backends/opencode/serverManager.ts` - explicit attach or opt-in `opencode serve` lifecycle helper.
- Create: `tests/fixtures/fake-opencode-server.ts` - fake HTTP server for deterministic tests.
- Create: `tests/opencode-client.test.ts` - client contract tests.
- Create: `tests/opencode-backend.test.ts` - backend run/status/result/abort tests.
- Modify: `src/core/types.ts` - add optional backend metadata fields while keeping old metadata readable.
- Modify: `src/core/retinue.ts` - preserve Claude behavior and prepare backend metadata compatibility.
- Modify: `src/cli.ts` - add `opencode_*` or explicit `opencode` CLI commands after backend works.
- Modify: `src/mcp.ts` - add `opencode_*` MCP tools after backend works.
- Modify: `tests/cli.test.ts` - CLI coverage for OpenCode commands.
- Modify: `tests/mcp-tools.test.ts` - MCP registration/schema coverage for OpenCode tools.
- Create: `docs/OPENCODE_BACKEND.md` - operator runbook and boundary.
- Modify: `docs/PROJECT_BOUNDARY.md` and `docs/VERIFICATION.md` - record OpenCode backend status.

---

### Task 1: OpenCode HTTP Client With Fake Server

**Files:**
- Create: `src/backends/opencode/client.ts`
- Create: `tests/fixtures/fake-opencode-server.ts`
- Create: `tests/opencode-client.test.ts`

- [ ] **Step 1: Write fake server fixture**

Create `tests/fixtures/fake-opencode-server.ts` exporting `startFakeOpenCodeServer()`. It should expose:

```text
GET  /global/health
POST /session
GET  /session
GET  /session/:id
POST /session/:id/prompt_async
GET  /session/:id/message
POST /session/:id/abort
```

The fixture stores sessions in memory and returns deterministic message/result payloads.

- [ ] **Step 2: Write failing client tests**

Tests should assert:

```ts
const server = await startFakeOpenCodeServer();
const client = new OpenCodeClient(server.url);
await expect(client.health()).resolves.toMatchObject({ status: "ok" });
const session = await client.createSession({ cwd: tempDir, title: "test" });
const prompt = await client.promptAsync(session.id, { prompt: "hello" });
expect(prompt.messageId).toBeTruthy();
await expect(client.messages(session.id)).resolves.toContainEqual(expect.objectContaining({ text: "fake result: hello" }));
```

- [ ] **Step 3: Run client tests to verify failure**

Run:

```bash
pnpm test -- tests/opencode-client.test.ts
```

Expected: FAIL because `OpenCodeClient` and fake server do not exist.

- [ ] **Step 4: Implement client**

Implement `OpenCodeClient` with:

- constructor `new OpenCodeClient(baseUrl: string)`
- `health()`
- `createSession(options)`
- `listSessions()`
- `getSession(sessionId)`
- `promptAsync(sessionId, options)`
- `messages(sessionId)`
- `abort(sessionId)`

Normalize base URL by trimming trailing slashes. Throw typed `OpenCodeClientError` for transport failures, invalid JSON, and non-2xx HTTP responses.

- [ ] **Step 5: Run client tests**

Run:

```bash
pnpm test -- tests/opencode-client.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

Run:

```bash
git add src/backends/opencode/client.ts tests/fixtures/fake-opencode-server.ts tests/opencode-client.test.ts
git commit -m "feat: add opencode http client"
```

### Task 2: Backend Metadata Compatibility

**Files:**
- Modify: `src/core/types.ts`
- Modify: `src/core/retinue.ts`
- Modify: `tests/core/retinue.test.ts`
- Modify: `tests/core/result-reconcile.test.ts`

- [ ] **Step 1: Write metadata tests**

Add tests proving:

```ts
expect(meta.backend).toBe("claude-code");
expect(readingOldMetaWithoutBackend.status).toBe("completed");
```

Existing metadata without `backend` must be treated as `claude-code`.

- [ ] **Step 2: Run focused tests to verify failure**

Run:

```bash
pnpm test -- tests/core/retinue.test.ts tests/core/result-reconcile.test.ts
```

Expected: FAIL until backend metadata defaults are implemented.

- [ ] **Step 3: Extend metadata types**

Add optional fields:

```ts
backend?: "claude-code" | "opencode";
externalSessionId?: string;
externalServerUrl?: string;
externalMessageId?: string;
model?: string;
agent?: string;
title?: string;
```

New Claude jobs should write `backend: "claude-code"` and keep existing `sessionId` behavior.

- [ ] **Step 4: Run focused tests**

Run:

```bash
pnpm test -- tests/core/retinue.test.ts tests/core/result-reconcile.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```bash
git add src/core/types.ts src/core/retinue.ts tests/core/retinue.test.ts tests/core/result-reconcile.test.ts
git commit -m "feat: record agent backend metadata"
```

### Task 3: OpenCode Backend Against Fake Server

**Files:**
- Create: `src/backends/types.ts`
- Create: `src/backends/opencode/backend.ts`
- Create: `tests/opencode-backend.test.ts`

- [ ] **Step 1: Write failing backend tests**

Tests should cover:

```ts
const backend = new OpenCodeBackend({ client, stateDir: tempDir });
const started = await backend.run({ cwd: tempDir, prompt: "hello", title: "demo" });
expect(started.backend).toBe("opencode");
expect(started.externalSessionId).toBeTruthy();
await expect(backend.status(started.handle)).resolves.toMatchObject({ status: "running" });
await expect(backend.result(started.handle)).resolves.toMatchObject({ parsedResult: { result: "fake result: hello" } });
await expect(backend.abort(started.handle)).resolves.toBeUndefined();
```

- [ ] **Step 2: Run backend tests to verify failure**

Run:

```bash
pnpm test -- tests/opencode-backend.test.ts
```

Expected: FAIL because backend does not exist.

- [ ] **Step 3: Implement backend contract**

Create `AgentBackend` types with:

```ts
type AgentBackendKind = "claude-code" | "opencode";
interface AgentBackend {
  readonly kind: AgentBackendKind;
  run(options: AgentRunOptions): Promise<AgentRunStart>;
  continueJob(options: AgentContinueOptions): Promise<AgentRunStart>;
  status(handle: AgentHandle): Promise<AgentBackendStatus>;
  result(handle: AgentHandle): Promise<AgentBackendResult>;
  abort(handle: AgentHandle): Promise<void>;
}
```

Keep this internal and do not expose generic MCP tools yet.

- [ ] **Step 4: Implement OpenCode backend**

`OpenCodeBackend` should:

- create an OpenCode session
- send prompts through `promptAsync`
- persist `externalSessionId`, `externalServerUrl`, `externalMessageId`, `backend`, `cwd`, `promptPath`, `promptPreview`, and `promptSha256`
- read messages for result extraction
- abort the session through the client
- never pass prompt text through process argv

- [ ] **Step 5: Run backend tests**

Run:

```bash
pnpm test -- tests/opencode-backend.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

Run:

```bash
git add src/backends/types.ts src/backends/opencode/backend.ts tests/opencode-backend.test.ts
git commit -m "feat: add opencode backend"
```

### Task 4: OpenCode Server Attach And Opt-In Serve

**Files:**
- Create: `src/backends/opencode/serverManager.ts`
- Create: `tests/opencode-server-manager.test.ts`
- Modify: `docs/OPENCODE_BACKEND.md`

- [ ] **Step 1: Write server manager tests**

Tests should cover:

```ts
expect(resolveOpenCodeServer({ baseUrl: "http://127.0.0.1:4096" })).toMatchObject({ mode: "attach" });
expect(resolveOpenCodeServer({ autoServe: false })).toThrow();
expect(buildServeArgs({ host: "127.0.0.1", port: 4096 })).toEqual(["serve", "--hostname", "127.0.0.1", "--port", "4096"]);
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
pnpm test -- tests/opencode-server-manager.test.ts
```

Expected: FAIL because server manager does not exist.

- [ ] **Step 3: Implement server manager**

Support:

- `RETINUE_OPENCODE_BASE_URL`
- `RETINUE_OPENCODE_COMMAND`, default `opencode`
- `RETINUE_OPENCODE_AUTO_SERVE=1`
- `RETINUE_OPENCODE_HOST`, default `127.0.0.1`
- `RETINUE_OPENCODE_PORT`, default `4096`

Do not auto-serve unless explicitly enabled.

- [ ] **Step 4: Run tests**

Run:

```bash
pnpm test -- tests/opencode-server-manager.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```bash
git add src/backends/opencode/serverManager.ts tests/opencode-server-manager.test.ts docs/OPENCODE_BACKEND.md
git commit -m "feat: add opencode server attach policy"
```

### Task 5: OpenCode CLI And MCP Surfaces

**Files:**
- Modify: `src/cli.ts`
- Modify: `src/mcp.ts`
- Modify: `tests/cli.test.ts`
- Modify: `tests/mcp-tools.test.ts`
- Modify: `README.md`
- Modify: `docs/OPENCODE_BACKEND.md`

- [ ] **Step 1: Add failing schema/registration tests**

MCP tools:

```text
opencode_run
opencode_status
opencode_wait
opencode_result
opencode_continue
opencode_kill
opencode_cleanup
```

Schemas should include `cwd`, `prompt`, optional `title`, optional `model`, optional `agent`, and no permission bypass flags.

- [ ] **Step 2: Add failing CLI tests**

Use fake OpenCode server URL and assert:

```bash
node src/cli.ts opencode-run --cwd <tmp> --prompt hello --opencode-base-url <url>
node src/cli.ts opencode-result <jobId>
```

- [ ] **Step 3: Run tests to verify failure**

Run:

```bash
pnpm test -- tests/mcp-tools.test.ts tests/cli.test.ts
```

Expected: FAIL because OpenCode tools and CLI commands do not exist.

- [ ] **Step 4: Implement tools and CLI**

Add explicit OpenCode surfaces. Do not rename or overload existing `claude_*` tools.

- [ ] **Step 5: Run focused tests**

Run:

```bash
pnpm test -- tests/mcp-tools.test.ts tests/cli.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

Run:

```bash
git add src/cli.ts src/mcp.ts tests/cli.test.ts tests/mcp-tools.test.ts README.md docs/OPENCODE_BACKEND.md
git commit -m "feat: expose opencode lifecycle tools"
```

### Task 6: Verification And Documentation

**Files:**
- Modify: `docs/VERIFICATION.md`
- Modify: `docs/PROJECT_BOUNDARY.md`
- Modify: `docs/OPENCODE_BACKEND.md`

- [ ] **Step 1: Run full Windows gate**

Run:

```bash
pnpm run typecheck
pnpm test
pnpm run build
pnpm pack --dry-run --json
```

Expected: all commands exit 0 and package output includes runtime `dist/**`, docs, scripts, and fixtures.

- [ ] **Step 2: Run WSL fresh clone gate**

Run:

```bash
rtk proxy wsl.exe -e bash -lc 'set -euo pipefail; d=$(mktemp -d /tmp/retinue-opencode-wsl-test-XXXXXX); git clone /mnt/g/repository/retinue "$d" >/dev/null; cd "$d"; git checkout feature/spawn-opencode >/dev/null; pnpm install --frozen-lockfile; pnpm run typecheck; pnpm test; pnpm run build; echo WSL_TEST_DIR="$d"'
```

Expected: all commands exit 0.

- [ ] **Step 3: Document verification evidence**

Record exact Windows and WSL results in `docs/VERIFICATION.md`.

- [ ] **Step 4: Commit and push**

Run:

```bash
git add docs/VERIFICATION.md docs/PROJECT_BOUNDARY.md docs/OPENCODE_BACKEND.md
git commit -m "docs: record opencode backend verification"
git push origin feature/spawn-opencode
```

## Self-Review

- Spec coverage: Covers official OpenCode server/API preference, CLI attach fallback as probe/fallback, third-party MCP as reference only, pnpm, Windows/WSL verification, no permission bypass, no provider/model routing, and no breakage of `claude_*`.
- Placeholder scan: No TBD/TODO placeholders remain.
- Scope check: This plan is implementable in independent milestones. CLI/MCP exposure is intentionally after the backend and fake HTTP server are stable.
