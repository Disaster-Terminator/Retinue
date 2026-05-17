# User Facing Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the package understandable and runnable for a new local user without reading source code.

**Architecture:** Keep code unchanged unless documentation reveals a package contract problem. Consolidate user-facing guidance in README and small docs: quickstart, environment variables, MCP config, daemon lifecycle, output bounds, cleanup, fake and real verification, troubleshooting.

**Tech Stack:** Markdown docs, existing npm scripts, existing CLI/MCP/daemon entrypoints, deterministic fake-Claude tests.

---

## File Structure

- Modify `README.md`: add a short first-run quickstart, bin/entrypoint guidance, environment variable table, example MCP config, daemon config, result/cleanup guidance, and troubleshooting links.
- Modify `docs/SERVICE_LIFECYCLE.md`: add daemon command variants and inspect/stop examples for both PowerShell and Bash.
- Modify `docs/REAL_CLAUDE_PROBES.md`: link fake dry-run probes back to quickstart expectations if needed.
- Modify `docs/VERIFICATION.md`: record the user-facing polish baseline after deterministic gates.
- Modify `package.json`: add a package `files` whitelist if `npm pack --dry-run --json` shows stale build outputs or missing runtime artifacts.
- Do not add auto-start, provider routing, or service installation.

## Task 1: README Quickstart And User Contract

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add first-run quickstart**

Add a `## Quickstart` section after the product intro with this flow:

```bash
npm install
npm run build
npm run typecheck
npm test
```

Then show a fake job dry run:

```bash
RETINUE_CLAUDE_COMMAND=node RETINUE_CLAUDE_PREFIX_ARGS=tests/fixtures/fake-claude.mjs node dist/cli.js run --cwd . --prompt "hello"
node dist/cli.js wait <jobId> --timeout-ms 30000
node dist/cli.js result <jobId>
```

Add a sentence that PowerShell users should set the two environment variables with `$env:`.

- [ ] **Step 2: Add entrypoints and environment variable table**

Add a section listing:

- `retinue` -> `dist/cli.js`
- `retinue-mcp` -> `dist/mcp.js`
- `retinue-daemon` -> `dist/daemon.js`

Add a table for:

- `RETINUE_STATE_DIR`
- `RETINUE_CLAUDE_COMMAND`
- `RETINUE_CLAUDE_PREFIX_ARGS`
- `RETINUE_DAEMON_URL`
- `RETINUE_DAEMON_DISCOVERY`
- `RETINUE_DEFAULT_RUNTIME_TIMEOUT_MS`
- `RETINUE_MAX_CONCURRENT_JOBS`

- [ ] **Step 3: Add MCP config example**

Add a JSON example:

```json
{
  "mcpServers": {
    "retinue": {
      "command": "node",
      "args": ["G:/repository/retinue/dist/mcp.js"],
      "env": {
        "RETINUE_DAEMON_DISCOVERY": "1"
      }
    }
  }
}
```

State that `RETINUE_DAEMON_URL` can be used instead when the daemon URL is fixed.

- [ ] **Step 4: Add output and cleanup guidance**

Explain that MCP/CLI results are bounded by default and include `stdoutPath` and `stderrPath` for full artifacts. Add cleanup examples:

```bash
node dist/cli.js cleanup --older-than-ms 86400000
```

Mention that cleanup preserves `running` and `abandoned` jobs.

## Task 2: Service Lifecycle Polish

**Files:**
- Modify: `docs/SERVICE_LIFECYCLE.md`

- [ ] **Step 1: Add platform-specific inspect commands**

Add PowerShell:

```powershell
curl.exe http://127.0.0.1:27777/health
Get-Content <stateDir>\daemon.json
Stop-Process -Id <pid>
```

Add Bash:

```bash
curl http://127.0.0.1:27777/health
cat <stateDir>/daemon.json
kill <pid>
```

- [ ] **Step 2: Add explicit config notes**

State:

- bind host and port are explicit: `--host 127.0.0.1 --port 27777`
- discovery remains opt-in for clients
- no command installs services or startup hooks

## Task 3: Package File Whitelist And Verification Notes

**Files:**
- Modify: `package.json`
- Modify: `docs/VERIFICATION.md`

- [ ] **Step 1: Add package file whitelist**

Add a `files` list that includes runtime entrypoints, docs, scripts, and the fake-Claude fixture:

```json
"files": [
  "README.md",
  "dist/cli.*",
  "dist/core/**",
  "dist/daemon.*",
  "dist/daemon/**",
  "dist/mcp.*",
  "docs/**",
  "scripts/**",
  "tests/fixtures/**"
]
```

- [ ] **Step 2: Add user-facing polish baseline**

Record:

- README now has quickstart, entrypoints, env table, MCP config, output bounds, cleanup, and troubleshooting guidance.
- Service lifecycle docs include PowerShell and Bash inspect/stop commands.
- `npm pack --dry-run --json` confirms the tarball includes runtime `dist/` entrypoints and excludes stale `dist/src` and `dist/tests` outputs.
- No service auto-start, provider routing, or permission bypass was added.

- [ ] **Step 3: Run deterministic Windows gates**

Run:

```bash
npm run typecheck
npm test
npm run build
```

Expected: PASS.

- [ ] **Step 4: Run packaging dry-run**

Run:

```bash
npm pack --dry-run
```

Expected: package metadata is printed and includes README, docs, `dist/`, `src/`, scripts, and tests. If `dist/` is missing, stop and fix the packaging contract before committing.

## Task 4: Commit And WSL

**Files:**
- All files above

- [ ] **Step 1: Commit P7 polish**

```bash
git add README.md docs/SERVICE_LIFECYCLE.md docs/VERIFICATION.md package.json docs/superpowers/plans/2026-05-04-user-facing-polish.md
git commit -m "docs: polish local user quickstart"
git push origin feature/spawn-claude-code
```

- [ ] **Step 2: WSL fresh clone gate**

Run:

```bash
rtk wsl.exe -e bash -lc 'set -euo pipefail; d=$(mktemp -d /tmp/retinue-user-polish-wsl-test-XXXXXX); git clone /mnt/g/repository/retinue "$d" >/dev/null; cd "$d"; git checkout feature/spawn-claude-code >/dev/null; npm ci; npm run typecheck; npm test; npm run build; echo WSL_TEST_DIR="$d"'
```

Expected: PASS.

- [ ] **Step 3: Record WSL verification**

Update `docs/VERIFICATION.md`, then commit and push:

```bash
git add docs/VERIFICATION.md
git commit -m "docs: add wsl user polish verification"
git push origin feature/spawn-claude-code
```

## Self-Review

Spec coverage:

- Package bin correctness: README lists package bin entrypoints and existing tests cover daemon bin exposure.
- README quickstart: Task 1.
- Troubleshooting section: Task 1.
- State directory explanation: Task 1 and existing safety section.
- Environment variables table: Task 1.
- Example MCP config: Task 1.
- Example daemon config: Task 2.
- Bounded output behavior: Task 1.
- Cleanup policy: Task 1.
- New user acceptance path: quickstart plus service lifecycle plus real probe docs.

Placeholder scan:

- No placeholder markers are used.
