# Anchorpoint

> 本地 coding agent 的后台任务控制面：启动、追踪、等待、续跑、读取结果、终止与清理长时间运行的 agent job。

Anchorpoint 让 Codex、MCP client、脚本或本地工具可以把外部 coding agent 当作可管理的后台任务来使用，而不是一次性阻塞调用。

它当前支持 Claude Code 兼容后端，并通过 CLI、stdio MCP server 和本地 daemon 暴露同一套生命周期语义。长期目标是由本地 daemon 统一拥有 job 生命周期，CLI 和 MCP 只作为轻量 adapter。

## 为什么不是继续叫 supervisor

`supervisor` 描述的是实现手段，不是产品边界。这个项目真正提供的是一个稳定的本地锚点：调用方提交任务后拿到 job handle，之后可以跨进程查询、等待、读取结果、续跑、终止和清理。

`Anchorpoint` 更贴近这个定位：

- 它不是 Claude Code wrapper；
- 它不是 provider/model router；
- 它不是通用 process manager；
- 它是本地 agent job 的 durable control point。

旧的 `supervisor` CLI / MCP / daemon 入口会保留一段时间作为兼容入口；新的公开叙事和后续命名迁移应以 Anchorpoint 为准。

## 它解决什么问题

很多 coding agent CLI 默认是“前台交互式进程”：

- 调用方必须一直等着它跑完；
- 中途很难可靠查询状态；
- 主进程退出后，任务状态容易丢失；
- stdout / stderr / JSON result / session id 没有稳定归档；
- 很难从上一次 session 继续；
- 很难统一做 timeout、kill、cleanup；
- MCP stdio server 的生命周期通常绑定在 client 进程上，不适合真正拥有长任务。

Anchorpoint 补的是这一层缺失的本地生命周期控制面。

它不替代 Claude Code、OpenCode 或其他 agent runtime；它只负责把这些成熟 runtime 包装成可管理、可恢复、可审计的后台 job。

## 当前定位

当前实现：

```text
MCP / CLI client
        ↓
Anchorpoint MCP / CLI adapter
        ↓
Claude Code backend
        ↓
system claude process
        ↓
job metadata + stdout/stderr artifacts on disk
```

长期目标：

```text
MCP / CLI / other clients
        ↓
thin adapters
        ↓
anchorpointd local daemon
        ↓
backend adapters
        ↓
Claude Code / OpenCode / other local agent runtimes
```

其中 daemon 是最终的生命周期 owner。CLI 和 MCP 不应该长期拥有任务生命周期，只负责提交、查询和管理。

## 非目标

Anchorpoint 故意不做这些事：

- 不做模型路由；
- 不做 provider switcher；
- 不替代 Claude Code / OpenCode；
- 不重新实现上游 agent 的模型选择、登录、quota、proxy 或权限策略；
- 不默认开启 permission bypass；
- 不解析交互式 TUI 输出作为稳定协议；
- 不做云队列或多机器调度；
- 不把自己变成通用 process manager。

本项目的边界是：**管理本地 agent job 生命周期，而不是管理模型供应商。**

## 核心能力

当前 Claude Code 兼容后端提供以下生命周期操作：

| 能力 | 含义 |
| --- | --- |
| `run` | 启动一个后台 agent job，并快速返回 `jobId` |
| `status` | 查询 job 当前元数据和状态 |
| `wait` | 等待一小段时间，直到 job 进入终态或超时 |
| `result` | 读取 stdout、stderr、parsed JSON、exit status 和 artifact path |
| `continue` | 基于已持久化的 session id 启动续跑 job |
| `peek` | 读取运行中或已完成 job 的 bounded stdout/stderr tail |
| `kill` | 终止运行中的进程树 |
| `cleanup` | 清理已结束的 job 目录，保留 running / abandoned job |

状态模型包括：

```text
running
completed
failed
killed
timed_out
orphaned
abandoned
not_found
corrupted
```

Anchorpoint 不会在状态不明确时假装成功。对于 stale、missing、corrupted 或不再由当前进程拥有的 job，它会显式报告状态。

## 安全默认值

Anchorpoint 的默认行为偏保守：

- 默认调用系统里的 `claude` 命令；
- 不默认添加 `--dangerously-skip-permissions`；
- 不通过普通 CLI / MCP 输入暴露 Claude Code permission bypass；
- prompt 写入 job-local `prompt.md`，通过 stdin 传给 agent；
- prompt 不作为命令行参数传递；
- `status` 默认不返回完整 prompt，只保存 `promptPath`、`promptPreview` 和 `promptSha256`；
- `result` 和 `peek` 默认只返回 bounded stdout/stderr；
- 完整输出通过本地 `stdoutPath` / `stderrPath` 读取。

如果本机的 `claude` 已经由 cc-switch 或其他本地配置接管，Anchorpoint 不会介入 provider、model、quota 或 proxy 选择。

## 安装与验证

```bash
pnpm install
pnpm run build
pnpm run typecheck
pnpm test
```

默认测试使用 fake Claude，不消耗真实 Claude Code quota。

## 快速试跑：fake Claude

在消耗真实 Claude Code quota 前，可以先用 fake runtime 验证本地生命周期。

Bash / WSL：

```bash
SUPERVISOR_CLAUDE_COMMAND=node \
SUPERVISOR_CLAUDE_PREFIX_ARGS=tests/fixtures/fake-claude.mjs \
node dist/cli.js run --cwd . --prompt "hello"
```

然后：

```bash
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

## CLI 使用

构建后可直接调用：

```bash
pnpm run build

node dist/cli.js run --cwd . --prompt "Reply exactly: OK"
node dist/cli.js status <jobId>
node dist/cli.js wait <jobId> --timeout-ms 30000
node dist/cli.js result <jobId>
node dist/cli.js continue --cwd . --job-id <jobId> --prompt "Follow up"
node dist/cli.js peek <jobId>
node dist/cli.js kill <jobId>
node dist/cli.js cleanup --older-than-ms 86400000
```

如果安装 package bin，可以使用新入口：

```bash
anchorpoint run --cwd . --prompt "Reply exactly: OK"
anchorpoint status <jobId>
anchorpoint result <jobId>
```

旧入口仍可用：

```bash
supervisor run --cwd . --prompt "Reply exactly: OK"
```

## MCP 使用

构建后，在 MCP client 中配置：

```json
{
  "mcpServers": {
    "anchorpoint": {
      "command": "node",
      "args": ["G:/repository/supervisor/dist/mcp.js"]
    }
  }
}
```

当前 Claude Code 兼容工具名保持稳定：

```text
claude_run
claude_status
claude_wait
claude_result
claude_continue
claude_peek
claude_kill
claude_cleanup
```

这些工具名是兼容面。后续加入 OpenCode backend 时，应新增 backend-specific 或 backend-neutral surface，而不是破坏现有 `claude_*` 行为。

## Daemon 模式

当前 daemon 是显式、手动、loopback-only 的第一阶段实现。

启动：

```bash
pnpm run build
node dist/daemon.js --host 127.0.0.1 --port 27777
```

健康检查：

```bash
curl http://127.0.0.1:27777/health
```

daemon 暴露：

```text
GET  /health
POST /v1/jobs/run
POST /v1/jobs/status
POST /v1/jobs/wait
POST /v1/jobs/result
POST /v1/jobs/continue
POST /v1/jobs/peek
POST /v1/jobs/kill
POST /v1/jobs/cleanup
```

CLI 默认仍走 direct local mode。只有显式配置后才会委托给 daemon：

```bash
SUPERVISOR_DAEMON_URL=http://127.0.0.1:27777 \
node dist/cli.js run --cwd . --prompt "Reply exactly: OK"
```

或：

```bash
node dist/cli.js --daemon-url http://127.0.0.1:27777 status <jobId>
```

daemon 会写入 discovery metadata。CLI / MCP 只有显式启用 discovery 时才会读取：

```bash
node dist/cli.js --discover-daemon daemon-health
SUPERVISOR_DAEMON_DISCOVERY=1 node dist/cli.js status <jobId>
```

MCP daemon discovery 示例：

```json
{
  "mcpServers": {
    "anchorpoint": {
      "command": "node",
      "args": ["G:/repository/supervisor/dist/mcp.js"],
      "env": {
        "SUPERVISOR_DAEMON_DISCOVERY": "1"
      }
    }
  }
}
```

## 产物与状态目录

job metadata 和 artifacts 默认存放在本地 state directory。

Windows：

```text
%LOCALAPPDATA%\supervisor
```

Linux / WSL：

```text
$XDG_STATE_HOME/supervisor
~/.local/state/supervisor
```

可以通过环境变量覆盖：

```text
SUPERVISOR_STATE_DIR
```

如果项目正式迁移到 Anchorpoint，后续可以新增：

```text
ANCHORPOINT_STATE_DIR
```

并在一段时间内兼容旧的 `SUPERVISOR_STATE_DIR`。

## 环境变量

| 变量 | 用途 |
| --- | --- |
| `SUPERVISOR_STATE_DIR` | 覆盖 job metadata 和 artifacts 的状态目录 |
| `SUPERVISOR_CLAUDE_COMMAND` | 覆盖 Claude executable，常用于 fake-Claude 测试 |
| `SUPERVISOR_CLAUDE_PREFIX_ARGS` | 给 Claude command 增加固定前置参数 |
| `SUPERVISOR_DAEMON_URL` | 显式指定 daemon URL |
| `SUPERVISOR_DAEMON_DISCOVERY` | 设置为 `1` 时显式读取 daemon discovery metadata |
| `SUPERVISOR_DEFAULT_RUNTIME_TIMEOUT_MS` | 给未传 `timeoutMs` 的 job 设置默认运行超时 |
| `SUPERVISOR_MAX_CONCURRENT_JOBS` | 限制当前 supervisor process 的并发 running job 数量 |

## Package entrypoints

| Bin | 文件 | 用途 |
| --- | --- | --- |
| `anchorpoint` | `dist/cli.js` | 本地 CLI：run/status/wait/result/continue/peek/kill/cleanup |
| `anchorpoint-mcp` | `dist/mcp.js` | stdio MCP server |
| `anchorpointd` | `dist/daemon.js` | 本地 daemon，长期目标中的生命周期 owner |
| `supervisor` | `dist/cli.js` | 旧名兼容入口 |
| `supervisor-mcp` | `dist/mcp.js` | 旧名兼容入口 |
| `supervisor-daemon` | `dist/daemon.js` | 旧名兼容入口 |

## 当前后端策略

### Claude Code

Claude Code 是当前冻结的兼容 baseline。

Anchorpoint 调用系统 `claude` 命令，并让本地 Claude Code 配置自己决定：

- provider；
- model；
- quota；
- proxy；
- auth；
- permission policy。

Anchorpoint 只关心 job lifecycle。

### OpenCode

OpenCode 是下一阶段更适合扩展的 backend。

推荐方向：

- 使用 OpenCode 官方 headless server / SDK / API 作为主要集成面；
- `opencode run --attach` 可作为 probe 或 fallback；
- 不解析交互式 TUI 输出；
- 不接管 OpenCode 的 provider login、`/connect`、model selection 或 endpoint routing；
- 新增 `opencode_*` 或 backend-neutral lifecycle surface；
- 不破坏现有 `claude_*` 兼容面。

## 可靠性设计

Anchorpoint 当前实现强调可审计和可恢复：

- job metadata 落盘；
- stdout / stderr artifact 落盘；
- prompt 单独保存并记录 sha256；
- completed Claude JSON `session_id` 持久化为 `sessionId`；
- child `close` 事件后再 finalize，避免 stdout/stderr 尚未关闭就写终态；
- atomic JSON write；
- stale running metadata 会被 reconciliation；
- missing PID 标记为 `orphaned`；
- live PID 但不属于当前 supervisor instance 标记为 `abandoned`；
- cleanup 保留 `running` 和 `abandoned` job；
- result/peek 默认返回 bounded output，避免 MCP client 被大输出拖垮。

## Windows / WSL 注意事项

Windows 和 WSL 不应该共享同一个 `node_modules`。

在 WSL fresh clone 中验证时，建议重新安装依赖：

```bash
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm test
pnpm run build
```

如果从 Windows 切到 WSL 后遇到 Rollup 或 optional dependency 相关问题，优先重新安装当前环境自己的依赖。

## 真实 Claude Code probe

真实 probe 是 opt-in 的，可能消耗 Claude Code quota。

默认 gate：

```bash
pnpm run typecheck
pnpm test
pnpm run build
```

真实 probe：

```bash
pnpm run probe:real:direct
pnpm run probe:real:daemon
pnpm run probe:real:mcp-daemon
```

这些 probe 只验证 Anchorpoint 的 lifecycle boundary：它能否调用系统 `claude`、追踪 job、读取结果、保存 session id，并通过 direct / daemon / MCP-to-daemon 路径完成同一件事。

## 故障排查

### `Unknown command`

先构建：

```bash
pnpm run build
```

然后使用：

```bash
node dist/cli.js <command>
```

### `claude` 找不到或路由异常

检查本机实际解析到的命令：

Windows：

```powershell
where.exe claude
```

WSL / Linux：

```bash
which claude
```

Anchorpoint 不负责 provider/model routing。

### daemon discovery stale

停止旧 PID 或重新启动 daemon，让 discovery metadata 刷新。

### 输出被截断

`result` 默认返回 bounded stdout/stderr。需要完整内容时读取：

```text
stdoutPath
stderrPath
```

### Windows / WSL 切换后依赖异常

在当前环境重新安装：

```bash
pnpm install --frozen-lockfile
```

## 开发约束

改架构前先确认这些边界：

- lifecycle owner 最终应是 daemon；
- CLI / MCP 应该逐步变成 adapter；
- backend adapter 只适配成熟 local agent runtime；
- 不做 provider/model router；
- 不默认暴露 permission bypass；
- prompt 不进 argv；
- status 不默认泄露完整 prompt；
- stale/corrupted state 必须显式表达；
- fake runtime 测试优先于真实 agent probe。

## 验证命令

```bash
pnpm run typecheck
pnpm test
pnpm run build
pnpm pack --dry-run --json
```

## Roadmap

- [x] Claude Code backend lifecycle baseline
- [x] CLI run/status/wait/result/continue/peek/kill/cleanup
- [x] stdio MCP server
- [x] bounded result output and artifact paths
- [x] manual loopback daemon
- [x] explicit daemon URL / discovery mode
- [x] daemon-backed MCP reconnect baseline
- [ ] rename public surface from Supervisor to Anchorpoint
- [ ] add `ANCHORPOINT_*` env aliases while preserving `SUPERVISOR_*`
- [ ] freeze Claude Code backend as compatibility backend
- [ ] introduce backend-neutral job metadata
- [ ] add OpenCode backend through official headless/API integration
- [ ] make daemon the default lifecycle owner
- [ ] design explicit, reversible service installation

## License

TBD.
