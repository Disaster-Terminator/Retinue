# Production OpenCode E2E

This document records the production-style OpenCode path for `feature/spawn-opencode`.

Supervisor stays a thin lifecycle wrapper. OpenCode owns provider configuration, endpoint routing, login, model availability, agent behavior, and permission policy. Supervisor owns job metadata, wait/result/continue/kill/cleanup, and MCP/CLI surfaces.

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

Do not copy API keys into this repository. If OpenCode is started non-interactively, load the user's OpenCode env before serving:

```bash
set -a
. "$HOME/.config/opencode/.env"
set +a
opencode serve --hostname 127.0.0.1 --port 4096
```

Windows can either attach to that WSL server through the loopback URL or maintain its own equivalent OpenCode config. The old Windows OpenCode config is not the baseline for this project.

## Supervisor Configuration

Attach to the server:

```bash
SUPERVISOR_OPENCODE_BASE_URL=http://127.0.0.1:4096
```

Use the production model only when explicitly configured:

```bash
SUPERVISOR_OPENCODE_MODEL=litellm/pro-router
SUPERVISOR_OPENCODE_AGENT=plan
```

Retinue 0.1.0 uses `plan` as the default OpenCode plugin agent. Use `build` only when the deployment intentionally allows the child agent to edit.

Precedence is:

1. CLI/MCP input fields.
2. `SUPERVISOR_OPENCODE_MODEL` and `SUPERVISOR_OPENCODE_AGENT`.
3. Unset: omit the field and let OpenCode choose its default.

`SUPERVISOR_OPENCODE_MODEL=litellm/pro-router` is sent to OpenCode as:

```json
{
  "providerID": "litellm",
  "modelID": "pro-router"
}
```

## CLI E2E Flow

Build first:

```bash
pnpm run build
```

Run:

```bash
SUPERVISOR_OPENCODE_BASE_URL=http://127.0.0.1:4096 \
SUPERVISOR_OPENCODE_MODEL=litellm/pro-router \
node dist/cli.js opencode-run \
  --cwd /mnt/g/repository/supervisor \
  --prompt "Reply exactly: SUPERVISOR_SPAWN_OPENCODE_OK" \
  --title supervisor-spawn-opencode-live
```

Wait and read:

```bash
node dist/cli.js opencode-wait <jobId> --timeout-ms 180000
node dist/cli.js opencode-result <jobId>
```

Continue:

```bash
SUPERVISOR_OPENCODE_MODEL=litellm/pro-router \
node dist/cli.js opencode-continue \
  --cwd /mnt/g/repository/supervisor \
  --external-session-id <sessionId> \
  --job-id <jobId> \
  --prompt "Reply exactly: SUPERVISOR_SPAWN_OPENCODE_CONTINUE_OK"
```

Kill and cleanup:

```bash
node dist/cli.js opencode-kill <jobId>
node dist/cli.js opencode-cleanup --older-than-ms 0
```

PowerShell uses the same commands with `$env:SUPERVISOR_OPENCODE_BASE_URL` and `$env:SUPERVISOR_OPENCODE_MODEL`.

## Retinue MCP Spawn Flow

This probe validates the OpenCode-first Retinue product surface:

- `retinue_spawn_agent`
- `retinue_wait_agent`
- `retinue_close_agent`

It intentionally does not pass a backend, profile, model, agent, or permission mode through the MCP tool arguments. Retinue uses the deployment-selected OpenCode server from `SUPERVISOR_OPENCODE_BASE_URL`, and OpenCode uses its active profile.

For local E2E, set `SUPERVISOR_STATE_DIR` to a known directory. Retinue writes job artifacts under `<stateDir>/jobs/<jobId>/` and startup diagnostics under `<stateDir>/logs/retinue.jsonl`. The real MCP probe prints both `stateDir` and `tracePath` on success or failure.

```bash
pnpm run build
SUPERVISOR_REAL_OPENCODE_PROBE=1 \
SUPERVISOR_RETINUE_BACKEND=opencode \
SUPERVISOR_OPENCODE_BASE_URL=http://127.0.0.1:4096 \
SUPERVISOR_OPENCODE_AGENT=plan \
pnpm run probe:real:retinue-opencode
```

On PowerShell:

```powershell
$env:SUPERVISOR_REAL_OPENCODE_PROBE = "1"
$env:SUPERVISOR_RETINUE_BACKEND = "opencode"
$env:SUPERVISOR_OPENCODE_BASE_URL = "http://127.0.0.1:4096"
$env:SUPERVISOR_OPENCODE_AGENT = "plan"
pnpm run probe:real:retinue-opencode
```

## 2026-05-05 E2E Result

Environment:

```text
Host runner: Windows PowerShell
OpenCode server: WSL Ubuntu-22.04, http://127.0.0.1:4096
OpenCode version: 1.14.35
Workspace sent to OpenCode: /mnt/g/repository/supervisor
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
stdout: SUPERVISOR_SPAWN_OPENCODE_OK
```

## 2026-05-07 Retinue MCP E2E Result

Environment:

```text
Host runner: Windows PowerShell
OpenCode server: Windows local, http://127.0.0.1:41987
OpenCode version: 1.14.39
Workspace sent to OpenCode: G:\repository\supervisor
Backend/profile selection in tool args: none
```

Run result:

```text
tool flow: retinue_spawn_agent -> retinue_wait_agent -> retinue_close_agent
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
stdout: SUPERVISOR_SPAWN_OPENCODE_CONTINUE_OK
```

Kill and cleanup were also exercised:

```text
kill jobId: job_e89aabf1-f6ad-494f-a62f-5c5ef956d757
kill status: killed
cleanup removed: job_aee04909-0b97-47f0-8c76-c75b2fc86f20, job_04fa0583-3968-429d-801e-242ea6b0ee0d, job_e89aabf1-f6ad-494f-a62f-5c5ef956d757
```

OpenCode message metadata confirmed `providerID=litellm` and `modelID=pro-router`. No API key or provider secret is recorded here.

WSL-side CLI result:

```text
runner: WSL Ubuntu-22.04
jobId: job_3eb667da-a718-4670-ba7a-2c60deb63de0
sessionId: ses_2074a18d2ffe9opvrLoLl1PdvE
providerID: litellm
modelID: pro-router
status: completed
stdout: SUPERVISOR_WSL_OPENCODE_OK
cleanup removed: job_3eb667da-a718-4670-ba7a-2c60deb63de0
```

## 2026-05-06 PR #58 Review E2E

Environment:

```text
Host runner: Windows PowerShell
OpenCode server: WSL Ubuntu-22.04, http://127.0.0.1:4096
OpenCode version: 1.14.35
Workspace sent to OpenCode: /mnt/g/repository/supervisor
Model override: litellm/pro-router
Provider/model confirmed by OpenCode messages: litellm/pro-router
```

Run result:

```text
jobId: job_e69a6efb-3273-429c-9fd1-f7af8a88bf59
sessionId: ses_202bb3938ffeBGQVwiD0NWN4YV
status: completed
stdout: ANCHORPOINT_E2E_RUN_OK
```

Continue result:

```text
jobId: job_07346cfd-6876-432e-9bb8-b4528312d434
sessionId: ses_202bb3938ffeBGQVwiD0NWN4YV
externalMessageBaselineCount: 2
externalCompletedAssistantBaselineCount: 1
status: completed
stdout: ANCHORPOINT_E2E_CONTINUE_OK
```

Kill and cleanup result:

```text
kill jobId: job_1c0bf160-afc6-4e33-972a-33b0369f68be
kill status: killed
cleanup removed completed jobs: job_e69a6efb-3273-429c-9fd1-f7af8a88bf59, job_07346cfd-6876-432e-9bb8-b4528312d434
cleanup removed killed job on second sequential cleanup: job_1c0bf160-afc6-4e33-972a-33b0369f68be
```

The continued job returned the new assistant answer, not the previous assistant answer and not the user prompt.

## 2026-05-07 Retinue 0.1.0 Plan-Agent E2E Result

Environment:

```text
Host runner: Windows PowerShell
OpenCode server: Windows local, http://127.0.0.1:41987
OpenCode version: 1.14.39
Workspace sent to OpenCode: G:\repository\supervisor
Retinue backend: opencode
OpenCode agent: plan
```

Command:

```powershell
$env:SUPERVISOR_REAL_OPENCODE_PROBE = "1"
$env:SUPERVISOR_RETINUE_BACKEND = "opencode"
$env:SUPERVISOR_OPENCODE_BASE_URL = "http://127.0.0.1:41987"
$env:SUPERVISOR_OPENCODE_AGENT = "plan"
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

This validates the Retinue 0.1.0 default OpenCode `plan` agent path without touching the user's WSL Codex plugin state.

## Known Environment Note

During the same session, direct WSL userland commands briefly returned `Wsl/Service/0x8007274c`, while the already running WSL OpenCode server remained reachable over loopback from Windows. WSL later recovered and completed the CLI E2E above. Do not reset or terminate WSL as an automatic fix; confirm with the user before any WSL lifecycle action.
