# Retinue

<!-- markdownlint-disable MD033 -->
<p>
  <img alt="npm version" src="https://img.shields.io/npm/v/%40disaster-terminator%2Fretinue">
  <img alt="license Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-blue">
  <img alt="package manager pnpm" src="https://img.shields.io/badge/package%20manager-pnpm-F69220">
  <img alt="node >=20" src="https://img.shields.io/badge/node-%3E%3D20-339933">
  <img alt="backends OpenCode Claude Code and Kilo" src="https://img.shields.io/badge/backends-OpenCode%20%2B%20Claude%20Code%20%2B%20Kilo-111827">
</p>
<!-- markdownlint-enable MD033 -->

[English](README.en.md)

Retinue 让 Codex 把本机 OpenCode、Claude Code 或 Kilo 作为可控子代理运行：主线程拿到 job handle，子代理在后台执行，结果、权限请求和失败诊断都通过 MCP 返回。

```text
Codex / Hermes
  -> Retinue MCP tools
  -> local agent runtime: OpenCode by default, Claude Code or Kilo when configured
```

## 适用场景

| 场景 | Retinue 提供什么 |
| --- | --- |
| 并行审查 | 启动独立本地 agent 做只读检查，主线程继续推进 |
| 长任务管理 | 用 `jobId` 等待、复查、关闭或诊断后台任务 |
| 权限上浮 | 子代理遇到 OpenCode 权限请求时，由主代理显式回复 |
| 本机预算 | 对单个 MCP 会话和共享机器状态目录做并发限制与排队 |
| 后端复用 | 复用 OpenCode / Claude Code / Kilo 自己的 profile、model、login、quota 和权限策略 |

Retinue 不选择模型、不接管 provider、不保存 API key，也不会把自己的只读策略叠加到正常 OpenCode 子代理上。模型、端点、插件、skills 和权限规则属于被调用的本地 agent runtime。

## 快速开始

前置条件：

- Node.js 20+
- Codex CLI 0.128+
- OpenCode 1.14+，推荐官方安装脚本：

```bash
curl -fsSL https://opencode.ai/install | bash
```

添加 Retinue 插件市场：

```bash
codex plugin marketplace add Disaster-Terminator/Retinue
```

然后在 Codex 中运行 `/plugins`，切到 `[Retinue Local]`，打开 `Retinue`，选择 `Install plugin`。安装后重启 Codex，让 Codex 跑一个真实的只读任务：

```text
Use Retinue to spawn an OpenCode explore subagent in this repository.
Ask it to inspect README.md and docs/README.md, summarize whether the docs entry points are clear, wait for the result, then close the child agent.
```

预期结果：

- Codex 调用 `retinue_spawn_agent` 并拿到 `jobId`。
- `retinue_wait_agent` 返回 `completed`、`running`、`queued`、`stalled` 或权限事件。
- 任务结束后，Codex 调用 `retinue_close_agent` 清理子代理。

更完整的安装说明见 [Plugin install](docs/how-to/install-plugin.md)，第一次任务教程见 [Quick start](docs/get-started/quick-start.md)。

## 默认行为

0.2.0 的插件默认路径是：

- 后端：OpenCode
- OpenCode server：Retinue 管理本机 loopback server
- 默认 OpenCode agent：`explore`
- 单个 MCP 会话默认 active 子代理数：3
- 共享机器预算默认值：`max(5, RETINUE_MAX_CONCURRENT_AGENTS)`
- 溢出策略：排队，而不是驱逐旧任务

这些是包内默认值，不是持久用户配置。需要持久覆盖时，把 `RETINUE_*` 环境变量放进 Codex `[env]` 或 MCP host 环境。完整配置见 [Configuration reference](docs/reference/configuration.md)。

## 常用文档

- [Documentation index](docs/README.md)
- [MCP tools](docs/reference/mcp-tools.md)
- [Diagnostics](docs/reference/diagnostics.md)
- [OpenCode backend](docs/reference/backends/opencode.md)
- [Claude Code backend](docs/reference/backends/claude-code.md)
- [Kilo backend](docs/reference/backends/kilo.md)
- [Hermes integration](docs/how-to/integrate-hermes.md)
- [Verification](docs/how-to/verify.md)
- [v0.2.0 release notes](docs/releases/v0.2.0.md)

## npm Runtime

普通 Codex 用户应优先使用插件市场。npm 包面向自定义 MCP 配置、Hermes 集成和直接 CLI 使用：

```bash
npm install -g @disaster-terminator/retinue@0.2.0
retinue-mcp
```

npm 只安装 runtime，不会自动安装 Codex 插件 skill。Hermes 配置见 [Hermes integration](docs/how-to/integrate-hermes.md)。
