# Retinue Attempt Recovery

Retinue recovery is deliberately outside the active backend session. The backend owns
provider, model, tools, permissions, and agent behavior. Retinue owns job provenance,
resource accounting, stalled diagnostics, and retry bookkeeping.

## Primary Run

The primary run is the normal product path: spawn one backend-selected child agent and
let the local backend runtime execute it. A successful primary run returns the child
result directly.

For OpenCode, Retinue does not add a read-only prompt contract, does not override the
child tool set, and does not classify write-capable tool parts as a Retinue policy
violation. Use OpenCode-native agents such as `explore`, `plan`, or `general` and let
OpenCode enforce its own profile and permission semantics.

## Stalled Output

Stalled output is not product evidence. Retinue can classify why a job did not produce
trusted final text, persist compact diagnostics, and keep enough metadata for later log
audit.

Current stalled classes include provider errors, provider blank or zero-progress
assistant output, incomplete assistant rounds, malformed or stuck read tools, completed
tool loops with no final answer, no trusted backend text, and permission waits.

Patch parts and write-capable tool parts are neutral OpenCode stream observations:
`patchPartCount` and `writeIntentToolPartCount`. They do not trigger a Retinue
read-only policy layer.

## Fresh Task Attempts

A fresh task attempt is a new Retinue child job/session with bounded handoff context
from the failed job. It is the only automatic recovery path for OpenCode stalls.

Fresh attempts may be used for:

| Situation | Strategy |
| --- | --- |
| `provider_blank_assistant` | Fresh task-level attempt when budget allows |
| `provider_zero_progress` | Fresh task-level attempt when budget allows |
| `incomplete_assistant_round` | Fresh task-level attempt when budget allows |
| `backend_no_final_text` | Fresh task-level attempt when budget allows |
| `tool_loop_no_completion` | Fresh task-level attempt when budget allows |
| `read_tool_invalid_input` | Fresh task-level attempt with malformed-read handoff guidance |
| `read_tool_stalled` | Stalled diagnostic unless a future explicit policy handles it |
| `external_directory_permission_pending` | Permission attention, not recovery |
| `provider_error` or `provider_reasoning_content_error` | Stalled diagnostic; future reroute candidate |

The original job remains non-evidence. If a fresh attempt succeeds, callers receive the
selected attempt result with provenance:

- `requestedJobId`
- `selectedAttemptJobId`
- `attemptChain`
- `recoveredFromJobId`
- `recoveryReason`
- `originalStallReason`
- `recoveryStallReason`

If every attempt fails, Retinue returns the attempt chain and a stalled result. The
caller should treat the whole chain as diagnostic evidence, not a usable child-agent
conclusion.

## Product Boundary

Retinue should not hide provider/tool failures by manufacturing a final answer from an
unreliable session. It also should not mutate OpenCode semantics to make a child look
read-only or write-capable. The safest default is:

- trust completed backend final text
- surface permission waits for supervising-agent decisions
- classify malformed or stalled backend output precisely
- start a fresh task attempt only when the retry budget allows it
- never promote stalled text into a trusted conclusion
