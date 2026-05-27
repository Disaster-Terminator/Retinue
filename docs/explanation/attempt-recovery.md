# Retinue Attempt Recovery

Retinue has two different recovery problems and must keep them separate.

## Primary Run

The primary run is the normal Retinue product path: spawn one backend-selected child agent and let the local backend runtime own provider, model, tools, permissions, and agent behavior. A successful primary run returns the child result directly.

## Finalization Rescue

Finalization rescue is same-session cleanup. It applies only when the child appears to have gathered useful context but failed to produce completed final text.

This rescue asks the same OpenCode session to stop using tools and summarize only from already collected information. Its tool set is intentionally disabled. It is not a second attempt at the task.

Use finalization rescue for soft no-final-text cases such as blank or zero-progress assistant output after tool progress, incomplete assistant rounds, and read-only write-intent prose recovery.

Do not use finalization rescue for malformed tool calls or provider execution failures unless the purpose is only to salvage a clearly bounded advisory summary from existing context.

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
