# Diagnostics Reference

Retinue diagnostics are designed for agents first: start from compact wait output or `audit:logs`, then open raw traces only for a narrow job/time window.

## State Directory

If `RETINUE_STATE_DIR` is unset:

- Linux, WSL, macOS: `$XDG_STATE_HOME/retinue` or `$HOME/.local/state/retinue`
- Windows: `%LOCALAPPDATA%\retinue`

Common artifacts:

```text
<stateDir>/logs/retinue.jsonl
<stateDir>/jobs/<jobId>/meta.json
<stateDir>/jobs/<jobId>/stdout.log
<stateDir>/jobs/<jobId>/stderr.log
```

`wait_agent` includes compact diagnostics and artifact paths when a job is running, stalled, or attention-required.

## Log Audit

For Retinue runtime issues, prefer the bounded audit before raw log reads:

```bash
pnpm run audit:logs -- --since <recent-iso-time>
```

The default output is compact. `--since` uses a larger bounded scan window than recent-tail mode; if compact output reports `warning=scan_truncated_before_since`, increase `--max-bytes` or `--max-lines` before treating a zero-issue audit as evidence. Use full JSON only when the compact summary cannot answer the question.

## Stall Reasons

| Reason | Meaning |
| --- | --- |
| `read_only_write_intent` | A read-only job attempted a write-capable tool. |
| `provider_error` | OpenCode attached a provider/API error. |
| `provider_reasoning_content_error` | A provider/router rejected thinking-mode `reasoning_content` continuity. |
| `provider_blank_assistant` | Provider produced assistant rounds with no useful text. |
| `provider_zero_progress` | Tool-call rounds or assistant placeholders made no useful progress. |
| `read_tool_stalled` | A read tool call remained pending/running past the threshold. |
| `read_tool_invalid_input` | The model emitted malformed read tool input, such as `{}` without `filePath`. |
| `incomplete_assistant_round` | Latest assistant round did not complete. |
| `backend_no_final_text` | Backend did not produce trusted final assistant text. |
| `tool_loop_no_completion` | Tool-call loop completed tools without a final answer. |
| `external_directory_permission_pending` | Backend is waiting for an external-directory permission decision. |

Treat stalled jobs as terminal attention-required records, not successful child-agent output.

Problem statuses such as `backend_unreachable`, `not_found`, and `corrupted`, plus spawn outcomes such as `resource_exhausted`, are state/read/capacity failures rather than stall reasons. Use them to diagnose Retinue or backend infrastructure, not child-agent evidence.

## Recovery Provenance

Soft stalls can trigger a same-session final-answer rescue while the wait call still has time. Malformed read output or a failed finalization rescue can trigger a fresh task-level attempt.

Final-answer rescue diagnostics may include:

- `softStallRescueStrategy`: currently `final_answer_no_tools`
- `softStallRescueAgent`: the OpenCode agent used for the rescue prompt
- `softStallRescueModel`: the explicit Retinue model override when one was sent
- `softStallRescueTools`: tool names disabled for the final-answer rescue prompt
- `softStallRescueSubmittedAt`: when Retinue submitted the rescue prompt
- `softStallRescueSourceReason` and `softStallRescueSourceSummary`: the original stall being rescued

These fields describe steering submitted through OpenCode's existing session API. They do not mean Retinue changed OpenCode provider configuration, bypassed permissions, or asked the child to continue tool work.

When this happens, output may include:

- `requestedJobId`
- `selectedAttemptJobId`
- `attemptChain`
- `recoveredFromJobId`
- `recoveryReason`
- `originalStallReason`
- `recoveryStallReason`

Trust only the selected completed attempt. Keep the original stalled attempt as diagnostic evidence, not product evidence.

Fresh task-level attempt trace events can include `handoffCapsule`, a bounded summary of previous completed tool evidence and failure warnings. Treat it as prompt handoff context for the new attempt, not as a trusted conclusion from the stalled attempt.

## Permission Diagnostics

Permission waits include structured `permissionActions` when possible:

- request id
- permission type
- target/patterns
- tool call id
- recommended reply
- workspace relation

Use `reply_permission` for the decision. Retinue validates that the request belongs to the job's OpenCode session or child sessions before replying.

## What Not To Record

Do not record API keys, provider secrets, tokens, account credentials, full prompt logs, or private model output unrelated to the issue. Record backend kind, job/session ids, redacted provider/model metadata, compact diagnostics, and paths to local artifacts.
