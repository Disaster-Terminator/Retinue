# Retinue Log Audit

Use this when WSL or plugin-host logs contain many Retinue issues and a full scan would repeat old failures or overload context.

## Command

```bash
pnpm run audit:logs -- --compact --since 2026-05-20T08:00:00.000Z --max-lines 120
```

The script reads only the tail of `logs/retinue.jsonl`, filters by `--since`, deduplicates terminal stalled OpenCode diagnostics by stall reason/provider/model/agent/mode, and emits concise issue candidates. If a job has a later `completed` event in the scanned window, earlier transient stalled diagnostics for that job are ignored. Use `--compact` for agent-facing triage; omit it when you need the full JSON sample payload.

This is a developer/operations diagnostic surface, not part of the default Retinue product MCP tool set. Default MCP hosts expose only child-agent lifecycle and permission bridge tools. When an agent host is explicitly dogfooding or investigating Retinue itself, set `RETINUE_EXPOSE_DIAGNOSTIC_TOOLS=1` to expose `retinue_audit_logs`; otherwise use the CLI command above from the repository.

Useful options:

- `--state-dir <dir>`: Retinue state directory. Defaults to `RETINUE_STATE_DIR` or `~/.local/state/retinue`.
- `--trace <file>`: explicit trace JSONL path.
- `--since <iso>`: ignore older events from previous baselines.
- `--max-lines <n>` and `--max-bytes <n>`: bound input size.
- `--compact` or `-c`: print short text with issue counts, job IDs, stall/recovery reason, provider/model, agent/mode, cwd, selected attempt markers, and one-line diagnosis.

## Interpretation

Each issue candidate includes a signature, affected job IDs, first/last seen timestamps, and one compact sample with session IDs, cwd, stall reason, recovery source/recovery stall reason, tool-call rounds, blank/zero-progress rounds, and read-only write intent status.

If a job briefly emits `opencode_job_stalled` and then later completes after Retinue's recovery prompt, treat the final completed result as the useful evidence. The audit output intentionally reports only jobs whose latest scanned status is still stalled.

For direct-child OpenCode runs, `sample.sessionId` is the result child session and `sample.parentSessionId` is the unprompted relationship container. If the same job also shows a later `build`/`build` candidate, that is usually the no-tools soft-stall rescue prompt, not the original child runner.

If `sample.stallReason` is `read_tool_invalid_input`, treat the run as provider/model malformed tool-call output rather than audit evidence. The sample includes `malformedReadToolParts` and `runningReadToolPartSummaries`; an input preview such as `{}` means OpenCode received a `read` tool call without a usable `filePath`.

If `sample.recoveryStallReason` is set, the sampled failure happened after Retinue had already submitted a no-tools recovery prompt for `sample.softStallRescueSourceReason`. For example, `softStallRescueSourceReason=provider_blank_assistant` with `recoveryStallReason=read_tool_invalid_input` means the original problem was blank provider output, and the recovery attempt itself emitted a malformed `read` call. Do not merge that evidence with first-pass malformed read failures.

If `sample.stallReason` is `read_tool_stalled`, treat the run as an OpenCode tool-executor stall rather than audit evidence. The sample includes the pending/running read call and its input preview when available. A later OpenCode completion for the same session should be reviewed as a separate backend event, not as evidence for the already stalled Retinue job.
