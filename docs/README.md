# Retinue Docs

Start here when you need more detail than the root README. This index separates current product guidance from deployment notes, development docs, runbooks, release records, and archive material.

## Current Product And Architecture

- [Architecture Overview](architecture/OVERVIEW.md) - runtime shape, product tool surface, lifecycle, backend notes, and safety defaults.
- [Project Boundary](architecture/PROJECT_BOUNDARY.md) - what Retinue is and is not.
- [OpenCode Backend](backends/OPENCODE.md) - default backend behavior, auto-serve policy, access mode, diagnostics, and raw adapter surfaces.
- [Long-Term Vision](LONG_TERM_VISION.md) - Codex-compatible spawn direction, backend policy, and phased roadmap.
- [Documentation Governance](DOCUMENTATION_GOVERNANCE.md) - source-of-truth map, behavior-change update matrix, style rules, PR checklist, and archive policy.

## Installation And Deployment

- [Plugin Deployment](deployment/PLUGIN_DEPLOYMENT.md) - Codex plugin packaging, installed plugin cache shape, local diagnostics, and production E2E boundary.
- [Service Lifecycle](deployment/SERVICE_LIFECYCLE.md) - daemon start, inspect, and stop workflow.
- [Hermes Agent Integration](integrations/HERMES.md) - Hermes native MCP setup for calling Retinue/OpenCode.

## Development And Verification

- [Source Install And Development](development/SOURCE_INSTALL.md) - contributor setup, source-tree verification, local gates, and probe commands.
- [Plugin Reload Workflow](development/PLUGIN_RELOAD.md) - fast WSL/Windows cache sync during plugin development.
- [Verification](VERIFICATION.md) - short test and packaging gates.

## Real Runtime Runbooks

- [Production OpenCode E2E](runbooks/PRODUCTION_OPENCODE_E2E.md)
- [Real OpenCode Probes](runbooks/REAL_OPENCODE_PROBES.md)
- [Real Claude Code Probes](runbooks/REAL_CLAUDE_PROBES.md)

## Release Records

- [0.1.0 Release Readiness](release/0.1.0_RELEASE_PLAN.md) - release boundary, closed work, release gate, and deferred issues.
- [0.1.0 Hardening Record](release/0.1.0_HARDENING_ISSUES.md) - closed smoke/E2E issues and current verification requirements.
- [v0.1.0 Release Notes](release/v0.1.0_RELEASE_NOTES.md) - user-facing release summary.
- [v0.1.0 Release Notes zh-CN](release/v0.1.0_RELEASE_NOTES.zh-CN.md) - Chinese reference.

## Archive And Research

- [Verification History](archive/VERIFICATION_HISTORY.md)
- [PR #58 Static Review](archive/PR58_STATIC_REVIEW.md)
- [Repository Metadata Notes](archive/REPOSITORY_METADATA.md)

Implementation plans and research notes remain under `docs/superpowers/` and `docs/research/`. They are not current product guidance unless this index explicitly promotes them into the sections above.
