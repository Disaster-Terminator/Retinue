# Shared Root Writable OpenCode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make OpenCode `shared_root` the Retinue default, keep `per_spawn` as an explicit legacy/fallback mode, and support writable OpenCode child agents that directly edit files under OpenCode's native permission model.

**Architecture:** Retinue remains an MCP lifecycle adapter, not a replacement permission/runtime layer. The default topology becomes one supervising Codex/Hermes thread -> one Retinue MCP session -> one OpenCode shared root session -> many OpenCode child sessions. Retinue manages job handles, wait/close, permission surfacing, resource budgets, and opt-in cross-session diagnostics; OpenCode owns child agent behavior, tools, permissions, and file edits.

**Tech Stack:** TypeScript, Node.js, pnpm, Vitest, Retinue MCP in-memory probes, OpenCode HTTP/SDK adapter, opt-in real OpenCode dogfood probes.

---

## Scope Boundaries

This plan does implement:

- Default OpenCode root binding mode changes from `per_spawn` to `shared_root`.
- `per_spawn` remains available through `RETINUE_OPENCODE_ROOT_BINDING_MODE=per_spawn`.
- Product spawn remains simple: caller may pass `agent`, but does not pass backend/profile/model/access-mode/bash-policy in normal MCP usage.
- Writable children are selected by OpenCode agent/profile, for example `agent: "build"`, and directly edit the working tree through OpenCode tools.
- Single-Codex-thread probes can simulate both normal shared-root behavior and the cross-MCP-session edge case.

This plan does not implement:

- A Retinue-owned patch protocol.
- A Retinue-owned `write_intent` blocker for OpenCode child output.
- Default blocking of OpenCode child concurrency inside one shared root.
- A global same-cwd write lock as default behavior.

## File Map

- Modify `src/backends/opencode/backend.ts`
  - Change root binding default to `shared-root`.
  - Preserve explicit `per_spawn`/`per-spawn` parsing.
  - Keep child permission construction OpenCode-first.
- Modify `tests/opencode-backend.test.ts`
  - Add direct backend default-mode coverage.
  - Keep explicit per-spawn coverage.
- Modify `tests/mcp-tools.test.ts`
  - Expand existing shared-root session scoping coverage to two independent MCP sessions, each with multiple children.
  - Add writable-agent request coverage with fake OpenCode session permissions.
- Modify `scripts/probe-retinue-opencode-dogfood.mjs`
  - Default dogfood root binding list to `shared_root`.
  - Keep env override for `per_spawn,shared_root` comparisons.
  - Remove obsolete normal-product `access_mode`/`bash_policy` arguments from MCP tool calls.
- Create `scripts/probe-retinue-opencode-shared-root-cross-session.mjs`
  - Opt-in real probe that runs two in-memory Retinue MCP server sessions in one Node process.
  - Both sessions use the same cwd, state dir, and OpenCode runtime.
  - Each session spawns multiple `build` children under its own shared root.
  - Emits root/session topology evidence and optional writable canary results.
- Modify `package.json`
  - Add an explicit opt-in probe script.
  - Keep real probes out of default `test`, `build`, and release lifecycle commands.
- Modify `docs/explanation/spawn-semantics.md`
  - Record default shared-root topology and per-spawn legacy status.
  - Record the default/high-risk distinction.
- Modify `docs/reference/backends/opencode.md`
  - Update configuration and product boundary.
- Modify `docs/reference/configuration.md`
  - Update `RETINUE_OPENCODE_ROOT_BINDING_MODE` default.
- Modify `docs/how-to/verify.md`
  - Update dogfood commands and explain topology probe usage.
- Modify `docs/runbooks/real-opencode-probes.md`
  - Update shared-root/per-spawn comparison runbook.
- Modify `docs/releases/v0.2.0.md` and `docs/releases/v0.2.0.zh-CN.md` only if they are meant to describe current installed behavior after this change; otherwise add a newer release note instead.

## Task 1: Claim Beads Issue And Record Design Boundary

**Files:**
- Modify: beads issue `RET-uld`
- Modify: `docs/explanation/spawn-semantics.md`

- [ ] **Step 1: Claim the issue**

Run:

```bash
bd update RET-uld --claim
```

Expected: issue `RET-uld` becomes `in_progress`.

- [ ] **Step 2: Update spawn semantics text**

In `docs/explanation/spawn-semantics.md`, replace the "Shared Root vs Per Spawn" section with:

```markdown
## Shared Root vs Per Spawn

`shared_root` is the default OpenCode topology. One supervising Codex/Hermes thread gets one Retinue MCP server session, which reuses one OpenCode root session for multiple child jobs with the same OpenCode server URL, cwd, and root agent. This matches OpenCode's native parent/child session shape while keeping Retinue in charge of MCP job handles, waits, closes, permission surfacing, and resource budgets.

`per_spawn` is a legacy/fallback topology. Each Retinue child job creates its own unprompted OpenCode root session and then a prompted child session. Use it for compatibility checks, isolation probes, or debugging when shared-root behavior is suspected.

OpenCode owns child agent behavior, tools, and permissions. A writable child such as `build` may edit files directly through OpenCode. Retinue must not replace that with a patch-only protocol or a prompt-text write-intent blocker.

The edge case is cross-session concurrency: multiple independent Retinue MCP sessions, possibly from multiple Codex/Hermes hosts or backends, may target the same cwd. That is outside one OpenCode root's native scheduling boundary. Retinue should make this observable through explicit probes and diagnostics before adding any opt-in safety policy.
```

- [ ] **Step 3: Commit design boundary**

Run:

```bash
git add docs/explanation/spawn-semantics.md .beads
git commit -m "docs: align opencode shared-root semantics"
```

Expected: commit succeeds.

## Task 2: Make Shared Root The Default

**Files:**
- Modify: `src/backends/opencode/backend.ts`
- Modify: `tests/opencode-backend.test.ts`

- [ ] **Step 1: Add failing default-mode test**

Add this test near existing root-binding tests in `tests/opencode-backend.test.ts`:

```ts
it("defaults OpenCode root binding to shared-root", async () => {
  const backend = createBackend({} as NodeJS.ProcessEnv);
  const first = await backend.run({ cwd: "/repo", prompt: "inspect one", agent: "explore" });
  const second = await backend.run({ cwd: "/repo", prompt: "inspect two", agent: "explore" });

  expect(first.externalRunnerMode).toBe("shared-root");
  expect(second.externalRunnerMode).toBe("shared-root");
  expect(second.externalRootSessionId).toBe(first.externalRootSessionId);
  expect(first.externalSessionId).not.toBe(second.externalSessionId);
});
```

Run:

```bash
pnpm run test:opencode
```

Expected before implementation: FAIL because default is currently `per-spawn`.

- [ ] **Step 2: Preserve explicit per-spawn test**

Add or update a test in `tests/opencode-backend.test.ts`:

```ts
it("keeps per-spawn available as an explicit legacy mode", async () => {
  const backend = createBackend({ RETINUE_OPENCODE_ROOT_BINDING_MODE: "per_spawn" } as NodeJS.ProcessEnv);
  const first = await backend.run({ cwd: "/repo", prompt: "inspect one", agent: "explore" });
  const second = await backend.run({ cwd: "/repo", prompt: "inspect two", agent: "explore" });

  expect(first.externalRunnerMode).toBe("per-spawn");
  expect(second.externalRunnerMode).toBe("per-spawn");
  expect(second.externalRootSessionId).not.toBe(first.externalRootSessionId);
});
```

Run:

```bash
pnpm run test:opencode
```

Expected: current explicit per-spawn behavior passes, default-mode test still fails.

- [ ] **Step 3: Change default resolver**

In `src/backends/opencode/backend.ts`, change `resolveRunnerMode` to:

```ts
function resolveRunnerMode(env: RetinueOptions["env"]): OpenCodeRunnerMode {
  const value = env?.RETINUE_OPENCODE_ROOT_BINDING_MODE?.trim().toLowerCase();
  if (value === undefined || value === "" || value === "shared_root" || value === "shared-root") {
    return "shared-root";
  }
  if (value === "per_spawn" || value === "per-spawn") {
    return "per-spawn";
  }
  throw new Error(`Unsupported RETINUE_OPENCODE_ROOT_BINDING_MODE: ${value}`);
}
```

- [ ] **Step 4: Verify root mode tests**

Run:

```bash
pnpm run test:opencode
```

Expected: PASS.

- [ ] **Step 5: Commit default change**

Run:

```bash
git add src/backends/opencode/backend.ts tests/opencode-backend.test.ts
git commit -m "feat: default opencode to shared root"
```

Expected: commit succeeds.

## Task 3: Strengthen Single-Thread Cross-MCP Topology Tests

**Files:**
- Modify: `tests/mcp-tools.test.ts`

- [ ] **Step 1: Expand the existing shared-root scoping test**

In `tests/mcp-tools.test.ts`, update `scopes shared OpenCode roots to one MCP server session` so the second MCP connection also spawns two children:

```ts
const fourth = parseToolJson(
  await secondConnection.client.callTool({
    name: "spawn_agent",
    arguments: { cwd: tempDir, message: "shared root other mcp second child", task_name: "shared-other-mcp-two", agent: "explore" }
  })
);

expect(fourth.externalRunnerMode).toBe("shared-root");
expect(fourth.externalRootSessionId).toBe(third.externalRootSessionId);
expect(fourth.externalRootSessionId).not.toBe(first.externalRootSessionId);
expect(fourth.externalSessionId).not.toBe(third.externalSessionId);
```

Update the fake OpenCode session request assertion to include the fourth child:

```ts
expect(fakeOpenCode.sessionRequests).toEqual([
  expect.objectContaining({ title: "retinue-shared-root", agent: "build" }),
  expect.objectContaining({ parentID: first.externalRootSessionId, agent: "explore" }),
  expect.objectContaining({ parentID: first.externalRootSessionId, agent: "explore" }),
  expect.objectContaining({ title: "retinue-shared-root", agent: "build" }),
  expect.objectContaining({ parentID: third.externalRootSessionId, agent: "explore" }),
  expect.objectContaining({ parentID: third.externalRootSessionId, agent: "explore" })
]);
```

- [ ] **Step 2: Run MCP tests**

Run:

```bash
pnpm run test:mcp
```

Expected: PASS. This proves one Codex thread can simulate two independent Retinue MCP sessions without launching two Codex hosts.

- [ ] **Step 3: Commit topology test**

Run:

```bash
git add tests/mcp-tools.test.ts
git commit -m "test: cover cross-session shared roots"
```

Expected: commit succeeds.

## Task 4: Keep Writable Children OpenCode-Owned

**Files:**
- Modify: `tests/mcp-tools.test.ts`
- Modify: `src/mcp.ts` only if the test shows MCP spawn forces readonly semantics.

- [ ] **Step 1: Add fake MCP coverage for writable child agent selection**

Add a test near OpenCode MCP spawn coverage in `tests/mcp-tools.test.ts`:

```ts
it("passes writable OpenCode child agent without Retinue readonly overrides", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "retinue-mcp-writable-opencode-"));
  const fakeOpenCode = await startFakeOpenCodeServer();
  const connection = await connectMcpClientWithRetinue(new ClaudeRetinue({ stateDir: "unused" }));
  try {
    process.env.RETINUE_STATE_DIR = tempDir;
    process.env.RETINUE_OPENCODE_BASE_URL = fakeOpenCode.url;
    process.env.RETINUE_OPENCODE_ROOT_BINDING_MODE = "shared_root";

    const spawned = parseToolJson(
      await connection.client.callTool({
        name: "spawn_agent",
        arguments: {
          cwd: tempDir,
          message: "make a tiny safe edit",
          task_name: "writable-build-child",
          agent: "build"
        }
      })
    );

    expect(spawned.externalRunnerMode).toBe("shared-root");
    expect(fakeOpenCode.sessionRequests).toEqual([
      expect.objectContaining({ title: "retinue-shared-root", agent: "build" }),
      expect.objectContaining({ parentID: spawned.externalRootSessionId, agent: "build" })
    ]);
    expect(fakeOpenCode.sessionRequests[1]?.permission ?? []).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ permission: "edit", action: "deny" })])
    );
  } finally {
    delete process.env.RETINUE_STATE_DIR;
    delete process.env.RETINUE_OPENCODE_BASE_URL;
    delete process.env.RETINUE_OPENCODE_ROOT_BINDING_MODE;
    await Promise.allSettled([closeMcpClient(connection), fakeOpenCode.close()]);
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run MCP tests**

Run:

```bash
pnpm run test:mcp
```

Expected: PASS if current MCP product path already uses `readOnly: false`. If it fails because Retinue injects readonly edit denies for normal product spawn, fix only that product path and keep explicit readonly tests intact.

- [ ] **Step 3: Commit writable child coverage**

Run:

```bash
git add tests/mcp-tools.test.ts src/mcp.ts
git commit -m "test: preserve writable opencode child permissions"
```

Expected: commit succeeds.

## Task 5: Add Opt-In Cross-Session Real Probe

**Files:**
- Create: `scripts/probe-retinue-opencode-shared-root-cross-session.mjs`
- Modify: `package.json`
- Modify: `tests/ci-package-guardrails.test.ts`

- [ ] **Step 1: Create the probe script**

Create `scripts/probe-retinue-opencode-shared-root-cross-session.mjs` with this behavior:

```js
#!/usr/bin/env node

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdir, mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createMcpServer } from "../dist/mcp.js";

const timeoutMs = Number(process.env.RETINUE_CROSS_SESSION_PROBE_TIMEOUT_MS ?? "180000");
const writable = process.env.RETINUE_CROSS_SESSION_WRITABLE === "1";

async function main() {
  const stateDir = process.env.RETINUE_STATE_DIR ?? (await mkdtemp(path.join(os.tmpdir(), "retinue-cross-session-state-")));
  const cwd = process.env.RETINUE_CROSS_SESSION_CWD ?? (await mkdtemp(path.join(os.tmpdir(), "retinue-cross-session-work-")));
  await mkdir(stateDir, { recursive: true });
  await mkdir(cwd, { recursive: true });

  const markerPath = path.join(cwd, "RETINUE_CROSS_SESSION_MARKER.txt");
  await writeFile(markerPath, "initial\n", "utf8");

  const previous = snapshotEnv([
    "RETINUE_BACKEND",
    "RETINUE_STATE_DIR",
    "RETINUE_OPENCODE_ROOT_BINDING_MODE",
    "RETINUE_OPENCODE_AGENT"
  ]);
  process.env.RETINUE_BACKEND = "opencode";
  process.env.RETINUE_STATE_DIR = stateDir;
  process.env.RETINUE_OPENCODE_ROOT_BINDING_MODE = "shared_root";
  process.env.RETINUE_OPENCODE_AGENT = writable ? "build" : "explore";

  const a = await connect("a");
  const b = await connect("b");
  try {
    const tasks = [
      spawn(a.client, cwd, "a-one", writable),
      spawn(a.client, cwd, "a-two", writable),
      spawn(b.client, cwd, "b-one", writable),
      spawn(b.client, cwd, "b-two", writable)
    ];
    const spawns = await Promise.all(tasks);
    const waits = await Promise.all(spawns.map((spawned) => waitTerminal(spawned.client, spawned.jobId)));
    await Promise.allSettled(spawns.map((spawned) => spawned.client.callTool({ name: "close_agent", arguments: { jobId: spawned.jobId } })));

    const rootsA = unique(spawns.filter((item) => item.group === "a").map((item) => item.externalRootSessionId));
    const rootsB = unique(spawns.filter((item) => item.group === "b").map((item) => item.externalRootSessionId));
    const output = {
      ok: rootsA.length === 1 && rootsB.length === 1 && rootsA[0] !== rootsB[0] && waits.every((item) => item.status === "completed"),
      writable,
      cwd,
      stateDir,
      tracePath: path.join(stateDir, "logs", "retinue.jsonl"),
      rootsA,
      rootsB,
      spawns: spawns.map(({ client, ...rest }) => rest),
      waits: waits.map((wait) => ({
        jobId: wait.jobId,
        status: wait.status,
        stallReason: wait.diagnostic?.stallReason,
        externalRunnerMode: wait.externalRunnerMode
      })),
      markerText: await readFile(markerPath, "utf8").catch(() => "")
    };
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    if (!output.ok) process.exitCode = 1;
  } finally {
    restoreEnv(previous);
    await Promise.allSettled([a.close(), b.close()]);
    if (!process.env.RETINUE_CROSS_SESSION_CWD) await rm(cwd, { recursive: true, force: true });
  }
}

async function connect(name) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: `retinue-cross-session-${name}`, version: "0.1.0" });
  const server = createMcpServer();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    close: async () => {
      await Promise.allSettled([client.close(), clientTransport.close(), serverTransport.close()]);
    }
  };
}

async function spawn(client, cwd, name, writable) {
  const message = writable
    ? `Append one line containing ${name} to RETINUE_CROSS_SESSION_MARKER.txt, then answer with ${name} DONE.`
    : `Read RETINUE_CROSS_SESSION_MARKER.txt, then answer with ${name} DONE.`;
  const parsed = parseToolJson(await client.callTool({
    name: "spawn_agent",
    arguments: { cwd, task_name: `cross-session-${name}`, agent: writable ? "build" : "explore", message }
  }));
  return { ...parsed, client, group: name.slice(0, 1) };
}

async function waitTerminal(client, jobId) {
  const deadline = Date.now() + timeoutMs;
  let last;
  do {
    const remaining = Math.max(1, deadline - Date.now());
    last = parseToolJson(await client.callTool(
      { name: "wait_agent", arguments: { jobId, timeoutMs: remaining } },
      undefined,
      { timeout: remaining + 30000 }
    ));
    if (last.status !== "running" && last.status !== "queued") return { ...last, jobId };
    await new Promise((resolve) => setTimeout(resolve, 500));
  } while (Date.now() < deadline);
  return { ...last, jobId };
}

function parseToolJson(result) {
  const text = result?.content?.find((item) => item.type === "text")?.text;
  if (!text) throw new Error("tool result did not include text JSON");
  return JSON.parse(text);
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function snapshotEnv(keys) {
  return Object.fromEntries(keys.map((key) => [key, process.env[key]]));
}

function restoreEnv(previous) {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

main().catch((error) => {
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exitCode = 1;
});
```

- [ ] **Step 2: Add package script**

In `package.json` scripts, add:

```json
"probe:real:opencode-shared-root-cross-session": "pnpm run build && node scripts/probe-retinue-opencode-shared-root-cross-session.mjs"
```

- [ ] **Step 3: Update CI guardrail test**

In `tests/ci-package-guardrails.test.ts`, include the new script in the allowed explicit real probe script regex and assert it is not part of default `test`, `build`, or `gate:release`.

- [ ] **Step 4: Run guardrail tests**

Run:

```bash
pnpm run test:probes
```

Expected: PASS.

- [ ] **Step 5: Commit probe**

Run:

```bash
git add package.json scripts/probe-retinue-opencode-shared-root-cross-session.mjs tests/ci-package-guardrails.test.ts
git commit -m "test: add shared-root cross-session probe"
```

Expected: commit succeeds.

## Task 6: Update Dogfood Defaults And Docs

**Files:**
- Modify: `scripts/probe-retinue-opencode-dogfood.mjs`
- Modify: `docs/how-to/verify.md`
- Modify: `docs/runbooks/real-opencode-probes.md`
- Modify: `docs/reference/backends/opencode.md`
- Modify: `docs/reference/configuration.md`

- [ ] **Step 1: Default dogfood to shared-root**

In `scripts/probe-retinue-opencode-dogfood.mjs`, change:

```js
const modes = (value ? value.split(",") : ["per_spawn"]).map((mode) => mode.trim()).filter(Boolean);
```

to:

```js
const modes = (value ? value.split(",") : ["shared_root"]).map((mode) => mode.trim()).filter(Boolean);
```

- [ ] **Step 2: Remove obsolete normal-product MCP arguments from dogfood**

In the `spawn_agent` arguments inside `scripts/probe-retinue-opencode-dogfood.mjs`, remove:

```js
access_mode: accessMode,
bash_policy: "readonly_git",
```

Keep `accessMode` in output only if the script still needs to describe old comparison runs; otherwise remove the parser and output field.

- [ ] **Step 3: Update docs**

Update docs to say:

```markdown
The default OpenCode root binding mode is `shared_root`. Use `RETINUE_OPENCODE_ROOT_BINDING_MODE=per_spawn` only for legacy compatibility, isolation probes, or debugging.
```

Update the comparison command to:

```bash
RETINUE_DOGFOOD_OPENCODE_ROOT_BINDING_MODE_LIST=shared_root,per_spawn pnpm run gate:dogfood
```

Add the cross-session probe command:

```bash
pnpm run probe:real:opencode-shared-root-cross-session
RETINUE_CROSS_SESSION_WRITABLE=1 pnpm run probe:real:opencode-shared-root-cross-session
```

Explain that the second command is opt-in and writes only to a probe workspace unless `RETINUE_CROSS_SESSION_CWD` is explicitly provided.

- [ ] **Step 4: Run docs/package guardrail tests**

Run:

```bash
pnpm run test:probes
```

Expected: PASS.

- [ ] **Step 5: Commit dogfood/docs**

Run:

```bash
git add scripts/probe-retinue-opencode-dogfood.mjs docs/how-to/verify.md docs/runbooks/real-opencode-probes.md docs/reference/backends/opencode.md docs/reference/configuration.md
git commit -m "docs: update shared-root dogfood guidance"
```

Expected: commit succeeds.

## Task 7: Real Dogfood And Package Reload

**Files:**
- No source changes expected unless a gate exposes a bug.

- [ ] **Step 1: Run fast deterministic gates**

Run:

```bash
pnpm run gate:fast
```

Expected: PASS.

- [ ] **Step 2: Run shared-root dogfood**

Run:

```bash
pnpm run gate:dogfood
```

Expected: PASS or a provider/runtime diagnostic that is not a Retinue lifecycle regression. If it fails, inspect the compact audit output first:

```bash
pnpm run audit:logs -- --max-lines 120
```

- [ ] **Step 3: Run explicit mode comparison**

Run:

```bash
RETINUE_DOGFOOD_OPENCODE_ROOT_BINDING_MODE_LIST=shared_root,per_spawn pnpm run gate:dogfood
```

Expected: both modes produce separated `externalRunnerMode`, `externalRootSessionId`, `externalParentSessionId`, and `externalSessionId` fields. Do not treat provider stalls as topology proof.

- [ ] **Step 4: Run cross-session topology probe**

Run:

```bash
pnpm run probe:real:opencode-shared-root-cross-session
```

Expected: `ok: true`, one root id for group A, one root id for group B, and different root ids across A and B.

- [ ] **Step 5: Run writable probe only after confirming local OpenCode model health**

Run:

```bash
RETINUE_CROSS_SESSION_WRITABLE=1 pnpm run probe:real:opencode-shared-root-cross-session
```

Expected: `ok: true`; marker text contains child-written lines, or the probe reports permission requests that can be replied through Retinue. Provider malformed tool calls are runtime evidence, not proof that Retinue should block writable children by default.

- [ ] **Step 6: Run local release gate**

Run:

```bash
pnpm run gate:local
```

Expected: PASS.

- [ ] **Step 7: Sync installed plugin cache**

Run:

```bash
pnpm run build
pnpm run smoke:package
pnpm run dev:sync-plugin-cache:all -- --apply
```

Expected: build, package smoke, and cache sync all pass.

- [ ] **Step 8: Commit any gate fixes**

If gates required follow-up edits, commit them:

```bash
git add <changed-files>
git commit -m "fix: stabilize shared-root opencode rollout"
```

Expected: commit succeeds, or skip if there were no changes.

## Task 8: Close Out And Push

**Files:**
- Modify: beads issue `RET-uld`

- [ ] **Step 1: Close beads issue**

Run:

```bash
bd close RET-uld --reason="Implemented shared-root default plan, writable OpenCode child coverage, and cross-session probe."
```

Expected: issue closes.

- [ ] **Step 2: Push beads and git changes**

Run:

```bash
bd dolt push
git pull --rebase
git push
git status
```

Expected: git status reports branch up to date with origin.

- [ ] **Step 3: Handoff**

Tell the user:

```text
Shared-root is now the default OpenCode topology. Existing hosts need a Codex/Hermes restart to load the synced plugin cache. per_spawn remains available via RETINUE_OPENCODE_ROOT_BINDING_MODE=per_spawn.
```

## Self-Review

- Spec coverage: The plan covers default shared-root, per-spawn legacy/fallback, writable children through OpenCode agent permissions, single-Codex cross-session simulation, and opt-in real probes.
- Placeholder scan: No task uses placeholder language. Each code-changing task names files and concrete edits.
- Type consistency: The plan uses existing fields `externalRunnerMode`, `externalRootSessionId`, `externalParentSessionId`, `externalSessionId`, `RETINUE_OPENCODE_ROOT_BINDING_MODE`, and `agent`.
- Risk: The probe script code may need small adjustments to match current MCP SDK result typing, but the intended contract and expected output are concrete.
