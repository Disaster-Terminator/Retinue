# Retinue Docs

Start here when the root README is not enough. The current product docs are separated from historical notes so `docs/` stays readable.

## Read by task

| I want to... | Read |
| --- | --- |
| Understand what Retinue is allowed to do | [Project Boundary](architecture/PROJECT_BOUNDARY.md) |
| Install the Codex plugin or inspect packaged plugin shape | [Plugin Deployment](deployment/PLUGIN_DEPLOYMENT.md) |
| Develop from source or run deterministic checks | [Source Install and Development](development/SOURCE_INSTALL.md) |
| Understand the default OpenCode backend | [OpenCode Backend](backends/OPENCODE.md) |
| Check service / daemon lifecycle behavior | [Service Lifecycle](deployment/SERVICE_LIFECYCLE.md) |
| Run the short verification gates | [Verification](VERIFICATION.md) |
| Track 0.1.0 release readiness | [0.1.0 Release Plan](release/0.1.0_RELEASE_PLAN.md) |
| Review active hardening issues | [0.1.0 Hardening Issues](release/0.1.0_HARDENING_ISSUES.md) |
| Understand the longer-term product direction | [Long-Term Vision](LONG_TERM_VISION.md) |

## Current product

- [0.1.0 Release Plan](release/0.1.0_RELEASE_PLAN.md) - release gate, completed work, and deferred issues.
- [0.1.0 Hardening Issues](release/0.1.0_HARDENING_ISSUES.md) - active smoke/E2E issues and acceptance boundaries.
- [Long-Term Vision](LONG_TERM_VISION.md) - Codex-compatible spawn direction, backend policy, and phased roadmap.
- [Project Boundary](architecture/PROJECT_BOUNDARY.md) - what Retinue is and is not.
- [OpenCode Backend](backends/OPENCODE.md) - OpenCode adapter behavior and constraints.

## Deployment and development

- [Plugin Deployment](deployment/PLUGIN_DEPLOYMENT.md) - Codex plugin packaging, marketplace install shape, and plugin cache behavior.
- [Source Install and Development](development/SOURCE_INSTALL.md) - contributor setup and source-tree verification.
- [Service Lifecycle](deployment/SERVICE_LIFECYCLE.md) - daemon start, inspect, and stop workflow.
- [Verification](VERIFICATION.md) - short test and packaging gates.

## Real runtime runbooks

- [Production OpenCode E2E](runbooks/PRODUCTION_OPENCODE_E2E.md)
- [Real Claude Code Probes](runbooks/REAL_CLAUDE_PROBES.md)
- [Real OpenCode Probes](runbooks/REAL_OPENCODE_PROBES.md)

## Archive

- [Verification History](archive/VERIFICATION_HISTORY.md)
- [PR #58 Static Review](archive/PR58_STATIC_REVIEW.md)
- [Repository Metadata Notes](archive/REPOSITORY_METADATA.md)

Implementation plans and research notes remain under `docs/superpowers/` and `docs/research/`.
