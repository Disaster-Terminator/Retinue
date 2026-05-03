# Agent Supervisor Options

Date: 2026-05-03

## Requirement

The target is a Codex-like subagent lifecycle for external Claude Code jobs:

- start a background job and return a handle quickly
- poll or wait for completion
- retrieve full or summarized results
- kill and clean up jobs
- preserve enough session identity to continue finished work when possible
- call the system `claude` executable so local Claude config and cc-switch remain in control

This is different from a synchronous MCP tool that waits for `claude --print` to finish.

## Initial Candidates

| Candidate | Fit | Main Concern |
| --- | --- | --- |
| PAL `clink` | Already works as a synchronous fallback | No durable background job lifecycle |
| `mkXultra/ai-cli-mcp` | Closest existing job-supervisor shape: background CLI agents, wait/result/peek/kill/cleanup style | Very small project: 12 stars, 6 forks as checked on 2026-05-03; needs security and Windows behavior review before trusting |
| `xihuai18/claude-code-mcp` | Good session/poll/reply ideas | Very small project: 6 stars, 1 fork; default session metadata is in memory, so restart behavior matters |
| `zhendalf/claude-mcp` | Explicit async task management | Very small project: 13 stars, 2 forks; README says it uses broad permission bypass by default |
| `steipete/claude-code-mcp` | Mature by popularity: 1272 stars, 160 forks | It is a one-shot bridge around Claude Code and uses broad permission bypass, so it is not the desired spawn lifecycle |

## Current Lean

Do not build a full clone of Codex native `spawn_agent`.

Do build or adapt a narrow local supervisor if no existing option passes the security and lifecycle checks. The smallest useful version should expose `run`, `status`, `wait`, `result`, `kill`, and `cleanup`, persist job state on disk, and avoid permission bypass by default.

## Source Notes

- Claude Code official docs support `claude -p`, `--output-format json`, `--output-format stream-json`, `--resume`, `--continue`, `--session-id`, `--max-turns`, and explicit permission modes. These are enough for a narrow job supervisor without building a terminal harness first.
- MCP long-running operations remain an active protocol concern rather than a universally deployed primitive. The closed SEP-1391 proposal describes the exact problem: single request-response tool calls are a poor fit for minute-to-hour tasks and force custom polling/result schemes.
- Existing community MCP bridges are useful references, but none should be treated as a drop-in trusted dependency before inspecting process spawning, permissions, persistence, cancellation, and Windows process-tree handling.
