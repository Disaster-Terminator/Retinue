# Retinue

<p align="left">
  <img alt="runtime Node.js 20+" src="https://img.shields.io/badge/runtime-Node.js%2020%2B-339933">
  <img alt="language TypeScript" src="https://img.shields.io/badge/language-TypeScript-3178C6">
  <img alt="package manager pnpm" src="https://img.shields.io/badge/package%20manager-pnpm-F69220">
  <img alt="interface MCP + CLI" src="https://img.shields.io/badge/interface-MCP%20%2B%20CLI-4B5563">
  <img alt="backends Claude Code and OpenCode" src="https://img.shields.io/badge/backends-Claude%20Code%20%2B%20OpenCode-111827">
  <img alt="scope local first" src="https://img.shields.io/badge/scope-local--first-0F766E">
</p>

[English](README.en.md)

**Retinue 让 Codex 把本地 coding agents 当作可控子代理来运行。**

Codex 提交一个 coding job，Retinue 立刻返回 job handle；之后可以查状态、等待完成、读取结果、继续外部会话、终止任务或清理本地产物。Claude Code、OpenCode 仍然负责自己的 provider、model、quota、proxy、login 和运行策略；Retinue 负责把这些本地 agent runtime 变成 Codex 可调用、可追踪、可接回的子代理能力。

```text
Codex / MCP client
  -> Retinue MCP 或 CLI
    -> backend adapter
      -> Claude Code / OpenCode
    -> local job state + bounded result artifacts
```

## 核心能力

| 能力 | 说明 |
| --- | --- |
| 启动子代理 | 让 Codex 启动 Claude Code 或 OpenCode coding job，并快速拿到 `jobId` |
| 查询状态 | 用 `status` 查看 running、completed、failed、killed、orphaned、abandoned 等状态 |
| 等待和轮询 | 用 `wait` 在短时间窗口内等待终态，不阻塞主 agent 的整段任务 |
| 读取结果 | 用 `result` 获取 bounded stdout/stderr、exit metadata、外部 session id 和本地 artifact path |
| 继续会话 | 后端支持时，用 `continue` 接回已有 Claude/OpenCode session 继续工作 |
| 终止和清理 | 用 `kill` 终止指定 job，或用 `cleanup` 删除终态 job 目录，同时保留运行中或状态不确定的任务 |

## 边界

Retinue 是本地子代理执行面，不是模型网关，也不是 provider router。

- 不选择或切换模型供应商。
- 不接管 Claude Code / OpenCode 的登录、配额、代理、模型默认值或运行策略。
- 不把 prompt 放进子代理进程 argv；CLI 调试场景请避免在敏感 prompt 上使用 `--prompt`。
- 不在默认 `status` 响应里返回完整 prompt。
- 不把自己扩展成通用进程管理器或云端队列。

## 快速开始

0.1.0 默认使用 OpenCode 后端，并让 OpenCode 使用 `explore` agent。用户不需要 clone、安装依赖或编译 Retinue。Retinue 面向 Windows、WSL/Linux 和 macOS；本轮验收路径使用 WSL。

前置条件：

- Node.js 20+
- Codex CLI 0.128+
- OpenCode 1.14+，优先使用官方安装脚本：

```bash
curl -fsSL https://opencode.ai/install | bash
```

官方脚本默认把 OpenCode 安装到 `$HOME/.opencode/bin/opencode`。Retinue 也兼容常见 npm/pnpm/bun 全局安装路径，但 0.1.0 的默认文档和冒烟验收以官方脚本安装为准。

把 Retinue 插件市场加入 Codex：

```bash
codex plugin marketplace add Disaster-Terminator/Retinue
```

打开 Codex，运行 `/plugins`，按键盘右方向键切到 `[Retinue Local]` 插件市场，按 Enter 打开 `Retinue` 详情页，然后选择 `Install plugin`。安装后重新打开 Codex，然后让 Codex 使用 Retinue：

```text
Use Retinue to spawn an OpenCode explore subagent. Ask it to reply exactly: RETINUE_OK. Wait for the result and close the child agent.
```

预期结果：

- Codex 能看到 Retinue skill。
- Codex 能调用 `retinue_spawn_agent`。
- `retinue_wait_agent` 返回包含 `RETINUE_OK` 的结果。
- `retinue_close_agent` 返回 terminal 状态。
- `retinue_list_agents` 可列出当前 MCP 会话内仍在运行的 Retinue 子代理。

说明：Codex CLI 0.128 的 `codex plugin marketplace add/upgrade/remove` 只管理插件市场；插件安装在 Codex TUI 的 `/plugins` 里完成。`codex plugin marketplace upgrade retinue-local` 只用于更新已有市场，不是安装命令。

## 平台说明

- Windows：需要本机 Node.js、Codex CLI 和 OpenCode 可用；Retinue 会优先查找官方脚本安装的 `%USERPROFILE%\.opencode\bin\opencode`，再回退到常见 pnpm/npm/bun shim。默认插件配置会管理本机 OpenCode server 生命周期。
- WSL / Linux：本轮 0.1.0 验收路径。默认插件配置会优先使用 `127.0.0.1:4096`，并在端口被外部服务占用时尝试 `4097` 到 `4127`。
- macOS：按同样的 Node.js、Codex CLI、OpenCode 前置条件运行；尚未作为本轮验收主路径。

## 默认插件配置

插件默认 MCP 配置位于 `plugins/retinue/.mcp.json`，随包出厂默认值位于 `plugins/retinue/retinue.config.json`。0.1.0 的 MCP 环境只负责启动后端：

```json
{
  "RETINUE_BACKEND": "opencode",
  "RETINUE_OPENCODE_AUTO_SERVE": "1",
  "RETINUE_OPENCODE_HOST": "127.0.0.1"
}
```

随包 `retinue.config.json` 默认是：

```json
{
  "maxConcurrentAgents": 3,
  "opencode": {
    "agent": "explore"
  }
}
```

这意味着：

- Codex 只调用 Retinue，不选择具体后端。
- Retinue 默认管理 OpenCode server 生命周期，优先使用 `127.0.0.1:4096`，端口被外部服务占用时尝试 `4097` 到 `4127`。
- OpenCode 使用当前本机 profile，包括 provider、model、login、plugin 和 skill。
- `explore` 是 0.1.0 的默认 agent。Retinue 不再提供产品级 `access_mode`，也不再用自己的 read-only prompt/tool 覆盖 OpenCode 行为。
- OpenCode 使用当前 profile，并按 OpenCode agent/profile 语义决定工具和权限。Retinue 只为直接 child session 派生 TaskTool-compatible session permission，例如按 OpenCode 语义补 `todowrite`/`task` deny。
- `retinue_spawn_agent` 只接受任务、工作目录、任务名和 OpenCode `agent` 选择。不要传 backend、profile、model、OpenCode server、`access_mode` 或 `bash_policy`。
- `retinue_wait_agent` 会把单次 MCP wait 限制在宿主安全窗口内，默认最大 180 秒。这个窗口覆盖 OpenCode 默认 45 秒 soft-stall 检测和一次 final-answer rescue；长任务仍可重复调用 wait 轮询，也可用 `RETINUE_MCP_WAIT_MAX_MS` 调整上限。
- 每个 Retinue MCP server 会话默认最多保留 3 个 active 子代理。超过上限的 active spawn 会关闭最旧的 running 子代理并返回 `evictedJobId`。`retinue.config.json` 是安装缓存内的包默认值，插件更新或缓存同步可能覆盖它；持久调整请写环境变量，例如 Codex `[env]` 或 Hermes MCP `env` 中的 `RETINUE_MAX_CONCURRENT_AGENTS`。

当 `retinue_wait_agent` 返回 `status: "running"` 时，子代理仍在运行。继续用同一个 `jobId` 再次调用 `retinue_wait_agent`；只有任务进入 `failed`、`killed`、`stalled` 或其他终态时，才需要按终态处理或重新启动。

`running` 响应会包含 `stdoutTail`、`stderrTail`、`tracePath` 和 job artifact 路径。先看 tail 字段；复杂 OpenCode 任务可能会连续几分钟处在 tool-call 阶段，单次 wait 超时不等于子代理失败。

OpenCode 空输出或未完成 assistant 循环超过诊断阈值后，Retinue 会把任务报告为 `stalled`。默认长兜底阈值是 10 分钟；blank provider placeholder、zero-progress assistant placeholder、未完成的最新 assistant round、pending/running `read` tool call，以及完成工具调用但没有最终文本的循环，默认窗口都是 45 秒。malformed read 或 finalization rescue 失败时，Retinue 可以启动一次新的 task-level attempt；原 job 仍是 `stalled` 非证据，wait 响应会带 `requestedJobId`、`selectedAttemptJobId` 和 `attemptChain`。部署可以用 `RETINUE_OPENCODE_TASK_ATTEMPT_MAX=0` 关闭 fresh attempt，用 `RETINUE_OPENCODE_STALL_MS`、`RETINUE_OPENCODE_STALL_COMPLETED_TOOL_LOOP_MS`、`RETINUE_OPENCODE_STALL_INCOMPLETE_ASSISTANT_MS`、`RETINUE_OPENCODE_STALL_READ_TOOL_MS`、`RETINUE_OPENCODE_STALL_BLANK_ASSISTANT_MS`、`RETINUE_OPENCODE_STALL_ZERO_PROGRESS_ASSISTANT_MS`、`RETINUE_OPENCODE_STALL_TOOL_CALL_ROUNDS` 和 `RETINUE_OPENCODE_STALL_EMPTY_ASSISTANT_ROUNDS` 调整诊断窗口。

`retinue_spawn_agent` 会同时返回请求的 `cwd` 和 OpenCode 实际 session 的 `externalSessionDirectory`。如果两者不一致，先关闭这个子代理，再用目标仓库的绝对路径重新 spawn；在此之前不要相信仓库相关结论。

## 日志

Retinue 把本地诊断写入 `RETINUE_STATE_DIR`。未设置时默认位置：

- Windows：`%LOCALAPPDATA%\retinue`
- Linux / WSL / macOS：`$XDG_STATE_HOME/retinue` 或 `$HOME/.local/state/retinue`

常用文件：

- `<stateDir>/logs/retinue.jsonl`：Retinue trace，包括 OpenCode server 生命周期和 wait 诊断。
- `<stateDir>/jobs/<jobId>/meta.json`：job 元数据。
- `<stateDir>/jobs/<jobId>/stdout.log` 和 `stderr.log`：终态结果和单 job 诊断。

## Claude Code 后端

Claude Code 后端已经通过 fake E2E 和真实 best-effort E2E。0.1.0 默认不启用它。需要切换时，修改部署配置：

```bash
RETINUE_BACKEND=claude-code
```

Claude Code 的模型、endpoint、权限和 profile 仍由 Claude Code 自己管理。

## npm 安装

npm 包用于直接安装 Retinue runtime，适合自定义 MCP 配置或开发者环境：

```bash
npm install -g @disaster-terminator/retinue@0.1.0
codex mcp add retinue \
  --env RETINUE_BACKEND=opencode \
  --env RETINUE_OPENCODE_BASE_URL=http://127.0.0.1:4096 \
  --env RETINUE_OPENCODE_AGENT=explore \
  -- retinue-mcp
```

普通 Codex 用户优先使用插件市场安装；npm 路径不安装 Retinue skill。

## Hermes Agent

Hermes Agent 可以把 Retinue 当作 master-agent MCP 集成来用。Hermes 不是 Retinue 后端；Hermes 通过 `mcp_servers` 加载 Retinue，然后调用带前缀的工具：`mcp_retinue_retinue_spawn_agent`、`mcp_retinue_retinue_wait_agent`、`mcp_retinue_retinue_close_agent`、`mcp_retinue_retinue_list_agents`。

安装 npm runtime，并把 `integrations/hermes/mcp-retinue.yaml` 合并进 `~/.hermes/config.yaml`；完整说明见 [Hermes Agent Integration](docs/integrations/HERMES.md)。默认仍然是 OpenCode `explore`，并由 Retinue 管理 OpenCode server 生命周期。

## 验证

发布前已通过：

- Retinue OpenCode fake E2E
- Retinue OpenCode real E2E
- Retinue Claude Code fake E2E
- Retinue Claude Code real best-effort E2E
- `pnpm test`
- `pnpm run typecheck`
- `pnpm run build`
- `pnpm run verify:package`

真实 OpenCode probe：

```bash
RETINUE_REAL_OPENCODE_PROBE=1 \
RETINUE_BACKEND=opencode \
pnpm run probe:real:retinue-opencode
```

Hermes MCP 形态 probe：

```bash
pnpm run probe:hermes-retinue
```

## 开发者文档

- [源码安装和开发](docs/development/SOURCE_INSTALL.md)
- [0.1.0 Release Notes](docs/release/v0.1.0_RELEASE_NOTES.md)
- [0.1.0 发布说明（中文）](docs/release/v0.1.0_RELEASE_NOTES.zh-CN.md)
- [0.1.0 发布就绪记录](docs/release/0.1.0_RELEASE_PLAN.md)
- [Docs Index](docs/README.md)
- [Long-Term Vision](docs/LONG_TERM_VISION.md)
- [Project Boundary](docs/architecture/PROJECT_BOUNDARY.md)
- [Service Lifecycle](docs/deployment/SERVICE_LIFECYCLE.md)
- [Plugin Deployment](docs/deployment/PLUGIN_DEPLOYMENT.md)
- [Hermes Agent Integration](docs/integrations/HERMES.md)
