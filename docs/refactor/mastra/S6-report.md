# S6 / PR5a 实施报告（Memory Phase 1）

> 对应 [07 开发计划](07-development-plan.md) 的 **S6 / PR5a**。
> 状态：**完成**。历史唯一真源仍是 SessionStore；Mastra Memory 未启用、无双写。
> 后续 Phase 2（PR5b）不在本次范围。

---

## 1. 交付物

| 路径 | 内容 |
|---|---|
| `model/runtime/message-adapter.js` | legacy OpenAI-style ↔ AI SDK/Mastra 消息；多模态、工具、reasoning、Anthropic provider_native |
| `model/runtime/chat-runner.js` | 显式历史/当前多模态输入；压缩/ledger/archive/cacheEpoch；全量覆写/追加 |
| `model/agent/session.js` | 对话 scope 元数据（官方 ID 不被键名 split 截断） |
| `apps/agent.js` | 官方 ID 清空记录修复（按对话元数据归属 + 精确 active key） |
| `model/runtime/test/message-adapter.test.mjs` | 多模态/工具/reasoning/provider_native 往返 |
| `model/runtime/test/chat-runner-isolation.test.mjs` | 多对话/active/删除/群共享/私聊/跨群隔离 |
| `model/runtime/test/chat-runner-compaction.test.mjs` | 压缩/归档/ledger/cacheEpoch 写回 |
| `model/runtime/test/contracts/official-id.test.mjs`（改） | `listAllConversations` 官方 ID 修复断言 |
| `stress/e2e/official-id-clear.mjs`（改） | 官方 ID `#清空所有记录` 修复断言 |

---

## 2. MessageAdapter

### 2.1 legacy → Mastra

- `text` / `image_url` / Anthropic `image(source.base64)` / `document` / `input_audio` / Gemini `image/audio/document`；
- `tool_calls` → AI SDK `tool-call`（arguments 解析为对象）；
- `role:'tool'` → `tool-result`（toolCallId/name 配对）；
- `reasoning` → `reasoning` part；
- Anthropic `provider_native.content`：
  - `thinking` → `reasoning` + `providerOptions.anthropic.signature`
  - `redacted_thinking` → `providerOptions.anthropic.redactedData`
  - `text` / `tool_use` → 原顺序保留；
- 未知块转 JSON 文本，不丢整条消息。

### 2.2 Mastra → legacy

- assistant `tool-invocation` → `assistant.tool_calls` + `role:'tool'` 结果；
- `text` → `content`；
- `reasoning` → `reasoning`，Anthropic signature 重建 `provider_native`；
- user `image/file` → `image_url`/文件占位；
- 保留会话历史顺序与工具配对。

### 2.3 当前轮多模态

- `currentUserContent(input, userText)` 保留图片/文件块，只替换文本块；
- 多模态不再整体回退 legacy。

---

## 3. 压缩 / ledger / archive / cacheEpoch

Mastra 路径继续使用 legacy 的压缩实现：

- 载入 `SessionStore.getConversationState()` 的 `cacheEpoch`/`compactLedger`；
- 组装 system 后按 `contextWindow × highRatio` 判断；
- 使用 `compactMessages()`：
  - 内容寻址归档 `CompactionArchive`；
  - `prevLedger` 合并；
  - `cacheEpoch++`；
- 发生压缩时 **全量覆写** 对话（`setConversation`/`set`），否则追加；
- 同时写回 `cacheEpoch` 与 `compactLedger` extra；
- 压缩失败保留原历史，不阻塞聊天。

---

## 4. 多对话 / 隔离

测试使用真实 `SessionStore`：

- u1/g1 的两个对话互不串；
- u2/g1、u1/g2、u1 私聊互不串；
- active 切换、删除后 active 回退；
- 群共享 `__group__:<gid>` 独立；
- Runner 只写 SessionStore，无 Mastra Memory 双写。

### 官方 ID 修复

- `createConversation` 写入 `scopeUserId`/`scopeGroupId` 元数据；
- `listAllConversations` 优先读元数据，官方 ID 不再被 `split(':')` 截断；
- `#清空所有记录` 按对话对象归属判断，并精确删除 active key；
- `listAll()` 旧式 group:user 会话仍保留已知解析缺陷（无元数据），留待 PR5b 迁移。

---

## 5. Web 兼容

- `/api/conversations` 全局列表使用修复后的 `listAllConversations`，返回完整 `scopeUserId/scopeGroupId`；
- `/api/sessions` 用完整 `userId/groupId/convId` 精确读取，不受键名解析影响；
- 历史仍为 legacy 消息形态，现有面板可直接读取。

---

## 6. 测试

| 指标 | 结果 |
|---|---|
| 测试文件 | **173 通过 / 0 失败 / 12 跳过（185）** |
| 断言 | **7,982** |
| Lint | **0 errors / 50 warnings** |

新增/修改：MessageAdapter 25、隔离 41、压缩 8、官方 ID 15、清空 5。

---

## 7. 真机 / 上线

（部署运行后补：Yunzai 启动、QQ READY、legacy/Mastra gray 状态、S6 无异常）

---

## 8. 边界

- Phase 1 不启用 Mastra Memory，不做 KV → LibSQL 迁移；
- 跨 bot 的 SessionStore 历史仍未按 bot 命名空间隔离（Identity 层已区分；历史键改造留 PR5b）；
- `listAll()` 旧式会话官方 ID 解析缺陷保留；
- 压缩归档/ledger 与 legacy 共用；Mastra 路径已覆盖，但未做大规模长会话压测。
