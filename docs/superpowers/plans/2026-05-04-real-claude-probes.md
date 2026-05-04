# Real Claude Probe Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add repeatable opt-in real Claude Code verification for direct CLI, daemon CLI, and MCP-to-daemon flows without adding real Claude to default tests.

**Architecture:** Keep deterministic Vitest suites fake-Claude only. Add a Node script under `scripts/` that a user explicitly runs after `npm run build`; it calls the built CLI/MCP/daemon surfaces and validates a known result string. Document the manual Windows, WSL, daemon, MCP-to-daemon, and cc-switch boundary probes in a separate runbook linked from verification notes.

**Tech Stack:** Node.js built-ins, built `dist/` entrypoints, `@modelcontextprotocol/sdk` stdio client, Vitest for script helper tests.

---

## File Structure

- Create `scripts/probe-real-claude.mjs`: opt-in probe runner. It supports `direct`, `daemon`, and `mcp-daemon` modes; it never runs from default tests.
- Create `tests/probe-real-claude.test.ts`: deterministic tests for argument parsing and result validation helpers exported by the probe script.
- Modify `package.json`: add explicit `probe:real:*` scripts. Do not add them to `test`, `build`, or any default lifecycle script.
- Create `docs/REAL_CLAUDE_PROBES.md`: copyable manual runbook for Windows real CLI, WSL fresh clone deterministic gate, daemon real probe, MCP-to-daemon real probe, fake probe dry-run, and cc-switch boundary.
- Modify `docs/VERIFICATION.md`: separate deterministic suites from manual/opt-in real probes and point to the runbook.
- Modify `README.md`: link the real probe runbook from the Verify section.

## Task 1: Probe Helper Tests

**Files:**
- Create: `tests/probe-real-claude.test.ts`
- Create later: `scripts/probe-real-claude.mjs`

- [ ] **Step 1: Write failing helper tests**

Create `tests/probe-real-claude.test.ts`:

```js
import { describe, expect, it } from "vitest";
import { assertExpectedResult, parseProbeArgs, readJsonOutput } from "../scripts/probe-real-claude.mjs";

describe("real Claude probe helpers", () => {
  it("parses mode and common probe flags", () => {
    expect(
      parseProbeArgs([
        "daemon",
        "--cwd",
        "G:/repository/supervisor",
        "--expect",
        "SUPERVISOR_REAL_OK",
        "--timeout-ms",
        "120000"
      ])
    ).toMatchObject({
      mode: "daemon",
      cwd: "G:/repository/supervisor",
      expected: "SUPERVISOR_REAL_OK",
      timeoutMs: 120000
    });
  });

  it("rejects unknown probe modes", () => {
    expect(() => parseProbeArgs(["unknown"])).toThrow("Unknown probe mode: unknown");
  });

  it("reads JSON from command stdout", () => {
    expect(readJsonOutput("noise\n{\"jobId\":\"abc\",\"status\":\"running\"}\n")).toEqual({
      jobId: "abc",
      status: "running"
    });
  });

  it("validates the parsed Claude result text", () => {
    expect(() =>
      assertExpectedResult(
        {
          status: "completed",
          exitCode: 0,
          parsedStdout: { result: "SUPERVISOR_REAL_OK" }
        },
        "SUPERVISOR_REAL_OK"
      )
    ).not.toThrow();

    expect(() =>
      assertExpectedResult(
        {
          status: "completed",
          exitCode: 0,
          parsedStdout: { result: "wrong" }
        },
        "SUPERVISOR_REAL_OK"
      )
    ).toThrow("Expected Claude result");
  });
});
```

- [ ] **Step 2: Run the failing test**

Run: `npm test -- tests/probe-real-claude.test.ts`

Expected: FAIL because `scripts/probe-real-claude.mjs` does not exist.

## Task 2: Probe Runner

**Files:**
- Create: `scripts/probe-real-claude.mjs`
- Test: `tests/probe-real-claude.test.ts`

- [ ] **Step 1: Implement exported helpers and modes**

Create `scripts/probe-real-claude.mjs` with these concrete behaviors:

- `parseProbeArgs(argv)` returns `{ mode, cwd, prompt, expected, timeoutMs, host, port, stateDir }`.
- Default mode is `direct`.
- Valid modes are `direct`, `daemon`, and `mcp-daemon`.
- Default prompt is `Reply exactly: SUPERVISOR_REAL_OK`.
- Default expected result is `SUPERVISOR_REAL_OK`.
- `readJsonOutput(stdout)` returns the first parseable JSON object from stdout.
- `assertExpectedResult(result, expected)` requires `status: "completed"`, `exitCode: 0`, and `parsedStdout.result === expected`.
- `direct` calls `node dist/cli.js run`, `wait`, and `result`.
- `daemon` starts `node dist/daemon.js --host <host> --port <port>`, reads readiness JSON, then calls the CLI through `SUPERVISOR_DAEMON_URL`.
- `mcp-daemon` starts the daemon, starts `node dist/mcp.js` through `StdioClientTransport`, calls `claude_run`, `claude_wait`, and `claude_result`, then validates the same result.
- Any daemon/MCP child process created by the script is closed in `finally`.

- [ ] **Step 2: Run helper tests**

Run: `npm test -- tests/probe-real-claude.test.ts`

Expected: PASS.

- [ ] **Step 3: Run fake-Claude dry-run probes**

Run after `npm run build`:

```bash
SUPERVISOR_CLAUDE_COMMAND=node SUPERVISOR_CLAUDE_PREFIX_ARGS=tests/fixtures/fake-claude.mjs node scripts/probe-real-claude.mjs direct --expect "fake result: Reply exactly: SUPERVISOR_REAL_OK"
SUPERVISOR_CLAUDE_COMMAND=node SUPERVISOR_CLAUDE_PREFIX_ARGS=tests/fixtures/fake-claude.mjs node scripts/probe-real-claude.mjs daemon --expect "fake result: Reply exactly: SUPERVISOR_REAL_OK"
SUPERVISOR_CLAUDE_COMMAND=node SUPERVISOR_CLAUDE_PREFIX_ARGS=tests/fixtures/fake-claude.mjs node scripts/probe-real-claude.mjs mcp-daemon --expect "fake result: Reply exactly: SUPERVISOR_REAL_OK"
```

Expected: each prints JSON with `ok: true`, `mode`, `jobId`, and `result`.

## Task 3: Package Scripts And Docs

**Files:**
- Modify: `package.json`
- Create: `docs/REAL_CLAUDE_PROBES.md`
- Modify: `docs/VERIFICATION.md`
- Modify: `README.md`

- [ ] **Step 1: Add opt-in package scripts**

Add:

```json
"probe:real:direct": "node scripts/probe-real-claude.mjs direct",
"probe:real:daemon": "node scripts/probe-real-claude.mjs daemon",
"probe:real:mcp-daemon": "node scripts/probe-real-claude.mjs mcp-daemon"
```

Do not reference these from `test`, `build`, or `typecheck`.

- [ ] **Step 2: Add real probe runbook**

Create `docs/REAL_CLAUDE_PROBES.md` with sections:

- Deterministic gates first: `npm run typecheck`, `npm test`, `npm run build`
- Fake dry-run probes using `SUPERVISOR_CLAUDE_COMMAND=node` and `SUPERVISOR_CLAUDE_PREFIX_ARGS=tests/fixtures/fake-claude.mjs`
- Windows real CLI direct probe: `npm run probe:real:direct`
- WSL fresh clone deterministic gate command
- Daemon mode real probe: `npm run probe:real:daemon`
- MCP-to-daemon real probe: `npm run probe:real:mcp-daemon`
- cc-switch boundary: supervisor invokes only the system `claude`; routing/quota stay in Claude Code configuration
- Safety notes: opt-in only, may consume quota, no permission bypass, no service install

- [ ] **Step 3: Update verification notes and README**

In `docs/VERIFICATION.md`, add a short "Manual And Opt-In Real Probes" section before the observed real Windows probe. In `README.md`, link `docs/REAL_CLAUDE_PROBES.md` under Verify.

## Task 4: Verification And Commits

**Files:**
- All files above

- [ ] **Step 1: Run deterministic Windows gates**

Run:

```bash
npm run typecheck
npm test
npm run build
```

Expected: PASS, with the new probe helper test included.

- [ ] **Step 2: Run opt-in fake dry-run probes**

Run the three fake dry-run commands from Task 2.

Expected: PASS, each with `ok: true`.

- [ ] **Step 3: Commit P6 implementation**

```bash
git add package.json scripts/probe-real-claude.mjs tests/probe-real-claude.test.ts docs/REAL_CLAUDE_PROBES.md docs/VERIFICATION.md README.md docs/superpowers/plans/2026-05-04-real-claude-probes.md
git commit -m "feat: add opt-in real claude probes"
git push origin feature/spawn-claude-code
```

- [ ] **Step 4: WSL fresh clone gate**

Run:

```bash
rtk wsl.exe -e bash -lc 'set -euo pipefail; d=$(mktemp -d /tmp/supervisor-real-probes-wsl-test-XXXXXX); git clone /mnt/g/repository/supervisor "$d" >/dev/null; cd "$d"; git checkout feature/spawn-claude-code >/dev/null; npm ci; npm run typecheck; npm test; npm run build; echo WSL_TEST_DIR="$d"'
```

Expected: PASS.

- [ ] **Step 5: Record WSL verification**

Update `docs/VERIFICATION.md` with the WSL result, then commit and push:

```bash
git add docs/VERIFICATION.md
git commit -m "docs: add wsl real probe verification"
git push origin feature/spawn-claude-code
```

## Self-Review

Spec coverage:

- Windows real Claude Code probe: covered by runbook and `probe:real:direct`.
- WSL fresh clone probe: covered by runbook and WSL gate task.
- Daemon mode probe: covered by `probe:real:daemon`.
- MCP-to-daemon probe: covered by `probe:real:mcp-daemon`.
- cc-switch boundary statement: covered by runbook and verification notes.
- No default real Claude dependency: package scripts are opt-in and default `test` remains Vitest with fake Claude.

Placeholder scan:

- No placeholder markers are used.

Type consistency:

- Script helper names in tests match the planned exports: `parseProbeArgs`, `readJsonOutput`, and `assertExpectedResult`.
