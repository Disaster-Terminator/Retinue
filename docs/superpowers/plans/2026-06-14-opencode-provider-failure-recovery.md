# OpenCode Provider Failure Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Improve Retinue recovery from OpenCode/provider stalls without modifying OpenCode source or expanding retry behavior before the trust boundary is documented.

**Architecture:** OpenCode remains the execution owner: provider retry, session history, tools, profile, permissions, and child-agent semantics stay OpenCode-native. Retinue owns MCP job state, stall classification, recovery decisions, bounded attempt provenance, and compact evidence handoff when a fresh task-level attempt is already selected.

**Tech Stack:** TypeScript, Vitest, Retinue OpenCode backend, OpenCode SDK/HTTP session APIs, project docs.

---

### Task 1: Document The Recovery Boundary

**Files:**
- Modify: `docs/explanation/project-boundary.md`
- Modify: `docs/explanation/attempt-recovery.md`
- Modify: `docs/reference/backends/opencode.md`

- [ ] **Step 1: Update project boundary**

  Add a recovery ownership section to `docs/explanation/project-boundary.md` that states OpenCode owns execution, profile, permissions, native retries, and structured session state; Retinue owns classification, budget, provenance, and MCP-facing recovery outcomes.

- [ ] **Step 2: Update attempt recovery semantics**

  Update `docs/explanation/attempt-recovery.md` so finalization rescue is explicitly a no-tools final-answer rescue, not a general "continue until done" mechanism. Add a separate section for future continue-task rescue and state that it needs a separate trigger decision.

- [ ] **Step 3: Link the boundary from the OpenCode backend reference**

  Add a short pointer in `docs/reference/backends/opencode.md` that recovery behavior follows `docs/explanation/attempt-recovery.md` and does not require OpenCode source changes.

- [ ] **Step 4: Verify docs references**

  Run: `pnpm run test:package`
  Expected: package guardrails and docs/package tests pass.

### Task 2: Improve Finalization Rescue Observability

**Files:**
- Modify: `src/backends/opencode/backend.ts`
- Modify: `src/core/types.ts`
- Modify: `src/mcp.ts`
- Test: `tests/opencode-backend.test.ts`

- [ ] **Step 1: Add diagnostic fields**

  Add optional fields for the active finalization rescue decision:
  `softStallRescueStrategy`, `softStallRescueAgent`, `softStallRescueModel`, `softStallRescueTools`, and `softStallRescueSubmittedAt`.

- [ ] **Step 2: Populate fields when rescue is submitted**

  In `maybeSubmitSoftStallRescue`, resolve the rescue agent once, record the submitted timestamp, record the selected model string if present, and mark the strategy as `final_answer_no_tools`.

- [ ] **Step 3: Include fields in MCP diagnostics**

  Add the fields to compact MCP diagnostics so callers can distinguish no steering, final-answer steering, and later escalation without reading raw logs.

- [ ] **Step 4: Test the trace and diagnostics**

  Extend an existing soft-stall rescue test to assert the trace contains `softStallRescueStrategy`, `softStallRescueAgent`, and `softStallRescueTools`, and that the rescue prompt still disables tools.

- [ ] **Step 5: Verify focused tests**

  Run: `pnpm run test:opencode`
  Expected: OpenCode backend tests pass.

### Task 3: Prepare Capsule Implementation Scope

**Files:**
- Modify: `docs/explanation/attempt-recovery.md`
- Create or modify later: OpenCode backend capsule helper and tests.

- [ ] **Step 1: Record capsule constraints**

  Document that the first capsule implementation must not increase retry count, expand trigger eligibility, trust stalled final text, parse raw provider logs, or create a second OpenCode session model.

- [ ] **Step 2: Leave implementation gated by RET-dwy.2**

  Do not implement capsule in this plan execution until `RET-dwy.1` is closed and `RET-dwy.2` is claimed.

### Task 4: Final Verification And Handoff

**Files:**
- Existing project files only.

- [ ] **Step 1: Run fast gate**

  Run: `pnpm run gate:fast`
  Expected: typecheck, core, MCP, and package tests pass.

- [ ] **Step 2: Build and sync plugin cache if source changed**

  Run:
  ```bash
  pnpm run build
  pnpm run smoke:package
  pnpm run dev:sync-plugin-cache:all -- --apply
  ```
  Expected: build, package smoke, and plugin cache sync pass.

- [ ] **Step 3: Update bd and commit**

  Close completed issues, commit docs/code/tests, and push according to project instructions.
