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

Codex 提交一个 coding job，Retinue 立刻返回 job handle；之后可以查状态、等待完成、读取结果、继续外部会话、结束任务或清理本地产物。Claude Code、OpenCode 仍然负责自己的 provider、model、quota、proxy、login 和运行策略；Retinue 负责把这些本地 agent runtime 变成 Codex 可调用、可追踪、可接回的子代理能力。

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
| 查询状态 | 用 `status` 查看 running、completed、failed、stopped、orphaned、abandoned 等状态 |
| 等待和轮询 | 用 `wait` 在短时间窗口内等待终态，不阻塞主 agent 的整段任务 |
| 读取结果 | 用 `result` 获取 bounded stdout/stderr、exit metadata、外部 session id 和本地 artifact path |
| 继续会话 | 后端支持时，用 `continue` 接回已有 Claude/OpenCode session 继续工作 |
| 结束和清理 | 结束指定 job，或用 `cleanup` 删除终态 job 目录，同时保留运行中或状态不确定的任务 |

## 边界

Retinue 是本地子代理执行面，不是模型网关，也不是 provider router。

- 不选择或切换模型供应商。
- 不接管 Claude Code / OpenCode 的登录、配额、代理、模型默认值或运行策略。
- 不把 prompt 放进进程 argv。
- 不在默认 `status` 响应里返回完整 prompt。
- 不把自己扩展成通用进程管理器或云端队列。

## 快速开始

```bash
pnpm install
pnpm run build
pnpm run typecheck
pnpm test
```

先用 fake Claude 跑一条确定性本地 job，避免消耗真实 Claude Code quota：

```bash
SUPERVISOR_CLAUDE_COMMAND=node \
SUPERVISOR_CLAUDE_PREFIX_ARGS=tests/fixtures/fake-claude.mjs \
node dist/cli.js run --cwd . --prompt "hello"

node dist/cli.js wait <jobId> --timeout-ms 30000
node dist/cli.js result <jobId>
```

PowerShell：

```powershell
$env:SUPERVISOR_CLAUDE_COMMAND = "node"
$env:SUPERVISOR_CLAUDE_PREFIX_ARGS = "tests/fixtures/fake-claude.mjs"
node dist/cli.js run --cwd . --prompt "hello"
node dist/cli.js wait <jobId> --timeout-ms 30000
node dist/cli.js result <jobId>
```

## CLI

```bash
pnpm run build

node dist/cli.js run --cwd . --prompt "Reply exactly: OK"
node dist/cli.js status <jobId>
node dist/cli.js wait <jobId> --timeout-ms 30000
node dist/cli.js result <jobId>
node dist/cli.js continue --cwd . --job-id <jobId> --prompt "Follow up"
node dist/cli.js cleanup --older-than-ms 86400000
```

OpenCode 后端连接本地 loopback server：

```bash
SUPERVISOR_OPENCODE_BASE_URL=http://127.0.0.1:4096 \
node dist/cli.js opencode-run \
  --cwd . \
  --prompt "Reply exactly: RETINUE_OPENCODE_OK"

node dist/cli.js opencode-wait <jobId> --timeout-ms 180000
node dist/cli.js opencode-result <jobId>
```

可选模型和 agent 默认值由环境变量传给 OpenCode；未设置时，Retinue 省略这些字段，让 OpenCode 使用自己的配置：

```bash
SUPERVISOR_OPENCODE_MODEL=litellm/pro-router
SUPERVISOR_OPENCODE_AGENT=build
```

## MCP 工具

构建后，把 MCP client 配到：

```bash
node /path/to/Retinue/dist/mcp.js
```

Claude Code 工具：`claude_run`、`claude_status`、`claude_wait`、`claude_result`、`claude_continue`、`claude_peek`、`claude_cleanup`。

OpenCode 工具：`opencode_run`、`opencode_status`、`opencode_wait`、`opencode_result`、`opencode_continue`、`opencode_cleanup`。

## 状态目录

Windows：

```text
%LOCALAPPDATA%\supervisor
```

Linux / WSL：

```text
$XDG_STATE_HOME/supervisor
~/.local/state/supervisor
```

用 `SUPERVISOR_STATE_DIR` 可以覆盖状态目录。

## 环境变量

| 变量 | 用途 |
| --- | --- |
| `SUPERVISOR_STATE_DIR` | 覆盖 job metadata 和 artifact 的状态目录 |
| `SUPERVISOR_CLAUDE_COMMAND` | 覆盖 Claude Code 可执行文件，常用于 fake runtime 测试 |
| `SUPERVISOR_CLAUDE_PREFIX_ARGS` | 在 Retinue 生成的 Claude Code 参数前追加固定参数 |
| `SUPERVISOR_DEFAULT_RUNTIME_TIMEOUT_MS` | 设置未显式传入 `timeoutMs` 时的默认 runtime timeout |
| `SUPERVISOR_MAX_CONCURRENT_JOBS` | 限制当前进程内并发运行 job 数 |
| `SUPERVISOR_OPENCODE_BASE_URL` | 指向本地 OpenCode loopback server |
| `SUPERVISOR_OPENCODE_MODEL` | 可选 OpenCode 默认模型，格式为 `provider/model` |
| `SUPERVISOR_OPENCODE_AGENT` | 可选 OpenCode 默认 agent |
| `SUPERVISOR_DAEMON_URL` | 让 CLI/MCP 显式连接本地 loopback daemon |
| `SUPERVISOR_DAEMON_DISCOVERY` | 设为 `1` 时从 `<stateDir>/daemon.json` 发现 daemon |

## 安全和可靠性默认值

- Prompt 写入 job-local `prompt.md`，再通过 stdin 传给后端 agent。
- `status` 默认只暴露 `promptPath`、`promptPreview` 和 `promptSha256`。
- `result` 和 `peek` 默认返回 bounded stdout/stderr，并给出 `stdoutPath`、`stderrPath`、字节数和截断标记。
- 缺失 PID、旧状态文件或损坏 metadata 会被标成明确状态，不伪装成成功。
- Windows 和 WSL 不应共用同一个 `node_modules`；两个环境分别执行 `pnpm install --frozen-lockfile`。

## 可选 daemon 模式

Retinue 可以直接在 CLI/MCP 进程内运行，也可以显式连接本地 loopback daemon：

```bash
pnpm run build
node dist/daemon.js --host 127.0.0.1 --port 27777
```

未设置 `SUPERVISOR_DAEMON_URL`、`--daemon-url`、`SUPERVISOR_DAEMON_DISCOVERY=1` 或 `--discover-daemon` 时，CLI/MCP 使用直接本地路径。

## 验证

```bash
pnpm run typecheck
pnpm test
pnpm run build
```

真实后端探针默认不进 CI，也不属于确定性测试套件：

- [Real Claude Code Probes](docs/REAL_CLAUDE_PROBES.md)
- [Real OpenCode Probes](docs/REAL_OPENCODE_PROBES.md)
- [Production OpenCode E2E](docs/PRODUCTION_OPENCODE_E2E.md)

更多边界和运行方式见：

- [Project Boundary](docs/PROJECT_BOUNDARY.md)
- [Service Lifecycle](docs/SERVICE_LIFECYCLE.md)
- [Plugin Deployment](docs/PLUGIN_DEPLOYMENT.md)
