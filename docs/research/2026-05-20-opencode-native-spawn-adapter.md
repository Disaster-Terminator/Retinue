# OpenCode Native Spawn Adapter Research

Date: 2026-05-20

## Context

Retinue has repeatedly exposed unstable behavior when it emulates a child-agent boundary around a standalone OpenCode session: read-tool stalls, zero-progress provider loops, and read-only jobs that still emit patch/write intent. Those are useful guardrails, but the architecture should prefer OpenCode's native session/subagent model when it exists instead of adding more Retinue-owned policy layers.

This note records the release-blocking architecture decision tracked in beads issue `RET-ygi`.

## Evidence

Local OpenCode server:

- Base URL: `http://127.0.0.1:4097`
- Health: `{"healthy":true,"version":"1.15.0"}`
- API document endpoint: `/doc`

OpenCode 1.15.0 exposes native spawn-relevant surfaces:

- `POST /session` accepts `parentID`, `agent`, `model`, `permission`, and `workspaceID`.
- `GET /session/{sessionID}/children` returns child sessions for a parent.
- `POST /session/{sessionID}/fork` creates a fork from a parent message.
- `POST /session/{sessionID}/prompt_async` accepts `SubtaskPartInput`.
- `SubtaskPartInput` requires `prompt`, `description`, and `agent`, with optional `model` and `command`.
- Native agents include primary agents (`build`, `plan`) and subagents (`explore`, `general`).

Real probe command:

```bash
pnpm run probe:real:opencode-native-spawn
```

Probe result summary:

| Path | Result | Meaning |
| --- | --- | --- |
| Current runner session + `prompt_async` | completed | The existing runner still works for simple deterministic prompts. |
| Explicit child session with `parentID` | completed | OpenCode records parent/child relation and `/children` returns the child. |
| Fork endpoint | created fork session | Fork exists, but the initial probe did not yet verify a completed fork reply. |
| `subtask` part on a parent prompt | completed, final text returned by parent | This is the strongest native candidate for Retinue-style spawn/result collection. |
| Agent `steps` surface | none in current agent summary | No actionable local `steps` contract was observed in this config. |

Retinue dogfood cross-check:

- A read-only Retinue review job produced useful text, but OpenCode also emitted a patch/write-intent part.
- Retinue correctly marked it `stalled` rather than trusting the job as clean read-only output.
- This supports reducing Retinue-owned prompt/policy emulation where OpenCode native subtask semantics can return a parent-level final answer.

## Decision

Retinue should not keep deepening the current standalone-session wrapper as the primary architecture.

The next backend direction should be a staged OpenCode-native adapter:

1. Keep the existing session runner as a compatibility fallback.
2. Add an experimental native-spawn path that drives OpenCode `subtask` parts from a parent session.
3. Preserve explicit child session and fork probes as diagnostics, not the first production path.
4. Keep Retinue access policy configurable, but avoid making Retinue pretend to be OpenCode's permission system.

## Acceptance For The Next Product Change

- A backend option can run a Retinue job through OpenCode native `subtask` and collect the parent final text.
- The option records parent/child session IDs in diagnostics when OpenCode exposes them.
- Current runner behavior and existing stall diagnostics remain available as fallback.
- The release should describe this as OpenCode-native spawn alignment work, not as a new custom agent framework.
