# Retinue Documentation

Use this page by reader intent. The root [README](../README.md) is the short user entry point; this directory holds the deeper product, integration, and maintainer material.

## I Want To Try Retinue

- [Quick start](get-started/quick-start.md) - first Retinue child-agent task.
- [Install plugin](how-to/install-plugin.md) - Codex plugin marketplace, npm runtime path, and platform notes.
- [v0.2.0 release notes](releases/v0.2.0.md) - what changed in the current release.
- [v0.2.0 release notes zh-CN](releases/v0.2.0.zh-CN.md)

## I Am Configuring An Integration

- [Configuration reference](reference/configuration.md) - `RETINUE_*` defaults, precedence, and deployment knobs.
- [MCP tools](reference/mcp-tools.md) - normal product tools, result states, and permission flow.
- [OpenCode backend](reference/backends/opencode.md) - OpenCode server, profile, model, stall, and permission semantics.
- [Claude Code backend](reference/backends/claude-code.md) - SDK-first path, legacy CLI compatibility, and Claude-specific environment variables.
- [Kilo backend](reference/backends/kilo.md) - Kilo adapter status and probe shape.
- [Hermes integration](how-to/integrate-hermes.md) - Hermes MCP setup.
- [Run daemon](how-to/run-daemon.md) - local daemon lifecycle.

## I Am Developing Retinue

- [Source install](how-to/source-install.md)
- [Plugin cache reload](how-to/dev-reload-plugin.md)
- [Verification](how-to/verify.md)
- [Plugin deployment](how-to/install-plugin.md)
- [Repository metadata](archive/REPOSITORY_METADATA.md)

## I Am Debugging A Runtime Issue

- [Diagnostics reference](reference/diagnostics.md)
- [Log audit runbook](runbooks/log-audit.md)
- [Production OpenCode E2E](runbooks/production-opencode-e2e.md)
- [Real OpenCode probes](runbooks/real-opencode-probes.md)
- [Real Claude Code probes](runbooks/real-claude-probes.md)
- [Backend candidate probes](runbooks/backend-candidate-probes.md)

## I Want The Design Rationale

- [Project boundary](explanation/project-boundary.md)
- [Attempt recovery](explanation/attempt-recovery.md)
- [Spawn semantics](explanation/spawn-semantics.md)
- [Long-term vision](project/vision.md)

## Maintainer And Archive

- Release planning lives under [project/release-plans](project/release-plans/).
- Historical hardening notes live under [project/hardening](project/hardening/).
- Dated research and handoff artifacts live under [archive](archive/).
- Historical implementation plans and specs remain under [archive/superpowers](archive/superpowers/).
