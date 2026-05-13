# Hermes Agent Integration

Hermes Agent is a peer master-agent surface, not a Retinue backend. The integration path is Hermes native MCP client -> Retinue MCP server -> OpenCode backend.

## Contract

Hermes reads MCP servers from `~/.hermes/config.yaml` under the `mcp_servers` key. Retinue exposes the same product tools there:

- `retinue_spawn_agent`
- `retinue_wait_agent`
- `retinue_close_agent`
- `retinue_list_agents`

Hermes registers them with the server prefix, so Hermes tool names are:

- `mcp_retinue_retinue_spawn_agent`
- `mcp_retinue_retinue_wait_agent`
- `mcp_retinue_retinue_close_agent`
- `mcp_retinue_retinue_list_agents`

The Retinue backend remains deployment-selected. The default Hermes config uses OpenCode with Retinue-managed auto-serve and the OpenCode `plan` agent.

## Recommended Runtime Install

Install the Retinue runtime so Hermes can start the MCP server by command name:

```bash
npm install -g @disaster-terminator/retinue@0.1.0
```

Then merge this into `~/.hermes/config.yaml`:

```yaml
mcp_servers:
  retinue:
    command: "retinue-mcp"
    env:
      RETINUE_BACKEND: "opencode"
      RETINUE_OPENCODE_AUTO_SERVE: "1"
      RETINUE_OPENCODE_HOST: "127.0.0.1"
      RETINUE_OPENCODE_AGENT: "plan"
    timeout: 180
    connect_timeout: 30
```

The same snippet is shipped at `integrations/hermes/mcp-retinue.yaml`.

## Source Checkout Runtime

For local development without a global npm install, point Hermes at the built source checkout:

```yaml
mcp_servers:
  retinue:
    command: "node"
    args: ["/absolute/path/to/Retinue/dist/mcp.js"]
    env:
      RETINUE_BACKEND: "opencode"
      RETINUE_OPENCODE_AUTO_SERVE: "1"
      RETINUE_OPENCODE_HOST: "127.0.0.1"
      RETINUE_OPENCODE_AGENT: "plan"
    timeout: 180
    connect_timeout: 30
```

Run `pnpm run build` before using the source checkout path.

## Optional Hermes Skill

Retinue ships a Hermes-facing skill at `integrations/hermes/skills/retinue/SKILL.md`. Copy or expose that skill through Hermes `skills.external_dirs` if you want Hermes to receive concise operating guidance for the Retinue MCP tools.

The skill is guidance only. The MCP server config is what makes the tools available.

## Smoke Probe

The local smoke probe starts Retinue using the same stdio MCP shape Hermes uses and verifies the tool list:

```bash
pnpm run probe:hermes-retinue
```

For a real OpenCode child-agent round trip, opt in explicitly:

```bash
RETINUE_REAL_HERMES_RETINUE_PROBE=1 pnpm run probe:hermes-retinue
```

The real probe creates a temporary workspace with a random `RETINUE_MARKER.txt`, uses `retinue_spawn_agent -> retinue_wait_agent -> retinue_close_agent`, asks the OpenCode child to read that file, and prints the Retinue state directory plus trace path. This proves the child agent can use its file-reading tools instead of only echoing prompt text.

## Safety Notes

- This integration does not mutate the Hermes gateway service.
- Retinue does not receive Hermes provider credentials unless the user explicitly puts them in the MCP server `env`.
- Backend, model, provider, and OpenCode server choices remain deployment/runtime configuration. `access_mode` is the one per-spawn safety intent exposed to Hermes callers; omit it for the deployment default, or set `profile` only when child-agent writes are intentionally acceptable.
- If Hermes cannot connect to the server, check `~/.hermes/logs/mcp-stderr.log` and Retinue's `<stateDir>/logs/retinue.jsonl`.
