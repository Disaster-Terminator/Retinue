# OpenCode Native Spawn Adapter Research

Date: 2026-05-20

## Context

Retinue has repeatedly exposed unstable behavior when it emulates a child-agent boundary around a standalone OpenCode session: read-tool stalls, zero-progress provider loops, and read-only jobs that still emit patch/write intent. Those are useful guardrails, but the architecture should prefer OpenCode's native session/subagent model when it exists instead of adding more Retinue-owned policy layers.

This note records the release-blocking architecture decision tracked in beads issue `RET-ygi`. The pre-migration wrapper snapshot is preserved on the remote branch `archive/pre-native-opencode-runner`.

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
| Direct child session with `parentID` | completed, final text returned by child | This is the default candidate for Retinue-style single child-agent spawn/result collection. |
| `subtask` part on a parent prompt | completed, final text returned by parent | Useful for parent-orchestrated probes or future multi-child aggregation, but it adds an extra model hop. |
| Agent `steps` surface | none in current agent summary | No actionable local `steps` contract was observed in this config. |

Retinue dogfood cross-check:

- A read-only Retinue review job produced useful text, but OpenCode also emitted a patch/write-intent part.
- Retinue correctly marked it `stalled` rather than trusting the job as clean read-only output.
- This supports reducing Retinue-owned prompt/policy emulation while keeping result collection on the actual child session whenever Retinue is asked to spawn one child agent.

## Decision

Retinue should not keep deepening the current standalone-session wrapper as the primary architecture.

The backend direction is now OpenCode-native by default:

1. Use an unprompted parent OpenCode session only as a native relationship container when useful.
2. Create the actual Retinue job as a direct OpenCode child session with `parentID`, requested agent, model, cwd, and permission policy.
3. Submit the prompt directly to the child session.
4. Treat the child assistant's final text as the result collection path.
5. Record parent and child session IDs in Retinue metadata and diagnostics.
6. Preserve `subtask` prompt parts and fork probes as diagnostics or future explicit parent-orchestrated flows, not the normal single-agent runner.
7. Keep Retinue access policy configurable, but avoid making Retinue pretend to be OpenCode's permission system.

## Acceptance For The Next Product Change

- Retinue runs OpenCode jobs through a direct native child session and collects child final text.
- Retinue records parent/child session IDs in metadata and diagnostics when OpenCode exposes them.
- Existing stall diagnostics remain available around the child session stream.
- The release should describe this as OpenCode-native spawn alignment work, not as a new custom agent framework.
