# Spawn Claude Code Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a repository-grade MCP server and CLI that lets Codex-like clients spawn Claude Code as background jobs with run/status/wait/result/kill/cleanup lifecycle tools.

**Architecture:** A TypeScript core supervisor owns job state and process lifecycle. CLI and MCP adapters stay thin and call the same core. Tests use a fake Claude executable so lifecycle behavior is deterministic and does not consume Claude Code quota.

**Tech Stack:** Node.js, TypeScript, Vitest, `@modelcontextprotocol/sdk`, `zod`.

---

## Tasks

- [x] Scaffold Node/TypeScript project with build, typecheck, and test scripts.
- [x] Add TDD tests and implementation for state path resolution and Claude argument construction.
- [x] Add TDD tests and implementation for `run`, `status`, `wait`, and `result`.
- [x] Add TDD tests and implementation for process-tree `kill` and terminal-job `cleanup`.
- [x] Add thin CLI adapter for local testing.
- [x] Add thin MCP stdio adapter exposing `claude_run`, `claude_status`, `claude_wait`, `claude_result`, `claude_kill`, and `claude_cleanup`.
- [x] Add verification for nonblocking core `run()` behavior using delayed fake Claude.
- [ ] Validate in Linux/WSL after Windows baseline is committed.

## Important Boundary

The MCP server is the intended spawn surface. The CLI is a local inspection and testing tool. Long-running production use should keep the MCP server process alive so it can observe child exit events and record final status.

