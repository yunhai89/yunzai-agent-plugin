# 05 · 测试与验收

> 目标：证明 Mastra 路径在**行为、权限、数据、恢复、隔离、性能**上不退化，而不是只证明“能跑”。
>
> 基线：commit `9323c5d`；`pnpm test` = 147 通过 / 0 失败 / 12 跳过 / 159 文件 / 7,230 断言；`pnpm lint` = 0 errors / 50 warnings。
>
> 所有新增测试必须能在**无网络/无 API Key**下运行；真实 Provider 用例无 Key 时 `SKIP_FILE:` 退出 0。

---

## 1. 测试分层

| 层 | 目的 | 运行时机 | 依赖 |
|---|---|---|---|
| 单元 | Schema/解析/映射/ID/错误归一 | 每次提交 | 无 |
| 契约 | 现有 Tool Pack/消息/回复/Web API/命令 | 每次提交 | 无（桩） |
| Parity | 同一 fixture 下 legacy vs mastra 语义等价 | PR2+ | 无（mock model） |
| Agent | 多轮/并行/终止/超时/空输出/finalizer | PR4+ | 无 |
| Memory | 多轮/多对话/隔离/重启/并发/遗忘 | PR5+ | LibSQL；PG 可 skip |
| Storage | LibSQL/PG/Vector/init/close/迁移 | PR1/PR5+ | 临时目录；PG 需 DSN |
| HITL | 批准/拒绝/超时/取消/重启/防重 | PR4+ | 无 |
| 流式 | text/tool/abort/error/去重/顺序 | PR4+ | 无 |
| 安全 | RBAC/群作用域/注入/不可信/脱敏 | PR3+ | 无 |
| 外围 | MCP/子 Agent/定时/研究/ToolEvo/多模态/人设/Skill/Web | PR7+ | 多为桩 |
| E2E | 真实 Yunzai 入口 + 桩协议/模型 | PR4+ | `stress/e2e/hooks.mjs` |
| 真实 Provider | 协议/流式/工具/reasoning/fallback/cache | 手动/定时 | API Key |

---

## 2. 单元测试矩阵

| 模块 | 必测点 | 文件建议 |
|---|---|---|
| `message-adapter` | OpenAI-style ↔ AI SDK parts；tool_calls 参数 JSON；tool_result 配对；多模态 text/image/file；reasoning/provider_native；空 assistant | `model/runtime/test/message-adapter.test.mjs` |
| `identity` | adapter/bot/scope/conv 组合；官方 ID；长度/字符；冲突；thread owner | `identity.test.mjs` |
| `model-factory` | protocol→provider；baseURL/apiKey/headers/fetch；`.chat()`；fallback；utility；embedding；Gemini 分支 | `model-factory.test.mjs` |
| `tool-adapter` | name sanitize/冲突/63；JSON Schema validate；execute ctx；toModelOutput；outputSchema 缺省 | `tool-adapter.test.mjs` |
| `tool-hooks` | policy deny/confirm/allow；alwaysConfirm；shouldConfirm；masterSkipConfirm；journal；effectState；幂等 | `tool-hooks.test.mjs` |
| `approval-bridge` | 短 id；CAS；argsHash；超时；取消；重启恢复；listSuspendedRuns 对账 | `approval-bridge.test.mjs` |
| `errors` | abort/timeout/provider/tool/suspended → stopReason | `errors.test.mjs` |
| `config schema` | 默认 legacy；非法值 fail-closed；旧配置迁移；DSN 脱敏 | `config.test.mjs` |
| `observability` | Mastra usage → normalizeUsage；cache 未观测；merge；traceId | `observability.test.mjs` |
| `storage-factory` | LibSQL 绝对路径；`:memory:` 单测；PG 配置；init/close；错误 | `storage.test.mjs` |
| `workflows` | step schema/顺序/suspend/resume/幂等/失败 | `workflows/*.test.mjs` |

### 2.1 必须覆盖的边界

- `jsonSchema()` 校验：draft-07/2019-09/2020-12；`additionalProperties:false`；`$ref`；union；`maxLength`；`required`。
- `null`/数组/原始类型参数 → `invalid_arguments`。
- schema 编译失败 → `schema_invalid`（fail-closed）。
- 工具名：中文、点号、空格、63/64 字符、两个名字 sanitize 后冲突。
- 审批：`argsHash` 变化；重复批准；迟到批准；超时；取消；进程重启。
- 幂等：`tool_started` 有、`tool_result` 无 → `effect_unknown`；`replay=never` 不重试；`idempotent` 有 key 才重试。
- 缓存 usage：Provider 不提供 cache 字段 → `cacheObserved=false`，不能显示 0% 命中。

---

## 3. 契约测试

### 3.1 工具 SDK

- `defineTool` 默认 category `system`；显式 category 保留。
- 工具包前缀 `pack__tool`；不重复前缀；`prefix:false`。
- `ToolRegistry.register` 同名拒绝；`replace()` 显式替换；`registerScoped` 只移除本次。
- `meta` 全字段保留：`alwaysConfirm`/`shouldConfirm`/`interactive`/`concurrency`/`resourceKeys`/`effect`/`replay`/`idempotencyKey`/`requires`/`resultCap`/`polling`/`mcp`/`shell`/`groupAdminSkip`/`toolEvoVersionId`。
- MCP：默认 `system`；前缀；冲突跳过；文本/错误/结构化结果。

### 3.2 消息/结果

- `Agent.run` 结果字段：`content, messages, usage, turns, taskId, stopReason, finalized?, journalDegraded?, tokenBudget?, think?`。
- `content` 等于持久化历史末条 assistant。
- 工具消息 `{role:'tool', tool_call_id, name, content}` 配对完整。
- 错误码字符串不变：`rejected_by_policy`/`rejected_by_confirm`/`schema_invalid`/`invalid_arguments`/`cancelled`/`journal_unavailable`。
- 工具失败富化：`_failure`/`_alternatives`/`_next`/`_hint`。

### 3.3 回复/命令/Web

- `reply_sent|reply_failed|cancelled|run_error` 唯一终态。
- 群聊 quote/at；私聊不 quote/at；markdown 降级 plain；图片失败退文本；sticker 标记不漏。
- 71 条命令的权限/文案/行为（至少覆盖主人/普通/官方 ID）。
- 95 个 Web API 的响应包/鉴权/错误码；运行时缺失时 `/overview`、`/runtime/scopes` 仍可用。

---

## 4. Parity（legacy vs mastra）

### 4.1 目标

同一 fixture、同一脚本化模型输出，比较：

- 工具调用名称/参数/顺序；
- 权限决策（allow/deny/confirm）与审批请求；
- 工具结果（截断后）与错误分类；
- `stopReason`/`turns`/`usage` 字段；
- 最终 `content` 语义（不要求逐字相同，但必须都非空/不含 narration）；
- 持久化消息的 role/tool 配对；
- 事件序列（映射到统一事件名）。

**不比较**：时间戳、随机 ID、内部 span、模型原始 chunk、prompt 字节（跨引擎不要求相同）。

### 4.2 Fixture 设计

```js
// model/runtime/test/fixtures/scripted-model.js
export function scriptedModel(steps) {
  // steps: [{ text, toolCalls:[{name,args}], finishReason, usage }]
  // 返回一个 AI SDK LanguageModelV4 兼容的假模型：
  // doStream/doGenerate 按 steps 产出 text-delta/tool-call/finish chunks
}
```

同一 `steps` 同时驱动：

- legacy：fake `Provider.chat()` 返回 `AssistantResult`；
- mastra：fake AI SDK model 产出 chunks。

### 4.3 场景

| # | 场景 | 断言 |
|---|---|---|
| P1 | 纯文本 | 无工具；content 非空；stopReason 结束 |
| P2 | 单工具成功 | tool name/args/结果一致；turns=2 |
| P3 | 并行只读工具 | 调用集合一致；顺序约束允许；结果按原序 |
| P4 | 写工具 + 审批 | deny/confirm 一致；未批准不执行；批准后执行一次 |
| P5 | 工具失败 | 结果错误码一致；不自动重试；模型收到失败 |
| P6 | 重复动作 | governor 命中；finalizer 非空；stopReason 一致 |
| P7 | 连续失败/无进展 | 同上 |
| P8 | maxSteps | 触顶；finalizer；stopReason=`max_turns` |
| P9 | 空输出 | `provider_incomplete`；确定性兜底 |
| P10 | 取消 | `aborted`；不发送迟到结果 |
| P11 | 审批超时/拒绝 | `rejected_by_confirm`；不执行 |
| P12 | 工具结果截断 | JSON 可 parse；`_truncated` 标记一致 |
| P13 | 注入工具结果 | 标记/不标记行为一致 |
| P14 | usage/cache | 字段映射一致；未观测 ≠ 0 |

### 4.4 差异处理

- 允许的差异必须写入 `parity-allowlist.json`，附原因/负责人/到期日。
- 不允许的差异：权限放宽、写工具多执行一次、工具结果丢失、最终回复为空、stopReason 错、usage 漏计。
- 每次 PR 跑 parity；差异增加即失败。

---

## 5. Agent 测试

| 场景 | 断言 |
|---|---|
| 多轮工具 | 轮数/工具集合/最终回复 |
| 并行工具 | 只读并发；写工具独占；资源键串行 |
| 重复调用治理 | duplicate/no_progress/consecutive_failures |
| 最大步数 | maxSteps 触顶 + finalizer |
| 超时 | totalMs/stepMs/firstChunkMs；time_budget |
| 空结果 | 不把空串/推理当回复 |
| Provider 异常 | fallback/错误归一；已输出半截不重跑 |
| 上下文超限 | 学习上限 + 压缩 + 重试 |
| clarify | 短路为最终回复 |
| 反思 | revise 回环一次；narration 不泄漏 |
| 审批 | 暂停/恢复/拒绝/超时/取消 |
| 任务账本 | begin/event/finish/projected/delivery |
| 嵌套/子 Agent | usage 归集/预算/取消 |

---

## 6. Memory 测试

| 场景 | 断言 |
|---|---|
| 多轮 | 历史顺序/工具配对/末条 assistant |
| 多 conversation | active/切换/新建/删除/标题/预览 |
| 群共享 | `__group__:<gid>` 隔离；旧键回退 |
| 私聊 | 按用户隔离 |
| 跨群 | 不串 |
| 跨 bot | 不串（identity 含 selfId） |
| 重启 | thread/messages 保留 |
| 并发写 | 同 thread 串行/无丢失 |
| 压缩 | ledger/archive/cacheEpoch 保留；context_recall 可恢复 |
| 遗忘/删除 | 只删目标；不误删其它 scope |
| TTL/保留 | 与产品策略一致 |
| 导出 | 可导出 thread/messages；脱敏 |

---

## 7. Storage 测试

| 场景 | 断言 |
|---|---|
| LibSQL 文件 | 绝对路径；重启后数据在 |
| `:memory:` | 单测可用；明确不验证重启 |
| Postgres | `MASTRA_TEST_DATABASE_URL`；init/close；schema |
| Vector | 维度/metric/index；重建；删除 |
| 初始化 | `disableInit` 行为；缺表报错清晰 |
| 关闭 | `memory.settled` → vector → storage；无泄漏 |
| 迁移 | dry-run/幂等/断点/校验/回滚 |
| 多进程 | 本地文件禁止；PG 并发 |

---

## 8. HITL 测试

| 场景 | 断言 |
|---|---|
| 批准 | 只执行一次；结果回模型；继续生成 |
| 拒绝 | 不执行；模型收到拒绝原因；可改方案 |
| 超时 | 不执行；标记 expired |
| 取消 | pending 撤销；迟到批准无效 |
| 重复提交 | CAS；第二次返回 false |
| 重启恢复 | `listSuspendedRuns` 找到；短 id 恢复；通知 |
| 参数漂移 | argsHash 不匹配 → 拒绝 |
| 副作用防重 | `tool_started` 无 result → 不重跑 |
| 多 pending | 按 toolCallId 精确恢复 |
| Web/QQ | 两个入口同一 Bridge；权限/文案一致 |

---

## 9. 流式测试

| 场景 | 断言 |
|---|---|
| 文本 | onDelta 顺序/拼接=最终正文 |
| 工具 | onToolStart/onToolEnd 一次；参数/结果正确 |
| reasoning | onReasoning 不发给用户 |
| abort | 停止读取；不发送迟到 |
| error | 归一；已输出半截不重跑 |
| 重复文本 | narration/final 不重复 |
| 部分失败 | 只补尾部；不重发已送达前缀 |
| sticker 标记 | 跨 chunk 不泄漏 |
| 脱敏 | 半截密钥不发出 |

---

## 10. 安全测试

| 场景 | 断言 |
|---|---|
| RBAC | member/admin/owner/master × category |
| 群作用域 | 只能操作当前群；私聊主人可跨群（按现有设计） |
| 官方 ID | 不 `Number()`/不 `split(':')`；scope 正确 |
| 注入 | 用户输入/工具结果/网页/MCP/记忆/情境 |
| 不可信边界 | 外部内容始终/命中时标记；工具结果可 JSON.parse |
| 审批绕过 | 无 confirm 器 fail-closed；masterSkipConfirm 仅主人 |
| 工具名冲突 | 内置不被 MCP/外挂/toolEvo 静默覆盖 |
| MCP | 默认 system；env 最小化；无 ctx 泄漏；AbortSignal/超时/分页/list_changed |
| 子 Agent | query-only；无写工具/审批；配额/总预算/取消；不读父归档（或明确允许） |
| ToolEvo | 采纳时重查名称；built-in 不可淘汰；并发锁不绕过 |
| 工具超时 | 忽略 signal 的工具被硬超时；独占屏障不永久阻塞 |
| 日志 | 不打印 Key/DSN/token/完整私聊 |

---

## 11. 外围测试

- MCP：stdio/http/sse；工具名/权限/超时/取消/分页/list_changed。
- 子 Agent：配额/取消/预算/工具白名单/结果回推/隔离。
- 定时：重启恢复/所有权/重复触发/时区。
- 研究：阶段/预算/引用/交付/暂停恢复。
- ToolEvo：生成/验证/审批/回滚/名称冲突。
- 多模态：图片/视频/文件/vision 降级/盲媒体提示。
- 人设/Skill：匹配/接地/注入/热加载。
- Web：会话/记忆/画像/审批/任务/日志/概览。

---

## 12. 真实 Provider 测试

无 Key 自动 skip；有 Key 时按协议分组：

| 协议 | 场景 | 断言 |
|---|---|---|
| OpenAI-compatible | 流式/工具/usage/cache/fallback | 事件/字段/无重复 |
| Anthropic | thinking/tool_use/signature/cache_control | 续轮不 400；signature 回放 |
| Gemini | Interactions/工具/thinking/usage | 与 legacy 语义一致或标记 legacy-only |
| Embedding | 批量/维度/失败降级 | 向量维度/降级 |

记录：Provider、模型、baseURL（脱敏）、日期、结果、耗时、usage 字段。不要把 Key 写入报告。

---

## 13. 性能基线

### 13.1 先测 legacy

| 指标 | 方法 |
|---|---|
| 进程启动到插件就绪 | 打点 `index.js`/`buildRuntime` |
| 首 token | `onDelta` 首次时间 |
| 总时延 | run 开始到最终回复 |
| 工具时延 | `onToolEnd` 时间戳 |
| 内存 | `process.memoryUsage()`（启动/稳态/长会话） |
| 并发 | 10/50 会话同时 run |
| 存储读写 | thread/message 次数/字节 |
| 压缩 | 触发次数/归档字节/恢复耗时 |
| fallback | 次数/原因/额外 token |

### 13.2 Mastra 门槛

- 不承诺提升；先记录，再定“不退化”阈值（建议：P95 总时延 +20% 内、首 token +30% 内、内存 +25% 内；最终以产品确认）。
- 无法等价比较的指标（如不同 Provider 的 cache 字段）标注“不可比”，不伪造。
- 性能测试必须固定模型/网络/并发/数据量；报告版本/日期。

---

## 14. 验收表

| ID | 验收项 | 通过标准 | 证据 |
|---|---|---|---|
| A1 | 现有测试 | 147/0/12 保持；新增全绿 | CI 日志 |
| A2 | Parity | P1–P14 全过；allowlist 有原因 | `parity-report.json` |
| A3 | 工具 | 名称/参数/结果/权限/审批/账本一致 | 单测 + E2E |
| A4 | Agent | 终止/超时/空输出/finalizer 一致 | 场景报告 |
| A5 | Memory | 多轮/多对话/隔离/重启/压缩 | 迁移/回归报告 |
| A6 | Storage | LibSQL + PG + Vector | 测试报告 |
| A7 | HITL | 批准/拒绝/超时/取消/重启/防重 | E2E 报告 |
| A8 | 流式 | 文本/工具/abort/去重 | E2E 报告 |
| A9 | 安全 | RBAC/群作用域/注入/官方 ID | 安全测试报告 |
| A10 | 外围 | MCP/子 Agent/定时/研究/ToolEvo/多模态/Web | 功能清单签字 |
| A11 | 性能 | 基线对比；无不可接受退化 | 性能报告 |
| A12 | 迁移 | dry-run/备份/校验/回滚 | 迁移报告 |
| A13 | 灰度 | 100% + 观察期无 P0/P1 | 变更单 |
| A14 | 回滚 | 演练成功；无重复副作用 | 回滚报告 |
| A15 | 文档 | 03/04 可执行；链接有效 | 文档检查 |

---

## 15. 证据模板

```md
## 测试证据

- 日期：
- commit：
- Node/pnpm：
- Mastra/AI SDK/Zod：
- 命令：
- 环境：libsql/postgres/vector；Redis 有/无；真实 Provider 有/无
- 结果：通过 N，失败 M，跳过 K
- 覆盖场景：
- 失败/差异：链接到 issue/allowlist
- 性能：首 token/总时延/内存（对比 baseline）
- 结论：通过/有条件通过/不通过
- 附件：日志、report.json、截图（脱敏）
```

---

## 16. Definition of Done（测试视角）

- 无 Key 的离线套件全绿；真实 Provider 用例有 Key 时通过、无 Key skip。
- Parity 无未解释差异；allowlist 有负责人/到期日。
- 审批/取消/重启/热重载/迁移/回滚全部有 E2E。
- 跨群/跨用户/跨 bot/官方 ID 隔离通过。
- 写工具无重复执行；`effect_unknown` 有明确人工路径。
- 性能基线记录；退化在阈值内或产品接受。
- 测试报告可复现，命令/版本/环境完整。
