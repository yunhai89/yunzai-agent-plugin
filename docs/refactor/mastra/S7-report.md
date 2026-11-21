# S7 / Memory Phase 2 实施报告（Mastra Memory 接管）

> 对应 [07 开发计划](07-development-plan.md) 的 **S7 / PR5b**。
> 状态：**完成**（ADR-004 Phase 2 于 2026-11-21 获批）。
> 历史唯一写：`memory.mode=mastra` 时由 Mastra Memory 接管；SessionStore 只读/迁移源，**不双写**。

---

## 1. 交付物

| 路径 | 内容 |
|---|---|
| `model/runtime/memory-bridge.js` | `MastraMemoryBridge`：thread/resource、conversation API、active/seq、状态、删除/清空、owner 校验、按需迁移 |
| `model/runtime/message-adapter.js` | 新增 `legacyToMastraDbMessages` / `mastraDbMessagesToLegacy`；工具调用/结果、reasoning、Anthropic provider_native、多模态 |
| `model/runtime/memory-migrate.js` | 迁移核心：inventory、dry-run、apply、verify、rollback、checkpoint、稳定 message id |
| `scripts/migrate-mastra.mjs` | CLI：Redis/JSON 源、LibSQL/Postgres 目标、备份、dry-run/apply/verify/rollback |
| `model/runtime/mastra-runtime.js` | `memory.mode=mastra` 时创建 `@mastra/memory`，关闭时 `settled()` |
| `model/runtime/factory.js` | 创建 MemoryBridge，交给 Facade/chat-runner |
| `apps/agent.js` | `rt.session` 切换到 MemoryBridge；`#清空所有记录` 清理 Mastra thread |
| `model/runtime/chat-runner.js` | 读写走 MemoryBridge；压缩/ledger/cacheEpoch 写入 thread metadata |
| `config/default_config/config.yaml` | `memory.mode/onDemandMigration`、`mastra.identity.botId/adapter` |
| `model/runtime/test/memory-bridge.test.mjs` | 42 断言：API/隔离/owner/并发/重启/清空/按需迁移 |
| `model/runtime/test/chat-runner-memory.test.mjs` | 14 断言：只写 Mastra、二轮历史、压缩、跨 bot |
| `model/runtime/test/memory-migrate.test.mjs` | 29 断言：dry-run/apply/verify/幂等/回滚/冲突/归档 |
| `model/runtime/test/migrate-cli.test.mjs` | 11 断言：CLI 端到端与安全门 |
| `model/runtime/test/factory-memory.test.mjs` | 6 断言：Facade/rt.session 接线 |
| `model/runtime/test/mastra-runtime.test.mjs` | 新增 Memory 创建/health/关闭 |
| `model/web/api.memory.test.mjs` | 12 断言：`/conversations`、`/sessions` 兼容 |
| `stress/e2e/mastra-memory-wiring.mjs` | 9 断言：真实 apps runtime → rt.session/Agent/Web 同源 |

---

## 2. MemoryBridge

### 2.1 身份与隔离

- `resourceId = yz_<adapter>_<botId>_<scopeId>`；`threadId = ..._c<conversationId>`。
- 官方 ID 先经 `safeScopePart`；threadId 超 128 字符时保留前缀 + 稳定 hash。
- `getThreadById({threadId, resourceId})` owner 校验；同 thread 换 resource → `memory_thread_owner_conflict`。
- 跨用户/群/bot 用不同 resource/thread；Web 全局列表用元数据（scopeUserId/scopeGroupId/adapter/botId/scopeId）。

### 2.2 conversation API

`MastraMemoryBridge` 继承 `SessionStore` 以复用 active/seq/旧 group:user 路径，但 conversation 消息全部走 Mastra：

- `createConversation` / `listConversations` / `listAllConversations`
- `getActiveConversation` / `setActiveConversation` / `peekActiveConversation`
- `getConversation` / `appendConversation` / `setConversation`
- `getConversationState` / `getConversationMeta` / `historyLength`
- `deleteConversation` / `clearAllConversations`

状态（`cacheEpoch` / `compactLedger` / `activeTools`）写入 thread metadata；`setConversation` 会显式清空旧 activeTools/ledger，避免浅合并残留。

### 2.3 单写 / 双读

- 默认 `memory.mode=sessionstore`，行为不变。
- 切到 `mastra` 后：
  - 读：Mastra thread 优先；未迁移的 legacy 对话仍可列出/读取（双读）。
  - 写：只写 Mastra；legacy 不再追加。
  - `onDemandMigration=true` 时，首次读取未迁移对话会以稳定 id 导入 Mastra；导入后继续读写 Mastra。
- 压缩仍复用 `compactMessages`；压缩后 `setConversation` 全量覆写 Mastra 消息，同时写回 ledger/epoch。

---

## 3. 消息适配

`legacyToMastraDbMessages` 生成 `content.format=2.parts`：

- user：text / image_url / image / document / input_audio；
- assistant：text、reasoning、tool-invocation(state=call)；
- tool：tool-invocation(state=result)，args 从对应 call 补齐，结果尝试 JSON 解析；
- Anthropic provider_native：thinking signature / redacted_thinking / text / tool_use，按原顺序保留；
- 稳定 message id：`sha256(threadId + seq + role + content + tool_call_id + tool_calls)` 前 32 位，重跑幂等。

`mastraDbMessagesToLegacy` 反向重建：

- 只有真正含 call part 的 assistant 才生成 `tool_calls`，不会为每个 result 重复造 call；
- tool result 独立为 `role:'tool'`；
- 单 text user 还原为字符串；
- 无 Anthropic native 标记时不生成 provider_native，避免污染普通 OpenAI 历史。

---

## 4. 迁移脚本

### 4.1 命令

```bash
# 盘点 / dry-run
node scripts/migrate-mastra.mjs --redis-url "$YZ_REDIS_URL" --inventory --json
node scripts/migrate-mastra.mjs --source-json dump.json --dry-run

# 导入（写 Mastra；--yes 必填）
node scripts/migrate-mastra.mjs --source-json dump.json --apply --yes \
  --bot-id <botId> --adapter onebot \
  --checkpoint data/mastra/migration-checkpoint.json \
  --backup-dir data/mastra/backup

# 校验 / 回滚
node scripts/migrate-mastra.mjs --source-json dump.json --verify --sample 5
node scripts/migrate-mastra.mjs --rollback --yes --checkpoint data/mastra/migration-checkpoint.json
```

### 4.2 校验项

- thread 数 / 消息数；
- 顺序与逐条内容 hash（`--sample N` 可抽样）；
- assistant(tool_calls) ↔ tool 结果配对，目标无孤立 tool；
- thread owner / scope 元数据；
- `cacheEpoch` / `compactLedger` / `activeTools`；
- `archive_refs` 可读取、hash 一致（提供 archive 时）；
- 跨用户/群/bot 无交叉 thread。

### 4.3 安全

- dry-run 只读；apply 拒绝覆盖已有非空 thread（除非 checkpoint 显示同一 sourceHash 已完成）；
- `--apply` / `--rollback` 必须有 `--yes`；
- 备份源 JSON 到 `backupDir`；checkpoint 每 thread 落盘；
- 回滚只删本次新建 thread / 导入 message id；legacy KV 与压缩归档不动；
- 不打印 API Key/DSN，不修改 config.yaml。

---

## 5. Web / 命令

- `/api/conversations`：列表来自 `rt.session`（Bridge），保留 `scopeUserId/scopeGroupId`；全局列表仍可直接用。
- `/api/sessions`：按 `convId/userId/groupId` 读取 Mastra 消息，输出 legacy 消息形态。
- `#聊天列表` / `#进入聊天` / `#new` / `#清空所有记录` 继续走 `rt.session`，无需改命令实现。
- `#清空所有记录` 在 mastra 模式额外调用 `clearAllConversations`，删除该用户/群下所有 bot 的 thread 与 legacy 对话对象，并清 active。

---

## 6. 测试

| 指标 | 结果 |
|---|---|
| 测试文件 | **180 通过 / 0 失败 / 12 跳过（192）** |
| 断言 | **8,114** |
| Lint | **0 errors / 51 warnings** |

S7 新增覆盖：

- bridge 42：conversation/active/delete/状态/工具往返/按需迁移/官方 ID/隔离/owner/并发/重启/清空；
- chat-runner-memory 14：只写 Mastra、二轮历史、压缩、跨 bot；
- migrate 29 + CLI 11：dry-run/apply/verify/幂等/回滚/冲突/归档/安全门；
- factory 6 + runtime 5：Memory 创建/关闭/Facade 接线；
- Web 12：conversations/sessions；
- E2E 9：真实 apps runtime 的 rt.session/Agent/Web 同源。

---

## 7. 上线 / 回退

### 7.1 上线步骤

1. 备份 `data/`、`config/config.yaml`、压缩归档。
2. 运行 dry-run，0 error。
3. 运行 apply + verify。
4. 配置：
   ```yaml
   agent:
     runtime: { engine: mastra, gray: { users: [...], groups: [...] } }
     mastra:
       memory: { mode: mastra, onDemandMigration: true }
       identity: { botId: "<botId>", adapter: onebot }
   ```
5. 重启（代码/依赖）或热加载（仅配置）。
6. 观察 thread 创建失败、owner 冲突、压缩/归档失败、消息数异常。

### 7.2 回退

- 先 `--rollback --yes`（可选，只删本次导入）。
- 把 `memory.mode` 改回 `sessionstore`，重启/热加载。
- legacy KV 与归档保留；Mastra 数据不删。
- 切回后新消息写 legacy；Mastra 期间新增消息不会自动回填，需要按 04 Runbook 导出/人工处理。

### 7.3 真机验证（2026-11-21）

配置：`engine=mastra`、`gray.users=['tester']`、`memory.mode=mastra`、`onDemandMigration=true`，LibSQL `data/mastra/s7-live.db`；单进程直接走真实 `Chat` 入口，真实 `deepseek-v4.1-flash`。

第一进程：

```text
SESSION_CLASS MastraMemoryBridge
HISTORY_BACKEND mastra MEMORY {"mode":"mastra","ready":true}
Mastra 灰度回复 model=deepseek-v4.1-flash turns=1 tools=0
CONV_ID 1
HISTORY_ROLES ["user","assistant"]
HISTORY_HAS_TOKEN true
REPLIES ["思考中…","s7-live-one"]
```

第二进程（重启后）：

```text
RESTART_CONV 1
RESTART_BEFORE_ROLES ["user","assistant"]
RESTART_BEFORE_HAS_TOKEN true
RESTART_AFTER_ROLES ["user","assistant","user","assistant"]
RESTART_AFTER_COUNT 4
RESTART_REPLIES ["思考中…","S7-LIVE"]
```

确认：第一轮写入 Mastra，重启后仍读到第一轮历史；第二轮正确回答 `S7-LIVE`；DB 仅 1 个 thread（`yz_onebot_stdin_u_tester_c1`，4 条）。验证后已恢复 `engine=legacy`、`memory.mode=sessionstore`，删除测试 LibSQL 数据，pm2 重启且 QQ READY。

---

## 8. 边界

- 默认仍是 `engine: legacy`、`memory.mode: sessionstore`；S7 不改变默认行为。
- 多 bot 同进程时，聊天请求用 `ctx.selfId` 区分 thread；Web/无 ctx 路径使用 `mastra.identity.botId`（或官方 ID 前缀推断）。多账号部署建议显式配置或分数据目录。
- 旧 `group:user` 非 conversation 路径仍走 SessionStore（S7 只接管 conversation 历史）。
- Postgres 真实 DSN、Gemini 仍未在本次真机验证；对应测试自跳过。
- 迁移不搬 Recall/Profile/KB/Task/Schedule/ToolEvo/压缩归档；它们继续用原存储。
- Mastra Memory 的 Observational Memory / Working Memory / Semantic Recall 仍关闭。
