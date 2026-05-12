# Long-Term Vision

Retinue 的长期目标不是发明一套新的子代理协议，而是学习 Codex 原生 spawn 的产品语义，把本机外部 agent runtime 包装成 Codex 可以使用的子代理执行面。

参考基准：2026-05-06 已同步并阅读 `G:\repository\codex` 的 `upstream/main`，基准提交为 `ebd9ec05b4`。该版本的 Codex 多代理工具面以 `spawn_agent`、`wait_agent`、`send_message`、`followup_task`、`list_agents`、`close_agent` 为核心。

## Product Shape

Codex 面向 Retinue 时，不应该选择 Claude Code 或 OpenCode。Codex 只应该表达：

- spawn 一个子代理。
- 等待子代理有进展或完成。
- 给子代理发后续消息。
- 列出当前可见子代理。
- 关闭不再需要的子代理。

Retinue 工具需要加前缀，避免和 Codex 原生工具混淆。当前倾向的产品工具面是：

```text
retinue_spawn_agent
retinue_wait_agent
retinue_send_message
retinue_followup_task
retinue_list_agents
retinue_close_agent
```

这些工具要尽量贴近 Codex 原生语义，但不能承诺完全等价。Claude Code 和 OpenCode 是外部后端，它们的 profile、上下文行为和 agent loop 都由各自 runtime 决定。

## Backend Policy

后端选择属于部署策略。一个 Retinue 部署只选择一个默认后端，任务运行途中不切换后端。

可选后端：

- `claude-code`
- `opencode`

两个后端都应该能跑通完整产品链路。本机生产冒烟优先选 `opencode`，因为它完全开源，方便直接读源码、复现和修补。`claude-code` 仍然是同等重要的产品后端，但它的本机验证排在 OpenCode 第一条链路之后。

当前不假定 Retinue 可以在 spawn 时创建或选择一个全新的后端 profile；最小链路先复用后端现成 profile。这里的“profile”是后端运行身份和运行环境的整体，包括配置、登录状态、模型/provider、默认 agent/mode、插件/skill、权限策略等。Retinue 第一阶段不拆开管理这些细项，也不另起一套子代理专用配置。

后端专属能力，例如现有 `opencode_*` / `claude_*` 生命周期工具，可以作为内部 adapter、CLI、测试或迁移入口存在，但不应该成为 Codex 的主要产品入口。插件默认不暴露这些 backend-specific MCP tools；开发者需要显式启用调试开关。

## Profile Policy

profile 策略先以“跑通真实产品链路”为目标，而不是先设计复杂隔离。Codex 原生 spawn 的重要经验是：子代理继承父 turn 的运行时状态，包括权限、cwd、sandbox/profile，并且只在明确请求时叠加角色或模型覆盖；Retinue 第一阶段也应该继承这个思路，让子进程使用当前部署后端的有效 profile。

OpenCode 当前有自己的 profile 机制和配置入口，其中权限只是 profile 的一部分。第一阶段不要求 Retinue 生成专用只读 profile；如果现有 profile 会阻塞最小 E2E，本机部署可以调整 OpenCode profile，让它适合 unattended 子代理执行。关键约束是：这属于部署事实，不能变成 Codex 每次调用工具时可随意选择的参数。

Claude Code 同理：先复用当前可工作的本机 profile。是否能配置专用低权限 profile、如何隔离 profile 内的插件/skill/权限，是 Phase 4 的 hardening 项，不阻塞 Phase 1。

## Phased Roadmap

### Phase 0 - Contract And Evidence

目标：先把 Codex 原生 spawn 的可学习语义、Retinue 可复刻部分、不可复刻部分梳理清楚。

交付：

- 长期愿景文档，也就是本文。
- 短实现计划，明确第一版只做哪些工具语义。
- 对 OpenCode 当前本机 profile 做只读盘点，只记录 Retinue 需要知道的非敏感事实。
- 对 Claude Code 当前本机 profile 做只读盘点，只记录 Retinue 需要知道的非敏感事实。

需要主动和用户对齐：

- profile 是否只记录本机部署事实，还是需要 repo 提供推荐配置模板。
- Codex 产品入口隐藏后端选择后，后端专属工具在插件里如何降级为调试入口。

### Phase 1 - One Backend, Codex-Compatible Tool Surface

目标：先用 OpenCode 默认后端跑通 Retinue 前缀工具面。

范围：

- 实现 `retinue_spawn_agent`、`retinue_wait_agent`、`retinue_close_agent`、`retinue_list_agents` 的最小闭环。
- `retinue_wait_agent` 在终态时负责带回 result，避免为了第一版引入非 Codex 风格的结果工具。
- `retinue_send_message`、`retinue_followup_task` 留作同阶段后续增量；只有后端继续会话语义足够稳定时再纳入。
- 通过 deployment policy 固定默认后端，不让 Codex 每次调用时选择后端。

验收：

- fake/controlled 测试覆盖 spawn、wait、result/message 回收、close。
- 本机真实 E2E 证明 Codex 插件可以驱动 OpenCode 并取回结果。
- 本机 E2E 不应该被 OpenCode profile 内部策略卡死；如果需要调整 profile，记录为本机部署事实。

### Phase 2 - Backend Parity

目标：让另一个后端也满足同一套 Retinue 前缀工具语义。

范围：

- 不追求内部代码完全复用；先追求外部工具契约一致。
- 记录两个后端在 profile、继续会话、关闭行为上的差异。
- 对无法稳定复刻 Codex 原生语义的地方写明降级行为。

验收：

- Claude Code 和 OpenCode 都有 fake/controlled 测试。
- Claude Code 和 OpenCode 都有本机真实 E2E 记录。

### Phase 3 - Production Hardening

目标：把 Retinue 从“能跑”提升到“可长期使用”。

范围：

- 结果回收、状态重建、异常恢复、清理策略。
- 更清晰的 spawn 指导，让 Codex 知道何时 spawn、何时本地做。
- 文档拆分：E2E 记录、profile 记录、后端差异表分开维护。

验收：

- 默认验证命令通过。
- 本机真实 E2E 可重复。
- 文档不记录 secret，只记录非敏感 backend metadata、job/session id 和观测结果。

### Phase 4 - Optional Advanced Profiles

目标：只有在前面阶段稳定后，再考虑更复杂的 profile 能力。

候选项：

- 子代理专用只读或低权限 profile。
- spawn 时显式选择后端 profile。
- 更接近 Codex 原生 mailbox 的跨 agent 消息模型。
- 多后端安装但单部署默认后端的管理 UI/配置。

这些都不是最小产品链路的前置条件。

## Open Questions

这些问题需要主动和用户讨论，不应该只埋在文档里：

- 哪些 Codex 原生语义无法在 Claude Code / OpenCode 上稳定复刻。
- 后端专属工具是否对 Codex 隐藏，或者以调试入口保留。
- OpenCode 的 `send_message` / `followup_task` 能否稳定映射到同一会话，还是第一阶段只承诺 spawn/wait/result/close。
- Claude Code parity 阶段能否复用同一 adapter 抽象，还是需要单独实现。
