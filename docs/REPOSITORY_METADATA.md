# Repository Metadata Proposal

This file records the proposed public repository metadata for the RunLatch repositioning.

No GitHub repository settings are changed by this document. Apply these manually only after the product identity and package alias direction are accepted.

## Repository name

```text
runlatch
```

## Display title

```text
RunLatch
```

## GitHub About description

```text
Durable local lifecycle control for coding-agent runs.
```

## Short tagline

```text
RunLatch gives local coding-agent runs stable handles, bounded artifacts, and explicit lifecycle control.
```

## Longer product subtitle

```text
A local lifecycle supervisor that starts external coding-agent jobs, returns stable handles, and lets clients inspect, wait, read results, continue, kill, and clean up those jobs without becoming a model router or agent runtime.
```

## Suggested website / social description

```text
Durable run handles for local coding agents. Start Claude Code or OpenCode work, detach from the foreground client, then inspect, wait, continue, read artifacts, kill, or clean up through CLI, MCP, and a loopback daemon path.
```

## Topics

```text
coding-agents
mcp
agent-runtime
local-daemon
job-lifecycle
claude-code
opencode
typescript
developer-tools
```

## Naming rationale

`supervisor` describes an implementation role. `Anchorpoint` described the earlier durable boundary idea, but it is still too abstract and can sound like a network endpoint, routing anchor, or integration hub.

`RunLatch` is closer to the actual product contract:

- `Run` matches the public lifecycle surface: run, status, wait, result, continue, kill, and cleanup.
- `Latch` suggests holding a stable handle to work that keeps running outside a single foreground request.
- The name stays backend-neutral across Claude Code, OpenCode, and future coding-agent runtimes.
- The name does not imply model routing, provider selection, cloud orchestration, or a replacement agent client.

The product should not be positioned as a Claude Code wrapper. Claude Code is the frozen compatibility backend. The product boundary is lifecycle ownership for local coding-agent jobs:

- start a job and return a handle quickly
- inspect status later
- wait for terminal state
- read bounded results and local artifacts
- continue from persisted session metadata
- kill or clean up jobs explicitly
- move lifecycle ownership toward a durable loopback daemon

## Compatibility policy

The public repo may eventually move from `supervisor` to `runlatch`, but existing command names and environment variables should not be broken in the first rename pass.

Recommended compatibility window:

- add `runlatch`, `runlatch-mcp`, and `runlatchd` bin aliases in a follow-up package PR
- keep `supervisor`, `supervisor-mcp`, and `supervisor-daemon` aliases through the first public rename window
- treat existing `anchorpoint`, `anchorpoint-mcp`, and `anchorpointd` aliases as transitional compatibility aliases, not the product identity
- add `RUNLATCH_*` environment variable aliases later
- keep `SUPERVISOR_*` variables until a deliberate breaking release
- keep current `claude_*` MCP tool names as the Claude Code compatibility surface
- keep explicit `opencode_*` MCP tool names until a generic `agent_*` abstraction is proven by multiple stable backends

## Non-goals to preserve in public metadata

Do not describe the project as:

- a model router
- a provider switcher
- a Claude Code replacement
- an OpenCode replacement
- a cloud queue
- a generic process manager
- a permission-bypass tool
- a multi-agent orchestration framework

The concise public positioning should stay close to:

```text
Durable local lifecycle control for coding-agent runs.
```
