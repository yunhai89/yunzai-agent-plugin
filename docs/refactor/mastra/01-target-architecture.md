# 01 · 目标架构与接线

> 本文是**目标设计**，不是已实现代码。除“现状”外，所有模块名、接口名、配置键均为拟议；实施时以锁定版本的 `@mastra/core`/`ai` 类型声明为准。
>
> 设计基线：commit `9323c5d` + [README](README.md#版本与兼容矩阵2026-11-20-核验) 中的依赖版本。Mastra API 已对照 2026-11-20 官方文档与 `@mastra/core@1.85.0` 包内 `.d.ts`/源码核验。

---

## 1. 目标与非目标

### 1.1 目标

1. 用 **Mastra Agent** 替换手写 ReAct 的“模型—工具循环”，用 **AI SDK** 作为 Mastra 的模型接入层，用 **Zod/Standard Schema** 统一边界校验。
2. 用 **Mastra Workflows** 承载确定性、多阶段、可暂停/恢复的流程（深度研究、工具进化审批等），不把普通聊天包成 Workflow。
3. 用 **LibSQL（本地默认）/ PostgreSQL（生产）** 持久化 Mastra 的 memory/workflow/observability 数据；现有 KV/文件数据按迁移方案逐步接管。
4. **保留外围契约**：Yunzai 事件、命令、回复、工具 SDK、配置真源、Web API、用户数据。
5. **可回退**：`legacy | mastra` 开关、按范围灰度、异常回退边界；默认 legacy，直到 parity 通过。
6. **不静默减功能**：多模型、工具、记忆、画像、KB、MCP、审批、RBAC、定时、子 Agent、多模态、流式、取消、压缩、Web 面板逐项保留/适配/延期。

### 1.2 非目标

- 不启动独立 Mastra Server/Hono 端口；不改变现有 Web 面板拓扑。
- 不把 `apps/agent.js` 的 71 条命令、Web 95 个端点重写成 Mastra 原生 API。
- 不一次性删除 `model/openai`/`model/anthropic`/`model/agent`；legacy 运行时保留到退出条件满足。
- 不把 Observational Memory 当作无损压缩的替代品；不默认启用 Semantic Recall。
- 不承诺性能提升；性能只以 05 文档的基线对比为准。
- 不做全量 TypeScript 迁移（见 ADR-001）。

---

## 2. 目标架构图

```
┌─────────────────────────────────────────────────────────────────────┐
│ Yunzai / Miao-Yunzai 进程                                            │
│                                                                     │
│  apps/agent.js  (事件/命令/回复编排，保持)                            │
│    ├─ onTrigger → _handleAgent                                      │
│    ├─ ctxOf / scope / permission / media / persona / perception     │
│    ├─ ReplySender / streamer / markdown / image / sticker / TTS      │
│    └─ runtime.runChat(...)  ← 只依赖 Facade，不 import Mastra 类型     │
│                                                                     │
│  model/runtime/  (新增：稳定 Facade + 工厂 + 适配器)                   │
│    ├─ AgentRuntimeFacade                                            │
│    ├─ RuntimeFactory (legacy | mastra)                              │
│    ├─ MastraRuntime (embedded)                                      │
│    ├─ ModelFactory (AI SDK providers)                               │
│    ├─ ToolAdapter (LegacyTool → Mastra Tool)                        │
│    ├─ MessageAdapter (legacy OpenAI-style ↔ AI SDK/Mastra)          │
│    ├─ MemoryBridge / Identity / ApprovalBridge                      │
│    ├─ StorageFactory (LibSQL / Postgres / Vector)                   │
│    └─ ObservabilityBridge (usage/trace/devLog)                      │
│                                                                     │
│  Mastra (embedded, 同进程)                                           │
│    ├─ Agent (dynamic instructions/tools/model, maxSteps/stopWhen)   │
│    ├─ Workflows (research/toolEvo/persona approval)                 │
│    ├─ Memory (message history; phase 2)                             │
│    ├─ Storage (LibSQL/Postgres)                                     │
│    └─ Vectors (LibSQLVector/PgVector, optional)                     │
│                                                                     │
│  项目业务层（永久保留）                                                │
│    ├─ model/agent/policy|guard|confirm|task-store|schedule|...      │
│    ├─ model/memory|recall|profile|knowledge|compact|...             │
│    ├─ model/toolkit|mcp|multiagent|toolEvo|research|...             │
│    └─ model/web + web/ (面板)                                       │
└─────────────────────────────────────────────────────────────────────┘
```

数据流（mastra 模式，Phase 1）：

```
QQ event → apps/agent.js
  → Facade.runChat({ input, ctx, taskId, signal, callbacks })
    → LegacyHistoryAdapter.load()  ← SessionStore (唯一真源)
    → ModelFactory.resolve()       ← 配置引用
    → Mastra Agent.generate/stream
       → ToolAdapter → LegacyTool.execute(params, ctx)
       → Policy/Guard/TaskStore/Reply hooks
    → LegacyHistoryAdapter.save()   ← SessionStore (唯一真源)
    → return {content, stopReason, turns, usage, runId}
  → apps 回复/统计/交付
```

Phase 2（Mastra Memory 接管历史）只把 `LegacyHistoryAdapter` 换成 `MastraMemoryAdapter`，上层 Facade 和 apps 不变。

---

## 3. Runtime 生命周期与 Facade

### 3.1 Facade 接口（目标设计）

文件：`model/runtime/facade.js`（新增）。**不导出 Mastra 类型**；只导出普通对象/JS 结构。

```js
/**
 * @typedef {Object} RuntimeRunInput
 * @property {string|{role:string,content:any}} input
 * @property {object} ctx                  // 现有 ctxOf() 产出，含 e/bot/role/scope
 * @property {string} taskId               // = 现有 traceId
 * @property {AbortSignal} [signal]
 * @property {boolean} [stream]
 * @property {object} [callbacks]          // onDelta/onReasoning/onToolStart/onToolEnd/onAssistant/...
 * @property {string} [systemPrompt]
 * @property {string} [context]
 * @property {boolean} [ephemeral]
 */

class AgentRuntimeFacade {
  constructor({ engine, legacy, mastra, config, logger, storage, approval }) {}

  /** 创建/获取按请求的 runner；内部可选择 legacy 或 mastra。 */
  forRequest({ ctx, taskId, overrides }) {}

  /** 非流式；返回与 Agent.run 兼容的结果。 */
  async runChat(input, opts) {}

  /** 流式；返回 { runId, events, result }；result 与非流式同形。 */
  async streamChat(input, opts) {}

  async abort(taskId) {}
  async approve(approvalId, decision, actor) {}
  async pendingApprovals({ scopeKey }) {}
  async health() {}
  async close(reason) {}
}
```

**兼容层**：保留 `rt.makeAgent()` 返回一个 `LegacyAgentHandle`，其 `.run()` 内部转到 `facade.runChat()`；这样 `apps/agent.js`、`apps/research.js`、`model/web/api.js` 可以在 PR4 前继续调用，不需要一次性改 95 个端点。最终把 `apps/agent.js` 的调用点改为 `rt.runtime.runChat()`，`makeAgent()` 仅作为 legacy 兼容。

### 3.2 创建/重建/关闭

| 对象 | 何时创建 | 配置变化时 | 关闭 |
|---|---|---|---|
| `StorageBundle`（LibSQL/PG + Vector） | 首次 runtime 构建，懒连接 | storage 配置不变则复用；变化则关闭旧 bundle | `memory.settled()` → `vector.close()` → `storage.close()` |
| `Mastra` 实例 | 首次构建 | 重建（agents/workflows 重新注册） | 无长期连接，依赖 storage 关闭 |
| `Memory` | Phase 2 启用时 | 重建（同一个 storage） | `await memory.settled()` |
| `Agent` | 每个请求或按配置缓存 | 重建（instructions/tools/model 变化） | 无连接；取消在途 run |
| `AI SDK Provider` | 每个厂商配置缓存 | API key/baseURL/headers 变化则重建 | 无状态 |
| `ToolAdapter` | 每个 runtime 构建 | 工具注册变化则重建 | 无状态（工具自身资源由 `RuntimeScope` 管） |
| `Workflow` | runtime 构建 | 重建 | `run.cancel()`/等待 settle |

**Generation 屏障**：沿用现有 `_runtimeGen` + `_closingPromise` 语义；`RuntimeFactory.build(gen)` 完成时若 `gen !== currentGen`，立即 `facade.close('stale_build')`，不得赋值给 `_runtime`。

**健康检查**：

```js
async health() {
  return {
    engine: 'mastra',
    ok: await storage.ping(),          // 目标设计：storage 适配器提供 ping；无则轻量 listThreads
    storage: { driver: 'libsql', path: '...' }, // 不返回 DSN/密码
    vector: { enabled: true, driver: 'libsql', dimensions: 1536 },
    runs: activeRuns.size,
    approvals: approval.pendingCount(),
    memory: memory ? await memory.getStatus?.() : null,
  }
}
```

### 3.3 最小初始化/调用/关闭示例（目标设计）

```js
// model/runtime/mastra-runtime.js（目标设计，非现有代码）
import { Mastra } from '@mastra/core'
import { Agent } from '@mastra/core/agent'
import { Memory } from '@mastra/memory'
import { RequestContext } from '@mastra/core/request-context'
import { stepCountIs } from 'ai' // 以锁定版本导出为准
import { createStorage, createVector } from './storage-factory.js'
import { createChatAgent, createResearchWorkflow } from './agents.js'

export async function createEmbeddedMastra({ cfg, storageCfg, vectorCfg, logger }) {
  const storage = createStorage(storageCfg)
  await storage.init()                         // disableInit=true 时由部署阶段执行
  const vector = createVector(vectorCfg)       // 可为 null

  const memory = cfg.mastra.memory.mode === 'mastra'
    ? new Memory({ storage, vector, embedder: vector ? cfg.mastra.embedder : undefined, options: { lastMessages: 400 } })
    : undefined

  const chat = createChatAgent({ cfg, memory })
  const mastra = new Mastra({
    agents: { chat },
    workflows: { deepResearch: createResearchWorkflow(cfg) },
    storage,
    vectors: vector ? { default: vector } : undefined,
    logger: logger ?? false,
  })

  async function close() {
    await memory?.settled?.()
    await vector?.close?.()
    await storage.close()
  }
  return { mastra, storage, vector, memory, close }
}
```

调用：

```js
const requestContext = new RequestContext()
requestContext.set('yz.ctx', ctx)                 // 不持久化，只在本请求内存中
requestContext.set('yz.taskId', taskId)

const out = await agent.generate(messages, {
  runId: taskId,                                  // = 现有 traceId
  abortSignal: signal,
  maxSteps: cfg.maxTurns,
  stopWhen: stepCountIs(cfg.maxTurns),            // 以安装版本导出为准；与 maxSteps 二选一/并用需 Spike
  memory: { thread: threadId, resource: resourceId }, // Phase 2；Phase 1 不传
  requestContext,
  modelSettings: {
    temperature,
    maxOutputTokens,
    timeout: { totalMs: 7200000, stepMs: 600000, firstChunkMs: 60000 }, // 目标值，按实际调
  },
  onStepFinish: (step) => observability.onStep(step),
})

// 流式替代
const stream = await agent.stream(messages, { /* 同上 */ })
for await (const chunk of stream.fullStream) {
  if (chunk.type === 'text-delta') callbacks.onDelta(chunk.payload.text)
  if (chunk.type === 'tool-call') callbacks.onToolStart(chunk.payload)
  if (chunk.type === 'tool-result') callbacks.onToolEnd(chunk.payload)
}
```

> `stopWhen`/`stepCountIs` 的导出位置和与 `maxSteps` 的叠加语义以锁定版本为准；Spike S4 必须验证。示例中的超时值是占位，不是产品承诺。

### 3.4 ID 对应关系

| 现有 ID | Mastra 对应 | 规则 |
|---|---|---|
| `taskId`（= `traceId` UUID） | `runId` | 直接传 UUID；`tracingOptions.traceId` 用去掉 `-` 的 32 位 hex |
| `conversationId`（数字字符串） | `threadId` 的一部分 | `threadId = yz_<adapter>_<botId>_<safeScopeId>_c<conversationId>` |
| `scopeUserId`/`scopeId` | `resourceId` | `resourceId = yz_<adapter>_<botId>_<safeScopeId>` |
| `ConfirmStore` 的 4 位 id | `approvalId` | 新的持久化短 id，映射到 `{runId, toolCallId}` |
| 子 Agent `childTaskId` | 子 runId / 临时 thread | 默认不共享父 thread；需要共享时显式传 |
| 定时任务 | 独立 thread | `conversationId=null` → `threadId=..._scheduled`，避免污染交互会话 |

**不变量**：

- `threadId` 创建后 owner（`resourceId`）不可变；同一 `threadId` 换 resource 会报错（Mastra 文档明确）。
- 所有 ID 只含 `[A-Za-z0-9_-]`，长度 ≤128；`safeScopePart` 已对官方 ID 做净化+短哈希，直接复用。
- `runId` 必须全局唯一；同一 `taskId` 不允许并发两次 run。
- `approvalId` 只映射一次；批准/拒绝是 CAS（`pending → resolving`）。

### 3.5 非流式/流式/取消/错误归一

```js
// 目标设计
async runChat(input, opts) {
  const runner = this.forRequest(opts)
  const signal = opts.signal
  const result = await runner.agent.generate(runner.messages, {
    runId: opts.taskId,
    abortSignal: signal,
    maxSteps: runner.maxSteps,
    stopWhen: runner.stopWhen,
    modelSettings: runner.modelSettings,
    providerOptions: runner.providerOptions,
    requestContext: runner.requestContext,
    onStepFinish: (step) => this.observability.onStep(step, opts),
    hooks: this.toolHooks(opts),
  })
  return this.normalize(result, opts)
}
```

错误归一：

| 来源 | 归一为 | apps 行为 |
|---|---|---|
| `AbortError` / signal aborted | `Error('aborted')` | 记 `cancelled`，不发送迟到结果 |
| Mastra `MastraTimeoutError` | `stopReason='time_budget'`？ | 先 finalizer；若无法收尾则 `run_error` |
| Provider 4xx/5xx | `provider_error` + 原始 message | 有 fallback 则内部尝试；否则 `run_error` |
| Tool 抛错 | tool result `{error}` | 模型继续；不把整轮判失败 |
| 审批 suspended | `stopReason='waiting_input'` | 发审批通知，不发送最终正文 |
| 空输出 | `stopReason='provider_incomplete'` | 走确定性兜底/finalizer |

**重要**：Mastra 的 `finishReason: 'suspended'` 不是失败，也不是完成；Facade 必须把它映射成 `waiting_input`/`approval`，并且**不**触发 `reply_sent`。

---

## 4. Agent 替换边界

### 4.1 职责映射

| 旧职责（`Agent.js`） | 新归属 | 机制 |
|---|---|---|
| 模型调用/工具循环 | Mastra Agent | `generate/stream` + `maxSteps`/`stopWhen` |
| 迭代上限 `maxTurns=200` | Mastra | `maxSteps`（需确认语义：Mastra step=一次 LLM 调用+工具） |
| 重复动作/连续失败/无进展 | 项目 `LoopGovernor` | 保留；通过 `onStepFinish`/`hooks.afterToolCall` 喂入；不依赖 Mastra 内置 stopWhen |
| 时间/token 预算 | Mastra `modelSettings.timeout` + 项目 governor | `totalMs/stepMs/firstChunkMs`；token 预算仍由 governor 统计 |
| finalizer（禁工具收尾） | 项目 Facade | 预算/停滞停止后，用同 system/tools 发一次禁工具调用；失败走确定性兜底 |
| 反思 `_reflect` | 项目 Processor/后处理 | 保留现有逻辑；Phase 1 先用 `onStepFinish` 后自检，Phase 3 再考虑 Mastra Processor |
| 流式增量 | Mastra `fullStream` → 现有 callbacks | 见 §10 |
| 取消 | `abortSignal` + `abortActiveRun` | 保留 `_activeRuns` 注册表 |
| 上下文压缩 | 项目 `compact/*` | Phase 1 保留；Phase 2 若 Mastra Memory 接管，需自定义 messageHistory/Processor |
| prompt 缓存对齐 | 项目 system/tool 组装 + Adapter | 工具顺序稳定、动态内容进 user 尾部、Anthropic 断点/OpenAI key |
| 审批 | Mastra `requireApproval` + `beforeApproval` | 见 §5.3 |
| RBAC | 项目 `policy` | Adapter 的 `requireApproval`/`beforeApproval` + `beforeToolCall` |
| 工具结果截断/注入标注 | 项目 | Adapter 执行后处理 |
| TaskStore 账本 | 项目 | `hooks` + Adapter 包装 |
| 最终答案状态机 | 项目 Facade | narration/final/clarify/finalizer 语义保留 |

### 4.2 动态 instructions / 人设 / Skills / 工具目录

- **instructions**：`agent.generate(messages, { instructions })` 可逐次覆盖（Mastra 文档确认）。Facade 把现有 `_assembleSystem()` 的结果作为 `instructions` 传入；人设 `systemPrompt` 仍由 apps 传入。
- **工具目录**：仍由项目 `buildToolDiscoverySection`/`buildToolCatalogSection` 生成，放进 instructions；**不要**把运行中增长的 `activeTools` 拼进目录（缓存不变量）。
- **Skills**：仍由项目 `SkillRegistry` 匹配后注入 `context`（user 消息尾部），不交给 Mastra。
- **动态情境/记忆/画像/召回**：仍拼进 user 消息尾部（现有行为），保证 instructions 是稳定前缀。
- **多模态**：`MessageAdapter` 把项目 content blocks 转成 AI SDK `ModelMessage` parts；模型能力校验仍由 `detectCapabilities` 做。不支持时保持现有“vision 子模型转文本/盲媒体提示”的降级。

### 4.3 终止与收尾顺序（必须保持）

1. 每步结束先更新 governor（工具名/参数/结果签名/usage）。
2. `precheck` 在下一轮模型调用前；`shouldStop` 在工具执行后。
3. 命中停止 → 不再调用模型；进入 finalizer（禁工具、独立宽限、同 system/tools）。
4. finalizer 失败/空 → `_deterministicWrapUp`。
5. 只有 `finalContent` 才允许作为最终回复；narration 永远不能成为最终答案。
6. 用户取消优先于预算：`aborted` 直接上抛，不交付 finalizer 结果。

Mastra 的 `maxSteps` 默认是 5（官方文档），**不能**直接沿用；必须显式设置 `maxSteps = cfg.maxTurns`，并保留项目 governor 作为第二道闸。

### 4.4 停止原因映射

| 旧 `stopReason` | 新来源 | 是否 finalizer | 用户可见后缀 |
|---|---|---|---|
| `end_turn`/provider finish | Mastra `finishReason` | 否 | 无 |
| `max_turns` | `maxSteps` 触顶 | 是 | `STOP_REASON_CN.max_turns` |
| `duplicate_action`/`no_progress`/`consecutive_failures` | governor | 是 | 对应文案 |
| `time_budget`/`token_budget` | governor/timeout | 是 | 对应文案 |
| `provider_incomplete` | 空输出 | 是 | 对应文案 |
| `clarify` | 工具短路 | 否 | 直接交付 clarify 文本 |
| `waiting_input` | Mastra suspended/approval | 否 | 审批/追问提示 |
| `cancelled` | abort | 否 | 不发 |
| `blocked` | guard | 否 | 拒绝文案 |

---

## 5. Tool SDK 兼容与 Zod

### 5.1 映射表

| Legacy | Mastra `createTool` | 说明 |
|---|---|---|
| `name` | `id` + tools 对象的 key | **key 决定 stream 的 toolName**；必须用同一字符串 |
| `description` | `description` | 原样 |
| `parameters`（JSON Schema） | `inputSchema: jsonSchema(parameters, { validate })` | 不强行转 Zod；用 AI SDK `jsonSchema()`，保留 AJV 校验 |
| `category` | 不直接映射 | 保留在 Adapter 闭包，供 policy/审批 |
| `meta.*` | Adapter 闭包 | `alwaysConfirm`/`effect`/`replay`/`idempotencyKey`/`resultCap`/`concurrency` 原样保留 |
| `execute(params, ctx)` | `execute(input, context)` | `ctx` 从 `context.requestContext` 取，不放进全局 |
| 返回 `string`/object | 原样返回 + `toModelOutput` | `toModelOutput` 统一成文本，保持模型可见格式 |
| 无 `outputSchema` | 不设 `outputSchema` | 避免输出校验改变既有语义 |
| 工具名非法字符/超长 | `sanitizeToolName` | 63 字符、`[A-Za-z0-9_]` 开头；建立双向映射 |
| `pack.name__tool` | 原样（`__` 合法） | 包名需为 ASCII；中文包名会被 sanitize，需映射 |

### 5.2 名称 sanitize

Mastra 的 `formatTools` 会把工具名中 `[^a-zA-Z0-9_-]` 替换为 `_`，首字符非字母/下划线则加 `_`，并截断到 63 字符（`@mastra/core@1.85.0` 源码 `run-registry` 中的 `formatTools`）。这会**静默改名**，导致：

- 模型调用的 toolName 与 legacy 名称不一致；
- 持久化历史里的旧 tool_call 名称回放时找不到工具；
- `onToolEnd`/统计/审批按名称匹配失败。

**Adapter 必须自己先 sanitize 并记录映射**：

```js
const used = new Map() // mastraName -> legacyName
function toMastraName(name) {
  let n = String(name).replace(/[^a-zA-Z0-9_-]/g, '_')
  if (!/^[a-zA-Z_]/.test(n)) n = `_${n}`
  n = n.slice(0, 63)
  let candidate = n
  let i = 2
  while (used.has(candidate) && used.get(candidate) !== name) {
    const suffix = `_${i++}`
    candidate = `${n.slice(0, 63 - suffix.length)}${suffix}`
  }
  used.set(candidate, name)
  return candidate
}
```

- 同一 runtime 内映射必须稳定、不可变。
- 持久化历史转换时，用 `legacyName` 写回 tool result 的 `name`；模型看到的是 `mastraName`。如果要在 legacy/mastra 间切换，需在消息适配层做双向映射。
- 新增测试：中文名、点号、超过 63 字符、两个工具 sanitize 后冲突。

### 5.3 RBAC 与审批

目标：**不再把审批放在 `execute` 内部阻塞**，改用 Mastra 原生 suspend/resume，获得持久化 snapshot。

```js
const tool = createTool({
  id: mastraName,
  description,
  inputSchema: jsonSchema(parameters, { validate: ajvValidate }),
  requireApproval: async (input, ctx) => {
    const legacyCtx = readLegacyCtx(ctx)
    const dec = decideExecution(toolMeta, input, legacyCtx) // allow|deny|confirm
    return dec !== 'allow' // deny 也先进入 approval 分支，由 beforeApproval 拒绝
  },
  beforeApproval: async (input, ctx) => {
    const legacyCtx = readLegacyCtx(ctx)
    const dec = decideExecution(toolMeta, input, legacyCtx)
    if (dec === 'deny') {
      return { proceed: false, output: { error: 'rejected_by_policy', reason: dec.reason } }
    }
    if (!legacyCtx) {
      return { proceed: false, output: { error: 'rejected_by_confirm', reason: '无审批上下文' } }
    }
    // confirm：返回 undefined，进入 suspend
  },
  execute: async (input, context) => {
    const legacyCtx = readLegacyCtx(context)
    return executeWithGuards(toolMeta, input, legacyCtx, context)
  },
  toModelOutput: (output) => ({ type: 'content', value: [{ type: 'text', text: stringify(output) }] }),
})
```

说明：

- `requireApproval` 的 `ctx.requestContext` 是普通对象视图；`execute` 的 `context.requestContext` 是 `RequestContext`，用 `.get('yz.ctx')`。Adapter 提供 `readLegacyCtx()` 兼容两者。
- `deny` 走 `beforeApproval` 的 `proceed:false`，**不会** suspend（Mastra 源码：`beforeApproval` 在 approval gate 之前，返回 `{proceed:false,output}` 直接作为工具结果）。
- `masterSkipConfirm` 在 `decideExecution` 里直接返回 `allow`，不进入审批。
- `meta.shouldConfirm`（如 terminal allowlist）在 `decideExecution` 内 await。
- `meta.alwaysConfirm` 永远 `confirm`（除 masterSkipConfirm）。
- **无 `ctx` 的嵌入调用必须复刻旧语义**：旧 `Agent._executeOne` 只在 `this.policy && ctx` 时跑 policy；没有 ctx 时仅 `meta.alwaysConfirm` 仍生效（`Agent.js:2244-2258`）。因此 `decideExecution` 在 `legacyCtx` 为空时应：query/personal 等普通工具按 `allow`；`alwaysConfirm` 仍 `confirm`，且 `beforeApproval` 因无审批上下文返回 `rejected_by_confirm`（fail-closed）。不要因为“没有 ctx”把所有工具都拒绝，否则子 Agent/嵌入用法会坏。
- 审批通知、短 id、超时、`#确认/#拒绝`、Web `/api/confirm` 由 `ApprovalBridge` 统一。
- **不能**在 `execute` 里再调用旧 `ConfirmStore`，否则会出现双重审批/双重阻塞。

### 5.4 工具执行守卫（Adapter 内）

`executeWithGuards` 顺序必须与旧 `_executeOne` 对齐：

1. `aborted()` → `cancelled` 结果，不执行。
2. 参数 AJV 校验（`jsonSchema.validate` + 执行前再校验一次，防止 Mastra 版本差异）。
3. `scheduleIntent` 硬门（`reminder_set` → `schedule_task`）。
4. shell 拦截/Jev shell 风险。
5. TaskStore `tool_started` 关键写；失败 → `journal_unavailable`，不执行。
6. 幂等检查：同 `runId+toolCallId` 已有 `tool_result` → 返回缓存；`effect !== 'read'` 且只有 `tool_started` → 返回 `effect_unknown`，不重复执行。
7. 合并 `ctx`（`Object.assign({}, legacyCtx, { signal, taskId, executionContext, userTexts })`）。
8. `tool.execute(params, toolCtx)`；异常归一。
9. 失败富化 `enrichToolFailure`。
10. `_capToolResult` 结构化截断。
11. 注入扫描（命中才加 `<untrusted_data>`）。
12. TaskStore `tool_result`（effectState/ replay/ idempotencyKey/ resultPreview）。
13. `onToolEnd` 回调（由 Facade 转发给 apps）。

### 5.5 输出校验与副作用

- 默认**不设** `outputSchema`；需要机器可读输出的新工具才设。
- 有副作用工具若设 `outputSchema`，必须 `outputValidation: 'warn'`，避免输出不符导致模型重试已发生的副作用（Mastra 文档明确）。
- 写工具重试：只有 `replay==='idempotent'` 且 `idempotencyKey` 存在时才允许自动重试；否则 `never`，返回 `effect_unknown` 要求人工核对。
- `toModelOutput` 不改变 App 拿到的原始结果（Mastra 文档：`toModelOutput` 只影响模型），适合保留完整结果给 Web/统计。

### 5.6 MCP 工具

- 现有 `model/mcp` 继续作为唯一 MCP 客户端；不引入 `@mastra/mcp`（peer 要求 Zod 4.2，且现有桥已有权限/命名/超时）。
- MCP 工具同样经 `LegacyTool → Mastra Tool` 适配；`meta.mcp=true`、`originalName` 保留。
- 名称冲突：`ToolRegistry.register` 已拒绝同名覆盖（`registry.js:74-99`），MCP bridge 还会检查 `existing.meta.mcp`（`model/mcp/bridge.js:70-83`）；Adapter 不得绕过。
- 权限默认 `system`（仅主人）；显式 `category` 才降级。
- 超时/取消：沿用 MCP client 的 request timeout；`context.abortSignal` 透传给 `client.callTool`（若客户端支持）。
- MCP 内容是不可信数据：继续走 `_screenUntrusted(..., 'tool:mcp')`。

### 5.7 第三方 Tool Pack

- `tools/<pack>/index.js` + `tool.config.js` 的加载不变（`model/toolkit/loader.js:53-115`）。
- `defineTool` 的默认 `category='system'` 不变。
- 动态 factory 在 runtime 构建时调用一次；Adapter 缓存结果。
- 工具热加载（`reload_skills` 是 skill，不是 tool）目前需要 runtime 重建；Mastra Adapter 不改变这一点。
- 失败隔离：单个 pack 加载失败只记日志，不阻塞其它工具（现有行为）。

### 5.8 并发、超时与调度的保留

现有 `ToolScheduler` 是跨 run 共享单例，生产 `maxParallel=4`（`apps/agent.js:1316`），默认 `exclusive`，只读白名单才 `parallel`（`tool-scheduler.js:28-80`）。Mastra 的 `toolCallConcurrency` 不能直接替代：

- **默认值**：Adapter 必须把未声明工具的并发降为 1/exclusive；不能使用 Mastra 默认的并行 fan-out。
- **资源键**：`meta.resourceKeys` 的串行语义在 Mastra 没有等价原语；保留项目 `ToolScheduler`，在 Adapter `execute` 外层提交任务，或把 same-resource 工具强制 `exclusive`。
- **超时**：现有调度器没有 per-tool timeout，只有取消；Mastra `modelSettings.timeout.stepMs` 是模型调用超时，不是工具超时。Adapter 必须给工具自身/MCP/子 Agent 加统一超时，并确保超时后 `execute` 不再继续产生副作用。
- **取消**：`context.abortSignal` 必须传给工具；忽略 signal 的工具仍可能阻塞，需在 Adapter 用 `Promise.race` 加硬超时并记录 `effect_unknown`（写工具不自动重试）。

### 5.9 MCP 与 ToolEvo 的特定约束

- MCP 工具当前不接收 `ctx`/`AbortSignal`（`model/mcp/bridge.js:78-91`），stdio 继承完整 `process.env`（`model/mcp/transport/stdio.js:23-28`），默认 `system`（`bridge.js:15-27`）。Adapter **不得**为了“让 Mastra 能传 ctx”而把 ctx 序列化给 MCP；保持最小上下文，另加 AbortSignal/超时/分页是独立安全改进。
- MCP 默认权限必须保持 `system`；如果 Mastra 侧有“未知工具默认 allow”，必须覆盖。
- ToolEvo 采纳/回滚必须在 `tools.replace()` 前重新检查名称是否已被 built-in/MCP 占用（`model/toolEvo/engine.js:84-90`；`apps/agent.js:2983-2999`）；否则会静默顶掉安全语义。
- 工具描述/Schema/MCP 元数据目前不过 guard；Mastra 迁移不应把外部描述当可信指令，必要时在 Adapter 里做长度/注入标注。

---

## 6. Provider 与 AI SDK 接线

### 6.1 Model Factory

文件：`model/runtime/model-factory.js`（新增）。

```js
import { createOpenAI } from '@ai-sdk/openai'
import { createAnthropic } from '@ai-sdk/anthropic'
import { createGoogleGenerativeAI } from '@ai-sdk/google'

function createProviderFor(ref, { fetchImpl, logger }) {
  const common = {
    apiKey: ref.apiKey,
    ...(ref.baseURL ? { baseURL: ref.baseURL } : {}),
    ...(ref.headers ? { headers: ref.headers } : {}),
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  }
  switch (ref.protocol) {
    case 'openai':
      // 关键：用 .chat() 走 /chat/completions；默认 openai(model) 可能走 Responses API
      return createOpenAI({ ...common, name: ref.preset || 'openai' }).chat(ref.model)
    case 'anthropic':
      return createAnthropic(common)(ref.model)
    case 'gemini':
      return createGoogleGenerativeAI(common)(ref.model)
    default:
      throw new Error(`未知协议：${ref.protocol}`)
  }
}
```

**保留现有配置方式**：`providerId/modelId` → `llmProviders[]/llmModels[]` → `protocol/preset/baseURL/apiKey/model` 镜像。`ModelFactory` 只读解析后的引用，不另建一套配置。

### 6.2 主模型 / fallback / utility / vision / embedding

| 用途 | 解析 | AI SDK |
|---|---|---|
| 主模型 | `resolveBaseModel(agent)`（`utils/Config.js:162-174`） | `createProviderFor(ref)` |
| fallback | `agent.fallbackModels[]`，每条独立 ref | `model: [primary, ...fallbacks]` 或逐条手动重试；优先用 Mastra 的 model 数组（需验证错误范围） |
| utility | `modelRouter.resolve(cfg.utilityModel || cfg.model)` | `createProviderFor(ref)`；用于 recall/thinking/selfReview |
| vision | `resolveVisionRoute` + `vcfg` | 独立 provider；视频/音频仍走项目 `VisionService` |
| embedding | `recall.embedProvider` + `embedBaseURL/embedApiKey` | `provider.embedding(model)`；保留 `embed()` 兼容 Doubao multimodal |

### 6.3 参数映射

| 现有 | AI SDK/Mastra | 说明 |
|---|---|---|
| `temperature` | `modelSettings.temperature` | 推理模型拒绝时需保留“剥离重试/记忆”策略 |
| `max_tokens` | `modelSettings.maxOutputTokens` | Anthropic 默认 4096 仍需保留 |
| `thinking`（DeepSeek `{type:enabled}`） | `providerOptions.deepseek?` 或自定义 provider middleware | **不能假设 AI SDK 会转发任意字段**；需 Spike |
| `reasoning_effort` | `providerOptions.openai.reasoningEffort` | 仅 OpenAI reasoning 模型 |
| `thinking_budget` / `enable_thinking` | 供应商特定 `providerOptions` | Qwen/MiMo/Doubao 等需逐厂商验证 |
| Anthropic `thinking` | `providerOptions.anthropic.thinking` | `budgetTokens` camelCase；`max_tokens > budget` |
| Gemini `thinking_level` | `providerOptions.google.thinkingConfig` | 与 `@google/genai` Interactions 语义不同 |
| `cache_control` | Anthropic `providerOptions` / Mastra 缓存 | 官方端点显式断点；兼容网关默认关 |
| `prompt_cache_key` | OpenAI `providerOptions` | 仅官方端点；键含 model/conv/epoch/toolFp |
| `response_format` | `structuredOutput` | 仅在需要结构化输出时；不用于普通工具循环 |

**优先级**：模型条目覆盖 > 全局配置 > preset 默认。与现有 `apps/agent.js:1188-1198,1286-1288` 一致。

### 6.4 fallback 语义

- Mastra Agent 支持 `model: [{ model, maxRetries, modelSettings, providerOptions }, ...]`（`AgentConfig` 类型确认）。
- 需要验证：
  - 失败尝试是否计入 usage；
  - 流式已输出后是否禁止 fallback；
  - 跨协议消息是否自动转换；
  - 错误分类是否与旧 `__tries` 一致。
- 在验证前，**Facade 可以保留手动 fallback**：先 `agent.generate` 主模型，捕获错误后换模型重建 Agent；但会重复工具副作用，禁止在工具已执行后使用。推荐用 Mastra model 数组，并补“已输出半截”保护。
- 回退后模型名/usage 必须进入 DevLog/UsageStats；无法获得的缓存字段标记 `unsupported`，不伪造 0。

### 6.5 代理

- 现有 `agent.proxy` 依赖未声明的 `undici`，实际不生效（见 00 §1.6）。
- PR2 必须二选一：
  - 增加 `undici` 依赖，`ProxyAgent` + 自定义 `fetch` 传给 AI SDK provider；
  - 或明确不支持，删除配置承诺并文档化。
- Gemini/AI SDK Google provider 需确认是否接受自定义 `fetch`；若不接受，代理对 Gemini 仍无效，必须在配置/文档中标注。

### 6.6 Gemini 特别说明

现有 Gemini 走 `@google/genai` 的 **Interactions API**（`ai.interactions.create`，`store:false`，`Step[]`，`thought_summary`），不是 `generateContent`。AI SDK Google provider 是另一套 API 面。

**决策**：Gemini 迁移必须单独 Spike（PR2 内），在以下全部通过前，Gemini 继续走 legacy provider：

- 工具调用/工具结果历史可回放；
- thinking level/预算映射；
- usage/cache 字段；
- 流式 text/thought 增量；
- 取消/超时；
- 结构化输出（如有使用）。

---

## 7. Message Adapter 与 Memory/Identity

### 7.1 为什么需要 Message Adapter

项目持久化消息是 OpenAI 风格：

```js
{ role:'assistant', content:'...', tool_calls:[{ id, type:'function', function:{ name, arguments:'{"x":1}' } }] }
{ role:'tool', tool_call_id:'...', name:'...', content:'...' }
```

AI SDK v7 `ModelMessage` 使用 typed parts：

```js
{ role:'assistant', content:[{ type:'text', text:'...' }, { type:'tool-call', toolCallId, toolName, input:{x:1} }] }
{ role:'tool', content:[{ type:'tool-result', toolCallId, toolName, output:{ type:'text', value:'...' } }] }
```

`MessageAdapter` 负责双向转换，并保留 `reasoning`、`provider_native`（Anthropic signature）。这是 PR4 的**前置阻塞项**，必须先有单测。

### 7.2 两阶段 Memory 策略

| 阶段 | 消息历史真源 | Mastra Memory | 目的 |
|---|---|---|---|
| Phase 1（PR4） | `SessionStore`（现状） | **不启用** | 只替换循环/Provider/Tool，最低风险；compaction/会话/Web 完全不变 |
| Phase 2（PR5） | Mastra Memory（thread/resource） | 启用 `lastMessages`/`messageHistory` | 统一持久化、跨重启、HITL snapshot；SessionStore 改为兼容读/迁移源 |

**Phase 1 不允许双写**：Mastra 不存消息，只有 SessionStore 写。**Phase 2 也不允许双写**：Mastra 写，SessionStore 只读/兼容视图。切换通过 `agent.mastra.memory.mode: history-adapter | mastra` 控制。

### 7.3 Identity / Scope 规范

完整格式：

```text
adapter   = onebot | qqbot | qqguild        // 来自 ctx.adapterKind / official
botId     = safeScopePart(ctx.selfId || 'bot') // 官方为完整 appid；缺失用 'bot'
scopeId   = ctx.scopeId（已是 safeScopePart 后的安全值）
ownerKey  = `${botId}_${scopeId}`           // 必须含 bot，防两个机器人账号串数据
resourceId = `yz_${adapter}_${ownerKey}`     // 数据归属：私聊用户 / 群成员 / 群共享
threadId   = `yz_${adapter}_${ownerKey}_c${conversationId}` // 每个对话
scheduledThreadId = `yz_${adapter}_${ownerKey}_scheduled`
subThreadId = `yz_${adapter}_${ownerKey}_sub_${agentName}_${childTaskId}`
```

> 现状 `ctx.scopeId` 不含 `self_id`；直接用它做 resource 会让两个机器人账号共享 thread。**迁移前必须在 identity 层补 `botId`**，或在 `ctxOf` 中把 bot 纳入 scope。不要用 `selfId` 的原始长字符串直接拼路径，必须 `safeScopePart`。

约束：

- `resourceId`/`threadId` 只允许 `[A-Za-z0-9_-]`，长度 ≤128。`scopeId` 已由 `safeScopePart` 处理；`adapter`/`agentName` 需再 sanitize。
- **必须包含 adapter 与 botId**：现在 scope key 不含 `self_id`，两个机器人账号共享数据目录会串数据（00 §1.6/§7）。Mastra 迁移前先修。
- 群共享：`isolation=false` 时 `scopeUserId=__group__:<gid>`、`scopeId=g<gid>`，resource 就是群；私聊/群成员各自独立。
- 多 conversation：thread 带 `conversationId`；active 指针仍由现有 SessionStore/后续 Adapter 维护。
- 子 Agent：默认不继承父 thread/resource；需要共享记忆时显式使用父 resource + 独立 thread。
- 定时任务：独立 `scheduled` thread，避免与交互会话历史互相污染；现有 `conversationId=null` 的 group:user 历史作为迁移源。
- 官方 ID 含 `:`：**不能**用 `split(':')` 解析；统一由 `ctx.scopeId`/`safeScopePart` 生成。修复现有 `listAll`/`listAllConversations`/`clearMyData` 后再迁移。

### 7.4 Memory 组件取舍

| Mastra 能力 | 是否采用 | 原因 |
|---|---|---|
| Message History | Phase 2 采用 | 替代 Session KV 的 messages；需保留 `cacheEpoch`/`compactLedger`/`activeTools` 元数据 |
| Working Memory | **暂不采用** | ProfileStore 已有 facets/证据/置信度/纠正/上限；Working Memory 的 Markdown/JSON 模板无法等价表达，且会形成第二真源 |
| Semantic Recall | **默认关闭** | RecallStore 是跨会话长期记忆，已有时间衰减/MMR/纠错；Mastra semanticRecall 是消息级 RAG，语义不同。启用需独立 namespace、embedder、维度、去重策略 |
| Observational Memory | **不采用为压缩替代** | 官方明确“压缩会丢精确措辞”，recall 只能回到 observation group；现有压缩是内容寻址无损归档 + ledger，不能替换 |
| Memory Processors | Phase 3 评估 | 可用于 messageHistory 截断/过滤，但必须先证明不破坏前缀缓存与无损归档 |

### 7.5 压缩与 Mastra Memory 的冲突

- 现有压缩在 **消息数组** 上做四阶段：删旧 tool 结果 → 分块 → ledger → 归档；`cacheEpoch++` 触发前缀换代。
- 若 Mastra Memory 接管历史，必须：
  - 要么把压缩后的 messages 显式写回 Memory（Mastra 是否允许覆盖历史？需 Spike）；
  - 要么用自定义 `messageHistory`/Processor 在**读取时**裁剪，但这样归档/ledger 不在持久化历史里，`context_recall` 语义会变；
  - 要么 Phase 2 暂不接管 history，只把 Mastra Memory 用于新会话/实验。
- **建议**：Phase 2 先只迁移“消息历史读写”，压缩仍由项目在每轮前对 Memory 返回的 messages 做，再把压缩结果通过 Memory API 持久化；如果 API 不支持安全覆写，则 Phase 2 延期，继续 Phase 1。不要在未验证前用 Observational Memory 替代。

---

## 8. Storage / Vector 设计

### 8.1 Storage Factory

文件：`model/runtime/storage-factory.js`（新增）。

```js
import path from 'node:path'
import { LibSQLStore, LibSQLVector } from '@mastra/libsql'
import { PostgresStore, PgVector } from '@mastra/pg'

function createStorage(cfg, { dataDir, logger }) {
  if (cfg.driver === 'postgres') {
    const connectionString = process.env[cfg.connectionStringEnv || 'MASTRA_DATABASE_URL']
    if (!connectionString) throw new Error('缺少 MASTRA_DATABASE_URL')
    return new PostgresStore({
      id: 'yz-mastra',
      connectionString,
      schemaName: cfg.schemaName || 'mastra',
      ssl: cfg.ssl,
      max: cfg.max ?? 10,
      idleTimeoutMillis: cfg.idleTimeoutMillis ?? 30000,
      disableInit: cfg.disableInit === true,
    })
  }
  const file = path.resolve(dataDir, cfg.libsqlFile || 'mastra/mastra.db')
  return new LibSQLStore({ id: 'yz-mastra', url: `file:${file}` })
}
```

### 8.2 本地默认

- 路径：`<plugin>/data/mastra/mastra.db`，**绝对路径**。Mastra 官方明确：相对 `file:./mastra.db` 会按进程 cwd 解析，不同 cwd 打开不同库。
- 目录启动时 `mkdir -p`。
- `:memory:` 只用于单测，不能验证重启持久化。
- 单进程本地开发/单机部署可用；多进程生产必须 Postgres 或共享 LibSQL（官方不建议多进程写本地文件）。

### 8.3 生产 Postgres

- 连接串只从环境变量/密钥管理读取，不写入 YAML/日志。
- `schemaName` 默认 `mastra`；初始化账号需要 `CREATE TABLE/INDEX/EXTENSION` 权限（首次迁移）。
- `disableInit: true` 用于生产运行时；部署阶段单独跑 `storage.init()`。
- 连接池 `max`/`idleTimeoutMillis` 可配；关闭时 `storage.close()` 释放 pool。
- SSL 由 `ssl` 配置/连接串决定；不要在日志打印完整 DSN。
- 备份/恢复用 PG 原生工具；Mastra 表与业务表同库不同 schema，便于单独备份。

### 8.4 Vector

- 语义召回/RAG 与关系存储分开配置：
  - `LibSQLVector({ id, url: file:.../mastra-vectors.db })` 或同库；
  - `PgVector({ connectionString, schemaName })`（独立 schema/索引）。
- Embedder 必须显式：`provider.embedding(model)` 或 `"openai/text-embedding-3-small"`。
- 维度、metric、索引名必须固定；换 embedder/维度必须重建索引（现有 KB 已有 `vectorSignature` 机制，可复用思路）。
- **没有 embedder/vector 时的降级**：`semanticRecall: false`，RecallStore/KB 继续用关键词/BM25；不要静默启用一个默认 embedder。
- Mastra Memory 的 vector 与 KB 的 vector 用**不同 index/namespace**，避免把消息 embedding 和文档 chunk 混在一起。

### 8.5 Storage domain

| Domain | 建议后端 | 说明 |
|---|---|---|
| memory | 主库（LibSQL/PG） | 每轮读写，事务型 |
| workflows | 主库 | 审批/研究/工具进化 snapshot |
| observability | 可选独立后端 | 高写入；MVP 先不启用，用 DevLog/hooks |
| scores/datasets/experiments | 暂不使用 | 现有自进化/TraceStore 保留 |
| schedules | **不迁移** | 现有 ScheduleStore + node-schedule 保留 |
| backgroundTasks/threadState | 暂不使用 | 子 Agent/TaskStore 保留 |

`MastraCompositeStore` 只在需要把 observability 拆到独立库时使用；MVP 单库即可。

### 8.6 init / close

```js
const storage = createStorage(cfg)
if (!cfg.disableInit) await storage.init()
const vector = cfg.vector.enable ? createVector(cfg) : null
if (vector && !cfg.vector.disableInit) await vector.init?.()

// close order
await facade.abortAll()
await memory?.settled()
await workflowRunsSettled()
await vector?.close?.()
await storage.close()
```

- `init()` 失败：运行时构建失败，按现有 `_runtimeFailed` 缓存；修复配置后重试。
- `disableInit: true` 但表不存在：首次查询失败；部署检查必须显式 `storage.init()`。
- 升级 Mastra 版本可能带 schema migration；按官方 storage migration 指南执行，先在备份库演练。

---

## 9. Workflow 设计

### 9.1 边界原则

- **普通聊天不包 Workflow**：模型自主决定工具循环，交给 Agent。外层 Workflow 只会增加一次状态机、破坏流式/取消语义。
- Workflow 只用于：阶段固定、可暂停、需要快照/恢复、需要人工审批的流程。
- Workflow 的 snapshot 是**运行状态**唯一真源；TaskStore 只做用户可见投影，不驱动 Workflow。

### 9.2 候选流程

| 流程 | 为什么不是普通 Agent | 优先级 |
|---|---|---|
| 深度研究 | scope→plan→并行 workers→synthesize→cite→evaluate 阶段固定；需要预算/暂停/恢复/阶段事件 | P1（PR6） |
| 工具进化 | synthesize→static verify→behavior verify→人工审批→activate→canary；审批必须 suspend/resume | P1（PR6） |
| 人设补齐/采纳 | research→draft→人工审批→active；当前是队列+Web 审批 | P2 |
| 定时多阶段任务 | 只有“多阶段”才需要；单次 Agent 任务不需要 | P2 |
| 聊天审批 | 用 Agent 原生 `requireApproval`，不要 Workflow | P0 |

### 9.3 深度研究 Workflow（目标设计）

```js
import { createStep, createWorkflow } from '@mastra/core/workflows'
import { z } from 'zod'

const scopeStep = createStep({
  id: 'scope',
  inputSchema: z.object({ query: z.string(), taskId: z.string() }),
  outputSchema: z.object({ brief: z.string(), subquestions: z.array(z.string()) }),
  execute: async ({ inputData, mastra, requestContext }) => {
    const agent = mastra.getAgent('researchScope')
    const out = await agent.generate(inputData.query, { requestContext })
    return parseScope(out.text)
  },
})

const planStep = createStep({
  id: 'plan',
  inputSchema: z.object({ brief: z.string(), subquestions: z.array(z.string()) }),
  outputSchema: z.object({ tasks: z.array(z.object({ id: z.string(), question: z.string() })) }),
  execute: async ({ inputData }) => ({ tasks: buildTasks(inputData) }),
})

const researchStep = createStep({
  id: 'research',
  inputSchema: z.object({ tasks: z.array(z.object({ id: z.string(), question: z.string() })) }),
  outputSchema: z.object({ findings: z.array(z.object({ taskId: z.string(), text: z.string(), citations: z.array(z.string()) })) }),
  execute: async ({ inputData, mastra, requestContext }) => {
    const worker = mastra.getAgent('researchWorker')
    const findings = await Promise.all(inputData.tasks.map(async (t) => {
      const r = await worker.generate(t.question, { requestContext })
      return { taskId: t.id, text: r.text, citations: extractUrls(r.text) }
    }))
    return { findings }
  },
})

const approveStep = createStep({
  id: 'approve',
  inputSchema: z.object({ findings: z.array(z.any()), estimateUsd: z.number() }),
  outputSchema: z.object({ approved: z.boolean() }),
  resumeSchema: z.object({ approved: z.boolean() }),
  suspendSchema: z.object({ reason: z.string(), estimateUsd: z.number() }),
  execute: async ({ inputData, resumeData, suspend }) => {
    if (resumeData?.approved != null) return { approved: resumeData.approved }
    return suspend({ reason: 'high_cost_research', estimateUsd: inputData.estimateUsd })
  },
})

export const deepResearchWorkflow = createWorkflow({
  id: 'deep-research',
  inputSchema: z.object({ query: z.string(), taskId: z.string() }),
  outputSchema: z.object({ report: z.string(), citations: z.array(z.string()) }),
})
  .then(scopeStep)
  .then(planStep)
  .then(researchStep)
  .then(approveStep)
  .then(synthesizeStep)
  .then(citeStep)
  .commit()
```

- 触发：`apps/research.js` 通过 `mastra.getWorkflow('deepResearch')` → `createRun()` → `start({inputData})`；结果回现有 PDF/图片/文本交付。
- 暂停：`run.start` 返回 `status='suspended'`，`suspendPayload` 写入审批桥；`#确认`/Web 调 `run.resume({resumeData:{approved:true}})`。
- 幂等：每个 step 的副作用（搜索/抓取是读；写报告是本地文件）用 `runId+stepId+index` 做幂等键；报告文件按 `taskId` 命名，重复写覆盖不追加。
- TaskStore：`begin/event/finish` 只记录阶段投影（`workflow_run_id`, `phase`, `stop_reason`），Workflow snapshot 是唯一运行状态。

### 9.4 工具进化 Workflow（目标设计）

阶段：`synthesize`（draft）→ `staticVerify`（AST/权限扫描）→ `behaviorVerify`（沙箱回放）→ `approve`（suspend）→ `activate`（stable，CAS）→ `canary`（可选）。

- `suspendSchema: { versionId, diff, risk }`；`resumeSchema: { approved: boolean, operator: string }`。
- 副作用：写 toolEvo DB、替换 registry 工具。`activate` 用 `versionId` 做幂等键；若当前 stable 已变，返回 `conflict` 不覆盖。
- 与现有 `model/toolEvo/lifecycle.js` 的关系：Workflow 管编排；`lifecycle` 管状态机；ToolEvo DB 管版本/证据。禁止三处各自维护“是否已批准”。
- Web `POST /tevo/tools/:versionId/approve` 改为 `resume`，保留旧接口作为兼容包装。

### 9.5 Workflow 与 TaskStore/ScheduleStore

- `ScheduleStore` 继续负责“何时触发”；触发后若是 Workflow，则 `workflow.createRun()`；若是普通 Agent，则 `agent.generate()`。不要用 Mastra Schedules 替换现有 ScheduleStore（会改变重启/所有权/多实例语义）。
- TaskStore 继续负责“用户看到的任务列表/状态/恢复”；Workflow 的 `runId` 作为外部关联字段。
- 恢复：进程重启后，Mastra storage 有 suspended snapshot；Facade 启动时 `workflow.listActiveWorkflowRuns()`/`restartAllActiveWorkflowRuns()` 仅用于 Workflow，不要自动重放普通 Agent 的写工具（TaskStore 仍是 `interrupted` + 人工恢复）。

---

## 10. 流式、审批、取消映射

### 10.1 Chunk 映射

Mastra `fullStream` 的 chunk 类型（`@mastra/core@1.85.0` 类型声明已核验）：

| Mastra chunk | 现有回调/动作 | 注意 |
|---|---|---|
| `text-delta` | `onDelta(text)` | 仍需 `<think>` 剥离/内联 tool_calls 剥离/脱敏；apps 的 streamer 做节流 |
| `reasoning-delta` | `onReasoning(text)` | 不发给用户 |
| `tool-call` | `onToolStart(tc)` | `payload.toolCallId/toolName/args`；sanitized name → legacy name |
| `tool-result` | `onToolEnd(tc, content)` | `payload.result` 转 legacy 字符串；usageStats |
| `tool-call-approval` | ApprovalBridge | 生成短 id，持久化 `{runId,toolCallId,argsHash}`，通知主人 |
| `tool-call-suspended` | `waiting_input` | clarify/ask user；恢复用 `resumeStream` |
| `step-finish` | 每步 usage | 合并到总 usage；不要重复计 |
| `finish` | `finishReason`/总 usage | 映射 stopReason |
| `error` | 抛错/归一 | 若已发 delta，禁止 fallback 重跑 |
| `abort` | `cancelled` | 不发迟到结果 |

### 10.2 中间文本与最终回复去重

- 旧 Agent 区分 `narrationContent`（带 toolCalls 的中间播报）与 `finalContent`（无工具轮的最终答案）。
- Mastra 的 `text-delta` 同时包含旁白和最终文本；Adapter 必须按 **step** 聚合：
  - 该 step 有 tool-call → 文本是 narration，只在 `reply.narrate` 开启且 progress gate 允许时发送；
  - 该 step 无 tool-call 且是最后一步 → 文本是 final，不发 narration；
  - 不能把 narration 当 final，也不能把 final 重复发一遍。
- `streamer.finish()` 的 `rawFull === content` 检查保留；Mastra 的 `textStream` 可能过滤/拼接，不能直接用 `text` 判断，需用累积的 text-delta。

### 10.3 审批

- 新的 `ApprovalBridge`（目标 `model/runtime/approval-bridge.js`）：
  - `create({runId, toolCallId, toolName, args, ctx, threadId, resourceId})` → 短 id（5 位，避开 0）→ 持久化（KV 或 TaskStore sqlite）。
  - `notify` 复用 `notifyMaster`；消息格式保持 `待审批 #id：tool args` + `#确认 #拒绝`。
  - `resolve(id, approved, actor)`：CAS `pending→resolving`；校验 actor 是 master/审批人；校验 `argsHash` 未变；调用 `agent.approveToolCall({runId, toolCallId})` 或 `declineToolCall`。
  - 返回的 stream 必须继续走原回复管线；若原进程已重启，用 `ctx` 的最小重建（scope + platform IDs）和 `listSuspendedRuns` 找回。
  - 超时：`confirmTimeout` 秒；超时调 `declineToolCall`（若可用），否则标记 expired，不自动执行。
  - 取消：run abort 时把 pending 标记 cancelled；迟到批准返回 false。
  - 进程重启：启动时扫描 `pending`，用 `listSuspendedRuns({threadId,resourceId})` 对账；找不到 → expired；找到 → 恢复短 id 映射。
- `#待确认` 列出 Bridge pending（mastra 模式）或 ConfirmStore（legacy 模式）；灰度期用前缀/来源字段区分，避免 id 冲突。
- Web `/api/confirm` 读同一个 Bridge；`POST /api/confirm/:id/decide` 调 `resolve`。
- **副作用防重**：审批通过后，工具只执行一次；Adapter 的 TaskStore 幂等检查兜底。Mastra 的 `approveToolCall` 可能重跑工具（官方明确“恢复时会重新执行工具”），所以必须有 `runId+toolCallId` 幂等键。

### 10.4 取消

- `abortActiveRun(taskId)` → Facade `abort(taskId)` → `AbortController.abort()` → `agent.stream` 的 `abortSignal`。
- Mastra 抛 `AbortError`/`MastraError`；Facade 统一 `Error('aborted')`。
- `abortAllActiveRuns()` 等在途 run 的 `done` promise；新增 Mastra `run` 注册表。
- 热重载/关闭：先 abort，再 `memory.settled()`，再关 storage；不要反过来。
- 流式已发送的片段不撤回（现有行为）；不发送迟到最终结果。

---

## 11. 配置、Web、日志与可观测性

### 11.1 配置新增（目标设计）

```yaml
agent:
  runtime:
    engine: legacy            # legacy | mastra
    gray:
      users: []               # scopeUserId 列表
      groups: []              # groupId 列表
      percent: 0              # 0-100，按 scopeKey 稳定哈希
    shadow:
      enable: false
      readOnlyOnly: true      # 强制只读工具
      sampleRate: 0
  mastra:
    storage:
      driver: libsql          # libsql | postgres
      libsqlFile: mastra/mastra.db
      connectionStringEnv: MASTRA_DATABASE_URL
      schemaName: mastra
      ssl: true
      max: 10
      idleTimeoutMillis: 30000
      disableInit: false
    vector:
      enable: false
      driver: libsql          # libsql | pg
      embedder:
        providerId: ""
        model: ""
        dimensions: null
    memory:
      mode: history-adapter   # history-adapter | mastra
      lastMessages: 400
      semanticRecall: false
      workingMemory: false
      observationalMemory: false
    tools:
      nameStrategy: sanitize  # sanitize | strict
    approval:
      enabled: true
      timeoutSec: 300
    tracing:
      enable: false
      exporter: devlog        # devlog | none
```

- 全部有默认值；旧配置缺省即 legacy。
- `normalizeConfig` 加 Zod 校验（或等价手写校验），非法值 fail-closed 回 legacy 并告警。
- 密码/DSN 只从环境变量读；Web 配置只显示 `configured: true`。
- 保存只写差异，保持现有 `Config.save()` 语义。

### 11.2 Web 面板

- 95 个端点不直接认识 Mastra；继续经 `rt`/Facade。
- `/api/sessions`、`/api/conversations` 由 `SessionAdapter` 提供，Phase 2 可从 Mastra Memory 读。
- `/api/tasks` 继续读 TaskStore；新增 `workflowRunId` 字段（可选）。
- `/api/confirm` 读 ApprovalBridge。
- `/api/overview` 的 token/cache 统计继续读 UsageStats；新增 `engine`/`storage` 健康块。
- 新增只读 `/api/runtime/mastra/health`（可选）返回 health，不暴露 DSN。

### 11.3 Usage / cache

Mastra `LanguageModelUsage` 字段（类型已核验）包括 `inputTokens/outputTokens/totalTokens/cachedInputTokens/cacheCreationInputTokens/reasoningTokens` 等。映射到现有 `normalizeUsage`：

| 现有 | Mastra/AI SDK |
|---|---|
| `input` | `inputTokens` |
| `output` | `outputTokens` |
| `total` | `totalTokens` |
| `cacheRead` | `cachedInputTokens` |
| `cacheWrite` | `cacheCreationInputTokens`（若提供） |
| `cacheObserved` | 任一 cache 字段存在 |
| `observedInput` | `inputTokens` |
| `observedOutput` | `outputTokens` |
| `observedUncached` | `inputTokens - cachedInputTokens`（Anthropic 口径需单独判断） |

- Provider 未报告缓存字段 → `cacheObserved=false`，Web 显示“未观测”，不是 0。
- `mergeUsage` 保留；多步/fallback 的 usage 要合并，不能只取最后一步。
- 不伪造 cold/warm 命中率。

### 11.4 Trace / DevLog

- `taskId` = runId；`tracingOptions.traceId` 用 32 位 hex；`tracingOptions.metadata` 带 `threadId/resourceId/adapter/scopeId`（脱敏）。
- 现有 DevLog 事件保留；新增 `engine`、`mastra_step`、`mastra_tool`、`approval`、`workflow` 事件。
- 敏感信息：API key/DSN/token/完整私聊不写；工具参数按现有 `redactSecrets` 规则处理；DevLog 的“正文逐字写盘”是既有风险，迁移时至少加 `maxChars`/敏感字段过滤。
- Mastra Studio/Observability 仅开发期可选；生产面板/DevLog 必须能独立排障。

---

## 12. 建议目录树（新增/调整）

```text
model/runtime/                 # 新增：稳定 Facade 与适配层
  facade.js                    # AgentRuntimeFacade / runChat / streamChat / abort / close
  factory.js                   # legacy | mastra 选择、generation、生命周期
  mastra-runtime.js            # new Mastra(...) + agents/workflows 注册
  model-factory.js             # AI SDK providers + fallback/utility/vision/embedding
  storage-factory.js           # LibSQL/Postgres/Vector 初始化/关闭
  message-adapter.js           # legacy OpenAI-style ↔ AI SDK/Mastra messages
  tool-adapter.js              # LegacyTool → createTool + name map + guards
  tool-hooks.js                # policy/confirm/taskStore/usage/observability hooks
  identity.js                  # resourceId/threadId/runId 规范
  approval-bridge.js           # 短 id ↔ runId/toolCallId，持久化/恢复
  memory-bridge.js             # Phase 2 SessionStore ↔ Mastra Memory
  observability.js             # usage/trace/devLog 映射
  errors.js                    # 错误归一化
model/runtime/workflows/       # 新增：确定性流程
  deep-research.js
  tool-evolution.js
  persona-completion.js        # P2
model/runtime/schemas/         # 新增：Zod 配置/Workflow/Tool 边界
  config.js
  identity.js
  workflow.js
scripts/
  migrate-mastra.mjs           # 新增：KV/文件 → LibSQL/Postgres（dry-run/verify/rollback）
  mastra-smoke.mjs             # 新增：离线最小验证
docs/refactor/mastra/          # 本目录
```

**不新增**：`src/` 构建目录、`dist/`、独立 server。保持 `index.js` 直接加载 ESM。

---

## 13. 端到端伪代码（目标设计）

```js
// apps/agent.js（PR4 后）
const rt = await getRuntime()
const runner = rt.runtime.forRequest({ ctx, taskId: traceId })

const result = await runner.runChat(input, {
  ctx,
  taskId: traceId,
  signal: runSignal,
  stream: wantStream,
  systemPrompt,
  context,
  callbacks: {
    onDelta: (d) => streamer.push(d),
    onReasoning: (r) => { /* count only */ },
    onToolStart: rs.onToolStart,
    onToolEnd: (tc, content) => { diagram.onToolEnd(tc, content); usageStats.recordToolResult(tc.name, content) },
    onAssistant: (res) => { /* narration throttle */ },
  },
})

// 与旧 Agent.run 返回值兼容
const { content, stopReason, turns, usage } = result
```

`runner.runChat` 内部：

```js
const history = await historyAdapter.load(ctx)          // Phase 1: SessionStore
const messages = messageAdapter.toModel(history, input) // OpenAI-style → AI SDK
const requestContext = new RequestContext()
requestContext.set('yz.ctx', ctx)
requestContext.set('yz.taskId', taskId)
requestContext.set('yz.scopeKey', scopeKeyOfCtx(ctx))

const agent = mastra.getAgent('chat')                    // 注册时使用动态 instructions/tools
const out = await agent.generate(messages, {
  runId: taskId,
  instructions: assembleStableSystem(ctx),
  maxSteps: cfg.maxTurns,
  abortSignal: signal,
  requestContext,
  modelSettings: { temperature, maxOutputTokens, timeout: { totalMs, stepMs, firstChunkMs } },
  providerOptions,
  hooks: toolHooks,
  onStepFinish: (step) => governor.observe(step),
})

await historyAdapter.save(ctx, messageAdapter.fromModel(out.messages))
return normalize(out)
```

---

## 14. 必须保持的不变量

1. **回复所有权在 apps**：Mastra/工具不直接 `e.reply`；只返回数据/事件。
2. **最终答案唯一**：narration 不能作为最终回复；`content` 必须等于持久化历史末条 assistant。
3. **工具名稳定**：同一 runtime 内 sanitize 映射不可变；跨轮 tool 数组顺序稳定。
4. **前缀缓存稳定**：system 只放静态内容；记忆/画像/召回/情境进 user 尾部；工具数组不因 `tool_search` 增长而变。
5. **审批唯一**：一个工具调用只有一个审批通道；Mastra suspend 与 ConfirmStore 不能同时生效。
6. **副作用不重放**：任何写工具恢复前必须查 TaskStore/幂等键；`effect_unknown` 时拒绝自动重试。
7. **Scope 隔离**：resource/thread 含 adapter+bot+scope；官方 ID 不 `split(':')`；群共享/私聊/多对话/子 Agent 不串。
8. **单一真源**：Phase 1 消息历史=SessionStore；Phase 2 消息历史=Mastra Memory；绝不双写。TaskStore 与 Workflow snapshot 各管各的，不互相驱动。
9. **可关闭**：abort → memory.settled → vector.close → storage.close；热重载 generation 丢弃旧 build。
10. **可回退**：`legacy | mastra` 开关；发生工具副作用后禁止自动换引擎重跑。
