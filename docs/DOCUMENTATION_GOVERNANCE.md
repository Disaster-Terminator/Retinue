# Documentation Governance

Retinue documentation should stay useful for three groups:

1. users who only want to install the Codex plugin and run a child agent;
2. operators who need deployment defaults, diagnostics, and real-runtime probes;
3. contributors who need to change the runtime safely.

When one document starts serving multiple audiences, split it or add an audience note near the top.

## Source Of Truth

| Topic | Source of truth | Notes |
| --- | --- | --- |
| Product positioning and user quickstart | Root `README.md` and `README.en.md` | Keep these focused on the current user path. |
| Documentation map | `docs/README.md` | Every durable doc should be reachable from here. |
| Architecture and boundary | `docs/architecture/OVERVIEW.md` and `docs/architecture/PROJECT_BOUNDARY.md` | Stable concepts, data flow, and non-goals. |
| OpenCode behavior | `docs/backends/OPENCODE.md` | Default backend behavior, access mode, diagnostics, and adapter notes. |
| Codex plugin packaging | `docs/deployment/PLUGIN_DEPLOYMENT.md` | Plugin install shape, bundled runtime, cache behavior, and production E2E boundary. |
| Source development | `docs/development/SOURCE_INSTALL.md` | Contributor setup, build, tests, hooks, and source-tree verification. |
| Release facts | `docs/release/*` | Versioned release notes and readiness records. Do not silently rewrite old release history. |
| Agent-facing behavior | `plugins/retinue/skills/retinue/SKILL.md` | Keep aligned with product MCP tools and safety defaults. |
| Hermes integration | `docs/integrations/HERMES.md` and `integrations/hermes/*` | Hermes is an MCP host integration, not a Retinue backend. |

## Document Types

Use these categories consistently:

- **README / quickstart**: current user path only; avoid implementation history.
- **Architecture**: stable concepts, data flow, boundaries, and non-goals.
- **Backend contract**: runtime-specific behavior and environment knobs.
- **Deployment**: installation shape, packaging, plugin cache, and operational defaults.
- **Development**: source checkout, tests, local probes, generated artifacts.
- **Runbook**: concrete steps for a real environment or incident class.
- **Release**: versioned records; historical once published.
- **Archive**: old reviews, metadata notes, and superseded records kept for traceability.

Research notes and speculative plans should stay under `docs/research/` or `docs/superpowers/` unless they are promoted into the docs index as current guidance.

## Required Updates When Behavior Changes

| Change | Docs to check |
| --- | --- |
| Product MCP tool added or removed | Root READMEs, architecture overview, Retinue skill doc |
| Backend default or backend selection behavior changes | Root READMEs, architecture overview, backend doc, plugin deployment doc |
| OpenCode auto-serve, port, timeout, or access-mode behavior changes | OpenCode backend doc, root READMEs, plugin deployment doc, skill doc |
| Plugin manifest, `.mcp.json`, bootstrap, or cache behavior changes | Plugin deployment doc, source install doc, root READMEs if user-visible |
| New environment variable | Relevant backend or deployment doc; root README only if normal users need it |
| State directory, log field, artifact, or diagnostic shape changes | Backend doc, deployment doc, runbooks, verification docs |
| Release process or package contents change | Release docs, source install doc, plugin deployment doc |
| Hermes integration changes | Hermes integration docs and `integrations/hermes/*` |

If a change is intentionally internal and not user-visible, say that in the PR body instead of forcing noisy README edits.

## Style Rules

- Prefer current behavior over project history.
- Put commands in copyable fenced blocks.
- Mark risky or environment-mutating steps explicitly.
- Keep secrets, tokens, account names, and API keys out of docs and traces.
- Use concrete tool names such as `retinue_spawn_agent`.
- Distinguish product tools from raw adapter/debug tools.
- Avoid claiming a real-runtime path is verified unless a real probe has passed.
- Use absolute paths in examples when workspace drift would matter.
- Keep Chinese and English READMEs semantically aligned when the user-facing install path changes.

## Documentation PR Checklist

```markdown
## Documentation checklist

- [ ] I identified the audience for each changed doc.
- [ ] I kept root README changes focused on current user paths.
- [ ] I updated `docs/README.md` when adding durable docs.
- [ ] I checked whether the Retinue skill guidance needs the same behavior update.
- [ ] I did not rewrite historical release notes except for typo/link fixes.
- [ ] I avoided secrets, local credentials, and unredacted provider details.
- [ ] I recorded whether verification was docs-only or included runtime gates.
```

For docs-only PRs, the minimum verification is a link/path review plus Markdown readability. Runtime gates are not required unless the doc claims a command or real probe currently works.

## Archive Policy

Move documents to `docs/archive/` when they are useful for traceability but no longer represent current product guidance. Add a short note at the top when practical:

```markdown
> Archived: this page records historical context and is not current setup guidance.
```

Do not delete release records or old review notes just because a newer path exists. Prefer demotion from the docs index to archive over deletion.

## Keeping The Docs Navigable

`docs/README.md` should remain the stable map for durable docs. Keep it grouped by user intent:

- current product and architecture;
- installation and deployment;
- development and verification;
- real-runtime runbooks;
- release records;
- archive and research.

A new doc that is not linked from `docs/README.md` should be treated as temporary or incomplete.
