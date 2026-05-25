# Retinue Docs

Start here. Current product guidance is separated from historical notes so the root `docs/`
directory stays readable.

## Current Product

- [0.2.0 Release Readiness](release/0.2.0_RELEASE_PLAN.md) - release boundary, closed work, release gate, and current evidence.
- [0.1.0 Hardening Record](release/0.1.0_HARDENING_ISSUES.md) - closed smoke/E2E issues and current verification requirements.
- [v0.2.0 Release Notes](release/v0.2.0_RELEASE_NOTES.md) - user-facing release summary.
- [v0.2.0 Release Notes zh-CN](release/v0.2.0_RELEASE_NOTES.zh-CN.md) - Chinese reference.
- [Long-Term Vision](LONG_TERM_VISION.md) - Codex-compatible spawn direction, backend policy, and phased roadmap.
- [Project Boundary](architecture/PROJECT_BOUNDARY.md) - what Retinue is and is not.
- [OpenCode Backend](backends/OPENCODE.md) - OpenCode adapter behavior and constraints.
- [Hermes Agent Integration](integrations/HERMES.md) - Hermes native MCP setup for calling Retinue/OpenCode.

## Deployment

- [Plugin Deployment](deployment/PLUGIN_DEPLOYMENT.md) - Codex plugin packaging and install shape.
- [Source Install And Development](development/SOURCE_INSTALL.md) - contributor setup and source-tree verification.
- [Plugin Reload Workflow](development/PLUGIN_RELOAD.md) - fast WSL/Windows cache sync during plugin development.
- [Service Lifecycle](deployment/SERVICE_LIFECYCLE.md) - optional daemon start, inspect, and stop workflow for custom deployments.
- [Verification](VERIFICATION.md) - short test and packaging gates.

## Real Runtime Runbooks

- [Production OpenCode E2E](runbooks/PRODUCTION_OPENCODE_E2E.md)
- [Real Claude Code Probes](runbooks/REAL_CLAUDE_PROBES.md)
- [Real OpenCode Probes](runbooks/REAL_OPENCODE_PROBES.md)

## Archive

- [Verification History](archive/VERIFICATION_HISTORY.md)
- [PR #58 Static Review](archive/PR58_STATIC_REVIEW.md)
- [Repository Metadata Notes](archive/REPOSITORY_METADATA.md)

Historical implementation plans and specs are archived under `docs/archive/superpowers/`. Research notes remain under `docs/research/` when they document current design decisions.
