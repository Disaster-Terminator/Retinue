# Repository Metadata Proposal

This file records the proposed public repository metadata for the Anchorpoint repositioning.

No GitHub repository settings are changed by this document. Apply these manually only after the README/package alias direction is accepted.

## Repository name

```text
anchorpoint
```

## Display title

```text
Anchorpoint
```

## GitHub About description

```text
Local control plane for long-running coding-agent jobs via CLI, MCP, and a durable daemon.
```

## Short tagline

```text
Anchorpoint turns local coding agents into durable, inspectable background jobs.
```

## Longer product subtitle

```text
A local control plane that gives coding agents durable job handles, bounded artifacts, session continuity, and daemon-owned lifecycle.
```

## Topics

```text
coding-agents
mcp
agent-runtime
local-daemon
claude-code
opencode
typescript
developer-tools
```

## Naming rationale

`supervisor` describes an implementation role. `Anchorpoint` describes the durable product boundary: a stable local control point for agent jobs that outlive a single foreground CLI or MCP request.

The project should not be positioned as a Claude Code wrapper. Claude Code is the frozen compatibility backend. The product boundary is lifecycle ownership for local coding-agent jobs:

- start a job and return a handle quickly
- inspect status later
- wait for terminal state
- read bounded results and local artifacts
- continue from persisted session metadata
- kill or clean up jobs explicitly
- move lifecycle ownership toward a durable loopback daemon

## Compatibility policy

The public repo may eventually move from `supervisor` to `anchorpoint`, but existing command names and environment variables should not be broken in the first rename pass.

Recommended compatibility window:

- add `anchorpoint`, `anchorpoint-mcp`, and `anchorpointd` bin aliases
- keep `supervisor`, `supervisor-mcp`, and `supervisor-daemon` aliases
- add `ANCHORPOINT_*` environment variable aliases later
- keep `SUPERVISOR_*` variables until a deliberate breaking release
- keep current `claude_*` MCP tool names as the Claude Code compatibility surface

## Non-goals to preserve in public metadata

Do not describe the project as:

- a model router
- a provider switcher
- a Claude Code replacement
- an OpenCode replacement
- a cloud queue
- a generic process manager
- a permission-bypass tool

The concise public positioning should stay close to:

```text
Local control plane for long-running coding-agent jobs.
```
