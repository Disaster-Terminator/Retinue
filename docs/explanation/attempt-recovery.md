# Retinue Attempt Recovery

Retinue has two different recovery problems and must keep them separate.

## Primary Run

The primary run is the normal Retinue product path: spawn one backend-selected child agent and let the local backend runtime own provider, model, tools, permissions, and agent behavior. A successful primary run returns the child result directly.

## Finalization Rescue

Finalization rescue is same-session cleanup. It applies only when the child appears to have gathered useful context but failed to produce completed final text.

This rescue asks the same OpenCode session to stop using tools and summarize only from already collected information. Its tool set is intentionally disabled. It is not a second attempt at the task.

Use finalization rescue for soft no-final-text cases such as blank or zero-progress assistant output after tool progress, incomplete assistant rounds, and read-only write-intent prose recovery.

Do not use finalization rescue for malformed tool calls or provider execution failures unless the purpose is only to salvage a clearly bounded advisory summary from existing context.

Finalization rescue is intentionally conservative. It answers only: "Can this same child produce a trustworthy final answer from what it already knows?" It does not mean "continue using tools until the task is done."

## Continue-Task Rescue

Continue-task rescue is a separate possible recovery strategy. It would ask the same OpenCode session to keep working while steering around the observed failure mode, such as avoiding a malformed read call or narrowing inspection paths.

Do not treat continue-task rescue as the default soft-stall behavior. It can spend additional model/tool budget in a session that has already shown unreliable output, so it needs explicit trigger rules, a bounded budget, and diagnostics that distinguish it from finalization rescue.

Until that strategy is designed, Retinue should prefer:

- finalization rescue when enough completed tool progress exists and only final text is missing
- fresh task-level retry when the execution chain itself is unreliable
- stalled diagnostics when permissions, provider errors, or malformed tool calls cannot be safely recovered inside the current budget

## Task-Level Retry Or Reroute

Task-level retry is a new attempt. It applies when the execution chain itself is unreliable, such as malformed read tool calls, provider errors, repeated zero-progress output, or a finalization rescue that itself stalls.

The original job remains terminal and non-evidence. Retinue may create a new child job or session for the retry, carrying structured attempt metadata:

- `recoveredFromJobId`
- `attempt`
- `rerouteReason`
- `originalStallReason`
- `recoveryStallReason` when the previous finalization rescue failed

A retry may change only Retinue-owned execution strategy, not silently override backend ownership. Examples include a smaller prompt, a grep-only/no-read instruction, a different configured OpenCode agent, or a deployment-configured fallback model/provider when one exists.

If a retry succeeds, callers receive the successful attempt result with provenance. If every attempt fails, Retinue returns the attempt chain so the caller can see whether the failure was malformed read, provider zero-progress, provider error, permission wait, or another classified stall.

## Product Boundary

Malformed read is not valid audit evidence. Retinue should keep classifying it as stalled, but product improvement should be a task-level retry or reroute policy, not widening finalization rescue.

Finalization rescue answers: "Can this same child produce a conclusion from what it already knows?"

Task-level retry answers: "Can Retinue run a new controlled attempt that avoids the observed backend failure mode?"

## Attempt Handoff Capsule

A fresh task-level retry may need useful context from the previous attempt, but Retinue must not copy or trust the whole stalled session.

The handoff snapshot should be a bounded, lossy Retinue Attempt Handoff Capsule. It is generated from OpenCode-native structured messages or Retinue's existing diagnostic summaries, not from raw provider logs. It may include completed tool evidence, file paths, command summaries, permission boundaries, and the normalized stall reason.

The capsule must not include:

- full prompts or full tool outputs
- secrets, API keys, provider tokens, or raw provider payloads
- old stalled final text as trusted evidence
- assistant reasoning as trusted evidence
- a Retinue-owned replacement for OpenCode session state

The first capsule implementation should not increase retry counts or expand which stalls trigger fresh attempts. It should only improve the information carried by already selected fresh task-level attempts.
