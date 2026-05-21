# Retinue Log Audit

Use this when WSL or plugin-host logs contain many Retinue issues and a full scan would repeat old failures or overload context.

## Command

```bash
pnpm run audit:logs -- --since 2026-05-20T08:00:00.000Z --max-lines 120
```

The script reads only the tail of `logs/retinue.jsonl`, filters by `--since`, deduplicates stalled OpenCode diagnostics by stall reason/provider/model/agent/mode, and emits concise issue candidates.

Useful options:

- `--state-dir <dir>`: Retinue state directory. Defaults to `RETINUE_STATE_DIR` or `~/.local/state/retinue`.
- `--trace <file>`: explicit trace JSONL path.
- `--since <iso>`: ignore older events from previous baselines.
- `--max-lines <n>` and `--max-bytes <n>`: bound input size.

## Interpretation

Each issue candidate includes a signature, affected job IDs, first/last seen timestamps, and one compact sample with session IDs, cwd, stall reason, tool-call rounds, blank/zero-progress rounds, and read-only write intent status.

For direct-child OpenCode runs, `sample.sessionId` is the result child session and `sample.parentSessionId` is the unprompted relationship container. If the same job also shows a later `build`/`build` candidate, that is usually the no-tools soft-stall rescue prompt, not the original child runner.

If `sample.stallReason` is `read_tool_invalid_input`, treat the run as provider/model malformed tool-call output rather than audit evidence. The sample includes `malformedReadToolParts` and `runningReadToolPartSummaries`; an input preview such as `{}` means OpenCode received a `read` tool call without a usable `filePath`.

If `sample.stallReason` is `read_tool_stalled`, treat the run as an OpenCode tool-executor stall rather than audit evidence. The sample includes the pending/running read call and its input preview when available. A later OpenCode completion for the same session should be reviewed as a separate backend event, not as evidence for the already stalled Retinue job.
