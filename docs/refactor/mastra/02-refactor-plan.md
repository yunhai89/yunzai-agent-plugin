# 02 · 改造矩阵与分阶段 PR 计划

> 本文把 [01 目标架构](01-target-architecture.md) 落到逐文件处置与可回滚的 PR 序列。
>
> 处置含义：**保留**=不动；**包装**=保留实现、加 Facade/Adapter；**适配**=改接口/加中间层；**替换**=由 Mastra 原语接管；**删除**=确认无调用后移除；**新增**=新文件；**暂缓**=本期不做。
>
> 复杂度：S（1–2 天）/ M（3–5 天）/ L（1–2 周）/ XL（>2 周，需拆分）。这是相对复杂度，不是承诺工时。

---

## 1. 逐文件/逐目录改造矩阵

### 1.1 入口、运行时与配置

| 当前路径与符号 | 当前职责 | 调用方/被调用方 | 处置 | 目标位置/原语 | 接线方式 | 数据兼容 | 风险 | 测试 | 阶段/依赖 | 证据 |
|---|---|---|---|---|---|---|---|---|---|---|
| `index.js` 动态加载 `apps/*.js` | 插件入口，过滤 class 导出 | Yunzai loader | **保留** | 不变 | Mastra 初始化放 `buildRuntime()`，不放模块顶层 | 无 | 顶层初始化会拖慢扫描/失败隔离 | 启动冒烟 | PR1 | `index.js:32-57` |
| `apps/agent.js` `getRuntime/_buildRuntime/invalidateRuntime` | 运行时单例、装配、热重载、关闭 | Chat/Web/research | **包装/适配** | `model/runtime/factory.js`、`facade.js` | `_buildRuntime` 末尾创建 Facade；`invalidateRuntime` 调 `facade.close`；保留 `_runtimeGen`/`_closingPromise` | 配置/路径不变 | 关闭顺序、旧 build 复活、连接泄漏 | `runtime-scope.test`、新增生命周期测试 | PR1/PR4 | `apps/agent.js:576-585,1628-1714` |
| `apps/agent.js` `agentConfig/makeAgent` | 每请求 new Agent，共享依赖 | `_handleAgent`、schedule、persona | **适配** | `facade.forRequest()` / `LegacyAgentHandle` | `makeAgent()` 暂时返回兼容 handle；PR4 改 `runtime.runChat` | Agent 结果契约不变 | 调用方多、私有字段 `_ranTools/_userTexts` | `test.mjs`、E2E | PR4 | `apps/agent.js:1262-1335` |
| `apps/agent.js` `_handleAgent` | 触发后全链路编排、回复 | `onTrigger` | **保留/小幅适配** | 仍由 apps 拥有 | 只把 `agent.run` 换成 `runtime.runChat`；回调/回复/统计不动 | 回复/命令/终端事件不变 | 回调语义、流式去重 | `stress/e2e/*` | PR4 | `apps/agent.js:2212-2889` |
| `apps/agent.js` 71 条命令 | 用户/管理入口 | 用户 | **保留** | 不变 | 审批命令改走 ApprovalBridge（mastra 模式） | 命令文本/权限不变 | 新旧审批 id 冲突 | 命令回归 | PR4/PR5 | `apps/agent.js:2020-2107` |
| `utils/Config.js` `normalizeConfig/diff/save/onChange` | 配置真源、差异保存、热加载 | 全仓 | **适配** | 新增 `agent.runtime`/`agent.mastra` 校验与迁移 | Zod 校验包装；旧配置缺省=legacy；DSN 只读 env | 旧 YAML 原样可读 | 归一化顺序、默认值变化影响老用户 | `web/dev/config-search-check` + 新增 schema 测试 | PR1 | `utils/Config.js:314-327,375-434` |
| `config/default_config/config.yaml` | 默认值真源 | Config/Web/Guoba | **新增字段** | 同上 | 只加必要字段；敏感值留空/env | 旧配置不受影响 | 四文件同步（yaml/Web/Guoba/docs） | `config-search-check` | PR1 | `config/default_config/config.yaml` |
| `model/web/api.js` 95 路由 | 面板 API | Web 前端 | **保留/适配** | 经 Facade/Adapter | sessions/confirm/tasks 改读 Bridge/Adapter；其余不动 | API 响应字段保持 | 直接依赖 rt 字段 | 现有 API 测试 + 新增 | PR5/PR7 | `model/web/api.js` |
| `model/web/auth.js` | Bearer/console token | Web | **保留** | 不变 | 无 | 无 | 无 | `auth.test` | — | `model/web/auth.js:14-241` |
| `apps/web.js` | 启停 HTTP | Config 变更 | **保留** | 不变 | 无 | 无 | 无 | 现有 | — | `apps/web.js:18-55` |
| `apps/research.js` | 深度研究入口/交付 | `#研究` | **适配** | Workflow（PR6） | 先保留类编排；PR6 切 Workflow，交付不变 | 报告/文件格式不变 | 预算/阶段回调 | research 测试 + 新 E2E | PR6 | `apps/research.js:37-163` |
| `apps/qqbot.js` | 官方适配器 | 框架 | **保留** | 不变 | 只提供 ctx.adapterKind/selfId | 无 | 无权限门是既有风险 | `qqbot-adapter` | — | `apps/qqbot.js:613-676` |

### 1.2 Agent 内核与循环

| 当前路径与符号 | 当前职责 | 调用方/被调用方 | 处置 | 目标位置/原语 | 接线方式 | 数据兼容 | 风险 | 测试 | 阶段/依赖 | 证据 |
|---|---|---|---|---|---|---|---|---|---|---|
| `model/agent/Agent.js` `run()` | ReAct 主循环、状态机、持久化、usage | apps/子代理/schedule | **替换（保留 legacy）** | Mastra Agent + `model/runtime/facade.js` | Facade 复刻状态机；legacy 原样保留到 PR8 | 结果对象/消息格式不变 | 最高：终止/反思/压缩/流式 | 全量 Agent 测试 + parity | PR4 | `Agent.js:544-1368` |
| `Agent._finalize` | 禁工具收尾 | run | **保留（项目）** | Facade finalizer | 用 Mastra 再发一次同 instructions/tools 的 generate，指令禁工具；失败走确定性兜底 | 输出入历史 | 与 Mastra 请求形状/缓存对齐 | stability 测试 | PR4 | `Agent.js:408-499` |
| `Agent._reflect` | 交付前自检 | run | **暂缓/保留** | 项目函数 + `onStepFinish` | Phase 1 保留旧逻辑；Phase 3 评估 Processor | 无 | 额外模型调用/缓存 | 现有 | PR4/PR6 | `Agent.js:2439-2475` |
| `Agent._hysteresisPressure/_compactMessages` | 压缩水位 | run | **保留** | `model/agent/compact/*` | Phase 1 完全保留；Phase 2 需与 Memory 读写对齐 | ledger/archive/cacheEpoch | 极高：无损/前缀 | compact 114 断言 + 新增 | PR4/PR5 | `Agent.js:1724-1792` |
| `Agent._executeToolCalls/_executeOne` | 工具守卫/调度/账本 | run | **适配** | `model/runtime/tool-adapter.js` + hooks | 逻辑迁移到 Adapter/guards；legacy 保留 | tool 消息/事件不变 | 顺序/审批/副作用 | scheduler/schema/effects + 新 parity | PR3/PR4 | `Agent.js:2039-2406` |
| `loop-governor.js` | 重复/失败/无进展/预算 | Agent | **保留** | 项目组件 | `onStepFinish`/`afterToolCall` 喂入，命中后 Facade 停止 | 无 | Mastra step 语义不同 | 现有 + 新 | PR4 | `loop-governor.js:51-215` |
| `continuation.js` | 检查点续跑消息 | TaskStore/apps | **保留** | 项目组件 | 继续用 `buildResumeMessages` | 消息格式 | 与 MessageAdapter 兼容 | 现有 | PR4 | `continuation.js` |
| `recovery.js` | 只读恢复计划 | apps | **保留** | 项目组件 | 不变 | TaskStore | 无 | 现有 | — | `recovery.js` |
| `cancellation`/`abortActiveRun` | 在途 run 注册/取消 | apps/Web | **适配** | Facade run registry | 保留 `taskId` 键；同时注册 Mastra abort | 无 | 漏注销/挂死 | cancellation 测试 | PR4 | `Agent.js:90-107,885,1364-1367` |

### 1.3 Provider / 模型

| 当前路径与符号 | 当前职责 | 调用方/被调用方 | 处置 | 目标位置/原语 | 接线方式 | 数据兼容 | 风险 | 测试 | 阶段/依赖 | 证据 |
|---|---|---|---|---|---|---|---|---|---|---|
| `model/agent/provider/openai.js` | OpenAI 兼容请求/流/自适应重试 | Agent | **替换（legacy 保留）** | AI SDK `createOpenAI(...).chat()` | ModelFactory 解析 baseURL/apiKey/preset/headers | 消息/工具/usage 需映射 | 厂商自定义字段/温度/结构化输出 | protocol 测试 + 新 parity | PR2 | `provider/openai.js:21-150` |
| `model/agent/provider/anthropic.js` | Anthropic 请求/流/thinking/cache | Agent | **替换（legacy 保留）** | `createAnthropic` | 同上；signature/cache 需 Spike | provider_native 回放 | thinking/cache 400 | protocol 测试 + 真实 Key | PR2 | `provider/anthropic.js:173-305` |
| `model/agent/provider/gemini.js` | Gemini Interactions SDK | Agent | **暂缓/替换** | `@ai-sdk/google` | 先保留 legacy；Spike 通过再切 | Step[]/thought/usage | API 面不同 | 真实 Gemini Key | PR2/PR7 | `provider/gemini.js:191-336` |
| `model/openai/{Client,stream,helpers,presets,errors,transport}` | 手写 HTTP/SSE/厂商 preset | provider | **保留到 PR8** | AI SDK 替代 | `presets` 数据可转为 ModelFactory 的 vendor 数据 | 无 | 误删导致 legacy 不可用 | 现有 | PR8 删除 | 文件树；`transport-base.js:130-241` |
| `model/anthropic/*` | 同上 | provider | **保留到 PR8** | AI SDK 替代 | 同上 | 无 | 同上 | 现有 | PR8 删除 | 同上 |
| `model/llm/capabilities.js` | 能力判定（thinking/vision） | Agent/apps | **保留** | 项目组件 | ModelFactory 仍用 | 无 | 无 | 现有 | — | `capabilities.js:64-118` |
| `model/llm/thinking.js` | 复杂度判档/厂商编码 | Agent/apps | **保留** | 项目组件 | 产出 providerOptions 映射 | 无 | 与 AI SDK 参数名不同 | thinking 86 断言 | PR2 | `thinking.js:62-305` |
| `model/llm/model-context.js` | 上下文窗口解析/学习 | Agent | **保留** | 项目组件 | 仍用于压缩水位 | 无 | 无 | model-context 53 断言 | — | `model-context.js:138-262` |
| `model/llm/embed.js`/`embed-wiring.js` | OpenAI 兼容 embedding | recall/KB | **保留/适配** | AI SDK `embedding()` 标准路径 | Doubao multimodal 保留自定义 | 向量维度/签名 | 维度不一致 | 现有 | PR2 | `embed.js:29-95` |
| `model/agent/model-router.js` | 功能模型引用解析 | apps | **保留/适配** | ModelFactory | 返回 ref 而非 legacy provider | 引用语义不变 | 缓存 key 不带 apiKey | 现有 + 新 | PR2 | `model-router.js:28-73` |
| `model/vision/*` | 视觉子模型 | apps/媒体工具 | **保留/适配** | 独立 ModelFactory | 仍用 `VisionService`，后端换 AI SDK model | 媒体块格式 | video/audio 特殊块 | vision 83 断言 | PR2 | `vision/client.js` |

### 1.4 工具、安全、调度

| 当前路径与符号 | 当前职责 | 调用方/被调用方 | 处置 | 目标位置/原语 | 接线方式 | 数据兼容 | 风险 | 测试 | 阶段/依赖 | 证据 |
|---|---|---|---|---|---|---|---|---|---|---|
| `model/toolkit/define.js` | 工具 SDK/契约 | 第三方/内置 | **保留** | 不变 | Adapter 读取 | 无 | 默认 category fail-closed | `toolkit/test` | — | `define.js:23-70` |
| `model/toolkit/loader.js` | 扫描/加载工具包 | buildRuntime | **保留** | 不变 | Adapter 在加载后转换 | 无 | 动态 factory | `toolkit/test` | — | `loader.js:53-115` |
| `model/agent/tools/registry.js` | 注册/同名拒绝/检索/AOP | 全仓 | **保留** | 不变（Mastra 只做适配） | `ToolRegistry.list()` → Adapter | 无 | 工具名 sanitize | registry 17 断言 | PR3 | `registry.js:34-313` |
| `tool-scheduler.js` | 并发/资源锁/独占屏障 | Agent | **替换/保留** | Mastra `toolCallConcurrency` + 项目 resource lock | 先保留项目调度；Mastra 并发仅作上限 | 无 | 资源键语义无法直接映射 | scheduler 25 断言 + 新 | PR3/PR4 | `tool-scheduler.js:92-175` |
| `tool-schema.js` | AJV 校验 | Agent/Adapter | **保留** | 项目校验 | `jsonSchema(validate)` + 执行前复核 | 无 | 方言/编译失败 | schema 10 断言 | PR3 | `tool-schema.js:86-113` |
| `tool-fallback.js` | 失败分类/备选 | Agent | **保留** | 项目组件 | 失败结果富化 | 无 | 误判正文 `"error":` | fallback 48 断言 | PR3 | `tool-fallback.js` |
| `tool-effects.js` | effect/replay/idempotency | Agent/Adapter | **保留** | 项目组件 | Adapter 用于幂等/账本 | 无 | 默认 write/never | effects 8 断言 | PR3 | `tool-effects.js:17-32` |
| `policy.js` | RBAC | Agent | **保留** | 项目组件 | `requireApproval/beforeApproval` 调用 | 无 | 无 | policy 测试 | PR3 | `policy.js:28-97` |
| `guard.js` | 注入防御/边界 | Agent/工具 | **保留** | 项目组件 | 输入/工具结果继续过 | 无 | 无 | guard 39 断言 | — | `guard.js` |
| `confirm.js` | 审批等待 | Agent | **替换（legacy 保留）** | Mastra `requireApproval` + ApprovalBridge | 见 01 §10.3 | 旧 pending 不迁移（内存） | 重启/幂等 | 新审批测试 | PR4/PR5 | `confirm.js:8-93` |
| `runtime-scope.js` | 资源生命周期 | buildRuntime | **保留** | 项目组件 | 新增 storage/vector/memory disposer | 无 | 关闭顺序 | 23 断言 | PR1 | `runtime-scope.js:52-125` |

### 1.5 会话、记忆、压缩、存储

| 当前路径与符号 | 当前职责 | 调用方/被调用方 | 处置 | 目标位置/原语 | 接线方式 | 数据兼容 | 风险 | 测试 | 阶段/依赖 | 证据 |
|---|---|---|---|---|---|---|---|---|---|---|
| `session.js` `SessionStore` | 会话/多对话/KV | Agent/Web/commands | **Phase1 保留；Phase2 适配** | `memory-bridge.js` + Mastra Memory | Phase1 MessageAdapter 读写 Session；Phase2 Mastra 真源 + 只读适配 | 键/ID/消息 | 官方 ID 冒号、TTL、锁 | session 11 断言 + 新迁移 | PR4/PR5 | `session.js:14-443` |
| `memory/store.js` | MEMORY.md/USER.md | Agent/memory 工具/Web | **永久保留** | 项目组件 | 仍注入 user 尾部 | Markdown | 无 | 37 断言 | — | `memory/store.js:90-332` |
| `memory/index.js` | memory 工具/证据校验 | registry | **永久保留** | 项目组件 | 工具适配 | 返回结构 | 无 | 现有 | — | `memory/index.js:97-171` |
| `recall.js` | 长期记忆/时间衰减/MMR/纠错 | Agent/工具/Web | **永久保留** | 项目组件 | 不改 | KV | 与 Mastra semanticRecall 去重 | recall 36 断言 | — | `recall.js:155-556` |
| `memory/profile.js` | 用户画像 | Agent/Web | **永久保留** | 项目组件 | 不改；不映射 Working Memory | KV | 群共享混合 | profile 37 断言 | — | `profile.js:67-365` |
| `knowledge.js` + `vector-*` | KB/RAG/向量 | 工具/Web | **永久保留** | 项目组件；Mastra Vector 仅新场景 | KB 不迁入 Mastra Memory | KV+bin | 全局共享/维度 | 25/45 断言 | — | `knowledge.js:68-484` |
| `compact/*` + `context_recall` | 无损压缩/归档 | Agent/工具 | **永久保留** | 项目组件 | Phase1/2 都不替换 | 文件/ledger | 极高 | 114 断言 | — | `compact/index.js:305-453` |
| `task-store.js` | 可恢复任务账本 | Agent/apps/Web | **永久保留** | 项目组件 | Workflow 只写投影 | sqlite | 双状态真源 | 89 断言 | PR6 | `task-store.js:122-519` |
| `schedule.js` | 提醒/定时任务 | apps/工具 | **永久保留** | 项目组件 | 不换 Mastra Schedules | KV | 重启恢复 | 现有 | — | `schedule.js:11-181` |
| 新增 Storage/Vector | Mastra 持久化 | Mastra Memory/Workflow | **新增** | `storage-factory.js` | 见 01 §8 | 新库 | 路径/迁移/关闭 | 新 storage 测试 | PR1/PR5 | — |

### 1.6 扩展能力与观测

| 当前路径与符号 | 当前职责 | 调用方/被调用方 | 处置 | 目标位置/原语 | 接线方式 | 数据兼容 | 风险 | 测试 | 阶段/依赖 | 证据 |
|---|---|---|---|---|---|---|---|---|---|---|
| `model/mcp/*` | MCP 客户端/桥 | buildRuntime | **保留** | 项目组件 | 工具仍进 ToolRegistry→Adapter | 无 | `@mastra/mcp` 不引入 | mcp 89 断言 | PR7 评估 | `mcp/bridge.js:50-108` |
| `model/multiagent/*` | 子 Agent/编排 | 工具 | **保留/适配** | 先保留；PR7 评估 Mastra subagents | 子 Agent 可走同一 Facade（legacy/mastra 各自） | 任务表 | 隔离/预算/回推 | 684 行测试 | PR7 | `multiagent/subagent.js` |
| `model/toolEvo/*` | 工具进化 | 命令/Web | **保留/Workflow 化** | Workflow 编排 + 现有 DB | PR6 先 deep research，再 toolEvo | sqlite | 审批/回滚 | 多文件测试 | PR6 | `toolEvo/lifecycle.js:18-44` |
| `model/research/*` | 深度研究 | `#研究` | **保留/Workflow 化** | `workflows/deep-research.js` | PR6 | 报告格式 | 预算/阶段 | research 测试 | PR6 | `research/deep-research.js:54-185` |
| `apps/agent.js` DeveloperLog/UsageStats | 观测 | 全链路 | **适配** | `observability.js` | Mastra usage/steps → 现有字段 | 现有 KV/日志 | 缓存字段缺失 | usage 72 断言 | PR4 | `usage-stats.js:107-133` |
| `model/agent/trace/events.js` | trace 字段 | Agent/devLog | **保留** | 项目组件 | 新增 mastra 事件字段 | 无 | 字段漂移 | 现有 | PR4 | `trace/events.js` |
| `apps/agent.js` ReplySender/streamer | 交付/节流/流式 | `_handleAgent` | **保留** | 不变 | Mastra chunks 映射到既有回调 | 无 | 重复/缺片 | `stream-send-accounting` | PR4 | `reply-sender.js` |

### 1.7 测试与脚本

| 当前路径 | 职责 | 处置 | 目标 | 阶段 |
|---|---|---|---|---|
| `scripts/run-tests.mjs` | 离线路由/跳过 | 保留；新增 mastra 测试发现 | 不变 | PR0 |
| `stress/e2e/hooks.mjs` | Yunzai/Config/agent 桩 | 适配：新增 Mastra 运行时桩/真实入口开关 | 保持 legacy 测试可跑 | PR0/PR4 |
| `stress/e2e/agent-*.mjs` | 入口接线 | 保留；新增 mastra 版本 | 双引擎跑同一断言 | PR4 |
| `stress/real/*` | 真实 Provider | 保留 skip；新增 mastra 真实 smoke | 无 Key 自动跳过 | PR2/PR4 |
| `model/agent/test.mjs` | Agent 综合 | 保留 legacy；新增 `model/runtime/*.test.mjs` | 不删旧测试 | PR0+ |

---

## 2. 删除清单

### 2.1 第一批可安全删除（不早于 PR4，且需单独 PR）

严格说，**没有业务代码可以在 PR0–PR3 安全删除**。以下只是候选，删除前必须 `grep` 确认无调用、测试已迁移：

| 候选 | 理由 | 前置 |
|---|---|---|
| `OpenAIClient.post()` / `AnthropicClient.post()` | 无调用者（provider 审计确认） | grep + 测试 |
| `Agent._compactMessages(maxTokens)` | 标注 deprecated，仅测试/旧调用 | 测试改用 `_hysteresisPressure` |
| `SessionStore.deleteConversation` | 无 app/API 调用（仅测试） | 明确产品是否需要删除对话 |
| `model/agent/tools/index.js` 的测试辅助导出 `makeFailingTool` | 生产不需要 | 测试改用本地 fixture |

这些删除与 Mastra 无关，收益低；**建议合并到 PR8 清理**，避免在迁移期增加变量。

### 2.2 只有 legacy 下线后才能删除

| 路径 | 删除条件 |
|---|---|
| `model/agent/Agent.js` | mastra 100% 灰度 + 观察期 + parity/soak 通过；`#继续任务`/`#恢复任务` 已适配 |
| `model/openai/*`、`model/anthropic/*` | AI SDK 覆盖全部生产 preset；Gemini 已决定 |
| `model/agent/provider/*` | 同上；legacy 不再被任何入口引用 |
| `model/agent/loop-governor.js` | Mastra stopWhen/Processor 证明等价，且 token/time 预算/重复检测有替代 |
| `model/agent/confirm.js` | ApprovalBridge 持久化/恢复/防重通过；旧 pending 不再存在 |
| `model/agent/tool-scheduler.js` | Mastra 并发 + 项目资源锁已覆盖；资源键语义有测试 |
| `model/agent/compact/*` | **不建议删除**；即使 Mastra Memory 接管，也应保留无损归档/context_recall |
| `model/agent/session.js` | **不建议删除**；Phase 2 后作为兼容读/迁移源保留至少一个发布周期 |

### 2.3 永久保留的项目业务代码

- `ctxOf`/`installMasterGate`/`safeScopePart`/官方 ID 语义。
- `MemoryStore`（MEMORY.md/USER.md）+ 证据校验 + 注入扫描。
- `RecallStore` + `ProfileStore`（时间衰减/MMR/纠错/画像）。
- `KnowledgeStore` + 本地向量后端。
- `CompactionArchive` + `context_recall` + ledger。
- `TaskStore` + `ScheduleStore` + `ReplySender` + 回复渲染。
- `ToolRegistry` + `defineTool` + `tool-schema` + `tool-effects` + `tool-fallback`。
- `model/mcp`、`model/multiagent`、`model/toolEvo`、`model/research`、`model/persona`、`model/skill`。
- `model/web` + `web/` 面板。
- `utils/Config`、`utils/DevLog`、`UsageStats`。

---

## 3. 新增文件建议树

```text
model/runtime/
  facade.js
  factory.js
  mastra-runtime.js
  model-factory.js
  storage-factory.js
  message-adapter.js
  tool-adapter.js
  tool-hooks.js
  identity.js
  approval-bridge.js
  memory-bridge.js
  observability.js
  errors.js
model/runtime/workflows/
  deep-research.js
  tool-evolution.js
  persona-completion.js
model/runtime/schemas/
  config.js
  identity.js
  workflow.js
model/runtime/test/
  facade.test.mjs
  model-factory.test.mjs
  tool-adapter.test.mjs
  message-adapter.test.mjs
  identity.test.mjs
  approval-bridge.test.mjs
  storage.test.mjs
  parity.test.mjs
scripts/
  migrate-mastra.mjs
  mastra-smoke.mjs
stress/e2e/
  agent-mastra-wiring.mjs
  approval-restart.mjs
  memory-restart.mjs
```

---

## 4. PR0–PR9 计划

### PR0 · 基线与契约测试

**目标**：固化现有行为，补关键缺口；不改运行时。

- 非目标：不引入 Mastra 依赖、不改 `Agent`。
- 修改文件：`docs/refactor/mastra/*`（本任务）；新增测试 fixture/harness 可在 PR0 实施时加。
- 接口变化：无。
- 配置变化：无。
- 测试：
  - 复跑现有 159 文件（147/0/12，7230 断言）作为基线。
  - 新增：官方 ID 含 `:` 的 session list/clear 测试（先暴露缺陷，不修）。
  - 新增：运行结果快照（content/stopReason/turns/usage 字段）fixture。
  - 新增：工具名 sanitize/63 字符冲突测试（仅测试设计，不接线）。
  - 新增：审批 pending 的内存语义/重启丢失测试（记录现状）。
- 灰度：无。
- 回滚：文档/测试变更可直接 revert。
- 完成标准：基线可重复；新增测试明确标记“预期失败/现状记录”，不混入现有绿灯。
- 风险：把既有缺陷写成“必须保持”的契约；需在测试里标注 `KNOWN-BUG`，迁移时修正。
- 复杂度：S–M。

### PR1 · 依赖与运行时骨架

**目标**：加依赖、Storage/Model/Mastra Factory、Facade 接口、legacy 默认开关；不接生产流量。

- 非目标：不替换 Agent、不改 apps 主链路、不迁移数据。
- 修改文件：`package.json`、`pnpm-lock.yaml`、`config/default_config/config.yaml`、`utils/Config.js`、新增 `model/runtime/*`、`model/runtime/schemas/config.js`、测试。
- 依赖：`@mastra/core@1.85.0`、`@mastra/memory@1.41.2`、`@mastra/libsql@1.31.1`、`@mastra/pg@1.37.0`、`ai@7.0.177`、`@ai-sdk/openai@4.0.121`、`@ai-sdk/anthropic@4.0.106`、`@ai-sdk/google@4.0.122`；`zod` 升 `^3.25.76`；`zod-stagehand` 保持。
- 接口：`AgentRuntimeFacade`、`createStorage`、`createMastraRuntime`、`createModelFactory`。
- 配置：新增 `agent.runtime.*`/`agent.mastra.*`，默认 `engine: legacy`。
- 测试：
  - Zod 配置 schema/迁移/默认值。
  - LibSQL `file:` 绝对路径、`:memory:` 单测、重启持久化（临时目录）。
  - Postgres 测试默认 skip（需要 `MASTRA_TEST_DATABASE_URL`）。
  - `new Mastra` 在 ESM 下创建/关闭；无网络。
- 灰度：不接流量。
- 回滚：删依赖/字段；legacy 默认不变。
- 完成标准：`pnpm test` 全绿；启动时延增量 < 可接受阈值（记录，不承诺）。
- 风险：Zod 升级、Mastra 大依赖、Node 版本。
- 复杂度：M。

### PR2 · AI SDK Model Factory

**目标**：主模型/utility/fallback/embedding parity；Gemini 先 Spike。

- 非目标：不替换 Agent 循环；不改工具。
- 修改文件：`model/runtime/model-factory.js`、`model/llm/thinking.js`（映射）、`model/llm/embed-wiring.js`、`model/vision/*`（适配）、测试。
- 接口：`resolveModel(ref) -> AI SDK model`；`resolveFallbacks()`；`buildEmbedding()`。
- 配置：复用现有 providerId/modelId/fallbackModels/utilityModel；不加第二套。
- 测试：
  - 13 个 OpenAI preset + 8 个 Anthropic preset 的 baseURL/header/body 断言（用 mock fetch 捕获）。
  - thinking 参数映射快照（各 style）。
  - fallback 错误范围/usage（mock provider）。
  - Gemini Spike：真实 Key 手动/CI skip；记录结果。
- 灰度：`agent.runtime.engine=mastra` 且仅模型层可独立测试；生产仍 legacy。
- 回滚：ModelFactory 不被主链路引用即可。
- 完成标准：OpenAI/Anthropic 的消息/工具/usage/finish 与 legacy 对同一 mock fixture 等价；Gemini 未通过则明确标记 legacy-only。
- 风险：自定义厂商字段、Anthropic thinking signature、Gemini API 面、代理。
- 复杂度：L。

### PR3 · Tool Adapter（先只读，再审批写）

**目标**：LegacyTool → Mastra Tool；保持名称/参数/返回/权限/账本/截断。

- 非目标：不切换主 Agent；不改工具实现。
- 修改文件：`model/runtime/tool-adapter.js`、`tool-hooks.js`、`identity.js`、测试。
- 接口：`adaptTool(legacy, deps)`、`ToolNameMap`、`executeWithGuards`。
- 配置：`agent.mastra.tools.nameStrategy`。
- 测试：
  - 参数 JSON Schema（draft-07/2019/2020）→ `jsonSchema` 校验；非法参数结构化错误。
  - 名称 sanitize/冲突/63 字符/中文。
  - 只读工具：成功/失败/截断/注入标注。
  - 写工具：requireApproval/beforeApproval/deny/approve/decline/masterSkipConfirm。
  - TaskStore planned/started/result/幂等/effect_unknown。
- 灰度：测试内直接调用 Mastra Tool；不进主链路。
- 回滚：Adapter 不被引用。
- 完成标准：工具名/返回结构/权限决策与 legacy 对同一 fixture 等价；写工具不重复执行。
- 风险：Mastra createTool 签名、工具名、审批语义、输出校验。
- 复杂度：L。

### PR4 · Mastra Agent 主链路（小范围灰度）

**目标**：Facade 接 `apps/agent.js`，流式/取消/终止/usage/日志/回复桥接；默认 legacy，按用户/群灰度。

- 非目标：不迁移 Memory/Storage 历史；不换 Workflow；不删 legacy。
- 修改文件：`apps/agent.js`、`model/runtime/facade.js`、`mastra-runtime.js`、`message-adapter.js`、`observability.js`、`tool-hooks.js`、测试/E2E。
- 接口：`runChat/streamChat/abort/close`；`LegacyAgentHandle` 兼容。
- 配置：`runtime.engine`、`gray.*`、`approval.*`。
- 测试：
  - 同一 fixture 下 legacy/mastra 的工具参数、调用顺序、权限、stopReason、usage 字段。
  - 流式：text/tool/abort/error/重复文本/回复顺序。
  - 取消：在途模型/工具/审批。
  - 空输出/超时/最大步数/finalizer。
  - 审批：批准/拒绝/取消/超时/同进程恢复。
  - E2E：真实 `apps/agent.js` + 桩 Provider/Tool。
- 灰度：`gray.users` 1 个测试账号 → 1 个群 → 5% → 25%。
- 回滚：配置改回 legacy；在途 run 取消；不重放写工具。
- 完成标准：灰度范围无 P0/P1 回归；停止原因/回复/usage 可对账；回滚演练通过。
- 风险：最高；finalizer/反思/流式/审批。
- 复杂度：XL（可拆 4a 非流式、4b 流式、4c 审批）。

### PR5 · Memory 与 Storage（LibSQL/Postgres）

**目标**：Mastra Memory 接管消息历史；SessionStore 迁移/兼容；跨重启/隔离/压缩。

- 非目标：不替换 MEMORY.md/Recall/Profile/KB；不启用 Observational Memory。
- 修改文件：`model/runtime/memory-bridge.js`、`identity.js`、`storage-factory.js`、`session.js`（适配）、`model/web/api.js`（读适配）、`scripts/migrate-mastra.mjs`、测试。
- 接口：`loadThread/saveThread/listThreads/deleteThread`；`SessionAdapter`。
- 配置：`agent.mastra.memory.mode`、`lastMessages`、`semanticRecall`。
- 数据：先 dry-run/备份/数量/哈希；旧 KV 只读保留。
- 测试：
  - thread/resource 确定性/冲突/长度/官方 ID。
  - 多轮/多 conversation/切换/删除/群共享/私聊/跨群/跨 bot。
  - 重启恢复/并发写/TTL/遗忘/导出。
  - LibSQL 文件 + Postgres（skip 无 DSN）。
  - 压缩：压缩前后 messages/ledger/archive 可恢复。
- 灰度：先新会话 → 迁移会话 → 全量。
- 回滚：切回 `history-adapter`；旧 KV 未删；Mastra 新数据保留但不再写。
- 完成标准：历史条数/抽样 hash/顺序/工具配对一致；Web `/sessions` 可读；无重复消息。
- 风险：Memory API 覆写/压缩、thread owner、双写。
- 复杂度：XL。

### PR6 · 确定性 Workflows

**目标**：深度研究 → 工具进化（→ 人设补齐 P2）。

- 非目标：不包普通聊天；不替换 ScheduleStore/TaskStore。
- 修改文件：`model/runtime/workflows/*`、`apps/research.js`、`model/toolEvo/*`（接线）、`model/web/api.js`（审批）、测试。
- 接口：`runResearchWorkflow`、`resumeWorkflow`、`getWorkflowStatus`。
- 配置：`agent.mastra.workflows.*`。
- 测试：阶段顺序/并行/失败重试/suspend/resume/重启/幂等/双状态对账。
- 灰度：`#研究` 先 1 个群；工具进化先 dry-run。
- 回滚：切回类编排；Workflow run 取消/保留 snapshot。
- 完成标准：报告/工具版本与旧路径一致；审批唯一；TaskStore 投影一致。
- 风险：状态双真源、副作用重放。
- 复杂度：L。

### PR7 · 外围能力 parity

**目标**：MCP、子 Agent、多模态、定时、研究、工具进化、Web 面板逐项 parity。

- 非目标：不引入 `@mastra/mcp`（除非 Zod 4 决策）。
- 修改文件：按 parity 缺口，优先 `multiagent`、`vision`、`mcp`、`web`。
- 测试：现有外围测试 + 新 mastra 版本。
- 灰度：与主链路同范围。
- 回滚：功能级开关。
- 完成标准：00 §4 功能清单逐项签字；无未说明删减。
- 风险：范围蔓延。
- 复杂度：L。

### PR8 · 全量灰度与 legacy 下线

**目标**：100% mastra、soak、数据核对、回滚演练后删除旧内核。

- 前置：PR0–PR7 DoD；观察期（建议 ≥2 周或 ≥1 个发布周期）。
- 删除：见 §2.2；分多个小 PR，不一次性删。
- 测试：全量 + 迁移 + 隔离 + 恢复 + 性能。
- 回滚：保留 legacy 分支/tag；数据回滚脚本。
- 完成标准：见 §6。
- 风险：不可逆；必须先备份。
- 复杂度：L。

### PR9 · 文档与运维收尾

**目标**：配置/部署/排障/扩展/升级指南；清理临时开关。

- 修改：`docs/*`、`README`、`docs/changelog.md`、`AGENTS.md`。
- 测试：文档命令可执行；链接检查。
- 完成标准：新开发者按 03 可跑通；运维按 04 可迁移/回滚。
- 复杂度：S–M。

---

## 5. 灰度与回滚设计

### 5.1 开关

```yaml
agent.runtime.engine: legacy | mastra
agent.runtime.gray.users: []
agent.runtime.gray.groups: []
agent.runtime.gray.percent: 0
agent.runtime.shadow.enable: false
```

选择顺序：

1. 显式 `engine=mastra` + 用户/群命中 → mastra。
2. `engine=legacy` → legacy。
3. `engine=mastra` 但未命中灰度 → legacy。
4. 稳定哈希 `sha256(scopeKey) % 100 < percent`。

### 5.2 回退边界

- **允许自动回退**：构建失败、模型解析失败、Mastra 初始化失败、在**任何工具执行前**失败。
- **禁止自动回退**：任何工具已执行（`tool_started` 或 `effect != read`）；审批已通过；Workflow 已产生副作用。此时返回 `run_error`/`paused`，由 TaskStore 恢复/人工处理。
- **Shadow**：只允许 `effect=read && replay=safe` 且不在 `MCP/未知工具` 白名单里的工具；不发送 shadow 回复；只记录 diff。默认关闭。
- **双跑禁止**：同一 taskId 不能同时注册 legacy 与 mastra；Facade 用 `_activeRuns` 唯一键。

### 5.3 回滚步骤

1. 配置 `engine=legacy`（热加载）。
2. `facade.abortAll()` 取消在途 mastra run；等待 settle。
3. 不删除 Mastra 数据；标记 `mastra_epoch`/`rolled_back_at`。
4. legacy 继续读旧 SessionStore/KV；若 PR5 已迁移，按 04 的只读回退策略。
5. 核对最近 N 条回复/任务/审批，确认无重复副作用。

---

## 6. legacy 退出条件（Definition of Done）

- 所有现有测试 + 新增 parity/迁移/隔离/恢复测试通过。
- 00 §4 功能清单逐项“保留/替换/适配/延期”签字；无未说明删减。
- 灰度 100% 至少一个观察期；无 P0/P1 事故。
- 旧配置/数据有可执行迁移与回滚；dry-run/幂等/可审计。
- LibSQL 与 Postgres 都验证；重启/断电/并发/多进程边界明确。
- 审批/取消/热重载/重启不丢状态、不重复副作用。
- 跨群/跨用户/跨 bot/官方 ID 隔离测试通过。
- Web 面板/DevLog 能定位新链路问题；Mastra Studio 不是唯一手段。
- 性能基线有对比；无法比较的指标说明原因。
- 回滚演练完成，且回滚不会重复执行工具或抹掉新数据。
- 旧内核删除后保留 tag/分支与回滚文档；观察期内可重新启用 legacy。

---

## 7. 行为差异与待确认项

### 7.1 已知会变化的行为（需产品确认）

1. **流式默认值**：Mastra 接入后是否开启逐字流？现有生产关闭（`AGENTS_STREAM_TEST`）。建议先保持关闭，灰度再开。
2. **审批持久化**：重启后 pending 不再丢失；超时/过期策略可能与旧“内存丢失”不同。
3. **工具名**：中文/超长工具名会被 sanitize；模型看到的名称可能变化。
4. **Memory Phase 2**：会话历史的 TTL/窗口/压缩落盘方式可能变化；必须保持“永不过期/首条意图保留/工具配对”。
5. **Semantic Recall**：默认关闭，因此不会新增“跨会话消息级召回”；如果产品期望，需要单独开。
6. **Workflow 交付**：深度研究可能从“同步长任务”变成“可暂停/恢复”，用户可见进度/通知会变化。
7. **错误文案**：Mastra/AI SDK 错误归一后可能与旧文案不同；需保留 `STOP_REASON_CN` 和可读原因。
8. **Gemini**：若 Spike 不通过，Gemini 继续 legacy，形成“双 Provider 栈”过渡；必须在 PR8 前决定。

### 7.2 待人工决策

| # | 决策 | 推荐 | 影响 |
|---|---|---|---|
| D1 | JS + JSDoc vs 全量 TS | **JS + JSDoc**（ADR-001） | 构建/Yunzai 加载/开发体验 |
| D2 | Phase 2 是否让 Mastra Memory 接管历史 | **先 Phase 1，PR5 验证后再决定** | 压缩/迁移/Web |
| D3 | 是否启用 Mastra Semantic Recall | **默认否** | 成本/去重/隔离 |
| D4 | 是否用 Observational Memory | **否**（无损契约） | 压缩语义 |
| D5 | 是否引入 `@mastra/mcp` | **暂否**（Zod 4.2 peer） | MCP 迁移成本 |
| D6 | 是否用 Mastra Schedules | **否**（保留 ScheduleStore） | 重启/所有权 |
| D7 | 是否把 TaskStore 迁到 Mastra storage | **否**（保留 sqlite，Workflow 只投影） | 恢复/命令/API |
| D8 | 是否把子 Agent 改为 Mastra subagents | **PR7 评估** | 隔离/预算/回推 |
| D9 | 是否修 `#qqbot*` 权限门/`#知识库列表`/`#人设详情` | **建议修**（独立安全 PR） | 既有风险 |
| D10 | 是否补 `undici` 让 `agent.proxy` 生效 | **建议补** | 海外 Provider |
| D11 | 生产是否多进程 | **需确认**；多进程必须 Postgres/共享存储 | 锁/DB |
| D12 | 观察期长度 | 建议 ≥2 周或 ≥1 发布周期 | 下线时间 |

---

## 8. 主要风险与缓解

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| AI SDK 无法等价映射厂商自定义 thinking/body | 高 | 高 | PR2 逐 preset mock + 真实 Key；不支持则 legacy-only |
| Anthropic thinking signature/cache 丢失 | 中高 | 高 | MessageAdapter 保留 provider_native；真实 Key spike；失败则 Anthropic thinking 暂不切 |
| Gemini Interactions 语义不兼容 | 高 | 中高 | 单独 Spike；不通过则保留 legacy Gemini |
| 工具名 sanitize 导致历史/统计/审批错位 | 中 | 高 | 显式 NameMap；历史双向映射；冲突测试 |
| 审批恢复重复执行写工具 | 中 | 极高 | runId+toolCallId 幂等；TaskStore effectState；effect_unknown 拒绝 |
| Memory 双写/压缩冲突 | 中高 | 高 | Phase 1 不启用 Memory；Phase 2 单写；压缩先验证 |
| 官方 ID 冒号导致 scope 错误 | 高（既有） | 高 | 迁移前修 list/clear；thread/resource 只用 safeScopePart |
| 热重载旧 storage 复活/连接泄漏 | 中 | 高 | generation + closing barrier；close 顺序；health |
| Postgres 权限/迁移失败 | 中 | 高 | 部署前 `init()`；备份；dry-run；回滚 |
| 大依赖导致启动/内存上升 | 中 | 中 | 按需 import；健康/启动基线；不阻塞插件扫描 |
| 测试只覆盖 mock，真实 Provider 偏差 | 高 | 中高 | 真实 Key 手动/定时；记录版本/日期；无 Key skip |
| 范围蔓延（Web/研究/MCP 全改） | 高 | 中 | PR 边界；Facade 优先；非必要不改端点 |
| 工具并发回归（Mastra 默认 fan-out） | 中高 | 高 | 保留项目 `ToolScheduler`（生产 maxParallel=4，默认 exclusive）；资源键串行；补测试 |
| 工具无硬超时，忽略 signal 阻塞独占屏障 | 中 | 高 | Adapter `Promise.race` 硬超时；写工具超时记 `effect_unknown`，不重试 |
| MCP stdio 继承完整 env / 无 AbortSignal | 中高 | 高 | 独立安全 PR：最小 env、signal、分页、list_changed；默认 `system` 不放宽 |
| 子 Agent 无 policy/confirm/governor，配额按会话、extend 无总上限 | 高（既有） | 中高 | PR7 补 worker 预算/总上限；保持 query-only/无写工具 |
| ToolEvo 采纳时名称竞态覆盖 built-in/MCP | 中 | 高 | 采纳/回滚前重查名称；冲突拒绝；补测试 |

---

## 9. 依赖顺序（关键路径）

```
PR0 基线
  → PR1 依赖/Storage/Facade 骨架
    → PR2 ModelFactory（OpenAI/Anthropic；Gemini spike）
    → PR3 ToolAdapter（只读 → 审批写）
      → PR4 Agent 主链路（非流式 → 流式 → 审批）
        → PR5 Memory/Storage（Phase 1 → Phase 2）
          → PR6 Workflows（research → toolEvo）
            → PR7 外围 parity
              → PR8 全量/下线
                → PR9 文档收尾
```

PR2 与 PR3 可并行（不同文件），但 PR4 依赖两者。PR5 的 Phase 2 依赖 PR4 稳定；PR6 可与 PR5 并行，但 Workflow 的审批复用 PR4 的 ApprovalBridge。

---

## 10. 第一个实施 PR 建议

**PR0**：先补契约/基线，不改运行时。执行排期、分工和第一迭代任务见 [07-development-plan.md](07-development-plan.md)。理由：

- 现有 147 文件通过，但缺少官方 ID、审批重启、工具名、运行结果快照等关键契约；这些恰是 Mastra 迁移最容易破坏的点。
- PR0 能让后续每个 PR 都有“是否退化”的硬证据，避免“功能跑通但语义变了”。
- PR0 复杂度低、可逆、不引入依赖，适合作为人工评审后的第一个实施 PR。

---

## 11. Spike 设计与最小验证

> 所有 Spike 都在独立分支/临时目录进行，不接生产流量；每个 Spike 产出一页结果（版本/命令/日志/结论），失败也要记录。不得把 Spike 代码直接合入主链路。

### S1 · 嵌入式 Mastra 从现有插件进程调用

- **目的**：证明 `new Mastra()` 可在 Yunzai ESM 进程内创建/关闭，不阻塞插件扫描、不新增端口。
- **最小步骤**：
  1. 在 `model/runtime/test/` 建独立脚本，`import { Mastra } from '@mastra/core'`。
  2. 创建一个无工具、无 memory 的 `Agent`，`model` 用 mock LanguageModel（不发网络）。
  3. `new Mastra({ agents: { smoke } })` → `getAgent('smoke').generate('hi')` → `mastra` 无 `close()` 时用 storage 关闭。
  4. 测量 import 时间、构建时间、进程退出是否挂起。
- **预期**：生成返回文本；进程正常退出；无额外监听端口；`RuntimeScope.openCount` 可归零。
- **失败判据**：import 阻塞 >2s、进程不退出、创建 Hono/端口、必须 `mastra dev`。
- **回滚**：删除脚本/依赖；legacy 不受影响。
- **示例**：

```js
import { Mastra } from '@mastra/core'
import { Agent } from '@mastra/core/agent'

const agent = new Agent({ id: 'smoke', name: 'smoke', instructions: 'echo', model: mockModel })
const mastra = new Mastra({ agents: { smoke: agent }, logger: false })
const out = await mastra.getAgent('smoke').generate('hi')
console.log(out.text)
```

### S2 · AI SDK Provider 连接现有 OpenAI-compatible / Anthropic / Gemini 配置

- **目的**：验证 `providerId/modelId` + `protocol/preset/baseURL/apiKey` 能解析为可用的 AI SDK model，且 baseURL/headers/proxy/thinking 行为可控。
- **最小步骤**：
  1. 用 `createOpenAI({ baseURL, apiKey, fetch: mockFetch }).chat(model)`，mock fetch 捕获 URL/body/headers。
  2. 对每个生产 preset 跑一遍，记录实际 URL/body；对比 legacy `provider/*` 的 body。
  3. Anthropic：`createAnthropic({baseURL,apiKey})(model)`；捕获 `thinking`/`cache_control`。
  4. Gemini：先用真实 Key 手动跑一次 `generate`/`stream`；无 Key 则标记未验证。
- **预期**：OpenAI-compatible `/chat/completions`；Anthropic `/v1/messages`；Gemini 与现有 Interactions 语义一致或明确差异。
- **失败判据**：baseURL 被忽略、鉴权 header 错、thinking 字段丢失、工具 schema 被改写、usage 字段缺失。
- **回滚**：ModelFactory 不启用；legacy provider 继续。
- **示例**：

```js
import { createOpenAI } from '@ai-sdk/openai'
const provider = createOpenAI({ baseURL, apiKey, fetch: captureFetch })
const model = provider.chat('deepseek-chat')
```

### S3 · 只读工具 + 审批写工具适配

- **目的**：验证 `LegacyTool → createTool` 的名称/参数/返回/权限/审批/账本语义。
- **最小步骤**：
  1. 选 `web_search`（只读）与 `schedule_task`（`alwaysConfirm`）。
  2. 用 `jsonSchema(parameters)` 作为 `inputSchema`；`execute` 调 legacy `execute(params, ctx)`。
  3. 只读：Mastra `generate` 触发；比较结果字符串/截断。
  4. 写：`requireApproval`/`beforeApproval`；`generate` 返回 `finishReason:'suspended'`；`approveToolCallGenerate` 后执行一次；`decline` 不执行。
- **预期**：名称/参数/结果一致；写工具只执行一次；拒绝不执行。
- **失败判据**：`jsonSchema` 校验未生效、名称被 sanitize 后找不到、审批不触发、拒绝仍执行、结果被二次 JSON 编码。
- **回滚**：Adapter 不接主链路。
- **示例**：

```js
const t = createTool({
  id: 'schedule_task',
  inputSchema: jsonSchema(legacy.parameters),
  requireApproval: () => true,
  execute: (input, ctx) => legacy.execute(input, readCtx(ctx)),
})
```

### S4 · 流式文本/工具/usage/错误/abort/maxSteps

- **目的**：验证 `agent.stream().fullStream` 能映射到现有 `onDelta/onToolStart/onToolEnd`，且取消/错误/步数可控。
- **最小步骤**：
  1. mock model 产出 `text-delta` → `tool-call` → `tool-result` → `text-delta` → `finish`。
  2. 收集 chunk 类型/顺序；映射到统一事件。
  3. `abortSignal` 在第 2 个 chunk 后 abort；确认 `abort`/异常；无迟到回调。
  4. `maxSteps:2` 触发停止；确认 `finishReason`/usage。
- **预期**：文本拼接=最终文本；工具事件一次；abort 及时；usage 合并。
- **失败判据**：chunk 名称不符、工具事件重复、abort 后仍回调、usage 丢失、narration 被当 final。
- **回滚**：流式保持关闭（现状）；先走非流式。
- **示例**：

```js
const stream = await agent.stream('q', { maxSteps: 4, abortSignal: ctl.signal })
for await (const chunk of stream.fullStream) {
  if (chunk.type === 'text-delta') onDelta(chunk.payload.text)
  if (chunk.type === 'tool-call') onToolStart(chunk.payload)
}
```

### S5 · LibSQL/Postgres Memory 跨重启保留 thread/resource

- **目的**：验证 thread/resource 创建、消息写入、重启后读取、owner 不可变。
- **最小步骤**：
  1. LibSQL 文件 `file:/tmp/.../mastra.db`；创建 Memory/Agent；`generate` 两轮。
  2. 关闭 storage；新进程重新打开；同一 thread/resource 读取历史。
  3. 尝试用不同 resource 打开同一 thread；确认报错。
  4. Postgres 用 `MASTRA_TEST_DATABASE_URL` 重复。
- **预期**：历史保留；顺序正确；owner 冲突报错；close 无挂起。
- **失败判据**：重启丢失、thread 自动换 owner、消息重复/乱序、close 后仍有写入。
- **回滚**：删除临时库；不接生产。
- **示例**：

```js
const memory = new Memory({ storage: new LibSQLStore({ id: 's', url: `file:${abs}` }), options: { lastMessages: 20 } })
await agent.generate('hi', { memory: { thread: 't1', resource: 'r1' } })
await memory.settled(); await storage.close()
```

### S6 · 审批/Workflow suspend/resume 持久化与重启恢复

- **目的**：验证 `finishReason:'suspended'`、`approveToolCall`/`declineToolCall`、`listSuspendedRuns`、snapshot 重启恢复。
- **最小步骤**：
  1. 写工具 `requireApproval:true`；`generate` 返回 suspended；记录 runId/toolCallId。
  2. 重启进程/重新创建 Mastra（同一 storage）；`listSuspendedRuns({threadId,resourceId})` 找到。
  3. `approveToolCallGenerate` 执行一次；重复批准返回失败。
  4. Workflow `suspend` 后 `run.resume({resumeData})`。
- **预期**：重启可发现；批准只执行一次；拒绝不执行；Workflow 恢复。
- **失败判据**：snapshot 丢失、runId 不可用、批准重复执行、恢复后 thread owner 错。
- **回滚**：ConfirmStore + 内存审批；Workflow 不上。
- **示例**：

```js
const out = await agent.generate('do it', { memory: { thread, resource } })
if (out.finishReason === 'suspended') {
  const runs = await agent.listSuspendedRuns({ threadId: thread, resourceId: resource })
  await agent.approveToolCallGenerate({ runId: runs.runs[0].runId, toolCallId: runs.runs[0].toolCalls[0].toolCallId })
}
```

### S7 · 配置热重载不泄漏旧 Agent/DB/MCP/定时器

- **目的**：验证 `invalidateRuntime` 风格重建不会泄漏旧 storage/vector/MCP/Workflow/定时器。
- **最小步骤**：
  1. 构建 → 运行 → 重建 10 次；记录 `RuntimeScope.openCount`、storage 连接、MCP 子进程、定时器数。
  2. 改 model/tool 配置；确认新请求用新配置，旧 run 被 abort。
  3. 关闭后 `process._getActiveHandles()`/health 无残留。
- **预期**：openCount 归零；无重复 MCP 工具/连接；无旧 build 复活；无定时器泄漏。
- **失败判据**：连接数增长、MCP 重复注册、旧配置继续生效、进程不退出。
- **回滚**：恢复旧 `invalidateRuntime`；不启用 Mastra。
- **示例**：

```js
for (let i = 0; i < 10; i++) { await build(); await facade.close('test') }
assert.equal(RuntimeScope.openCount, 0)
```

### S8 · Mastra Studio 仅作为可选开发工具

- **目的**：证明不启动 Server/Studio 也能完整运行；Studio 不改变生产拓扑。
- **最小步骤**：
  1. 生产路径只 `new Mastra()`，不 `mastra dev`；验证所有功能。
  2. 开发机另起 `mastra dev` 指向同一 LibSQL 绝对路径；确认可观察，但停掉 Studio 不影响插件。
  3. 检查无新增端口/依赖注入。
- **预期**：生产无 Studio 正常；Studio 仅读/观察；不成为唯一排障手段。
- **失败判据**：生产必须启动 Server；Studio 停掉后插件不可用；端口冲突。
- **回滚**：不安装 `mastra` CLI；仅库依赖。
- **示例**：见官方 `mastra dev` 文档；生产入口不引用 `mastra` 包。

### Spike 结果模板

```md
## S<N> 结果
- 日期/分支/commit：
- 依赖版本：
- 环境：Node/pnpm/OS/DB/Provider
- 命令：
- 结果：通过/失败
- 关键日志（脱敏）：
- 与 legacy 差异：
- 失败判据是否命中：
- 结论/后续：
- 回滚验证：
```
