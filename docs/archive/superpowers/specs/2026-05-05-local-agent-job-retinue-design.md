# Local Agent Job Retinue Design

## Purpose

`retinue` is moving from a Claude Code-specific spawn helper to a local agent job retinue. The project should keep the lifecycle semantics already proven by the Claude Code backend while adding a backend contract that can support OpenCode without copying Claude-specific assumptions.

The product does not route models, providers, quota, proxy settings, or permission policies. Those remain owned by the local agent runtime: Claude Code for the frozen backend and OpenCode for the next backend.

## Current Evidence

`feature/spawn-claude-code` already contains the important durable pieces: CLI, MCP server, daemon, disk-backed job state, fake-Claude deterministic tests, real Claude probe scripts, bounded result artifacts, daemon discovery, daemon RPC, and Windows/WSL documentation.

`review/codex-web-nightly-2026-05-04` adds useful generic hardening, but it is not safe to merge as a whole. It still assumes npm workflows and package-lock metadata, adds npm-based GitHub Actions, and contains tests that fail under pnpm when Vitest imports executable `.mjs` probe scripts. The review branch should be treated as a patch source, not as an integration branch.

OpenCode already exposes mature integration surfaces: official headless server/API, official SDK, `opencode run --attach`, `opencode session`, and provider/model management owned by OpenCode itself. Third-party `opencode-mcp` is useful as a reference for workflows and session handling, but not as a core dependency.

## Architecture

The long-term architecture is:

```text
retinue-daemon
  owns job lifecycle, state, limits, cleanup, and external session mapping

AgentBackend adapters
  own runtime-specific launch, attach, prompt, abort, and result extraction

retinue-cli
  adapter for local inspection and administration

retinue-mcp
  adapter exposing stable tools to Codex-like clients
```

The daemon remains the lifecycle owner. CLI and MCP should not own long-running job truth once daemon mode is in use.

## Backend Contract

The internal backend contract should represent agent work without leaking Claude-specific command details:

```ts
type AgentBackendKind = "claude-code" | "opencode";

interface AgentBackend {
  readonly kind: AgentBackendKind;
  run(options: AgentRunOptions): Promise<AgentRunStart>;
  continueJob(options: AgentContinueOptions): Promise<AgentRunStart>;
  status(handle: AgentHandle): Promise<AgentBackendStatus>;
  result(handle: AgentHandle): Promise<AgentBackendResult>;
  abort(handle: AgentHandle): Promise<void>;
}
```

The existing `RetinueApi` can remain the public lifecycle boundary while the implementation moves runtime-specific work behind adapters. This reduces risk: existing `claude_*` tools can stay compatible while `opencode_*` tools are added explicitly.

## Metadata

Job metadata should be extended, not replaced:

```ts
backend: "claude-code" | "opencode";
externalSessionId?: string;
externalServerUrl?: string;
externalMessageId?: string;
model?: string;
agent?: string;
title?: string;
```

Existing Claude metadata remains readable. Metadata migrations must tolerate older records without a `backend` field by treating them as `claude-code`.

## Review Branch Absorption

Absorb these from `review/codex-web-nightly-2026-05-04` after converting to pnpm-compatible tests and docs:

- daemon client structured error fidelity
- daemon discovery URL and timestamp validation
- read-only `daemon-health` diagnostics
- MCP input schema validation tests

Do not absorb these as-is:

- npm-based CI workflows
- package-lock based package verifier
- npm command documentation
- Claude Code MCP matrix as a new product direction
- any permission bypass or provider/model routing behavior

## Package Manager Standard

The repository standard is pnpm. Verification commands are:

```bash
pnpm run typecheck
pnpm test
pnpm run build
```

Documentation, workflows, and scripts should use pnpm vocabulary. If package smoke verification is needed, it must be written against pnpm-compatible pack output and the package manifest, not `package-lock.json`.

## OpenCode Backend Direction

OpenCode integration should prefer the official server and SDK/API. `opencode run --attach --format json` is acceptable for manual probes and fallback compatibility, but it should not be the only durable integration path.

The first production OpenCode backend should:

- attach to an explicit `RETINUE_OPENCODE_BASE_URL` when provided
- optionally start `opencode serve` when explicitly enabled
- use loopback-only server defaults
- create or continue OpenCode sessions through the official API/SDK
- persist OpenCode session ids as external session ids
- expose bounded result artifacts through the same retinue result model
- preserve OpenCode-owned provider/model configuration

OpenCode permission bypass flags must not be exposed through normal retinue inputs.

## Public Surface

Do not rename existing Claude tools during the freeze work. Add OpenCode tools explicitly:

```text
opencode_run
opencode_status
opencode_wait
opencode_result
opencode_continue
opencode_kill
opencode_cleanup
```

Generic `agent_*` tools can be considered after both backends are stable. Adding them too early would force a premature abstraction across different runtime semantics.

## Testing Strategy

The default test suite must remain deterministic and quota-free:

- fake Claude for Claude Code behavior
- fake OpenCode HTTP server for OpenCode backend behavior
- CLI/MCP/daemon adapter tests for routing and schemas
- no real OpenCode or Claude Code calls in default tests

Manual probes can verify real runtimes:

- `opencode --version`
- `opencode serve`
- `/global/health`
- session create/list/prompt/abort/result extraction
- `opencode run --attach --format json` as compatibility fallback

Windows and WSL should be verified separately because node_modules and process behavior are platform-specific.

## Milestones

1. Document the new boundary and design.
2. Migrate the Claude branch to pnpm commands and lockfile.
3. Selectively absorb review branch hardening with pnpm-compatible tests.
4. Freeze Claude Code backend and merge it into `main`.
5. Create `feature/spawn-opencode` from updated `main`.
6. Implement OpenCode backend behind a backend contract using TDD.
7. Add `opencode_*` CLI/MCP surfaces and daemon delegation.
8. Run Windows verification, then WSL verification where practical.
