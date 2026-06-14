# Provider Recovery Policy Evaluation

Date: 2026-06-14

## Question

After adding the OpenCode attempt handoff capsule, should Retinue expand default retry eligibility, increase retry budget, or add provider/model reroute behavior now?

## Evidence

Commands:

```bash
pnpm run audit:logs -- --since 2026-06-14T00:00:00+08:00 --max-lines 2000
pnpm run audit:logs -- --since 2026-06-11T00:00:00+08:00 --max-lines 6000
pnpm run audit:logs -- --since 2026-06-14T00:00:00+08:00 --max-lines 2000 --include-terminal
pnpm run audit:logs -- --since 2026-06-11T00:00:00+08:00 --max-lines 6000 --include-terminal
```

Observed compact audit output:

- today window: `issues=0 attention=0 scanned=241 ignoredCompleted=6`
- three-day window: `issues=0 attention=0 scanned=912 ignoredCompleted=10 ignoredTerminal=8`
- `--include-terminal` did not surface additional issue candidates
- expanded scans reached before the requested `--since` timestamps; remaining `scan_truncated` warnings mean the whole trace file is larger than the scan window, not that the requested windows were missed

## Decision

Do not expand default retry or reroute behavior yet.

Keep the current policy:

- same-session final-answer rescue for eligible soft stalls
- one fresh task-level attempt for selected unreliable execution chains
- handoff capsule only on already selected fresh task attempts
- no continue-task rescue by default
- no provider/model reroute by default

## Rationale

The current logs do not show unresolved failures that justify a broader default retry policy. Expanding retry eligibility now would add model/tool spend and could hide provider or permission failures without evidence that it improves successful outcomes.

The new handoff capsule changes the quality of already selected fresh attempts without changing the recovery budget. That is the correct baseline to observe before deciding whether more retries or reroute policies are needed.

## Future Trigger

Reopen this decision if compact audits show repeated unresolved jobs with the same signature after the capsule baseline is deployed, especially:

- `provider_blank_assistant` or `provider_zero_progress` chains exhausting the single fresh attempt
- `read_tool_invalid_input` chains where the capsule prevents repeat exploration but the selected attempt still stalls
- provider-specific `provider_error` or `provider_reasoning_content_error` clusters that would benefit from an explicit deployment-configured reroute

Any reroute design should remain deployment-configured and should not silently override OpenCode profile ownership.
