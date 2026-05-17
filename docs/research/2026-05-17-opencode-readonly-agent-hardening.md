# OpenCode Read-Only Agent Hardening

Date: 2026-05-17

## Problem

Retinue's default OpenCode backend is intended to provide safe read-only subagents for Codex and Hermes. Recent WSL and Windows dogfood runs exposed a product gap:

- Retinue blocks direct writes and patch intent in read-only mode.
- The child can still choose a write-shaped reasoning path and emit patch/write intent.
- Retinue currently treats that as `read_only_write_intent` and returns a terminal `stalled` result.
- That is safe, but it is not good product behavior: a read-only review child should usually recover and return useful prose to the caller.

The target behavior is not "let the child write." The target is:

> Default read-only children stay write-blocked, but if they attempt a write-shaped answer, Retinue should steer them back to plain-text review output instead of immediately losing the result.

## Evidence Gathered

### OpenCode Capabilities

Official OpenCode documentation says agents can be configured with custom prompts, models, modes, steps, and permissions:

- Agents overview: <https://opencode.ai/docs/agents/>
- Permissions: <https://opencode.ai/docs/permissions/>
- CLI agent management: <https://opencode.ai/docs/cli/>

Relevant facts from the docs:

- OpenCode has built-in primary agents such as `build` and `plan`.
- `plan` is intended for analysis and planning without direct modifications, but its semantic is still "suggest changes or plans", not necessarily "produce only review findings".
- OpenCode also has read-only exploration-oriented agents, including `explore` in current docs.
- Agent permissions are first-class. Legacy `tools` booleans are deprecated in favor of `permission`, but still supported.
- `edit` gates modification tools such as `write`, `edit`, and `apply_patch`.
- `bash` can be constrained by pattern. Last matching rule wins.
- `opencode agent create` can create agents non-interactively; omitted permissions are denied.

Local environment:

- `opencode --version` returned `1.15.0`.
- `opencode debug paths` reported config at `/home/raystorm/.config/opencode`.
- The local OpenCode config is permissive for the main user profile (`edit: allow`, broad bash allow with some deny/ask rules), so Retinue cannot rely on the user's profile as the read-only boundary.

### Current Retinue Behavior

Retinue already has several read-only guard layers:

- `src/backends/opencode/backend.ts` creates read-only session permissions for OpenCode sessions.
- It denies `edit`, `write`, `apply_patch`, `patch`, `task`, `question`, `external_directory`, `doom_loop`, and arbitrary `bash`.
- With `readonly_git`, it re-allows a small read-only git command allowlist.
- It passes prompt-level tool denial to `prompt_async`: `edit`, `write`, `apply_patch`, `patch`, and `task` are disabled.
- It prepends `createReadOnlyPromptContract()` to tell the child to use read/grep/glob and allowed read-only git only, avoid patch mode, avoid unified diffs, keep inspection bounded, and finish with prose.

Current stall classification:

- `computeStallDiagnostic()` classifies read-only patch or write tool parts as `read_only_write_intent`.
- `isHardStallDiagnostic()` treats `readOnlyWriteIntent` and `provider_error` as hard stalls.
- `wait()` only submits the no-tools final-answer rescue prompt for non-hard stalls.
- Therefore `read_only_write_intent` bypasses the soft-stall recovery path and returns as terminal `stalled`.

This explains the observed user-facing failure: Retinue is safe, but a child that tries to patch cannot be salvaged into useful review text.

### Cross-Validation Results

Retinue low-cost read-only scans:

- `readonly-state-machine-scan` confirmed that `read_only_write_intent` is currently hard-stalled and identified the relevant paths: classification, hard-vs-soft stall check, rescue submission, and result handling.
- `readonly-docs-tests-scan` confirmed tests/docs cover write-intent detection and soft-stall rescue independently, but not write-intent recovery.

High-reasoning Codex subagent review:

- Agreed that custom OpenCode agents can improve behavior but cannot be the security boundary.
- Recommended keeping Retinue's per-session permissions and per-call tool denial as the actual boundary.
- Recommended considering a dedicated `readonly-review` agent only as an optional behavior-shaping layer, especially for Retinue-managed auto-serve mode.

## Architecture Direction

### Layer 1: Keep Retinue-Owned Read-Only Enforcement

Do not replace Retinue's per-session permission and per-call tool denial with OpenCode profile configuration.

Reasons:

- User OpenCode profiles may be permissive.
- Attach mode may point to an externally managed OpenCode server where Retinue cannot assume a custom agent exists.
- OpenCode agent prompt/permission is useful, but it is not enough as the product security boundary.

Retinue must keep enforcing read-only at spawn time.

### Layer 2: Add Write-Intent Recovery

Current behavior:

```text
read-only child emits patch/write intent -> hard stalled -> caller gets no trusted review result
```

Target behavior:

```text
read-only child emits patch/write intent
-> Retinue records the violation
-> Retinue submits one no-tools recovery prompt
-> child must convert already gathered facts into plain-text findings
-> if successful: completed with recoveredFromReadOnlyWriteIntent=true
-> if it emits patch/write intent again or produces no useful text: stalled
```

Important implementation detail:

The recovery cannot simply make `read_only_write_intent` a normal soft stall in the same way as `read_tool_stalled`. Old patch parts remain in the OpenCode session. If the stall diagnostic keeps scanning the whole job history, it will repeatedly see the old violation.

The recovery path needs a recovery baseline:

- record the message count or assistant count before submitting recovery;
- ignore pre-recovery patch/write intent when deciding whether the recovery succeeded;
- only trust assistant output after that recovery baseline;
- still reject any patch/write intent emitted after the recovery prompt.

Suggested metadata:

- `externalWriteIntentRecoverySubmittedAt`
- `externalWriteIntentRecoveryMessageBaselineCount`
- `externalWriteIntentRecoveryCompletedAssistantBaselineCount`
- `recoveredFromReadOnlyWriteIntent`

The final result should retain diagnostics that a violation happened, but should return `completed` only if the trusted post-recovery text is plain prose.

### Layer 3: Evaluate Better Read-Only Agent Semantics

The current default agent is `plan`. That is defensible for 0.1.x because it works without mutating user OpenCode config. But `plan` is not necessarily the best long-term semantics for review-only output.

Options to test:

1. Continue using `plan`, but improve recovery.
2. Use OpenCode's built-in `explore` for default read-only Retinue tasks if `prompt_async(agent: "explore")` is stable in OpenCode `1.15.x`.
3. In Retinue-managed auto-serve mode, optionally provide a Retinue-owned `readonly-review` agent with explicit review-only prompt and permissions.

Recommended order:

1. Implement write-intent recovery first.
2. Add an E2E probe comparing `plan` and `explore` for Retinue dogfood tasks.
3. Only after that, decide whether to change the default or add optional custom-agent provisioning.

## Testing Gaps

Needed unit tests:

- read-only child emits patch part, then recovery produces prose -> final status `completed`.
- read-only child emits write tool intent, then recovery produces prose -> final status `completed`.
- recovery emits patch/write intent again -> final status remains `stalled`.
- recovery produces no useful assistant text -> final status remains `stalled`.
- recovered result includes a diagnostic flag such as `recoveredFromReadOnlyWriteIntent`.
- pre-recovery patch parts are not trusted as final output.

Needed dogfood/E2E:

- `gate:dogfood` should continue to reject unrecovered `read_only_write_intent`.
- Add a targeted fake-OpenCode or real-OpenCode probe that exercises write-intent recovery.
- Add an optional OpenCode agent comparison probe for `plan` vs `explore`.

## Non-Goals For The Next Iteration

- Do not allow default read-only agents to write.
- Do not make the user's OpenCode profile the security boundary.
- Do not require users to install a custom OpenCode agent before Retinue works.
- Do not change the default backend away from OpenCode.
- Do not make `access_mode: profile` the default.

## Open Questions

1. Can `prompt_async(agent: "explore")` target OpenCode's built-in `explore` agent directly and reliably, or does the HTTP API expect primary agents only?
2. Does `mode: subagent` work with direct `prompt_async`, or should any Retinue-managed custom agent use `mode: all` or `primary`?
3. Should write-intent recovery use the current configured agent, `build` with tools disabled, or a dedicated recovery agent?
4. Should recovered write intent be surfaced as a warning in `stdout`, `stderr`, or diagnostic only?

## Current Recommendation

Proceed with write-intent recovery as the next implementation slice.

This directly addresses the user-visible failure mode while preserving the existing safety boundary. Dedicated OpenCode agent work should follow only after a small real E2E comparison proves it reduces stalls and write intent without increasing deployment complexity.
