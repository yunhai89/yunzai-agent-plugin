# 07 · 开发计划（执行版）

> 本文是 [02 改造矩阵与 PR 计划](02-refactor-plan.md) 的**执行版排期**，不重复逐文件矩阵。所有技术方案以 [01 目标架构](01-target-architecture.md) 为准，测试/验收以 [05](05-test-and-acceptance.md) 为准。
>
> 计划基线：`dev @ 9323c5d`。当前状态是“审计/方案完成、代码未改造”；本文从 **PR0** 开始。
>
> 排期是**相对计划**，不是工时承诺。参考前提：2 名全职工程师 + 1 名架构评审 + 0.5 名 QA/运维；单人开发按 1.5–2x 拉长。外部依赖（真实 Provider Key、Postgres、灰度窗口）不计入编码周期。

---

## 1. 计划目标

### 1.1 总目标

在不降低现有产品能力、不破坏 Yunzai 插件运行方式的前提下，把 Agent 内核逐步迁移到：

- Mastra Agent（模型—工具循环）
- Vercel AI SDK（模型接入层）
- Zod/Standard Schema（配置、Workflow、新工具边界）
- LibSQL（本地）/ PostgreSQL（生产）+ 可选 Vector/Embedder
- 嵌入式运行，不新增 Server/端口

### 1.2 成功标准

| # | 标准 | 证据 |
|---|---|---|
| 1 | 现有 147/0/12 测试保持；新增测试全绿 | CI |
| 2 | legacy/mastra parity P1–P14 无未解释差异 | parity 报告 |
| 3 | 工具权限/审批/账本/副作用语义不退化 | 工具契约测试 + E2E |
| 4 | 会话/记忆/压缩/隔离/重启不退化 | Memory 测试 + 迁移校验 |
| 5 | 审批/取消/热重载/重启不丢状态、不重复副作用 | HITL E2E |
| 6 | LibSQL 与 Postgres 均验证 | Storage 报告 |
| 7 | 灰度 100% + 观察期无 P0/P1 | 变更单 |
| 8 | 回滚演练成功，不重复执行工具 | 回滚报告 |
| 9 | Web 面板/DevLog 能定位新链路问题 | 排障演练 |
| 10 | 文档可让新开发者独立跑通 | 03/04 验收 |

### 1.3 不在本期范围

- 独立 Mastra Server/Studio 生产部署；
- 全量 TypeScript 迁移；
- 用 Observational Memory 替代无损压缩；
- 用 Mastra Schedules 替换 ScheduleStore；
- 用 Mastra Storage 替换 TaskStore/Recall/Profile/KB；
- 重写 95 个 Web 端点或 71 条命令；
- 一次删除 legacy 内核。

---

## 2. 工作分解（WBS）

| 工作流 | 代号 | 内容 | 主要产出 |
|---|---|---|---|
| 基线与契约 | A | PR0：测试基线、fixture、现状缺陷记录、parity harness 骨架 | 基线报告、fixture、契约测试 |
| 运行时骨架 | B | PR1：依赖、Facade、StorageFactory、MastraFactory、配置 schema | 可构建但不接流量的 runtime |
| 模型接入 | C | PR2：AI SDK ModelFactory、thinking/fallback/embedding parity、Gemini Spike | ModelFactory + 报告 |
| 工具与安全 | D | PR3：ToolAdapter、名称映射、RBAC/审批/账本/幂等、只读→写 | Adapter + 安全测试 |
| Agent 主链路 | E | PR4：generate/stream、取消、终止、usage、回复桥接、灰度 | Facade 接入 + 灰度 |
| Memory/数据 | F | PR5：Mastra Memory Phase 1/2、LibSQL/PG、迁移、隔离 | Memory 适配 + 迁移脚本 |
| Workflow | G | PR6：深度研究、工具进化、人设补齐（P2） | 可暂停/恢复流程 |
| 外围 parity | H | PR7：MCP、子 Agent、多模态、定时、研究、ToolEvo、Web | 功能清单签字 |
| 灰度与下线 | I | PR8：100%、soak、回滚演练、删除 legacy | 生产切换 |
| 文档与运维 | J | PR9：配置/部署/排障/升级指南 | 运维文档 |

---

## 3. 里程碑与相对排期

以 2 周为一个迭代；下表是**参考节奏**，不是日期承诺。

| 里程碑 | 迭代 | 参考周 | 内容 | 退出条件 |
|---|---|---|---|---|
| M0 基线冻结 | S0 | W1–W2 | PR0 | 147/0/12 可重复；新契约测试入库；基线报告评审通过 |
| M1 骨架就绪 | S1 | W3–W4 | PR1 | legacy 默认；Mastra 可建/可关；LibSQL 测试通过 |
| M2 模型层可用 | S2 | W5–W6 | PR2 | OpenAI/Anthropic mock parity；Gemini Spike 有结论 |
| M3 只读工具可用 | S3 | W7–W8 | PR3a | 只读工具名称/参数/结果/截断一致 |
| M4 写工具+审批 | S4 | W9–W10 | PR3b + PR4a | 审批/拒绝/超时/取消；非流式 Agent 灰度 1 用户 |
| M5 流式/取消 | S5 | W11–W12 | PR4b | 流式/取消/重复文本/最终去重通过；灰度 1 群 |
| M6 Memory Phase 1 | S6 | W13–W14 | PR5a | 历史适配器稳定；重启/多对话/隔离通过 |
| M7 Memory Phase 2 | S7 | W15–W16 | PR5b（仅 ADR-004 Phase 2 获批） | 迁移 dry-run 0 error；抽样校验通过；灰度新会话 |
| M8 Workflow | S8 | W17–W18 | PR6 | 研究/工具进化 suspend/resume/幂等通过 |
| M9 外围 parity | S9 | W19–W20 | PR7 | 功能清单逐项签字 |
| M10 全量+soak | S10 | W21–W22 | PR8a | 100% 灰度；观察期无 P0/P1 |
| M11 下线+收尾 | S11 | W23–W24 | PR8b + PR9 | 回滚演练；legacy 分 PR 删除；文档完成 |

> 如果团队只有 1 名工程师：按 M0→M1→M2→M3→M4→M5→M6 顺序串行，M7/M8 可合并；整体按 1.5–2x 拉长。QA/运维可兼职，但 M4/M5/M7/M10 必须有独立验收人。

---

## 4. 迭代计划（执行卡）

### S0 · 基线冻结（PR0）✅ 已完成（2026-11-20）

**目标**：把“现在是什么行为”变成可重复的证据。

**任务**：

1. 复跑基线：`pnpm install --frozen-lockfile`、`pnpm test`、`pnpm lint`，保存日志/断言数/跳过清单。
2. 新建 `model/runtime/test/fixtures/`：
   - 脚本化 legacy Provider（返回 `AssistantResult`）；
   - 脚本化 AI SDK LanguageModel（产出 text/tool/finish chunks）；
   - 统一场景 P1–P14 的输入/期望。
3. 补现状契约测试（**只记录，不修复**）：
   - 官方 ID 含 `:` 的 `listAll/listAllConversations/#清空所有记录`；
   - `ConfirmStore` 重启丢失；
   - 工具名 sanitize/63 字符冲突；
   - `Agent.run` 结果字段快照；
   - 审批无 confirm 器 fail-closed。
4. 用 `KNOWN-BUG` 标记既有缺陷，避免后续把“修复”误判为“回归”。
5. 评审 00/01/02/04/05/06，确认 D1–D12 决策。

**交付**：基线报告、fixture、契约测试、决策确认记录。

**退出**：基线可一键复现；新增测试不混入现有绿灯；PR1 的 Go/No-Go 评审通过。

**明确不做**：不引 Mastra 依赖、不改 `Agent`、不改配置默认值。

---

### S1 · 依赖与运行时骨架（PR1）✅ 已完成（2026-11-20）

**目标**：可创建/关闭嵌入式 Mastra，但不接生产流量。

**任务**：

1. 依赖：`@mastra/core@1.85.0`、`@mastra/memory@1.41.2`、`@mastra/libsql@1.31.1`、`@mastra/pg@1.37.0`、`ai@7.0.177`、`@ai-sdk/openai@4.0.121`、`@ai-sdk/anthropic@4.0.106`、`@ai-sdk/google@4.0.122`；`zod` 升 `^3.25.76`。
2. `model/runtime/facade.js`、`factory.js`、`mastra-runtime.js`、`storage-factory.js`、`identity.js`、`errors.js`。
3. 配置 `agent.runtime.*`/`agent.mastra.*`，默认 `engine: legacy`；Zod/手写校验；旧配置迁移。
4. Storage：LibSQL 绝对路径、`:memory:` 单测、Postgres skip 配置；init/close 生命周期。
5. Identity：resource/thread 规范 + 单测（含 botId/adapter/官方 ID）。
6. 健康检查/关闭顺序：`abort → memory.settled → vector.close → storage.close`。

**交付**：骨架代码、配置 schema、storage/identity 测试。

**退出**：现有测试全绿；legacy 默认不变；Mastra 构建/关闭无泄漏；启动时延增量有记录。

**回滚**：删依赖/字段；legacy 不受影响。

---

### S2 · AI SDK Model Factory（PR2）✅ 已完成（2026-11-20）

**目标**：OpenAI-compatible/Anthropic 模型层 parity；Gemini 给出明确结论。

**任务**：

1. `model-factory.js`：`providerId/modelId` → AI SDK model；`.chat()` 用于 OpenAI-compatible；baseURL/apiKey/headers/fetch。
2. thinking/reasoning 映射：OpenAI `reasoningEffort`、Anthropic `thinking.budgetTokens`、Google `thinkingConfig`；不支持的厂商保留 legacy-only。
3. fallback：Mastra model 数组 vs 手动重试；验证错误范围/usage/流式半截保护。
4. utility/vision/embedding：复用现有 `modelRouter`/`buildEmbed`，不另建配置。
5. Gemini Spike（S2 文档）：工具/thinking/usage/流式/取消；不通过则 legacy-only。
6. 代理：决定补 `undici` 或明确不支持；AI SDK provider 的 `fetch` 透传测试。

**交付**：ModelFactory、参数映射表、Gemini Spike 报告、mock parity。

**退出**：OpenAI/Anthropic 的 URL/body/header/usage/finish 与 legacy 对同一 fixture 等价；Gemini 有结论。

**回滚**：ModelFactory 不接主链路。

---

### S3 · 只读工具 Adapter（PR3a）✅ 已完成（2026-11-20）

**目标**：`LegacyTool → Mastra Tool`，先只读。

**任务**：

1. `tool-adapter.js`：`createTool({id,inputSchema:jsonSchema(...),execute,toModelOutput})`。
2. 名称映射：sanitize、63 字符、中文/点号/冲突、双向映射。
3. `ctx` 传递：`RequestContext.set('yz.ctx', ctx)`；execute 读取；不全局共享。
4. 结果管线：legacy 返回值、`stringifyArgs`、`_capToolResult`、注入标注、失败富化。
5. 只读工具：`web_search`/`memory_search`/`kb_search`/`context_recall` 等；并发/截断/错误测试。
6. 记录 `meta` 全字段保留测试。

**交付**：Adapter、名称映射、只读 parity。

**退出**：名称/参数/结果/截断/错误与 legacy 一致；无写工具接入。

**回滚**：Adapter 不接主链路。

---

### S4 · 写工具、审批与 Agent 非流式（PR3b + PR4a）✅ 已完成（2026-11-20，非流式灰度）

**目标**：写工具审批 + Mastra Agent 非流式，灰度 1 用户。

**任务**：

1. `requireApproval`/`beforeApproval`：policy deny/confirm/allow、alwaysConfirm、shouldConfirm、masterSkipConfirm。
2. `ApprovalBridge`：短 id、CAS、argsHash、超时、取消、持久化；`#确认/#拒绝/#待确认`/Web 兼容。
3. TaskStore 守卫：planned/started/result、effectState、幂等键、`effect_unknown`。
4. Mastra Agent `generate`：instructions、messages、tools、maxSteps、abortSignal、usage。
5. 结果归一：content/stopReason/turns/usage/taskId；finalizer/narration 语义。
6. Facade 接入 `apps/agent.js`，默认 legacy，`gray.users=[testUser]`。

**交付**：写工具 Adapter、ApprovalBridge、非流式 Facade、灰度记录。

**退出**：工具只执行一次；拒绝/超时不执行；灰度用户无 P0/P1；legacy 可立即回退。

**回滚**：配置 `engine=legacy`；取消在途；不重放写工具。

---

### S5 · 流式、取消与灰度扩群（PR4b）🟡 功能完成，72h 观察待执行

**目标**：Mastra `fullStream` 映射到现有回调；灰度 1 个群。

**任务**：

1. chunk 映射：`text-delta`/`reasoning-delta`/`tool-call`/`tool-result`/`step-finish`/`finish`/`error`/`abort`。
2. 中间文本 vs 最终答案：按 step 聚合；narration 不泄漏；最终只发一次。
3. 取消：`abortSignal`、`_activeRuns`、`abortAllActiveRuns`、热重载。
4. 流式去重：`streamer.finish()`、部分失败补尾、sticker/脱敏切断。
5. 灰度扩到 1 个群；错误率/时延/回复质量对比。

**交付**：流式 Adapter、取消测试、灰度报告。

**退出**：流式/取消/重复文本/回复顺序通过；1 群 72h 无 P0/P1。

**回滚**：流式关闭，保留非流式；或整体 legacy。

---

### S6 · Memory Phase 1（PR5a）✅ 已完成（2026-11-21）

**目标**：消息历史继续由 SessionStore 唯一写；验证多对话/隔离/重启。

**任务**：

1. `message-adapter.js`：legacy OpenAI-style ↔ AI SDK parts；tool_calls/tool_result、多模态、reasoning/provider_native。
2. Facade 显式传入 messages；Mastra `memory` 不启用。
3. 多轮/多 conversation/active/切换/删除/群共享/私聊/跨群/跨 bot 测试。
4. 压缩/ledger/archive/cacheEpoch 保持现有路径。
5. Web `/sessions`/`/conversations` 兼容验证。

**交付**：MessageAdapter、Phase 1 回归报告。

**退出**：历史条数/顺序/工具配对/压缩恢复/隔离全部通过；无 Mastra 双写。

**回滚**：MessageAdapter 不启用，回 legacy。

---

### S7 · Memory Phase 2 与迁移（PR5b）

> **条件**：仅当 ADR-004 的 Phase 2 获批。若未获批，跳过 S7，停在 S6；PR6/S8 仍可继续（Workflow 用独立 storage），但消息历史迁移不做。

**目标**：Mastra Memory 接管历史；迁移脚本 dry-run 0 error。

**任务**：

1. `memory-bridge.js`：thread/resource、load/save/list/delete；thread owner 校验。
2. LibSQL/Postgres storage；vector/embedder 可选；`semanticRecall=false`。
3. `scripts/migrate-mastra.mjs`：inventory/dry-run/backup/import/verify/rollback/checkpoint。
4. 迁移：官方 ID 修复、stable message id、首条意图、tool 配对、ledger/archive_refs。
5. 灰度：新会话 → 迁移会话 → 指定群；双读单写。
6. 重启/并发/TTL/遗忘/导出测试。

**交付**：Memory 适配、迁移脚本、校验报告、回滚脚本。

**退出**：dry-run 0 error；抽样 hash/顺序/配对一致；迁移会话 Web 可读；回滚演练成功。

**回滚**：切回 `history-adapter`；旧 KV 只读保留；Mastra 数据不删。

---

### S8 · Workflows（PR6）

**目标**：深度研究、工具进化可暂停/恢复；TaskStore 只投影。

**任务**：

1. `createWorkflow/createStep`：scope→plan→research→approve→synthesize→cite。
2. `suspend/resume`：审批 payload、snapshot、重启恢复、幂等键。
3. 工具进化：synthesize→static verify→behavior verify→approve→activate→canary。
4. 触发/交付：`#研究`、`#采纳工具`、Web 审批；TaskStore 写 `workflow_run_id`。
5. 失败/重试/超时/取消/双状态对账测试。

**交付**：两个 Workflow、审批桥接、E2E。

**退出**：阶段顺序/暂停恢复/重启/幂等/交付与旧路径一致；审批唯一。

**回滚**：切回类编排；Workflow run 取消/保留 snapshot。

---

### S9 · 外围 parity（PR7）

**目标**：MCP、子 Agent、多模态、定时、研究、ToolEvo、Web 逐项签字。

**任务**：

1. MCP：现有桥 + Adapter；默认 system；补 AbortSignal/分页/list_changed/最小 env（独立安全 PR）。
2. 子 Agent：spawn/check/extend/orchestrate；配额/预算/取消/回推；PR7 评估 Mastra subagents。
3. 多模态：图片/视频/文件/vision 降级/盲媒体。
4. 定时/研究/工具进化/人设/Skill/Web 回归。
5. 功能清单逐项“保留/替换/适配/延期”签字。

**交付**：外围 parity 报告、功能签字表。

**退出**：00 §4 功能清单无未说明删减；现有外围测试 + 新 mastra 版本通过。

---

### S10 · 100% 灰度与 soak（PR8a）

**目标**：全量 mastra，观察期验证。

**任务**：

1. 灰度 5%→25%→50%→100%，每步 ≥24h（或变更单）。
2. 监控：成功率/错误率/P95/工具失败/审批/存储/内存/重复副作用。
3. 数据核对：会话/记忆/任务/审批/usage。
4. 回滚演练：配置切回、在途取消、数据保留。
5. 观察期 ≥2 周或 ≥1 发布周期。

**交付**：灰度报告、监控报表、回滚演练记录。

**退出**：无 P0/P1；指标在阈值内；产品/运维签字。

---

### S11 · legacy 下线与文档收尾（PR8b + PR9）

**目标**：分 PR 删除旧内核；文档可执行。

**任务**：

1. 删除 `Agent.js`/provider/transport/ConfirmStore/ToolScheduler 等（按 02 §2.2）。
2. 保留 `compact/*`、SessionStore 兼容读、项目业务层。
3. 清理临时开关/死代码/测试桩。
4. 更新 README/docs/changelog/AGENTS。
5. 新开发者按 03 跑通；运维按 04 演练。

**交付**：删除 PR、最终文档、升级说明。

**退出**：全量测试 + 迁移/隔离/恢复/性能通过；回滚文档可用；legacy tag 保留。

---

## 5. 关键路径与并行

```text
S0 基线
  → S1 骨架
    → S2 ModelFactory ─┐
    → S3 只读 Adapter ─┼→ S4 写工具+非流式 → S5 流式
                       │
                       └→ S6 Memory Phase1 → S7 Phase2
                                              → S8 Workflows
                                                → S9 外围
                                                  → S10 100%
                                                    → S11 下线
```

可并行：

- S2 与 S3 不同文件，可并行；S4 依赖两者。
- S6 可在 S4 稳定后启动；S7 依赖 S6。
- S8 可与 S7 并行（Workflow 用独立 storage/审批）。
- S9 的部分（Web/MCP/多模态）可与 S8 并行，但不要抢 S7 的迁移资源。

不可并行/必须串行：

- S4 审批桥 → S5 取消/流式（同一 Facade）。
- S7 迁移切写 → S8 Workflow 生产灰度（避免双状态）。
- S10 100% → S11 删除（观察期不可省）。

---

## 6. 人员与职责（RACI）

| 角色 | 职责 | 关键产出 |
|---|---|---|
| 技术负责人/架构 | 方案、ADR、PR 评审、跨模块决策 | 01/06、评审记录 |
| Runtime 工程师 | Facade、Factory、Agent/Stream、取消/终止 | B/E |
| 模型工程师 | ModelFactory、thinking/fallback、Provider Spike | C |
| 工具/安全工程师 | ToolAdapter、RBAC/审批/账本/幂等 | D |
| 数据工程师 | Memory/Storage/迁移/校验/回滚 | F |
| QA | parity、E2E、隔离、恢复、性能 | 05 报告 |
| 运维/SRE | 部署、备份、监控、灰度、回滚 | 04 Runbook |
| 产品/负责人 | 行为差异确认、灰度范围、下线批准 | D1–D12 签字 |

RACI 简表：

| 事项 | R | A | C | I |
|---|---|---|---|---|
| 架构/ADR | 架构师 | 技术负责人 | Runtime/数据/安全 | 全员 |
| PR 实现 | 对应工程师 | 技术负责人 | QA | 产品 |
| Parity/验收 | QA | 技术负责人 | 工程师 | 产品 |
| 迁移/回滚 | 数据/运维 | 技术负责人 | QA/产品 | 全员 |
| 灰度/下线 | 运维 | 产品负责人 | 架构/QA | 全员 |

单人开发时合并 R/A，但**验收必须由另一人执行**；不能自写自验关键安全/迁移 PR。

---

## 7. 质量门禁

| 门禁 | 时机 | 必须满足 |
|---|---|---|
| G0 方案评审 | S0 前 | 00/01/02/04/05/06 评审通过；D1–D12 有结论 |
| G1 基线 | S0 末 | 147/0/12 可重复；新契约测试入库 |
| G2 骨架 | S1 末 | legacy 默认；Mastra 可建/可关；LibSQL 测试 |
| G3 模型 | S2 末 | OpenAI/Anthropic mock parity；Gemini 结论 |
| G4 只读工具 | S3 末 | 名称/参数/结果/截断一致 |
| G5 写/审批 | S4 末 | 只执行一次；拒绝/超时不执行 |
| G6 灰度 1 用户/群 | S4/S5 | 72h 无 P0/P1；可回滚 |
| G7 Memory | S6/S7 | 隔离/重启/压缩/迁移校验 |
| G8 Workflow | S8 | suspend/resume/幂等/投影 |
| G9 外围 | S9 | 功能清单签字 |
| G10 全量 | S10 | 100% + soak + 回滚演练 |
| G11 下线 | S11 | 删除后全量测试 + 文档 |

任何门禁失败：停止进入下一阶段；回到上一稳定点；不在失败分支上继续加功能。

---

## 8. 度量与阈值

阈值是**建议初值**，M0 用 legacy 基线校准后再定；不能凭空承诺性能提升。

| 指标 | 采集 | 建议门槛 |
|---|---|---|
| 测试 | CI | 0 失败；新增全绿 |
| Parity | parity 报告 | 100% 通过；差异 0 或 allowlist |
| 错误率 | DevLog/UsageStats | ≤ baseline +1% |
| P95 总时延 | DevLog | ≤ baseline +20% |
| 首 token | DevLog | ≤ baseline +30%（如开流式） |
| 工具失败率 | UsageStats | ≤ baseline +2% |
| 审批超时率 | ApprovalBridge | <10% |
| 迁移不一致 | 校验报告 | 0 |
| 重复副作用 | TaskStore `effect_unknown` | 0（出现即停） |
| 内存/连接 | health/进程 | 无持续增长 |
| 回滚 | 演练 | 一次成功，且无重复工具 |

---

## 9. 风险缓冲

| 风险 | 缓冲策略 |
|---|---|
| AI SDK Provider 不兼容 | S2 内 20% 缓冲；不通过则 legacy-only，不阻塞主线 |
| Anthropic thinking signature | 单独 Spike；失败则 Anthropic thinking 暂不切 |
| Gemini | 单独 Spike；不通过则保持 legacy |
| 工具名/审批 | S3/S4 各留 20% 缓冲；先只读再写 |
| Memory/压缩 | S6/S7 各留 20%；Phase 2 不通过则停在 Phase 1 |
| 迁移 | 维护窗口 + 备份 + dry-run；预留回滚半天 |
| 灰度事故 | 每步可回退；100% 前不删 legacy |
| 人员不足 | 单人按 1.5–2x；优先 S0–S6，S8/S9 可延后 |

整体计划建议预留 **15–20%** 缓冲；不要把缓冲压进灰度观察期。

---

## 10. 变更与决策治理

1. **决策记录**：所有 D1–D12/新争议写入 `06-decision-log.md`；未记录的选择不进入实现。
2. **PR 边界**：每个 PR 只做一个工作流；跨工作流改动拆 PR。
3. **默认安全**：新开关默认 legacy/关闭；不自动启用。
4. **不双写**：任何阶段只允许一个消息历史真源；发现双写立即停。
5. **不重放**：写工具恢复前必须查幂等键；`effect_unknown` 人工处理。
6. **可回滚**：每个 PR 必须写回滚点；不可回滚的 PR 不合并。
7. **不删旧数据**：观察期结束前不删 KV/文件/归档/sqlite。
8. **评审**：安全/迁移/审批 PR 需要第二人 review；不能自审。

---

## 11. 第一迭代（S0）10 个工作日任务清单

> 目标：只做 PR0，不引依赖、不改运行时。

| 天 | 任务 | 产出 |
|---|---|---|
| D1 | 复跑基线；记录 Node/pnpm/commit；保存日志 | 基线报告 |
| D2 | 建 fixture 目录；脚本化 legacy Provider / AI SDK model 骨架 | `model/runtime/test/fixtures/` |
| D3 | 官方 ID 冒号测试：list/clear；标 `KNOWN-BUG` | 契约测试 |
| D4 | 审批基线：pending/超时/取消/重启丢失；标 `KNOWN-BUG` | 契约测试 |
| D5 | 工具名 sanitize/63/冲突测试；`Agent.run` 结果快照 | 契约测试 |
| D6 | parity harness：P1–P6 场景；统一事件归一 | harness |
| D7 | P7–P14 场景；差异 allowlist 模板 | harness |
| D8 | 评审 00/01/02/04/05/06；确认 D1–D12 | 评审记录 |
| D9 | 修测试运行器/文档；确保新测试可独立跑 | CI 通过 |
| D10 | PR0 评审；Go/No-Go；更新计划状态 | 评审结论 |

**S0 完成定义**：

- 基线可一键复现；
- 新契约测试与 fixture 入库；
- 既有缺陷有 `KNOWN-BUG` 标记；
- parity harness 能跑 P1–P14（即使 mastra 侧暂用 mock）；
- 决策项有结论或明确“延期”；
- PR1 的依赖/风险/回滚已确认。

---

## 12. 交付物清单

| 阶段 | 交付物 |
|---|---|
| S0 | 基线报告、fixture、契约测试、parity harness、决策记录 |
| S1 | Facade/Factory/Storage/Identity、配置 schema、生命周期测试 |
| S2 | ModelFactory、参数映射、Gemini Spike 报告、Provider parity |
| S3 | ToolAdapter、名称映射、只读 parity |
| S4 | 审批桥、写工具、非流式 Facade、灰度 1 用户 |
| S5 | 流式/取消映射、灰度 1 群 |
| S6 | MessageAdapter、Memory Phase 1 回归 |
| S7 | Memory Phase 2、迁移脚本、校验/回滚报告 |
| S8 | 深度研究/工具进化 Workflow、审批 E2E |
| S9 | 外围 parity、功能签字表 |
| S10 | 100% 灰度、soak、回滚演练 |
| S11 | legacy 删除 PR、最终文档、升级说明 |

---

## 13. 计划评审检查表

- [ ] 是否确认“默认 legacy、灰度、可回退”？
- [ ] 是否确认 D1–D12（JS/TS、Memory Phase、Semantic Recall、Observational Memory、MCP、Schedule、TaskStore、子 Agent、安全修复、代理、多进程、观察期）？
- [ ] 是否接受“Phase 2 可能延期、Gemini 可能 legacy-only”？
- [ ] 是否有真实 Provider Key/Postgres 测试环境？
- [ ] 是否有维护窗口/备份/回滚值班？
- [ ] 是否确认灰度范围/观察期/下线批准人？
- [ ] 是否确认验收人不是实现者本人？
- [ ] 是否确认第一迭代只做 PR0、不改运行时？

---

## 14. 计划状态跟踪（模板）

| 里程碑 | 状态 | 负责人 | 开始 | 完成 | 证据 | 阻塞 |
|---|---|---|---|---|---|---|
| M0 | **完成** | 实现者 | 2026-11-20 | 2026-11-20 | [PR0-baseline.md](PR0-baseline.md)：153/0/12、7,418 断言；P1–P14；真机 Yunzai+LLM+QQ READY | 无 |
| M1 | **完成** | 实现者 | 2026-11-20 | 2026-11-20 | [PR1-report.md](PR1-report.md)：160/0/12、7,571 断言；legacy 不建库；mastra 骨架 3.4s 创建/关闭；真机通过 | 无 |
| M2 | **完成** | 实现者 | 2026-11-20 | 2026-11-20 | [PR2-report.md](PR2-report.md)：162/0/12、7,713 断言；19 preset parity；真实 AI SDK+legacy；Gemini/Azure legacy-only | 无 |
| M3 | **完成** | 实现者 | 2026-11-20 | 2026-11-20 | [PR3-report.md](PR3-report.md)：164/0/12、7,770 断言；26 只读/56 写过滤；真机通过 | 无 |
| M4 | **完成** | 实现者 | 2026-11-20 | 2026-11-20 | [PR4a-report.md](PR4a-report.md)、[PR4b-report.md](PR4b-report.md)：170/0/12、7,908 断言；灰度/流式/取消/原生审批 | S5 观察期 |
| M5 | **功能完成（72h 观察待执行）** | 实现者 | 2026-11-20 | | [PR4b-report.md](PR4b-report.md)：流式/取消/灰度群/原生审批 | 72h 观察 |
| M6 | **完成** | 实现者 | 2026-11-21 | 2026-11-21 | [S6-report.md](S6-report.md)：173/0/12、7,982 断言；两轮 Mastra gray 真机；pm2 legacy 上线 | 无 |
| M7 | 未开始 | | | | | |
| M8 | 未开始 | | | | | |
| M9 | 未开始 | | | | | |
| M10 | 未开始 | | | | | |
| M11 | 未开始 | | | | | |
