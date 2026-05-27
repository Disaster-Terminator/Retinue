# Retinue 多 Agent 并行压力测试报告（2026-05-12）

## 1) 测试目标（真需求）

本轮不是“堆 token 压测”，只测对当前项目真实有价值的并发场景：

1. Retinue 在 Hermes 侧并行发起多个子代理任务时的槽位上限与驱逐行为是否稳定。
2. 子代理用于“只读探索/交叉验证”时，结论可靠性如何，主代理是否需要并行独立证据链兜底。
3. Hermes 集成边界（尤其记忆治理）与 OV（OpenViking）相关治理缺口是否能在并发审查中被识别。

约束：
- 全程不改代码。
- 子代理只读。
- 建议落地到文档，不直接改实现。

---

## 2) 执行摘要（结论先行）

结论：
- Retinue 并发槽位控制（`maxAgents=3`）和自动驱逐机制工作正常，可复现。
- 并发只读子代理可产出有效意见，但存在“工作目录漂移导致误报”的可靠性风险，主代理必须并行做独立核验。
- 当前文档对 Hermes × Retinue 的工具边界是清晰的，但“记忆治理/日志边界/结果保留策略”仍缺显式契约。
- OV 相关风险在本仓库可见证据下依然是高优先级（P1）治理项，尤其是检索排序偏差与 UUID 污染。

---

## 3) 压测设计与执行

### 场景 A：并行 4 子代理触发槽位驱逐（真实并发控制需求）

动作：连续 spawn 4 个只读任务（同一 MCP 会话）。

观测：
- 第 4 个任务触发驱逐最早任务（符合设计）。
- 返回 `evictedJobId`，且日志记录 `retinue_agent_evicted`。

证据：
- 运行输出（脚本）：`pnpm run probe:real:retinue-opencode-slots`
- 日志：`/tmp/retinue-opencode-slot-state-qHjUQ2/logs/retinue.jsonl`
  - `retinue_agent_evicted`，`maxAgents: 3`

### 场景 B：Hermes 实际调用 `mcp_retinue_*` 并行任务（真实主流程需求）

动作：通过 MCP 工具并行发起 4 个只读审查任务（ops、记忆治理、OV 集成、文档交叉验证）。

观测：
- 同样触发第 4 个任务驱逐第 1 个任务。
- 3 个任务最终完成，1 个被驱逐后状态 `killed`。

证据：
- 状态目录：`/home/raystorm/.local/state/retinue/jobs/`
- 关键 job：
  - killed：`job_074b0030-9aec-4d07-9f2f-0bb5d96d9a77`
  - completed：`job_ee90ee58-f5b1-4db7-b5ea-1041ff62dec1`、`job_03759597-1f7b-4d73-9b76-59d26d972477`、`job_ab23386b-4fc6-445c-8001-0b4765b03fc2`
- 主日志：`/home/raystorm/.local/state/retinue/logs/retinue.jsonl`（包含 `retinue_agent_evicted`）

### 场景 C：并行交叉验证可靠性（真实“只读子代理”治理需求）

动作：并行发起文档一致性验证 + 主代理独立证据链复核。

观测：
- 一个子代理错误声称目标文件“全系统不存在”。
- 主代理并行复核后确认：绝对路径存在；子代理实际 `cwd=/home/raystorm`，相对路径检查失败导致误报。

证据：
- 误报任务输出：`job_ab23386b-4fc6-445c-8001-0b4765b03fc2`
- 复核任务：
  - `job_588049dc-a425-449a-82b1-62e209affc2c`（绝对路径存在=true）
  - `job_6b6b9631-d09d-482f-80f5-b380ac161e51`（相对路径不存在，且 cwd=/home/raystorm）

这条结果直接验证了：
- 子代理只能做“候选结论”，不能直接当事实。
- 主代理并行独立核验是必须项，不是可选项。

---

## 4) 量化结果

本轮纳入统计的并行 job：7 个
- completed: 6
- killed(驱逐): 1

时延（createdAt -> updatedAt）
- 最短：3.865s
- 最长：392.911s
- 平均：143.955s

注：长尾主要来自只读审查任务在外部 agent 内部运行与 wait 轮询超时重试，不是 MCP 崩溃。

---

## 5) 有效发现（按优先级）

### P1：并发下的“结论可靠性防线”必须产品化

问题：子代理在 cwd 偏移时会给出高置信误报。

建议：
1. 文档级规则：所有只读审查提示词必须要求“输出 pwd + 绝对路径证据”。
2. 调用级规则：主代理默认传绝对路径，不依赖相对路径。
3. 流程级规则：任何“文件不存在/冲突/过期”类结论，主代理必须并行二次核验（至少 1 条独立证据）。

### P1：Hermes × Retinue 记忆治理边界仍缺显式契约

已有清晰点：
- 工具面与配置面边界清楚（不在 tool args 传 backend/model/provider/profile/permission）。

缺口：
- `tracePath` 仅说“诊断”，未写清“不可作为状态同步/长期记忆输入”。
- `close_agent` 后结果/日志保留策略缺乏明确声明。

建议：
- 在 `docs/integrations/HERMES.md` 增补“记忆治理契约”段：
  - 允许跨境：jobId/status/bounded stdout-stderr
  - 受限跨境：tracePath（只读临时诊断）
  - 禁止跨境：内部状态目录长期吸收为 Hermes 常驻记忆
  - 保留/清理语义：close vs cleanup 的明确生命周期

### P1：OV 相关治理缺口仍是高优先级

只读审查结论（有仓库证据支持）：
1. UUID 自动提取碎片污染仍在。
2. 插件 bucket-order 导致检索排序偏差（未做全局 score 排序）的问题仍未见闭环审查结论。

建议：
- 在 Retinue 的 Hermes 集成文档中补一节“OV 记忆接入注意事项（仅引用、不过度固化）”，明确：
  - 先用只读抽样验证检索排序质量
  - 不把目录摘要当稳定 top 命中依据

---

## 6) 关于“ops 文件夹优化”的测试结论

本仓库未发现独立 `ops/` 目录（当前结构以 `docs/runbooks`、`docs/deployment` 承担运维知识）。

因此本轮“ops 优化”建议应落在现有结构：
- 把并发压测、槽位驱逐、交叉验证误报案例沉淀进 `docs/runbooks`。
- 不新增平行目录，避免运维知识分叉。

---

## 7) 下一步测试建议（不改代码版）

1. 固定 3 组并发回归用例（每组 3~4 任务）：
   - 槽位驱逐一致性
   - cwd/路径鲁棒性
   - 文档一致性审查
2. 每组都要求输出：
   - 子代理原始结论
   - 主代理复核结论
   - 冲突与仲裁理由
3. 连续跑 3 轮，观察误报率是否稳定下降（通过提示词与流程约束，而非代码改动）。

---

## 8) 本次产物

- 本报告：`docs/runbooks/2026-05-12-retinue-multi-agent-stress-test.md`
- 关键运行日志：
  - `/home/raystorm/.local/state/retinue/logs/retinue.jsonl`
  - `/tmp/retinue-opencode-slot-state-qHjUQ2/logs/retinue.jsonl`
- 关键 job 结果目录：
  - `/home/raystorm/.local/state/retinue/jobs/job_074b0030-9aec-4d07-9f2f-0bb5d96d9a77`
  - `/home/raystorm/.local/state/retinue/jobs/job_ee90ee58-f5b1-4db7-b5ea-1041ff62dec1`
  - `/home/raystorm/.local/state/retinue/jobs/job_03759597-1f7b-4d73-9b76-59d26d972477`
  - `/home/raystorm/.local/state/retinue/jobs/job_ab23386b-4fc6-445c-8001-0b4765b03fc2`
