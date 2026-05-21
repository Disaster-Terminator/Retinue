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

- OpenCode has built-in primary agents `build` and `plan`.
- OpenCode has built-in subagents `general`, `explore`, and `scout`.
- `plan` is intended for analysis and planning without direct modifications, but its semantic is still "suggest changes or plans", not necessarily "quick read-only repository exploration".
- `explore` is OpenCode's built-in fast read-only codebase exploration subagent. It cannot modify files according to the current official docs.
- Agent permissions are first-class. Legacy `tools` booleans are deprecated in favor of `permission`, but still supported.
- `edit` gates modification tools such as `write`, `edit`, and `apply_patch`.
- `bash` can be constrained by pattern. Last matching rule wins.
- `opencode agent create` can create agents non-interactively; omitted permissions are denied.

Local environment:

- `opencode --version` returned `1.15.0`.
- `opencode debug paths` reported config at `/home/raystorm/.config/opencode`.
- The local OpenCode config is permissive for the main user profile (`edit: allow`, broad bash allow with some deny/ask rules), so Retinue cannot rely on the user's profile as the read-only boundary.

### Previous Strict Retinue Behavior

Retinue originally stacked several read-only guard layers:

- `src/backends/opencode/backend.ts` creates read-only session permissions for OpenCode sessions.
- It denies `edit`, `write`, `apply_patch`, `patch`, `task`, `question`, `external_directory`, `doom_loop`, and arbitrary `bash`.
- With `readonly_git`, it re-allows a small read-only git command allowlist.
- It passes prompt-level tool denial to `prompt_async`: `edit`, `write`, `apply_patch`, `patch`, and `task` are disabled.
- It prepends `createReadOnlyPromptContract()` to tell the child to use read/grep/glob and allowed read-only git only, avoid patch mode, avoid unified diffs, keep inspection bounded, and finish with prose.

This research note describes an earlier design. The product path now removes the Retinue-owned access-mode layer and lets OpenCode profile and agent semantics own permissions for normal children.

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
- Recommended keeping Retinue's per-session permissions as the actual product boundary.
- Recommended considering a dedicated `readonly-review` agent only as an optional behavior-shaping layer, especially for Retinue-managed auto-serve mode.

## Architecture Direction

### Layer 1: Keep Retinue-Owned Read-Only Enforcement

Do not replace Retinue's per-session permission boundary with OpenCode profile configuration.

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

### Layer 3: Prefer OpenCode's Built-In Read-Only Agent Semantics

The previous default agent was `plan`. That was defensible early in 0.1.x because it is a primary agent and is explicitly analysis-oriented. Current evidence shows that this default likely overfits Retinue's own prompt contract instead of using OpenCode's built-in subagent design.

Evidence gathered on 2026-05-17:

- `opencode --version` returned `1.15.0`.
- `opencode agent list --pure` listed `explore (subagent)`.
- A real `RETINUE_REAL_OPENCODE_AGENT_AB_PROBE=1 RETINUE_OPENCODE_AGENT_LIST=plan,explore` run completed all 3 `plan` jobs and all 3 `explore` jobs with `0` stalled jobs and `0` read-only write-intent jobs.
- The returned OpenCode message metadata confirmed `lastAssistantAgent=explore` and `lastAssistantMode=explore`, so `prompt_async(agent: "explore")` can target the built-in subagent directly in the local OpenCode 1.15.0 server path.
- A real `RETINUE_DOGFOOD_OPENCODE_AGENT_LIST=explore pnpm run gate:dogfood` run completed all 3 dogfood jobs with `0` stalled jobs and `0` read-only write-intent jobs.
- A parallel live Retinue dogfood review using the default `plan` path stalled with `stallReason=read_tool_stalled` after 6 tool-call assistant rounds and one running `read` tool call. That does not prove `plan` is always worse, but it is enough to stop treating `plan` as the safer default.

Recommended direction:

1. Use OpenCode's built-in `explore` as the default Retinue OpenCode read-only agent.
2. Keep Retinue's session-level OpenCode permission as the MCP product boundary, because MCP callers need a stable read-only default even when the user's OpenCode profile is permissive. Treat Retinue's prompt contract and `tools: false` overrides as optional stricter mode, not the default path.
3. Do not introduce a Retinue-owned custom OpenCode agent for 0.1.0. Custom agents remain a later workflow feature if real usage proves that built-in `explore` is insufficient.
4. Keep write-intent recovery as a follow-up hardening item, not a prerequisite for changing the default agent.

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
- Keep the OpenCode agent comparison probe focused on `plan` vs `explore` as a compatibility diagnostic.

## Non-Goals For The Next Iteration

- Do not allow default read-only agents to write.
- Do not make the user's OpenCode profile the security boundary.
- Do not require users to install a custom OpenCode agent before Retinue works.
- Do not build a Retinue-owned custom agent until the built-in `explore` path has been exhausted.
- Do not change the default backend away from OpenCode.
- Do not reintroduce a product-level `access_mode` switch unless OpenCode-native profile and agent semantics are proven insufficient.

## Open Questions

1. Is `prompt_async(agent: "explore")` stable across Windows and WSL OpenCode 1.15.x deployments, not only the current WSL run?
2. Does `mode: subagent` keep behaving correctly under direct `prompt_async` in future OpenCode releases, or should Retinue add a startup compatibility check?
3. Should write-intent recovery use the current configured agent, `build` with tools disabled, or a dedicated recovery agent?
4. Should recovered write intent be surfaced as a warning in `stdout`, `stderr`, or diagnostic only?

## Current Recommendation

Switch the default Retinue OpenCode read-only agent to built-in `explore`, then continue dogfood on Windows and WSL.

This reduces Retinue-specific behavior shaping and follows OpenCode's native agent design without requiring a custom agent. Retinue should still preserve the MCP-side read-only boundary and diagnostics, because that boundary is product behavior for Codex and Hermes callers rather than an OpenCode profile preference.
