# 03 · 后续开发者指南

> 面向接手 Mastra 重构的开发者。本文假设你已读完 [00](00-code-audit.md) 和 [01](01-target-architecture.md)。
>
> ⚠️ **当前是极早期初步开发（pre-alpha）**：S0–S4、S6、S7 已落地，默认 `engine: legacy`，Mastra 只按用户/群灰度；S5 观察期与 S8–S11 未完成，效果**远不如 `master`**，不要用于生产。
>
> **S1–S7 已落地**：Mastra/AI SDK/Zod 依赖、`model/runtime/` 骨架（Facade/Storage/Identity/Config）、ModelFactory、Tool Adapter、灰度聊天/审批、Memory Phase 1/2 与迁移都已存在。标注“目标/后续 PR”的章节仍是将来的实现。

---

## 1. 环境准备

### 1.1 必需版本

| 组件 | 要求 | 说明 |
|---|---|---|
| Node.js | **>= 22.13.0** | Mastra v1 官方要求；当前开发机 v26.13.1 |
| pnpm | 11+（CI 用 11；本机 12.21.0 也可） | `pnpm-lock.yaml` lockfileVersion 9.0 |
| Python | 仅 crawl4ai/部分媒体测试需要 | 标准离线测试不需要 |
| Docker | 仅 E2B/Kroki/部分集成测试需要 | 缺失时测试自行 skip |
| GPU | 仅 cuVS 测试/部署需要 | 缺失时 skip |

Yunzai 宿主也必须满足 Node >=22.13.0；不能只在开发机满足。部署前用 `node -v` 在宿主进程实际使用的 Node 上确认。

### 1.2 安装

```bash
cd <yunzai>/plugins/agents-plugin
pnpm install --frozen-lockfile
```

PR1 已加入 Mastra/AI SDK 依赖；`pnpm install --frozen-lockfile` 必须可复现。依赖只在 `engine: mastra` 时动态加载。

### 1.3 离线测试与 lint（现状）

```bash
pnpm test          # 192 文件；180 通过 / 0 失败 / 12 跳过；8114 断言
pnpm lint          # 0 errors / 50 warnings
node scripts/mastra-smoke.mjs   # PR1 骨架冒烟（legacy + mastra 创建/health/close）
node scripts/mastra-model-smoke.mjs  # PR2 真实模型双通道（AI SDK + legacy；需配置主模型）
```

单文件：

```bash
node model/agent/test.mjs
node model/agent/compact/test.mjs
node scripts/run-tests.mjs   # 全量
```

需要 Yunzai 桩的入口测试：

```bash
node --import ./stress/e2e/hooks.mjs stress/e2e/run.mjs
```

前端自检：

```bash
node web/dev/smoke.mjs
node web/dev/config-search-check.mjs
node web/dev/feature-assign-check.mjs
node web/dev/token-normalize-check.mjs
```

### 1.4 真实 Provider（可选）

无 Key 时相关测试自动 skip。需要时设置环境变量（不要把 Key 写进仓库）：

```bash
export REAL_LLM_BASE_URL=...
export REAL_LLM_API_KEY=...
export REAL_LLM_MODEL=...
node stress/real/real-llm-smoke.mjs
```

Mastra 的 Postgres 集成测试目标使用：

```bash
export MASTRA_TEST_DATABASE_URL='postgres://...'
node --test model/runtime/test/storage.test.mjs
```

没有该变量时，Postgres 用例必须 `SKIP_FILE:` 退出 0，不能失败。

---

## 2. 仓库结构与职责

```text
index.js                 唯一 Yunzai 入口；扫描 apps/*.js，只导出 class
apps/                    事件/命令/回复编排（可 import Yunzai）
  agent.js               主链路、运行时装配、71 条命令
  web.js / qqbot.js / research.js / humanize.js / groupworld.js ...
model/                   纯逻辑层（不得硬依赖 Yunzai）
  agent/                 现有 ReAct、工具、会话、记忆、压缩、审批
  runtime/               PR1 后新增：Facade/Adapter/Factory/Workflow
  openai/ anthropic/     手写传输（legacy，PR8 前保留）
  llm/                   能力/思考/上下文/embedding
  toolkit/ mcp/ multiagent/ toolEvo/ research/ ...
  web/                   面板 API
web/                     静态 Vue 3 面板（无构建）
config/default_config/   默认配置真源
tools/                   外置工具包（自动加载）
skills/                  技能 Markdown
stress/e2e/              真实入口 + 桩协议/模型
scripts/                 测试运行器/迁移/安装
docs/refactor/mastra/    本目录
```

**分层规则**（现有 `AGENTS.md` 同样要求）：

- `model/` 不得 `import '../../lib/plugins/plugin.js'`；需要宿主能力时通过 `ctx`/注入/`typeof Bot !== 'undefined'` 守卫。
- `apps/` 负责发消息；工具只返回数据，不 `e.reply`。
- 共享函数不要放 `apps/`（Yunzai loader 会把同步函数导出当插件类）。
- 配置真源是 `config/default_config/config.yaml`；新增用户项要同步默认 YAML、Web 配置、Guoba、docs（如适用）。

---

## 3. 配置与运行时开关

### 3.1 现状

- 用户配置：`config/config.yaml`（gitignored）。
- 默认值：`config/default_config/config.yaml`。
- 保存只写差异；`Config.save()` → fs.watch → `reload()` → `onChange` → `invalidateRuntime()`。
- `agent.providerId/modelId` 是基础模型引用；`protocol/preset/baseURL/apiKey/model` 是运行时回填镜像，**不要手改**。
- `agent.fallbackModels[]` 是回退唯一真源。
- `agent.maxTurns` 默认 200；循环护栏/时间/token 预算内置（2h/2M effective tokens）。

### 3.2 当前开关（PR1）

```yaml
agent:
  runtime:
    engine: legacy          # 默认；mastra 只创建骨架，聊天仍 legacy（PR4 才切）
    fallbackToLegacy: true
    gray:                   # PR4 灰度；PR1 只解析
      users: []
      groups: []
      percent: 0
  mastra:
    storage:
      driver: libsql        # libsql | postgres
      libsqlFile: mastra/mastra.db
      connectionStringEnv: MASTRA_DATABASE_URL
    vector: { enable: false }
    memory: { mode: sessionstore, semanticRecall: false }
```

- `engine=mastra` 初始化失败且 `fallbackToLegacy=true` → 回退 legacy；`false` → `buildRuntime` 失败。
- LibSQL 路径运行时转绝对；`libsqlUrl: :memory:` 仅测试。
- Postgres DSN 只从 `connectionStringEnv` 读，不写配置/日志。
- 关闭顺序：`mastra.shutdown → memory.settled → vector.close → storage.close`。

规则：

- 缺省值 = legacy；不要用“检测到 Mastra 依赖就自动切”。
- 灰度按 `scopeKey` 稳定哈希；同一用户/群不要在两引擎间抖动。
- 改 storage 配置会触发 runtime 重建；改 `engine` 只影响新请求，在途 run 继续到结束或被 abort。
- 敏感配置（DB DSN/API Key）只从 env/密钥管理读取，不写 YAML、不进日志。

---

## 4. LibSQL / PostgreSQL 切换

### 4.1 本地默认 LibSQL

```yaml
agent:
  mastra:
    storage:
      driver: libsql
      libsqlFile: mastra/mastra.db
```

实际路径：`<plugin>/data/mastra/mastra.db`（绝对路径）。启动时创建目录。

```bash
ls -lh data/mastra/
sqlite3 data/mastra/mastra.db '.tables'   # 可选，确认表已建
```

注意：

- `file:./mastra.db` 会按进程 cwd 解析；必须用绝对路径（Mastra 官方明确）。
- `:memory:` 只用于单测；不能验证重启持久化。
- 本地文件不适合多进程生产；多进程请用 Postgres。
- 备份：停写后复制 `data/mastra/`；或 `sqlite3 .backup`。

### 4.2 生产 Postgres

```bash
export MASTRA_DATABASE_URL='postgres://<user>:<password>@host:5432/db?sslmode=require'
```

```yaml
agent:
  mastra:
    storage:
      driver: postgres
      connectionStringEnv: MASTRA_DATABASE_URL
      schemaName: mastra
      ssl: true
      max: 10
      disableInit: true   # 生产运行时；部署阶段单独 init
```

部署阶段（有建表权限的账号）：

```bash
node scripts/migrate-mastra.mjs --init-storage --dry-run
node scripts/migrate-mastra.mjs --init-storage
```

运行时用低权限账号（只 DML），`disableInit: true`。表不存在时启动健康检查应失败并给出明确提示，而不是静默降级。

### 4.3 Vector

只有需要语义召回/RAG 时才启用：

```yaml
agent:
  mastra:
    vector:
      enable: true
      driver: libsql
      embedder:
        providerId: <llmProviders 里的 id>
        model: text-embedding-3-small
        dimensions: 1536
```

- Embedder 必须显式；不填就保持 `semanticRecall: false`，继续用关键词/BM25。
- 换模型/维度必须重建索引；不同 index 名不要混用。
- KB 的向量仍由 `KnowledgeStore` 管理；Mastra Vector 是给 Memory/新 RAG 用的，二者不要共用 index。

### 4.4 关闭顺序

任何关闭/重载：

```js
await facade.abortAll()        // 1. 取消在途 run
await memory?.settled()        // 2. 等 Observational/vector cleanup（如启用）
await vector?.close?.()        // 3. 关向量
await storage.close()          // 4. 关主库
```

不要先关 storage 再 abort run；不要在 `memory.settled()` 前关库。

---

## 5. 新增一个 Agent（目标设计）

> 普通聊天只有一个 `chat` Agent；新增“功能 Agent”（研究 scope/worker、persona completion 等）时使用本节。

```js
// model/runtime/agents/research-worker.js
import { Agent } from '@mastra/core/agent'
import { createModelFactory } from '../model-factory.js'

export function makeResearchWorker({ config, tools, memory }) {
  const model = createModelFactory(config).resolve(config.research.workerModel)
  return new Agent({
    id: 'research-worker',
    name: 'Research Worker',
    description: '执行一个自包含的检索子任务，返回结论和引用。',
    instructions: `你是检索子代理。只完成被委派的任务，直接给出结论与来源；不要解释过程。`,
    model,
    tools,                 // 只放 query 工具；不要放写工具/审批工具
    memory,                // 默认不传；需要跨任务记忆时显式传
    defaultOptions: {
      maxSteps: config.multiagent.workerMaxTurns ?? 30,
    },
  })
}
```

要求：

- `id` 稳定、唯一；不要用中文/空格。
- `instructions` 只放静态内容；动态上下文用 `generate(..., { instructions })` 或 `context`。
- 子 Agent 默认无 memory/policy/confirm/taskStore；不要把主 Agent 的写工具塞进去。
- 预算：`maxSteps` + `modelSettings.timeout` + 外层时间预算；不要只靠 `maxSteps`。
- 结果归一：返回 `{content,status,usage,turns}`，不要把 Mastra 原始对象透给 apps。

注册到 Mastra：

```js
const mastra = new Mastra({
  agents: { chat, researchScope, researchWorker },
  workflows: { deepResearch },
  storage,
  vectors: vector ? { default: vector } : undefined,
  logger,
})
```

---

## 6. 新增一个 Workflow（目标设计）

只在“阶段固定、需要暂停/恢复/快照”的时候用；普通聊天不要包 Workflow。

```js
// model/runtime/workflows/persona-completion.js
import { createStep, createWorkflow } from '@mastra/core/workflows'
import { z } from 'zod'

const collect = createStep({
  id: 'collect',
  inputSchema: z.object({ personaId: z.string(), query: z.string() }),
  outputSchema: z.object({ facts: z.array(z.string()) }),
  execute: async ({ inputData, mastra, requestContext }) => {
    const agent = mastra.getAgent('personaResearcher')
    const out = await agent.generate(inputData.query, { requestContext })
    return { facts: parseFacts(out.text) }
  },
})

const approve = createStep({
  id: 'approve',
  inputSchema: z.object({ facts: z.array(z.string()) }),
  outputSchema: z.object({ approved: z.boolean() }),
  suspendSchema: z.object({ reason: z.string(), preview: z.string() }),
  resumeSchema: z.object({ approved: z.boolean() }),
  execute: async ({ inputData, resumeData, suspend }) => {
    if (resumeData?.approved != null) return { approved: resumeData.approved }
    return suspend({ reason: 'persona_adoption', preview: inputData.facts.join('\n').slice(0, 1200) })
  },
})

export const personaCompletionWorkflow = createWorkflow({
  id: 'persona-completion',
  inputSchema: z.object({ personaId: z.string(), query: z.string() }),
  outputSchema: z.object({ approved: z.boolean() }),
})
  .then(collect)
  .then(approve)
  .commit()
```

运行/恢复：

```js
const run = await workflow.createRun({ runId: taskId })
const result = await run.start({ inputData })
if (result.status === 'suspended') {
  await approvalBridge.create({ runId: taskId, suspendPayload: result.suspendPayload, ctx })
}
// 审批后
const resumed = await workflow.createRun({ runId: taskId }).then(r => r.resume({ resumeData: { approved: true } }))
```

要求：

- 每个 step 的 `inputSchema/outputSchema` 必填；`stateSchema` 只放跨 step 的可序列化状态。
- 副作用 step 必须幂等：用 `runId+stepId`（foreach 再加 item id）做键；不要用 `Date.now()`。
- `suspend` 前把审批记录持久化；恢复时校验操作者/参数指纹。
- 不要同时用 TaskStore 和 Workflow snapshot 表示同一个“运行状态”；TaskStore 只存用户可见投影。

---

## 7. 新增一个 Tool（现有 SDK，永久有效）

### 7.1 最简单

```js
// tools/example.js
import { defineTool, param } from '../../model/toolkit/define.js'

export default defineTool({
  name: 'weather',
  description: '查询城市天气',
  category: 'query',
  parameters: {
    type: 'object',
    properties: { city: param.str('城市名') },
    required: ['city'],
    additionalProperties: false,
  },
  async execute({ city }, ctx) {
    if (!city) return { error: '缺少 city' }
    return { city, temp: 26, text: '晴' }
  },
})
```

### 7.2 工具包 + 配置

```js
// tools/my-pack/tool.config.js
export default {
  info: { title: 'My Pack', description: '示例', version: '1.0.0' },
  config: [
    { key: 'apiKey', type: 'string', label: 'API Key', secret: true },
    { key: 'enable', type: 'boolean', label: '启用', default: true },
  ],
}
```

```js
// tools/my-pack/index.js
import { defineToolPack, param } from '../../../model/toolkit/define.js'
import { getToolConfig } from '../../../model/toolkit/pack-config.js'

export default defineToolPack({
  name: 'my_pack',
  tools: [
    {
      name: 'search',
      description: '...',
      category: 'query',
      parameters: { type: 'object', properties: { q: param.str('query') }, required: ['q'] },
      async execute({ q }) {
        const cfg = getToolConfig('my_pack') || {}
        if (cfg.enable === false) return { error: '未启用' }
        return { q, results: [] }
      },
    },
  ],
})
```

### 7.3 硬性规则

- 必须声明 `category`；不声明 = `system`（仅主人）。
- 写/外部副作用工具必须声明 `meta.effect='write'|'external'`、`meta.replay='never'|'idempotent'`；审批用 `meta.alwaysConfirm`。
- 返回对象优先 `{ ok, content, data, error }`；失败用 `{ error }` 或 `{ ok:false }`，不要抛（抛也会被归一，但可读性差）。
- 不要 `e.reply`；不要访问全局单例；需要宿主能力时从 `ctx` 取。
- 工具名只允许 `[A-Za-z0-9_-]`，≤63 字符；包命名空间 `pack__tool`。不要用中文/点号（Mastra 会 sanitize）。
- 不要依赖 `execute` 内的审批；审批在 Agent 层。Adapter 之后由 Mastra `requireApproval` 承担。
- 长结果用 `meta.resultCap`；默认 8000 字符。
- 并发：只读工具可声明 `meta.concurrency='parallel'`；写工具默认 `exclusive`；有资源键用 `resource`。
- 幂等：写工具提供 `meta.idempotencyKey(args, ctx)`，恢复时防重。

### 7.4 工具测试

```bash
node model/toolkit/test.mjs
node model/agent/tools/registry.test.mjs
node model/agent/tool-schema.test.mjs
node model/agent/tool-scheduler.test.mjs
node model/agent/tool-effects.test.mjs
```

新增测试至少覆盖：合法/非法参数、软失败、结果截断、权限类别、并发语义、幂等键。

---

## 8. Mastra Tool Adapter 开发（PR3）

```js
import { createTool } from '@mastra/core/tools'
import { jsonSchema } from 'ai'

export function adaptTool(legacy, deps) {
  const id = deps.nameMap.toMastra(legacy.name)
  return createTool({
    id,
    description: legacy.description,
    inputSchema: jsonSchema(legacy.parameters, {
      validate: (value) => {
        const r = deps.validate(legacy, value)
        return r.ok ? { success: true, value } : { success: false, error: new Error(JSON.stringify(r.fields)) }
      },
    }),
    requireApproval: (input, ctx) => deps.approval.needs(legacy, input, deps.readCtx(ctx)),
    beforeApproval: (input, ctx) => deps.approval.before(legacy, input, deps.readCtx(ctx)),
    execute: (input, ctx) => deps.execute(legacy, input, deps.readCtx(ctx), ctx),
    toModelOutput: (output) => ({ type: 'content', value: [{ type: 'text', text: deps.stringify(output) }] }),
  })
}
```

注意：

- `createTool` 的第一个参数是 `id`，不是 `name`；stream 的 `toolName` 由 **tools 对象的 key** 决定，所以 key 必须等于 `id`。
- `execute(inputData, context)` 是唯一签名；`context.requestContext` 是 `RequestContext`，用 `.get('yz.ctx')`。
- `requireApproval` 的 `ctx.requestContext` 是普通对象视图；两种都兼容。
- `jsonSchema()` 来自 `ai`，保留原始 JSON Schema；不要强行转 Zod。
- `outputSchema` 默认不设；有副作用工具如设，必须 `outputValidation:'warn'`。
- 工具名 sanitize 规则见 01 §5.2；必须写冲突测试。

---

## 9. 调试

### 9.1 现状日志

- 控制台：`[chat]` 汇总、`[limits]`、`[provider]`、`[tools]`、`[sandbox]`、`[mcp]`。
- DevLog：`data/logs/<gid>-<uid>-<conv>-<ts>.log`，逐事件 JSON。
- `debug: true` 强制全链路 devLog；`agent.devLog.enable=false` 才真正关闭（除非 debug）。
- Web：`/api/logs/files`、`/api/logs?file=`；`/api/overview` 看 usage/cache。
- 单条 trace：`taskId`=traceId；Web 日志详情按 traceId 过滤。

### 9.2 Mastra 调试（PR1 后）

```js
const health = await facade.health()
console.log(health) // { engine, storage, vector, runs, approvals }
```

- 本地 `mastra dev`/Studio 可选，只作为开发工具；不要把它作为生产排障唯一手段。
- `tracingOptions.traceId` 用 taskId 的 32 位 hex；`metadata` 带 thread/resource/scope（脱敏）。
- 工具调用问题：看 `onToolStart/onToolEnd` 的 legacy name（不是 sanitized name），以及 TaskStore 的 `tool_planned/started/result`。
- 审批问题：看 ApprovalBridge 的 `{approvalId, runId, toolCallId, status, argsHash}`；重启后用 `listSuspendedRuns` 对账。
- 内存/存储问题：`storage.close()` 前必须 `memory.settled()`；热重载看 `RuntimeScope.openCount`/`/api/runtime/scopes`。

### 9.3 常见错误

| 现象 | 可能原因 | 排查 |
|---|---|---|
| 启动报 `apiKey` 为空 | `providerId/modelId` 未选/厂商条目缺 Key | Web 配置中心；不要手改镜像 `apiKey` |
| 配置保存后模型没变 | 运行时构建失败被缓存 | 看 `[agent] 初始化失败`；修复后 `#agent重载` |
| 工具调用 400 | 工具名被 sanitize/历史 tool_call 名称不匹配 | NameMap + 消息适配层；打开 devLog `tool` |
| Anthropic 工具续轮 400 | thinking signature 丢失 | 检查 `provider_native` 映射；先关闭 thinking 灰度 |
| 审批后重复执行 | 恢复时未查幂等键 | Adapter 的 `runId+toolCallId` 检查；TaskStore `tool_started` |
| 重启后审批消失 | 旧 ConfirmStore 内存 | 切 ApprovalBridge；看 pending 持久化 |
| 会话串群/串 bot | scope key 不含 adapter/selfId；官方 ID 冒号 | 修 identity；thread/resource 只用 safeScopePart |
| Postgres 启动失败 | `disableInit:true` 但表不存在/权限不足 | 部署阶段 `storage.init()`；检查 schema/权限 |
| LibSQL 打开错库 | 相对路径/cwd 不同 | 用绝对 `file:/...` |
| 内存持续上涨 | vector/MCP/stagehand 未关闭；旧 runtime 未释放 | 检查 close 顺序/`RuntimeScope`/health |

---

## 10. 代码风格与语言选择

### 10.1 推荐：ESM JavaScript + JSDoc

- 仓库没有构建步骤；Yunzai 直接加载 `index.js`。
- Mastra/AI SDK 发布 ESM + `.d.ts`，JS 可直接消费。
- 新模块用 JSDoc 描述公开接口；关键 schema 用 Zod（运行时校验）。
- 可选：CI 加 `tsc --noEmit --allowJs --checkJs` 只检查新模块，**不产出构建物**；不要引入 `dist/`。
- 不推荐全量 TS：会引入 loader/构建/发布复杂度，且与“Yunzai 直接加载插件”冲突。详见 ADR-001。

### 10.2 命名/结构

- 文件名 kebab-case；类 PascalCase；函数 camelCase。
- 新增运行时模块放 `model/runtime/`；不要放 `apps/`（loader 会误判）。
- 公共错误码保持现有字符串（`rejected_by_policy`/`rejected_by_confirm`/`schema_invalid`/`invalid_arguments`/`cancelled`/`journal_unavailable`），测试和模型提示依赖它们。
- 不打印密钥/DSN/token/完整私聊；日志用 `redactSecrets`。

---

## 11. 测试与提交前检查

### 11.1 必跑

```bash
pnpm lint
pnpm test
node web/dev/smoke.mjs
node web/dev/config-search-check.mjs   # 改配置时
node web/dev/feature-assign-check.mjs  # 改配置 UI 时
```

### 11.2 新增测试放置

- 纯逻辑：同目录 `*.test.mjs`。
- 运行时：`model/runtime/test/*.test.mjs`。
- 入口/E2E：`stress/e2e/*.mjs`；需要 Yunzai 桩的加入 `HOOKED_STRESS`。
- 真实 Provider：`stress/real/*.mjs`，无 Key `SKIP_FILE:`。
- 迁移：`scripts/migrate-mastra.mjs --self-test` 或独立 `test.mjs`。

### 11.3 失败标记约定

- 测试汇总必须打印 `通过 N，失败 M`。
- 成功时不要输出 `✗`/`FAIL:`（runner 会误判）。
- 整文件跳过用 `SKIP_FILE:` + exit 0。

### 11.4 提交前

- `git status` 确认没有 `config/config.yaml`、`data/`、日志、临时文件。
- 不提交 `.env`/Key/DSN。
- 不修改 `master`；不 force push；不清理用户改动。
- 文档变更同步 `docs/README.md` 索引。

---

## 12. 版本升级

```bash
pnpm add @mastra/core@1.85.0 @mastra/memory@1.41.2 @mastra/libsql@1.31.1 @mastra/pg@1.37.0
pnpm add ai@7.0.177 @ai-sdk/openai@4.0.121 @ai-sdk/anthropic@4.0.106 @ai-sdk/google@4.0.122
pnpm add zod@^3.25.76
```

规则：

- 所有 `@mastra/*` 同批升级；不要混用不同 minor 线。
- 升级前读官方 migration guide + 包内 changelog；先备份 LibSQL/PG。
- 跑 `pnpm test` + parity + 真实 Provider smoke。
- 记录 Node/pnpm/依赖版本到 README/CHANGELOG。
- 不要用 `latest` 直接上线；锁定精确版本。

---

## 13. 排障清单（按顺序）

1. `node -v` >= 22.13.0？宿主进程用的是同一个 Node 吗？
2. `pnpm install --frozen-lockfile` 成功？`zod` 解析到 >=3.25.76？
3. `pnpm test` 是否仍保持当前基线（S7：180/0/12，8,114 断言）？新增失败是否与本次改动相关？
4. `agent.runtime.engine` 是 legacy 还是 mastra？灰度命中了吗？
5. `facade.health()` 的 storage/vector 是否 ok？close 顺序对吗？
6. 模型解析：`providerId/modelId` 有效？fallback 每条有 apiKey？
7. 工具：name sanitize/映射/权限/审批/幂等；看 TaskStore 事件。
8. 记忆：thread/resource 是否符合 identity 规范？是否双写？
9. 流式：chunk 映射/最终去重/取消；看 `stream` devLog。
10. 回复：`reply_sent/reply_failed` 终态是否唯一？Web/日志能否定位？
