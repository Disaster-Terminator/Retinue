# Production OpenCode E2E

This document records the production-style OpenCode path for `feature/spawn-opencode`.

Retinue stays a thin lifecycle wrapper. OpenCode owns provider configuration, endpoint
routing, login, model availability, agent behavior, and permission policy. Retinue owns
job metadata, wait/result/continue/kill/cleanup, and MCP/CLI surfaces.

## WSL Baseline

The current real baseline is the user's WSL OpenCode configuration:

```text
OpenCode version: 1.14.35
Config path: /home/raystorm/.config/opencode/opencode.json
Provider id: litellm
Model id: pro-router
Model override: litellm/pro-router
Provider base URL: http://localhost:4000/v1
Secret env name: LITELLM_API_KEY
```

Do not copy API keys into this repository. If OpenCode is started non-interactively,
load the user's OpenCode env before serving:

```bash
set -a
. "$HOME/.config/opencode/.env"
set +a
opencode serve --hostname 127.0.0.1 --port 4096
```

Windows can either attach to that WSL server through the loopback URL or maintain its
own equivalent OpenCode config. The old Windows OpenCode config is not the baseline for
this project.

## Retinue Configuration

Attach to the server:

```bash
RETINUE_OPENCODE_BASE_URL=http://127.0.0.1:4096
```

Use the production model only when explicitly configured:

```bash
RETINUE_OPENCODE_MODEL=litellm/pro-router
RETINUE_OPENCODE_AGENT=explore
```

Retinue uses OpenCode's built-in `explore` subagent as the default plugin agent. Use
OpenCode's built-in `general` subagent when a child is intentionally allowed to edit.
`build` is a primary/root agent, not the default writable subagent.

Precedence is:

1. CLI/MCP input fields.
2. `RETINUE_OPENCODE_MODEL` and `RETINUE_OPENCODE_AGENT`.
3. Unset: omit the field and let OpenCode choose its default.

`RETINUE_OPENCODE_MODEL=litellm/pro-router` is sent to OpenCode as:

```json
{
  "providerID": "litellm",
  "modelID": "pro-router"
}
```

## CLI Operations

Build first:

```bash
pnpm run build
```

The default CLI is an operator/bootstrap control plane. It does not expose the removed
legacy flat job commands such as `opencode-run`, `opencode-wait`, or `opencode-result`.
Use the MCP product flow below for child-agent E2E.

Inspect the packaged MCP product surface:

```bash
node dist/cli.js mcp tools
```

Audit recent Retinue logs without exposing diagnostic tools through the default MCP
surface:

```bash
node dist/cli.js diagnostics audit-logs --since 2026-05-20T08:00:00.000Z
```

Refresh installed plugin caches after a build:

```bash
node dist/cli.js plugin sync-cache --all --apply
```

Restart a Retinue-managed auto-served OpenCode runtime:

```bash
node dist/cli.js runtime restart --cwd /mnt/g/repository/retinue --force
```

PowerShell uses the same commands with `$env:RETINUE_OPENCODE_BASE_URL` and
`$env:RETINUE_OPENCODE_MODEL` for environment configuration.

## Retinue MCP Spawn Flow

This probe validates the OpenCode-first Retinue product surface:

- `spawn_agent`
- `wait_agent`
- `close_agent`
- `list_agents`
- `list_permissions`
- `reply_permission`

It intentionally does not pass a backend, profile, model, OpenCode server,
`access_mode`, or `bash_policy` choice through the MCP tool arguments. Retinue uses the
deployment-selected OpenCode path and may pass a per-spawn `agent` when a probe needs to
exercise a specific OpenCode agent. By default this is Retinue-managed auto-serve; set
`RETINUE_OPENCODE_BASE_URL` only when intentionally attaching to an externally managed
OpenCode server. If `RETINUE_OPENCODE_BASE_URL` and `RETINUE_OPENCODE_AUTO_SERVE=1` are
both present, Retinue tries the explicit URL first and falls back to managed auto-serve
when that attach target is unavailable. OpenCode uses its active profile.

For local E2E, set `RETINUE_STATE_DIR` to a known directory. Retinue writes job
artifacts under `<stateDir>/jobs/<jobId>/` and diagnostics under
`<stateDir>/logs/retinue.jsonl`. The real MCP probe prints both `stateDir` and
`tracePath` on success or failure. If `wait_agent` returns `running`, inspect the
returned `diagnostic` first, then `stdoutTail` and `stderrTail`; the response also
includes `jobDir`, `promptPath`, `stdoutPath`, and `stderrPath` for deeper OpenCode
session/message snapshots. A single MCP wait timeout is a polling event rather than a
failed child, but repeated blank, zero-progress, incomplete, pending-read, and
no-final-text loops are bounded and become diagnostic `stalled` results. If Retinue
starts a fresh task-level attempt for malformed read output or a failed finalization
rescue, the wait response can re-key from `requestedJobId` to the selected attempt
`jobId` and include `selectedAttemptJobId` plus `attemptChain`; treat the original
stalled job as non-evidence. If it returns `attentionRequired.kind: "permission"` or
`permissionRequired: true`, treat the response as an action-required workflow event, use
`list_permissions` when request ids are needed, reply with `reply_permission` using
`once`, `always`, or `reject`, then wait again. If it returns `stalled` without
`attentionRequired`, inspect `diagnostic.stallReason` and `diagnostic.stallSummary`
before deciding whether to retry with a smaller prompt, switch backend configuration, or
close the child as non-evidence.

Retinue reports OpenCode empty-output or incomplete assistant loops as `stalled` only
after diagnostic thresholds are crossed. Defaults are tuned to keep real child agents
responsive within a single MCP wait call: the long fallback no-text threshold is 10
minutes, while blank provider placeholders, incomplete latest assistant rounds,
pending/running `read` tool calls, and completed tool-call loops with no final text use
45-second windows. Zero-progress assistant placeholders use 45 seconds by default, but
the latest zero-progress placeholder after completed tool-call progress uses 120
seconds. This gives OpenCode room to finish a normal tool chain before Retinue marks
the child as stalled, while still bounding jobs that repeatedly complete tools or leave
tools pending and never summarize.

Retinue does not submit same-session no-tools rescue prompts, switch the OpenCode
agent behind the caller, or override child tools to simulate read-only behavior.
OpenCode owns the active session, agent profile, tool availability, and permission
engine. Retinue may create a fresh task-level attempt after eligible provider/no-final-text
stalls or malformed read output; the default cap is one fresh attempt, and
`RETINUE_OPENCODE_TASK_ATTEMPT_MAX=0` disables it. Provider/API errors
still return immediately as hard stalls and are classified as `provider_error` or a
narrower provider-specific reason. The product path does not send Retinue-owned
read-only session permissions or prompt-level tool overrides. `stalled` no longer
occupies the MCP session active-agent slot, but its artifacts and backend session remain
available for inspection until explicit close/cleanup.

Use `RETINUE_OPENCODE_STALL_MS`, `RETINUE_OPENCODE_STALL_BLANK_ASSISTANT_MS`,
`RETINUE_OPENCODE_STALL_ZERO_PROGRESS_ASSISTANT_MS`,
`RETINUE_OPENCODE_STALL_FINALIZATION_AFTER_TOOL_PROGRESS_MS`,
`RETINUE_OPENCODE_STALL_INCOMPLETE_ASSISTANT_MS`, `RETINUE_OPENCODE_STALL_READ_TOOL_MS`,
`RETINUE_OPENCODE_STALL_COMPLETED_TOOL_LOOP_MS`,
`RETINUE_OPENCODE_STALL_TOOL_CALL_ROUNDS`, and
`RETINUE_OPENCODE_STALL_EMPTY_ASSISTANT_ROUNDS` only when a probe needs a different
failure window. Structured stall reasons currently include `provider_error`,
`provider_reasoning_content_error`, `provider_zero_progress`,
`provider_blank_assistant`, `read_tool_stalled`,
`external_directory_permission_pending`, `read_tool_invalid_input`,
`incomplete_assistant_round`, `backend_no_final_text`, and `tool_loop_no_completion`.

```bash
pnpm run build
RETINUE_REAL_OPENCODE_PROBE=1 \
RETINUE_BACKEND=opencode \
RETINUE_OPENCODE_AGENT=explore \
pnpm run probe:real:retinue-opencode
```

Slot-pool pressure probe:

```bash
pnpm run build
RETINUE_REAL_OPENCODE_SLOT_PROBE=1 \
RETINUE_BACKEND=opencode \
RETINUE_OPENCODE_AGENT=explore \
pnpm run probe:real:retinue-opencode-slots
```

On PowerShell:

```powershell
$env:RETINUE_REAL_OPENCODE_PROBE = "1"
$env:RETINUE_BACKEND = "opencode"
$env:RETINUE_OPENCODE_BASE_URL = "http://127.0.0.1:4096"
$env:RETINUE_OPENCODE_AGENT = "explore"
pnpm run probe:real:retinue-opencode
```

## 2026-05-05 E2E Result

Environment:

```text
Host runner: Windows PowerShell
OpenCode server: WSL Ubuntu-22.04, http://127.0.0.1:4096
OpenCode version: 1.14.35
Workspace sent to OpenCode: /mnt/g/repository/retinue
Model override: litellm/pro-router
Agent: build
```

Run result:

```text
jobId: job_aee04909-0b97-47f0-8c76-c75b2fc86f20
sessionId: ses_2075283c6ffezabgaTHjAQGj3s
providerID: litellm
modelID: pro-router
status: completed
stdout: RETINUE_SPAWN_OPENCODE_OK
```

## 2026-05-07 Retinue MCP E2E Result

Environment:

```text
Host runner: Windows PowerShell
OpenCode server: Windows local, http://127.0.0.1:41987
OpenCode version: 1.14.39
Workspace sent to OpenCode: G:\repository\retinue
Backend/profile selection in tool args: none
```

Run result:

```text
tool flow: spawn_agent -> wait_agent -> close_agent
jobId: job_8f973d30-f473-4f08-a016-af7104508a1e
sessionId: ses_201af60f0ffeYYXl3ylzNejwCm
backend: opencode
task_name: real-opencode-smoke
status: completed
stdout: RETINUE_OPENCODE_REAL_OK
closeStatus: completed
```

Continue result:

```text
jobId: job_04fa0583-3968-429d-801e-242ea6b0ee0d
sessionId: ses_2075283c6ffezabgaTHjAQGj3s
providerID: litellm
modelID: pro-router
status: completed
stdout: RETINUE_SPAWN_OPENCODE_CONTINUE_OK
```

Kill and cleanup were also exercised:

```text
kill jobId: job_e89aabf1-f6ad-494f-a62f-5c5ef956d757
kill status: killed
cleanup removed: job_aee04909-0b97-47f0-8c76-c75b2fc86f20, job_04fa0583-3968-429d-801e-242ea6b0ee0d, job_e89aabf1-f6ad-494f-a62f-5c5ef956d757
```

OpenCode message metadata confirmed `providerID=litellm` and `modelID=pro-router`. No
API key or provider secret is recorded here.

WSL-side CLI result:

```text
runner: WSL Ubuntu-22.04
jobId: job_3eb667da-a718-4670-ba7a-2c60deb63de0
sessionId: ses_2074a18d2ffe9opvrLoLl1PdvE
providerID: litellm
modelID: pro-router
status: completed
stdout: RETINUE_WSL_OPENCODE_OK
cleanup removed: job_3eb667da-a718-4670-ba7a-2c60deb63de0
```

## 2026-05-06 PR #58 Review E2E

Environment:

```text
Host runner: Windows PowerShell
OpenCode server: WSL Ubuntu-22.04, http://127.0.0.1:4096
OpenCode version: 1.14.35
Workspace sent to OpenCode: /mnt/g/repository/retinue
Model override: litellm/pro-router
Provider/model confirmed by OpenCode messages: litellm/pro-router
```

Run result:

```text
jobId: job_e69a6efb-3273-429c-9fd1-f7af8a88bf59
sessionId: ses_202bb3938ffeBGQVwiD0NWN4YV
status: completed
stdout: RETINUE_E2E_RUN_OK
```

Continue result:

```text
jobId: job_07346cfd-6876-432e-9bb8-b4528312d434
sessionId: ses_202bb3938ffeBGQVwiD0NWN4YV
externalMessageBaselineCount: 2
externalCompletedAssistantBaselineCount: 1
status: completed
stdout: RETINUE_E2E_CONTINUE_OK
```

Kill and cleanup result:

```text
kill jobId: job_1c0bf160-afc6-4e33-972a-33b0369f68be
kill status: killed
cleanup removed completed jobs: job_e69a6efb-3273-429c-9fd1-f7af8a88bf59, job_07346cfd-6876-432e-9bb8-b4528312d434
cleanup removed killed job on second sequential cleanup: job_1c0bf160-afc6-4e33-972a-33b0369f68be
```

The continued job returned the new assistant answer, not the previous assistant answer
and not the user prompt.

## 2026-05-07 Retinue 0.1.0 Plan-Agent E2E Result

Environment:

```text
Host runner: Windows PowerShell
OpenCode server: Windows local, http://127.0.0.1:41987
OpenCode version: 1.14.39
Workspace sent to OpenCode: G:\repository\retinue
Retinue backend: opencode
OpenCode agent: explore
```

Command:

```powershell
$env:RETINUE_REAL_OPENCODE_PROBE = "1"
$env:RETINUE_BACKEND = "opencode"
$env:RETINUE_OPENCODE_BASE_URL = "http://127.0.0.1:41987"
$env:RETINUE_OPENCODE_AGENT = "explore"
pnpm run probe:real:retinue-opencode
```

Observed result:

```json
{
  "ok": true,
  "retinueBackend": "opencode",
  "backend": "opencode",
  "task_name": "real-opencode-smoke",
  "status": "completed",
  "result": "RETINUE_OPENCODE_REAL_OK",
  "closeStatus": "completed"
}
```

This validates the Retinue 0.1.0 default OpenCode `explore` agent path without touching
the user's WSL Codex plugin state.

## Known Environment Note

During the same session, direct WSL userland commands briefly returned
`Wsl/Service/0x8007274c`, while the already running WSL OpenCode server remained
reachable over loopback from Windows. WSL later recovered and completed the CLI E2E
above. Do not reset or terminate WSL as an automatic fix; confirm with the user before
any WSL lifecycle action.
