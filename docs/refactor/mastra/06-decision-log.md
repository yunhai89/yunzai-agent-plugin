# 06 · 决策记录（ADR）

> 格式：Context / Options / Decision / Consequences / Status。
>
> 状态：`proposed` = 待人工确认；`accepted` = 本文推荐并作为方案基线；`deferred` = 暂缓；`rejected` = 不采用。
>
> 这些决策不是代码事实；实施前需由项目负责人确认 `proposed` 项。

---

## ADR-001 · 语言：继续 ESM JavaScript + JSDoc，不做全量 TypeScript 迁移

**Status**: proposed（推荐 accepted）

### Context

- 仓库是 Yunzai 插件，`index.js` 直接 ESM 加载 `apps/*.js`，无构建步骤。
- `typescript@5.7.2` 已是 runtime dep，但仅用于 toolEvo AST 检查。
- Mastra/AI SDK 是 TS-first，但发布 ESM JS + `.d.ts`，JS 可直接消费。
- 新增 `model/runtime/` 需要类型表达，但全量 TS 会引入 `tsc`/loader/`dist`/发布路径问题。

### Options

1. **全量 TS**：源码 `.ts`，构建到 `dist/`，`index.js` 指向 dist。
   - 优点：类型强；Mastra 类型体验好。
   - 缺点：新增构建体系；Yunzai 直接加载/热重载/发布复杂；与现有 548 个 JS 文件长期并行；容易两套构建。
2. **TS 只用于底层 + 运行时 loader（tsx/jiti）**。
   - 优点：渐进。
   - 缺点：宿主启动多一个 loader；Node 版本/ESM 兼容风险；仍是两套。
3. **继续 JS + JSDoc；关键边界用 Zod 运行时校验**。
   - 优点：零构建；与 Yunzai 加载一致；Mastra 可用；Zod 提供运行时安全。
   - 缺点：类型检查弱；需要自律。

### Decision

选择 **3**。新增 `model/runtime/*.js`，公开接口用 JSDoc；配置/Workflow/Tool 边界用 Zod。可选 CI 加 `tsc --noEmit --allowJs --checkJs` 只检查新模块，**不产出 dist、不改入口**。不留下两套构建体系。

### Consequences

- 开发体验不如纯 TS；用 JSDoc + 测试 + Zod 补。
- 如果未来全量 TS，必须单独 ADR，并一次性迁移入口/构建/发布，不允许长期双轨。
- 代码示例中的 TS 仅表达类型，实际实现用 JS。

---

## ADR-002 · Mastra 以嵌入式运行，不启动独立 Server

**Status**: accepted

### Context

- 插件运行在 Yunzai 进程内；Web 面板已有独立 HTTP（`apps/web.js`）。
- Mastra 官方支持 `new Mastra({...})` 嵌入式；Studio/Server 是可选开发/部署形态。
- 需求明确“默认不引入独立 Mastra Server，不要求另起 Hono/HTTP 服务”。

### Options

1. 独立 Mastra Server + 插件 HTTP 调用。
   - 优点：隔离/可观测/Studio 原生。
   - 缺点：多进程/端口/认证/部署复杂；破坏现有插件拓扑。
2. 嵌入式 `Mastra` 实例，由 Facade 调用。
   - 优点：同进程、低延迟、复用现有配置/日志/回复；无新端口。
   - 缺点：共享事件循环/内存；需自己管生命周期。
3. 只用 Agent 类、不用 Mastra 实例。
   - 优点：最轻。
   - 缺点：失去 workflows/storage/observability 统一注册。

### Decision

选择 **2**。`new Mastra()` 在 `buildRuntime()` 内创建；不启动 `mastra dev`/Server。Studio 仅开发期可选。

### Consequences

- 必须自己实现 health/close/generation；见 ADR-009/014。
- 观测用项目 DevLog/UsageStats + 可选 `@mastra/observability`，不能依赖 Studio。
- 生产拓扑不变；Web 面板仍是唯一管理入口。

---

## ADR-003 · Agent 与 Workflow 边界：普通聊天用 Agent，确定性流程才用 Workflow

**Status**: accepted

### Context

- 现有 `Agent` 是动态 ReAct；`DeepResearch`/`ToolEvo` 是固定阶段编排。
- 需求明确“不要把 ReAct 内循环机械重写成巨型 Workflow”。
- Mastra Workflow 提供 suspend/resume/snapshot，适合审批/长流程。

### Options

1. 所有聊天都包一层 Workflow（agent step + 审批 step）。
   - 优点：统一状态/恢复。
   - 缺点：多一层状态机；流式/取消/工具循环语义复杂；收益低。
2. 普通聊天直接 Agent；只把固定阶段流程 Workflow 化。
   - 优点：符合 Mastra 设计；改动小；保留 ReAct。
   - 缺点：两套编排并存，需要清晰边界。
3. 全部用 Agent + tools（research/toolEvo 作为工具）。
   - 优点：简单。
   - 缺点：长流程无法暂停/恢复；审批靠阻塞工具。

### Decision

选择 **2**。Workflow 候选：深度研究、工具进化、人设补齐（P2）。普通聊天/定时单任务/子 Agent 委派不包 Workflow；审批用 Agent 原生 `requireApproval`。

### Consequences

- 需要维护“何时用 Workflow”的评审规则；新增流程默认 Agent，只有满足“固定阶段 + 可暂停 + 需要快照”才升 Workflow。
- Workflow snapshot 是运行状态唯一真源；TaskStore 只做投影（ADR-013）。

---

## ADR-004 · 消息历史：Phase 1 用 SessionStore，Phase 2 才让 Mastra Memory 接管

**Status**: **accepted（Phase 2 于 2026-11-21 获批并完成 S7）**

### Context

- 现有 SessionStore 有 conversation/active/seq、400 窗口、压缩 ledger、cacheEpoch、activeTools、并发保护、旧键迁移、Web 会话视图。
- Mastra Memory 有 thread/resource/message history，但压缩/覆写/元数据语义需验证。
- 直接切换会同时改变历史、压缩、缓存、Web、#清空所有记录。

### Options

1. PR4 直接 Mastra Memory 接管。
   - 优点：一步到位。
   - 缺点：风险最高；压缩/迁移/隔离一起爆。
2. Phase 1 不启用 Memory，仅用 Agent 循环；Phase 2 再接管。
   - 优点：先证明循环/工具/Provider；历史不变；可回退。
   - 缺点：两阶段；Phase 2 仍需迁移。
3. 永久保留 SessionStore，Mastra 不碰历史。
   - 优点：最稳。
   - 缺点：未使用 Mastra Memory；跨重启/审批 snapshot 仍靠旧栈。

### Decision

选择 **2**。Phase 1：`memory: undefined`，`MessageAdapter` 读写 SessionStore；Phase 2：Mastra Memory 唯一写，SessionStore 只读/迁移源。**绝不双写**。

Phase 2 已落地（S7）：`MastraMemoryBridge` 提供 conversation API，`scripts/migrate-mastra.mjs` 提供 inventory/dry-run/apply/verify/rollback，默认 `memory.mode=sessionstore`，切到 `mastra` 后仍可回退。

### Consequences

- PR4 的 parity 不包含 Memory；PR5 单独验收。
- Phase 2 必须先验证：消息覆写/压缩、thread owner、metadata、并发、迁移。
- 若 Phase 2 无法满足无损压缩，则延期，继续 Phase 1；不强行用 Observational Memory。

---

## ADR-005 · Working Memory 不替代 ProfileStore

**Status**: accepted

### Context

- ProfileStore：facets（identity/preference/communication/expertise/sensitivity/fact）、`source: observed|inferred|corrected`、`confidence`、`evidence[]`、`prev[]`、`status: active|superseded`、per-facet cap、maxChars、纠正/审计。
- Mastra Working Memory：Markdown/JSON 模板，线程/资源级，适合偏好/目标，但没有同等证据/置信度/纠正链。

### Options

1. 用 Working Memory 替换 Profile。
   - 优点：Mastra 原生、可注入。
   - 缺点：语义丢失；迁移/纠错/审计/上限无法等价；双真源。
2. 保留 ProfileStore；Working Memory 关闭。
   - 优点：行为不变；风险低。
   - 缺点：未使用 Mastra 能力。
3. 双写：Profile + Working Memory。
   - 优点：两边都有。
   - 缺点：冲突/重复注入/成本；禁止。

### Decision

选择 **2**。ProfileStore 永久保留；Working Memory 默认关闭。未来若要用，只做“只读摘要镜像”，不写、不作为注入真源。

### Consequences

- Mastra 原生 Working Memory 工具不启用；模型仍通过项目 `memory`/`profile` 工具写。
- Web `/profile` 继续读 ProfileStore。
- 需要文档明确“Mastra Memory 不是用户画像的唯一来源”。

---

## ADR-006 · Semantic Recall 默认关闭

**Status**: accepted

### Context

- RecallStore 是跨会话长期记忆：时间衰减、MMR、置信度、纠错、价值淘汰、证据。
- Mastra Semantic Recall 是消息级 RAG：topK/messageRange/scope，依赖 vector/embedder。
- 两者都叫“召回”，但数据/语义/成本不同。

### Options

1. 开启 Mastra Semantic Recall 替代 RecallStore。
   - 优点：原生、消息级。
   - 缺点：语义不等价；重复 embedding；隔离/纠错/衰减丢失。
2. 默认关闭；保留 RecallStore；未来按需开独立 namespace。
   - 优点：行为不变；成本可控。
   - 缺点：Mastra Memory 的跨会话检索不用。
3. 双开。
   - 优点：能力多。
   - 缺点：重复召回/重复注入/成本；模型混淆。

### Decision

选择 **2**。默认 `semanticRecall: false`；RecallStore 继续。若未来开启，使用独立 index/namespace，明确 topK/messageRange/embedder/维度，并与 Recall 去重。

### Consequences

- 没有 embedder/vector 时行为可预测（关键词/BM25）。
- 需要监控 embedding 成本；不能默认用 `text-embedding-3-small` 静默。
- KB 的 vector 与 Memory 的 vector 分开。

---

## ADR-007 · Observational Memory 不作为无损压缩替代

**Status:** accepted

### Context

- 现有压缩：内容寻址归档（sha256）+ 结构化 ledger + `context_recall` 可恢复原文；`cacheEpoch` 分代；多次压缩 merge。
- Mastra Observational Memory：后台观察/反思，压缩会丢精确措辞；recall 只能回到 observation group；不是无损格式。

### Options

1. 用 Observational Memory 替换现有压缩。
   - 优点：Mastra 原生、上下文小。
   - 缺点：有损；归档/ledger/refs 不兼容；`context_recall` 契约破坏。
2. 保留现有压缩；Observational Memory 关闭。
   - 优点：无损契约不变。
   - 缺点：未使用新能力。
3. 仅实验环境开启，生产关闭。
   - 优点：可评估。
   - 缺点：双路径/配置复杂。

### Decision

选择 **2**；实验评估可放 PR7 之后、独立开关，不进入生产默认。现有压缩/归档/ledger 永久保留。

### Consequences

- Mastra Memory 若接管历史，必须能容纳压缩后的 messages/ledger；否则 Phase 2 延期。
- 文档明确“Observational Memory 不是无损”。

---

## ADR-008 · Storage：本地 LibSQL，生产 PostgreSQL；Vector 分开配置

**Status**: accepted

### Context

- 需求：本地默认 LibSQL，生产支持 Postgres；语义召回需要时配置 Vector/Embedder。
- Mastra 提供 `LibSQLStore`/`LibSQLVector`/`PostgresStore`/`PgVector`。
- 现有 KV/文件/sqlite 数据不应全部搬入 Mastra。

### Options

1. 全部用 LibSQL 文件。
   - 优点：简单。
   - 缺点：多进程/生产不可靠。
2. 本地 LibSQL；生产 Postgres；Vector 可选。
   - 优点：符合需求；可扩展。
   - 缺点：两套测试/运维。
3. 只支持 Postgres。
   - 优点：一致。
   - 缺点：本地开发重；不符合需求。

### Decision

选择 **2**。默认 `LibSQLStore` 绝对路径 `data/mastra/mastra.db`；生产 `PostgresStore`（`DATABASE_URL`/schema/SSL/pool/disableInit）；Vector 独立开关。Mastra Storage 第一版只接管 memory + workflow，不接管 Recall/Profile/KB/Schedule/Usage。

### Consequences

- 必须测两套 storage；迁移/备份/恢复分别写。
- 本地文件禁止多进程写；多进程必须 PG。
- `storage.init()`/`close()`/schema 升级纳入 runbook。

---

## ADR-009 · 审批：Mastra 原生 suspend/resume + 持久化 ApprovalBridge

**Status**: proposed（推荐 accepted）

### Context

- 现有 ConfirmStore 是内存 Promise，重启丢；无 runId/toolCallId 持久化。
- Mastra `requireApproval`/`tool-call-approval`/`approveToolCall`/`declineToolCall`/`listSuspendedRuns` 提供 suspend/resume + storage snapshot。
- 需要保留 `#确认/#拒绝/#待确认`、Web、超时、主人权限、迟到批准无效。

### Options

1. 保留 ConfirmStore（在 Adapter execute 内阻塞）。
   - 优点：行为最接近；改动小。
   - 缺点：重启丢；阻塞工具；Mastra 无感知；无法持久化。
2. Mastra 原生审批 + ApprovalBridge（短 id、CAS、argsHash、持久化）。
   - 优点：持久化/可恢复/防重；符合 Mastra。
   - 缺点：实现复杂；需对账/迁移。
3. Workflow suspend 包审批。
   - 优点：统一 snapshot。
   - 缺点：普通工具审批也要包 Workflow；过重。

### Decision

选择 **2**。Adapter 用 `requireApproval` + `beforeApproval`；Bridge 持久化短 id→`{runId,toolCallId,argsHash,...}`；启动时 `listSuspendedRuns` 对账；超时不执行；恢复用幂等键防重。

### Consequences

- 旧 pending 不迁移（内存，无法恢复）；切换前处理/取消。
- 需要新测试：重启/重复/迟到/参数漂移/多 pending。
- 写工具恢复可能重跑（Mastra 官方明确），必须 TaskStore 幂等兜底。

---

## ADR-010 · Tool Adapter：保留 JSON Schema，用 AI SDK `jsonSchema()`，不强行转 Zod

**Status**: accepted

### Context

- 现有工具用 JSON Schema（draft-07/2019/2020），Ajv `strict:false`、`useDefaults:false`、`coerceTypes:false`。
- Mastra `createTool` 接受 Standard Schema/JSON Schema/AI SDK Schema；AI SDK 提供 `jsonSchema()`。
- 全量转 Zod 会丢 `$ref`/union/`additionalProperties`/方言，且默认值行为不同。

### Options

1. 全部转 Zod。
   - 优点：类型强。
   - 缺点：转换损失；默认值/严格性变化；工具作者负担。
2. 用 `jsonSchema()` 包装原 Schema + AJV 校验。
   - 优点：零转换；行为一致；Mastra 可用。
   - 缺点：类型推断弱。
3. 两套并存（Zod 新工具 + JSON Schema 旧工具）。
   - 优点：渐进。
   - 缺点：边界复杂。

### Decision

选择 **2**。Adapter 用 `jsonSchema(parameters, { validate })`；执行前再用现有 AJV 校验一次；新工具可选 Zod，但必须能导出 JSON Schema。`outputSchema` 默认不设。

### Consequences

- 需要测试 Mastra 是否真正调用 `validate`；若不调用，Adapter 在 execute 内再校验（已有）。
- 工具名/描述/参数保持原样；`meta` 保留在闭包。
- 不引入 `zod-to-json-schema` 等转换依赖。

---

## ADR-011 · MCP：保留现有客户端/桥，不引入 `@mastra/mcp`

**Status**: accepted（可复议）

### Context

- 现有 `model/mcp` 有 JSON-RPC/stdio/http/sse、超时、命名空间、权限桥、结果归一。
- `@mastra/mcp@2.10.0` peer 要求 `zod ^4.2`，与当前主 zod 3.25 冲突；且会引入第二套命名/权限默认。
- MCP 工具默认 `system`（仅主人），不能放松。

### Options

1. 引入 `@mastra/mcp`，替换现有客户端。
   - 优点：Mastra 原生。
   - 缺点：Zod 4 升级；权限/命名/结果语义重写；风险高。
2. 保留现有客户端，经 ToolAdapter 接入。
   - 优点：行为不变；Zod 3.25；安全默认保留。
   - 缺点：未用 Mastra MCP 能力。
3. 双客户端。
   - 优点：可对比。
   - 缺点：重复连接/工具；禁止。

### Decision

选择 **2**。MCP 工具仍由 `loadMcpTools` 注册到 ToolRegistry，再经 Adapter 变成 Mastra Tool。`@mastra/mcp` 暂不引入。

### Consequences

- 需要补 MCP 既有缺口：AbortSignal、分页、list_changed、stdio env 最小化（独立安全 PR）。
- 如果未来升 Zod 4，再评估 `@mastra/mcp`；届时单独 ADR。

---

## ADR-012 · 多 Agent：先保留 spawn/check/extend 与 Orchestrator，PR7 再评估 Mastra subagents

**Status**: proposed

### Context

- 现有子 Agent 有会话配额、时间预算、取消、结果回推、query-only 工具、身份 ctx、shutdown。
- Mastra subagents/supervisor 有原生委派/记忆隔离/审批传播，但语义/预算/回推需重写。
- 现有子 Agent 没有 policy/confirm/taskStore/governor/token budget（既有风险）。

### Options

1. PR4 即换 Mastra subagents。
   - 优点：原生。
   - 缺点：与主链路同时变；预算/配额/回推/取消风险。
2. 先保留现有 spawn/orchestrator，PR7 评估。
   - 优点：隔离风险；主链路先稳定。
   - 缺点：两套编排短期并存。
3. 永久保留。
   - 优点：行为不变。
   - 缺点：不用 Mastra 能力。

### Decision

选择 **2**。PR4 的子 Agent 继续用现有实现（内部可走 legacy 或 mastra runner，按父引擎）；PR7 再做 Mastra subagents 的 parity/替换。

### Consequences

- 子 Agent 的写工具仍受“无 policy/confirm”限制（query-only + 工具白名单），不因 Mastra 改变。
- 需要补：worker token budget/governor、`extend_subagent` 总上限、MCP/context_recall 隔离。
- 如果 PR7 不通过，永久保留现有实现。

---

## ADR-013 · TaskStore / ScheduleStore 保留，Workflow 只做投影

**Status**: accepted

### Context

- TaskStore：sqlite 事件/检查点/恢复计划/投递账本；命令/Web 依赖。
- ScheduleStore：KV+node-schedule+所有权+重启恢复；Mastra Schedules 语义不同。
- Mastra Workflow snapshot 是运行状态，但不能替代用户可见任务列表。

### Options

1. 用 Mastra storage 替换 TaskStore。
   - 优点：统一。
   - 缺点：事件契约/恢复/命令/API 全改；迁移风险。
2. 保留 TaskStore；Workflow 写投影字段。
   - 优点：行为不变；风险低。
   - 缺点：两套状态需对账。
3. 用 Workflow 替换 ScheduleStore。
   - 优点：Mastra 原生调度。
   - 缺点：重启/所有权/多实例语义变化。

### Decision

选择 **2**。TaskStore/ScheduleStore 永久保留；Workflow 只在 TaskStore 写 `workflow_run_id`/phase 投影；ScheduleStore 继续触发 Agent 或 Workflow。

### Consequences

- 需要明确“Workflow snapshot 是运行真源，TaskStore 是用户视图”；禁止 TaskStore 驱动 Workflow。
- 恢复：Workflow 用 Mastra snapshot；普通 Agent 写工具仍走 TaskStore 人工恢复。
- 多实例定时任务重复触发是既有问题，迁移不解决；单独评估。

---

## ADR-014 · 版本/兼容：Node >=22.13、Zod 3.25.76、Mastra/AI SDK 同批锁定

**Status**: accepted

### Context

- Mastra v1 要求 Node >=22.13.0；core peer `zod ^3.25||^4`；AI SDK 7 peer `zod ^3.25.76||^4.1.8`。
- 当前 zod 3.23.0 不满足；zod-stagehand 4.4.3 必须保留。
- Mastra 包版本不同步（core 1.85.0/memory 1.41.2/libsql 1.31.1/pg 1.37.0），但 peer 范围兼容。

### Options

1. 继续 `latest`/不锁版本。
   - 优点：省事。
   - 缺点：不可复现；升级破坏。
2. 精确锁定兼容集；Zod 3.25.76；Node 22.13+。
   - 优点：可复现；风险可控。
   - 缺点：升级需手动。
3. 升 Zod 4。
   - 优点：未来。
   - 缺点：diagram/既有 schema/Stagehand 风险；`@mastra/mcp` 才需要。

### Decision

选择 **2**。锁定 README 表中的版本；Zod `^3.25.76`；不升 4；`zod-stagehand` 保持；CI Node 22.13+。

### Consequences

- 升级必须同批 + 备份 + parity + 真实 Provider。
- 任何“latest”写法禁止进入生产依赖。
- Node 20 宿主必须升级；否则不启用 mastra。

---

## ADR-015 · Gemini：Spike 不通过则继续 legacy

**Status**: proposed

### Context

- 现有 Gemini 用 `@google/genai` Interactions API（`ai.interactions.create`、`Step[]`、`thought_summary`），不是 AI SDK Google 的 `generateContent`。
- 工具/thinking/usage/流式语义可能不同。
- 需求要求“不得静默减功能”。

### Options

1. PR2 直接切 `@ai-sdk/google`。
   - 优点：统一 Provider。
   - 缺点：行为变化/功能缺失风险高。
2. 先 Spike；不通过则 Gemini 继续 legacy。
   - 优点：风险可控；其它模型先迁移。
   - 缺点：双 Provider 栈过渡。
3. 永不迁移 Gemini。
   - 优点：稳定。
   - 缺点：长期双栈。

### Decision

选择 **2**。Spike 覆盖工具/工具结果/thinking/usage/流式/取消/结构化输出；全部通过才切，否则 legacy-only 并在文档标注。

### Consequences

- PR8 前必须决定；不能无限期双栈。
- ModelFactory 需要“Gemini → legacy provider”分支；Facade 要能按模型选择底层。
- 真实 Key 测试是前置；无 Key 只能记录未验证。

---

## ADR-016 · Legacy 下线：分阶段、可回退、观察期后删除

**Status**: accepted

### Context

- 旧内核 2,494 行，承载大量行为；测试 7,230 断言。
- 需求明确“不能直接删旧内核；legacy|mastra 开关；默认旧链路直到 parity/验收”。

### Options

1. 一次性切换并删除 legacy。
   - 优点：干净。
   - 缺点：不可回退；风险极高。
2. 灰度 + 观察期 + 分 PR 删除。
   - 优点：可回退；可审计。
   - 缺点：周期长；双栈维护。
3. 永久保留双栈。
   - 优点：安全。
   - 缺点：维护成本/行为漂移。

### Decision

选择 **2**。`engine` 默认 legacy；灰度 1 用户→1 群→5%→25%→100%；观察期 ≥2 周或 ≥1 发布周期；回滚演练；分 PR 删 `Agent`/provider/confirm/scheduler；保留项目业务代码。

### Consequences

- 双栈期间所有修复要判断是否两边都改；优先修 Facade/共享层。
- 删除前必须备份/标签/回滚文档；删除后保留 tag。
- 观察期内任何 P0/P1 立即回滚，不继续扩大灰度。
