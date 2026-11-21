# PR4a 实施报告（S4 后半 · Mastra 非流式聊天灰度）

> 对应 [07 开发计划](07-development-plan.md) 的 **S4 / PR4a**。
> 状态：**完成（灰度非流式）**。默认 legacy；仅 `runtime.engine=mastra` 且命中 `runtime.gray` 时走 Mastra。
> PR3b（写工具/持久审批/TaskStore）见 [PR3b-report.md](PR3b-report.md)。

---

## 1. 交付物

| 路径 | 内容 |
|---|---|
| `model/runtime/chat-runner.js` | Mastra Agent 非流式 Runner：上下文装配、历史、工具、usage、持久化 |
| `model/runtime/message-adapter.js` | SessionStore 历史 ↔ AI SDK/Mastra 消息；工具调用/结果配对 |
| `model/runtime/facade.js` | `shouldUseMastra()` 灰度选择；命中 Runner，不支持时安全回退 |
| `model/runtime/factory.js` | engine=mastra 时创建 Runner（仅动态加载） |
| `apps/agent.js` | 主聊天 `rt.runtime.runChat(input, {agentInst})`；legacy 原路径保留 |
| `model/runtime/tool-adapter.js` | `requireApproval` + 旧 ConfirmStore 阻塞审批兼容模式 |
| `model/runtime/test/chat-runner.test.mjs` | 文本/工具/写审批/回退/空输出 |
| `model/runtime/test/facade.test.mjs`（扩展） | 灰度用户/群/百分比、Runner 回退 |

---

## 2. 灰度与回退

```yaml
agent:
  runtime:
    engine: mastra
    gray:
      users: [tester]
      groups: []
      percent: 0
```

- `engine=legacy` → 永远 legacy；
- `engine=mastra` 但用户/群/百分比未命中 → legacy；
- 命中后 Runner 只在**模型/消息准备阶段**返回 `unsupported` 时回退（多模态、流式、Gemini/Azure、thinking 自定义字段、空会话某形态）；
- **模型/tool 已执行后不再回退**：空输出/异常直接抛错，避免重复副作用；
- 默认空 gray = 不切流量。

---

## 3. Runner 行为

### 3.1 上下文

复用 legacy Agent 的装配器：

- 历史：`SessionStore.getConversation()` / `get()`；
- system：`agentInst._assembleSystem()`（身份/服务准则/工具目录/技能/guard）；
- 动态：recall、profile、MEMORY 快照、情境按 legacy 方式拼到本轮 user 消息尾部；
- 消息：`legacyToMastraMessages()` 转换，显式传给 Mastra（Phase 1 不让 Memory 接管）。

### 3.2 工具

- `adaptTools(..., allowWrite:true)`；
- PR4a 的写审批使用**旧 ConfirmStore 阻塞**（`#确认/#拒绝/#待确认`、Web `/api/confirm` 原样可用），不进入 Mastra suspend；
- PR3b 的原生 `ApprovalBridge`/`approveToolCallGenerate` 已实现并有真实 Mastra E2E，但 PR4a 默认不启用（避免灰度期审批恢复链路未稳定时改变命令语义）；PR4c 再切。

### 3.3 结果

- `content`：`out.text`；
- `stopReason`：AI SDK finishReason → legacy 口径（Anthropic `end_turn`、OpenAI `stop`、tool calls 等）；
- `usage`：`normalizeAiSdkUsage(out.totalUsage || out.usage)`；
- `turns`：steps 数；
- 持久化：`mastraMessagesToLegacy(out.messages)`，剥离输入历史前缀后写回 SessionStore（含 tool_calls/tool 结果配对）；
- TaskStore：Runner 在存在 taskStore 时 `begin`/`finish`，Adapter 的 planned/started/result 守卫可生效。

### 3.4 已知能力边界

- 仅非流式、纯文本；多模态/流式回退 legacy；
- 不实现 legacy 的 finalizer/反思/循环护栏（Mastra `maxSteps` 兜底）；灰度测试用户使用简单对话；
- 不支持 Gemini/Azure（legacy-only）；DeepSeek 等自定义 thinking 字段回退 legacy；
- narration（中途播报）在非流式 Runner 中不额外发送。

---

## 4. 测试

| 指标 | 结果 |
|---|---|
| 测试文件 | **169 通过 / 0 失败 / 12 跳过（181）** |
| 断言 | **7,890** |
| Lint | **0 errors / 50 warnings** |

新增：

- `chat-runner.test.mjs`（18）
- `facade.test.mjs` +7
- `runtime-facade-wiring.mjs` +1（改为断言 Runner 就绪/灰度未命中不切）

---

## 5. 真机验证

### 5.1 隔离说明（重要）

同机 `/root/Yunzai/plugins/yuncat` 也会响应私聊消息；早期用 `#ai` 私聊的“真机回复”可能由 YunCat 接管，不能作为本插件全链路证据。
本次验证：

1. 临时把 `plugins/yuncat` 移出 `plugins/`；
2. 临时把 `plugins/adapter/stdin.js` 的 `user_id` 改为 `tester`（原为 `stdin`，会被本插件“忽略自身消息”过滤）；
3. 配置 `runtime.engine=mastra`、`gray.users:['tester']`；
4. 验证后恢复 YunCat、stdin.js 与默认 legacy 配置。

### 5.2 完整 Yunzai 链路

日志：`/tmp/opencode/pr4a-full2.log`

```
[trigger] user=tester gid=- mode=at inputLen=23 media=false
[runtime] runChat engine=mastra chat=mastra user=tester gray=yes
[runtime] Mastra 灰度回复 model=deepseek-v4.1-flash turns=1 tools=0
[stdin] full2-ok
```

- 面板：`运行时：mastra（storage=libsql，灰度 u=1 g=0 0%）`
- 真实 `opencode-go / deepseek-v4.1-flash`，约 3.4s
- 退出：`Facade 已关闭（scope_close）`，code 5

### 5.3 非灰度隔离

默认配置（无 runtime/gray）下，`runChat` 走 legacy；`runtime-facade-wiring` E2E 断言 `chatEngine=mastra` 但 `shouldUseMastra` false，不切流量。

---

## 6. 回滚

- 配置 `runtime.engine=legacy` 或清空 `runtime.gray`；
- 在途 run 由 `Bot.exit`/scope 关闭取消；
- 不删除 Mastra 数据库；legacy 继续读 SessionStore；
- 未改现有命令/ConfirmStore/Web API 契约。

---

## 7. 结论

**S4 完成（PR3b + PR4a 非流式灰度）**：

- 写工具、审批、TaskStore 守卫 + 原生 Mastra suspend/approve E2E；
- 灰度用户真实走 Mastra Agent，保留工具/记忆/画像/历史/回复；
- 默认 legacy，空 gray 不切流量，模型/tool 已执行后不回退；
- 非流式限制与审批模式已在 §3.4/§3.2 明确。

下一步：PR4b 流式/取消/灰度扩群；PR4c 原生 ApprovalBridge 接入聊天并支持重启恢复。
