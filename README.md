# Retinue

<p align="left">
  <img alt="runtime Node.js 20+" src="https://img.shields.io/badge/runtime-Node.js%2020%2B-339933">
  <img alt="language TypeScript" src="https://img.shields.io/badge/language-TypeScript-3178C6">
  <img alt="package manager pnpm" src="https://img.shields.io/badge/package%20manager-pnpm-F69220">
  <img alt="interface MCP + CLI" src="https://img.shields.io/badge/interface-MCP%20%2B%20CLI-4B5563">
  <img alt="backends Claude Code and OpenCode" src="https://img.shields.io/badge/backends-Claude%20Code%20%2B%20OpenCode-111827">
  <img alt="scope local first" src="https://img.shields.io/badge/scope-local--first-0F766E">
</p>

[English](README.en.md) · [文档索引](docs/README.md) · [插件部署](docs/deployment/PLUGIN_DEPLOYMENT.md) · [源码开发](docs/development/SOURCE_INSTALL.md)

**Retinue 让 Codex 把本地 coding agents 当作可控子代理来运行。**

Codex 提交一个 coding job，Retinue 立刻返回 job handle；之后可以查状态、等待完成、读取结果、继续外部会话、终止任务或清理本地产物。Claude Code、OpenCode 仍然负责自己的 provider、model、quota、proxy、login 和运行策略；Retinue 负责把这些本地 agent runtime 变成 Codex 可调用、可追踪、可接回的子代理能力。

```text
Codex / MCP client
  -> Retinue MCP 或 CLI
    -> backend-neutral lifecycle API
      -> backend adapter
        -> Claude Code / OpenCode
      -> local job state + bounded result artifacts
```

## 适合什么场景

Retinue 适合把一段相对独立的 coding task 委托给本机已有 agent，同时让主 Codex 线程保留控制权：

- 主 Codex 线程继续规划、review、验收；子代理负责局部实现、调查或验证。
- 子代理运行时间可能较长，主线程需要先拿到 `jobId`，之后再轮询或等待结果。
- 需要保留本地 job 状态、外部 session id、bounded stdout/stderr 和 artifact path，便于接回或排查。
- 希望复用本机 Claude Code / OpenCode 的现有登录、模型、profile、代理、权限和配额设置，而不是在 MCP 工具里重新实现一套路由系统。

## 不做什么

Retinue 是本地子代理执行面，不是模型网关，也不是 provider router。

- 不选择或切换模型供应商。
- 不接管 Claude Code / OpenCode 的登录、配额、代理、模型默认值或运行策略。
- 不把 prompt 放进进程 argv。
- 不在默认 `status` 响应里返回完整 prompt。
- 不把自己扩展成通用进程管理器、云端队列或多机调度系统。

更完整的边界说明见 [Project Boundary](docs/architecture/PROJECT_BOUNDARY.md)。

## 核心工具流

普通 Codex 插件用户主要用这三个 Retinue 工具：

| 工具 | 用途 | 典型返回 |
| --- | --- | --- |
| `retinue_spawn_agent` | 启动部署所选后端的子代理 job | `jobId`、`status`、`backend`、session id |
| `retinue_wait_agent` | 在短时间窗口内等待子代理进入终态 | running 或 terminal 状态，终态时带 result |
| `retinue_close_agent` | 关闭仍在运行的子代理，或确认已终止状态 | killed / completed / failed 等状态 |

底层仍保留 `opencode_*` 和 `claude_*` 调试工具，但它们不是默认的 Codex 委托入口。

## 快速开始：Codex 插件市场

0.1.0 默认使用 OpenCode 后端，并让 OpenCode 使用 `plan` agent。普通用户不需要 clone、安装依赖或编译 Retinue。Retinue 面向 Windows、WSL/Linux 和 macOS；本轮验收路径使用 WSL。

前置条件：

- Node.js 20+
- Codex CLI 0.128+
- OpenCode 1.14+

把 Retinue 插件市场加入 Codex：

```bash
codex plugin marketplace add Disaster-Terminator/Retinue
```

然后打开 Codex，运行 `/plugins`，按键盘右方向键切到 `[Retinue Local]` 插件市场，按 Enter 打开 `Retinue` 详情页，再选择 `Install plugin`。

安装后重新打开 Codex，然后让 Codex 使用 Retinue：

```text
Use Retinue to spawn an OpenCode plan subagent. Ask it to reply exactly: RETINUE_OK. Wait for the result and close the child agent.
```

预期结果：

- Codex 能看到 Retinue skill。
- Codex 能调用 `retinue_spawn_agent`。
- `retinue_wait_agent` 返回包含 `RETINUE_OK` 的结果。
- `retinue_close_agent` 返回 terminal 状态。

说明：Codex CLI 0.128 的 `codex plugin marketplace add/upgrade/remove` 只管理插件市场；插件安装在 Codex TUI 的 `/plugins` 里完成。`codex plugin marketplace upgrade retinue-local` 只用于更新已有市场，不是安装命令。

## 默认插件配置

插件默认 MCP 配置位于 `plugins/anchorpoint/.mcp.json`。0.1.0 固定为：

```json
{
  "mcpServers": {
    "retinue": {
      "command": "node",
      "args": ["./dist/mcp.js"],
      "cwd": ".",
      "startup_timeout_sec": 30,
      "env": {
        "SUPERVISOR_RETINUE_BACKEND": "opencode",
        "SUPERVISOR_OPENCODE_AUTO_SERVE": "1",
        "SUPERVISOR_OPENCODE_HOST": "127.0.0.1",
        "SUPERVISOR_OPENCODE_AGENT": "plan"
      }
    }
  }
}
```

这意味着：

- Codex 只调用 Retinue，不在每次 tool call 里选择具体后端。
- Retinue 默认管理 OpenCode server 生命周期，优先使用 `127.0.0.1:4096`，端口被外部服务占用时尝试 `4097`。
- `cwd: "."` 让 Codex 从已安装的插件缓存目录启动 `node ./dist/mcp.js`，避免被当前对话工作目录影响。
- OpenCode 使用当前本机 profile，包括 provider、model、login、permission、plugin 和 skill。
- `plan` 是 0.1.0 的安全默认；后续会通过 Retinue 配置支持切到 `build`，不把这个选择暴露成每次 tool call 的参数。

## 安装路径怎么选

| 路径 | 适合谁 | 会安装什么 |
| --- | --- | --- |
| Codex 插件市场 | 普通 Codex 用户 | Retinue skill、MCP 配置、插件内置 runtime |
| npm 全局安装 | 自定义 MCP 配置或开发者环境 | `retinue`、`retinue-mcp`、`retinued` runtime |
| 源码 checkout | 贡献者、调试者 | TypeScript 源码、测试、构建和打包验证脚本 |

普通 Codex 用户优先使用插件市场。npm 路径只安装 runtime，不安装 Retinue skill。

npm 安装示例：

```bash
npm install -g @disaster-terminator/retinue@0.1.0
codex mcp add retinue \
  --env SUPERVISOR_RETINUE_BACKEND=opencode \
  --env SUPERVISOR_OPENCODE_BASE_URL=http://127.0.0.1:4096 \
  --env SUPERVISOR_OPENCODE_AGENT=plan \
  -- retinue-mcp
```

## 平台说明

- Windows：需要本机 Node.js、Codex CLI 和 OpenCode 可用；OpenCode server 地址仍按部署环境配置。
- WSL / Linux：当前 0.1.0 验收主路径。默认配置连接 `http://127.0.0.1:4096`。
- macOS：按同样的 Node.js、Codex CLI、OpenCode 前置条件运行；尚未作为本轮验收主路径。

## 后端状态

### OpenCode

OpenCode 是 0.1.0 默认后端。Retinue 默认启用 auto-serve：

```text
SUPERVISOR_OPENCODE_AUTO_SERVE=1
SUPERVISOR_OPENCODE_HOST=127.0.0.1
SUPERVISOR_OPENCODE_AGENT=plan
```

Retinue 只负责连接或启动本地 OpenCode server，并通过 OpenCode API 创建、等待、读取和关闭 job。模型、provider、登录、权限、插件和 skill 仍由 OpenCode 当前 profile 管理。

### Claude Code

Claude Code 后端已经通过 fake E2E 和真实 best-effort E2E。0.1.0 默认不启用它。需要切换时，修改部署配置：

```bash
SUPERVISOR_RETINUE_BACKEND=claude-code
```

Claude Code 的模型、endpoint、权限和 profile 仍由 Claude Code 自己管理。

## 开发和验证

贡献者从源码运行：

```bash
pnpm install
pnpm run build
pnpm test
```

发布前的确定性 gates：

```bash
pnpm run typecheck
pnpm run check:generated
pnpm test
pnpm run verify:package
```

真实 OpenCode probe：

```bash
SUPERVISOR_REAL_OPENCODE_PROBE=1 \
SUPERVISOR_RETINUE_BACKEND=opencode \
SUPERVISOR_OPENCODE_BASE_URL=http://127.0.0.1:4096 \
pnpm run probe:real:retinue-opencode
```

发布前已通过：

- Retinue OpenCode fake E2E
- Retinue OpenCode real E2E
- Retinue Claude Code fake E2E
- Retinue Claude Code real best-effort E2E
- `pnpm test`
- `pnpm run typecheck`
- `pnpm run build`
- `pnpm run verify:package`

## 常见问题

### `marketplace add` 之后为什么还不能用？

`codex plugin marketplace add Disaster-Terminator/Retinue` 只是添加插件市场。还需要在 Codex TUI 里运行 `/plugins`，进入 `[Retinue Local]`，再选择 `Install plugin`。

### npm 安装后为什么没有 Retinue skill？

npm 包只安装 runtime，不安装 Codex 插件 skill。普通 Codex 用户应使用插件市场路径。

### OpenCode 端口被占用怎么办？

默认 auto-serve 会优先尝试 `127.0.0.1:4096`，如果该端口被外部服务占用，会尝试 `4097`。如果你明确要连接外部 OpenCode server，设置 `SUPERVISOR_OPENCODE_BASE_URL=http://127.0.0.1:4096`。

### 为什么不在 tool call 里传 model / provider / permission？

这是刻意边界。Retinue 的默认入口只负责子代理生命周期；模型、provider、权限和 profile 属于 Claude Code / OpenCode 的本地 runtime 策略。

## 文档导航

- [Docs Index](docs/README.md)
- [Project Boundary](docs/architecture/PROJECT_BOUNDARY.md)
- [OpenCode Backend](docs/backends/OPENCODE.md)
- [Plugin Deployment](docs/deployment/PLUGIN_DEPLOYMENT.md)
- [Source Install and Development](docs/development/SOURCE_INSTALL.md)
- [Service Lifecycle](docs/deployment/SERVICE_LIFECYCLE.md)
- [0.1.0 Release Plan](docs/release/0.1.0_RELEASE_PLAN.md)
- [Long-Term Vision](docs/LONG_TERM_VISION.md)
