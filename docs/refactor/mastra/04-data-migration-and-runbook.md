# 04 · 数据迁移与运维 Runbook

> 适用：从 legacy（KV/文件/sqlite）迁移到 Mastra Memory/Storage（LibSQL/Postgres）。
>
> **前置决策**：本文的消息历史迁移只在 ADR-004 的 Phase 2 获批后执行。若 Phase 1（Mastra 只替换 Agent 循环、SessionStore 仍是历史真源）已满足目标，则不需要迁移消息历史；仍建议按本文完成备份/校验/回滚演练。
>
> 原则：**先只读、再 dry-run、再备份、再迁移、再校验、最后才切写**。任何一步失败都能回到 legacy，且不会重复执行工具副作用。
>
> 本文命令/脚本名为目标设计；PR5 实施时落地为 `scripts/migrate-mastra.mjs`。

---

## 1. 迁移前置条件（缺一不可）

| # | 条件 | 验证 |
|---|---|---|
| 1 | Node >= 22.13.0 | 宿主进程 `node -v` |
| 2 | `zod` >= 3.25.76（且 `zod-stagehand` 仍 4.4.3） | `node -e "console.log(require('zod/package.json').version)"` |
| 3 | 现有 147/0/12 测试全绿 | `pnpm test` |
| 4 | 官方 ID 冒号解析缺陷已修 | `#聊天列表`/`#清空所有记录` 对 `<appid>:<openid>` 的测试 |
| 5 | 新 identity 含 adapter+bot | thread/resource 单测 |
| 6 | 全量备份完成 | KV dump/文件 tar/sqlite backup/PG dump |
| 7 | 迁移脚本 dry-run 通过 | `--dry-run` 输出 0 error |
| 8 | 回滚脚本演练通过 | 在临时库跑一次 |
| 9 | 观察窗口/值班人确定 | 变更单 |

**不要**在以下情况迁移：

- 生产正跑长任务/定时任务高峰；
- 没有 Redis 且使用 `memoryKv`（重启即丢，先修持久化）；
- 多进程共享本地 LibSQL 文件（先切 Postgres）；
- 审批/任务账本处于大量 pending（先清空/处理）。

---

## 2. 数据清单与处置

| 数据 | 现状 | 目标 | 处置 |
|---|---|---|---|
| 会话消息 | KV `Yz:agent:sess:conv:*` | Mastra Memory thread/messages | **迁移**（Phase 2） |
| active 指针 | KV `conv:active:*` | 项目 SessionAdapter / Mastra thread metadata | 保留/迁移 |
| conv seq | KV `conv:seq:*` | 项目保留 | **不迁**（防旧归档复用） |
| legacy group:user | KV `Yz:agent:sess:*` | Mastra thread `..._scheduled`/legacy | 只读保留/可选迁移 |
| MEMORY.md/USER.md | 文件 | 项目 `MemoryStore` | **不迁**（继续文件真源） |
| Recall | KV `Yz:agent:mem:*` | 项目 `RecallStore` | **不迁**（继续 KV；后续可独立 DB） |
| Profile | KV `Yz:agent:profile:*` | 项目 `ProfileStore` | **不迁** |
| KB | KV + `vectors.bin` | 项目 `KnowledgeStore` | **不迁** |
| 压缩归档 | 文件 | 项目 `CompactionArchive` | **不迁**（保留 hash/convKey） |
| TaskStore | sqlite `data/tasks/tasks.db` | 项目 TaskStore | **不迁**；Workflow 只加投影字段 |
| Schedule | KV `Yz:agent:rem:jobs` | 项目 ScheduleStore | **不迁** |
| UsageStats | KV `agents:stats:day:*` | 项目 UsageStats | **不迁** |
| DevLog | 文件 | 项目 DevLog | **不迁** |
| 审批 | 内存 | ApprovalBridge（KV/sqlite） | **新建**；旧 pending 不迁（进程重启即丢） |
| 人设/资料 | 文件 | 项目 | **不迁** |
| ToolEvo | sqlite | 项目 | **不迁** |

**结论**：Mastra Storage 第一版只接管“消息历史 + Workflow snapshot（新增）+ 可选 observability”。不要把 Recall/Profile/KB/压缩/任务/日程全部搬进 Mastra——它们各有语义，强行迁移只会制造双真源。

---

## 3. Identity / Scope 规范（迁移核心）

### 3.1 规范

```text
adapter   = onebot | qqbot | qqguild
botId     = safeScopePart(ctx.selfId || 'bot')   // 官方完整 appid
scopeId   = ctx.scopeId（safeScopePart 后）
ownerKey  = `${botId}_${scopeId}`
resourceId = `yz_${adapter}_${ownerKey}`
threadId   = `yz_${adapter}_${ownerKey}_c${conversationId}`
scheduledThreadId = `yz_${adapter}_${ownerKey}_scheduled`
subThreadId = `yz_${adapter}_${ownerKey}_sub_${agentName}_${childTaskId}`
```

**必须含 botId**：现有 `scopeId` 不含 `self_id`，两个机器人账号共享同一数据目录时会串会话/记忆。迁移前在 identity 层补上；不要直接拼原始 `selfId`，先 `safeScopePart`。

### 3.2 示例

| 场景 | scopeId | resourceId | threadId |
|---|---|---|---|
| 私聊用户 123 | `u_123` | `yz_onebot_<bot>_u_123` | `yz_onebot_<bot>_u_123_c1` |
| 群 456 用户 123（隔离） | `g456_u123` | `yz_onebot_<bot>_g456_u123` | `yz_onebot_<bot>_g456_u123_c1` |
| 群 456 共享（isolation=false） | `g456` | `yz_onebot_<bot>_g456` | `yz_onebot_<bot>_g456_c1` |
| 官方 `<appid>:<openid>` | `u_<safe>` | `yz_qqbot_<bot>_u_<safe>` | `yz_qqbot_<bot>_u_<safe>_c1` |
| 定时任务 | 同创建者 | 同创建者 | `..._scheduled` |
| 子 Agent | 同父 | 同父（或独立） | `..._sub_worker_<uuid>` |

### 3.3 字符/长度

- 只允许 `[A-Za-z0-9_-]`；`adapter`/`agentName` 先 sanitize。
- 总长 ≤128；超长用 `sha256` 前 12 位截断（保留可读前缀）。
- 不允许空字符串；空则用 `unknown` + 短哈希。
- 官方 ID 不直接拼接冒号；必须经 `safeScopePart`。

### 3.4 冲突测试（必须）

- 同一用户私聊 vs 群聊 → 不同 resource。
- 同一群共享 vs 成员隔离 → 不同 resource。
- 两个 bot 账号同群同用户 → 不同 resource。
- 同 conversationId 不同 resource → 不同 thread。
- 官方 ID 含 `:`/`qg_`/超长/中文 → 不冲突、不路径穿越。
- `threadId` 创建后换 resource → 必须报错（Mastra owner 校验）。

### 3.5 既有缺陷修复（迁移前）

- `SessionStore.listAll`（`model/agent/session.js:141-143`）用 `split(':')` 解析 group/user。
- `listAllConversations`（`session.js:249-252`）用最后两段推断 user/group。
- `#清空所有记录`（`apps/agent.js:4117-4129`）用 `parts[2]/[3]`。
- 修法：所有解析改为“已知 key 构造 + 结构化元数据”，不要把 ID 拼进可分割字符串；或增加 `conversation_meta`（scope_group/scope_user）表/字段。**先修再迁移**，否则 Mastra thread 会把错误放大。

---

## 4. 迁移阶段

### 阶段 0 · 盘点

```bash
node scripts/migrate-mastra.mjs --inventory --json > /tmp/mastra-inventory.json
```

输出：

```json
{
  "kv": { "conversations": 1234, "legacySessions": 56, "recallKeys": 789, "profileKeys": 789, "kbDocs": 12, "scheduleJobs": 8 },
  "files": { "memories": 789, "archives": 321, "vectors": 2 },
  "sqlite": { "tasks": 42, "tevoVersions": 3 },
  "scopes": [{ "scopeId": "g456_u123", "conversations": 3, "messages": 120 }],
  "warnings": ["official-id-colon", "no-redis"]
}
```

### 阶段 1 · Dry-run

```bash
node scripts/migrate-mastra.mjs \
  --source kv,file,sqlite \
  --target libsql \
  --dry-run \
  --report /tmp/mastra-dryrun.json
```

Dry-run 必须：

- 只读源；不写目标（或写临时库）。
- 逐 scope 计算将创建的 thread 数、消息数、冲突数。
- 校验 identity：无空/超长/非法字符/owner 冲突。
- 校验消息：role/content/tool_calls/tool_call_id 配对；损坏值列出。
- 校验压缩归档 ref 可解析（hash/convKey）。
- 输出 0 error 才允许下一步。

### 阶段 2 · 备份

```bash
# Redis（若使用）
redis-cli --scan --pattern 'Yz:agent:*' | sort > /tmp/yz-keys.txt
while read k; do redis-cli --raw GET "$k" > "/tmp/kv-dump/$(echo "$k" | tr '/:' '__')"; done < /tmp/yz-keys.txt

# 文件
tar czf /tmp/agents-data-$(date +%Y%m%d%H%M).tgz data/memories data/context-archive data/vectors data/tasks data/personas data/persona-lore

# SQLite
sqlite3 data/tasks/tasks.db ".backup '/tmp/tasks-$(date +%Y%m%d%H%M).db'"

# Postgres（如已是目标）
pg_dump --format=custom --schema=mastra "$MASTRA_DATABASE_URL" > /tmp/mastra.dump
```

备份校验：文件非空、sqlite `PRAGMA integrity_check`、PG `pg_restore --list` 可读。备份放到与生产不同的故障域。

### 阶段 3 · 初始化目标存储

```bash
# LibSQL：创建目录/文件
mkdir -p data/mastra

# Postgres：部署阶段 init
node scripts/migrate-mastra.mjs --init-storage --target postgres
```

`init()` 需要建表/索引权限；运行时账号只 DML。记录 schema 版本。

### 阶段 4 · 导入

```bash
node scripts/migrate-mastra.mjs \
  --target libsql \
  --mode conversations \
  --batch-size 50 \
  --checkpoint /tmp/mastra-checkpoint.json \
  --report /tmp/mastra-import.json
```

导入算法：

```text
for each scope in inventory:
  resourceId = identity.resource(scope)
  ensureThreadOwner(resourceId)                   # 不存在则创建
  for each conversation:
    threadId = identity.thread(scope, convId)
    createThreadIfMissing({ id: threadId, resourceId, title, metadata })
    if thread exists and owner != resourceId: record conflict, skip, fail scope
    for each message batch:
      stableMessageId = sha256(threadId + seq + role + content + toolCallId)  # 幂等
      upsert/append message with stable id
      if message already exists with same hash: skip (idempotent)
    write checkpoint {scope, threadId, lastSeq, count}
```

规则：

- **稳定 message id**：不要用随机 UUID；用 `threadId+seq+hash`，保证断点续传幂等。
- **顺序**：按原数组顺序；`assistant(tool_calls)` 与后续 `tool` 必须同批/连续，不能拆。
- **元数据**：`cacheEpoch`/`compactLedger`/`activeTools` 写入 thread metadata 或项目侧 conversation meta；不要丢（prompt cache/压缩依赖）。
- **压缩归档**：不导入 Mastra；保留文件。ledger 中的 `archive_refs` 继续指向原文件；`context_recall` 仍按 convKey 读。
- **损坏值**：`SessionStore` 对坏值返回 null/拒绝写；迁移时记录并跳过，不覆盖、不猜测。
- **失败隔离**：单 scope 失败不影响其它；报告列出 scope/原因；可重试。
- **断点续传**：每批写 checkpoint；重跑从 lastSeq 继续；已存在同 hash 消息跳过。
- **不双写**：导入期间 legacy 仍可读；**停止写入**后再做最终增量，或切换写开关。不要在导入时同时让 legacy 与 Mastra 写同一会话。

### 阶段 5 · 校验

```bash
node scripts/migrate-mastra.mjs --verify --target libsql --sample 5% --report /tmp/mastra-verify.json
```

校验项：

| 项 | 方法 | 通过标准 |
|---|---|---|
| thread 数 | 源 scope×conv vs 目标 | 相等（除明确跳过） |
| 消息数 | 每 thread 源/目标 | 相等；允许压缩归档后的差异需说明 |
| 顺序 | 抽样首/中/尾 | role/tool_call_id 顺序一致 |
| 工具配对 | 每个 assistant(tool_calls) 有对应 tool | 0 孤儿 |
| 内容 hash | 抽样 5% 消息 | hash 一致 |
| owner | 每 thread resourceId | 与 identity 计算一致 |
| 元数据 | cacheEpoch/ledger/activeTools | 存在且类型正确 |
| 归档 ref | ledger.archive_refs | 文件存在且 hash 校验通过 |
| 隔离 | 跨群/跨用户/跨 bot | 无交叉 thread |
| Web | `/api/sessions` | 可读、条数/预览一致 |

抽样 hash 示例：

```bash
node scripts/migrate-mastra.mjs --hash-sample 100 --target libsql
```

### 阶段 6 · 切写

1. 暂停写入：切换维护窗口/停止接收新消息（或只读模式）。
2. 做最后一次增量导入（从 checkpoint）。
3. 校验通过。
4. 配置 `agent.mastra.memory.mode=mastra`（灰度用户/群）。
5. 新请求只写 Mastra；legacy SessionStore 只读/不再写。
6. 观察错误率/延迟/回复质量。

**禁止**：切换后继续双写。若必须双读，明确“Mastra 是唯一写，legacy 只读”。

### 阶段 7 · 观察与清理

- 观察期建议 ≥2 周或 ≥1 发布周期。
- 监控：thread 创建失败、消息写入失败、owner 冲突、压缩/归档失败、审批 pending、回复失败。
- 旧 KV/文件保留只读；不要立即删。
- 清理条件：无回滚、无缺失、备份可恢复、产品确认。

---

## 5. 各数据迁移细节

### 5.1 会话消息

- 源：`Yz:agent:sess:conv:<gid>:<uid>:<convId>` 的 `{messages,...}`。
- 目标：thread + messages；`title`/`createdAt`/`updatedAt` 放 thread metadata。
- 工具消息：`role:'tool'` + `tool_call_id` + `name` + `content`；AI SDK `tool-result` parts 由 `MessageAdapter` 生成。
- reasoning/provider_native：保留在消息 metadata；Anthropic signature 不能丢。
- 压缩消息：`【上下文压缩档案...】` 是普通消息；迁移时保留；ledger 关联 archive_refs。
- 并发：导入时单线程/单 scope 串行；不要用多 worker 写同一 thread。

### 5.2 active 指针 / 多对话

- `conv:active:*` 不必迁入 Mastra；由 SessionAdapter 维护（可存在项目 KV/DB）。
- `#new` 仍用现有 seq；不要重置，否则旧归档目录可能被复用。
- Web `/api/conversations` 读 SessionAdapter；Phase 2 可从 Mastra `listThreads` + metadata 组合。

### 5.3 声明式记忆

- 不迁。继续 `data/memories/<scopeId>/MEMORY.md|USER.md`。
- 迁移后 scopeId 不变；不要改成 threadId，否则文件路径/Web 视图全变。
- 备份/恢复按目录；人可编辑。

### 5.4 Recall / Profile

- 不迁。继续 KV。
- 若未来要迁 DB：保留 `prev[]`/`status`/`confidence`/`evidence`/`injected`/`used`；不要只存 content。
- 与 Mastra Semantic Recall 去重：默认关闭；开启时用独立 index，且不要把 Recall 条目重复 embedding。

### 5.5 KB / 向量

- 不迁。继续 `Yz:agent:kb:__global__` + `data/vectors/kb`。
- 若换 embedder/维度：先 `#知识库重建`，再切；保留旧 vectors.bin 备份。
- Mastra Vector 只用新 index（如 `memory_messages`），不要复用 `kb` index。

### 5.6 压缩归档

- 不迁。保留 `<convKey>/<epoch>-<hash16>.json`。
- ledger 的 `archive_refs` 与 `convKey` 必须继续可解析；`context_recall` 仍按 `scopeUser:group:conv` 计算 convKey。
- 迁移后 conversationId 不变；threadId 只是 Mastra 映射，不替代 convKey。
- 若未来移动归档目录：必须原子迁移 refs 或保留只读旧目录；不能只改目录不改 ledger。

### 5.7 TaskStore / Schedule / Usage

- 不迁。TaskStore 继续 sqlite；Workflow 新增 `workflow_run_id` 投影字段（可选）。
- Schedule 继续 KV+node-schedule；迁移不影响触发。
- Usage 继续 KV 日聚合；Mastra usage 映射到同一 `recordRun`。
- 审批：新建 ApprovalBridge（KV/sqlite），旧 pending 不迁；切换时先清空/处理旧 pending。

### 5.8 审批迁移/恢复

1. 切换前：`#待确认` 处理完；或记录并取消。
2. 新审批写 Bridge：`{id,runId,toolCallId,toolName,argsHash,threadId,resourceId,status,createdAt,expiresAt}`。
3. 进程重启：扫描 `status=pending`；对每个调 `agent.listSuspendedRuns({threadId,resourceId})`。
   - 找到同 `toolCallId` → 恢复映射；通知主人。
   - 找不到 → `expired`；不执行。
   - `argsHash` 不匹配 → `conflict`；拒绝。
4. 批准/拒绝：CAS；成功后 `approveToolCall`/`declineToolCall`；失败保持 pending 或标记 error。
5. 超时：`declineToolCall`（可用时）或标记 expired；绝不自动执行。
6. 防重：Adapter 的 `runId+toolCallId` 幂等检查 + TaskStore `tool_started`/`tool_result`。

---

## 6. 回滚

### 6.1 回滚触发

- 迁移校验失败、P0/P1 事故、回复质量明显下降、工具重复执行、隔离串数据、storage 不可用。

### 6.2 回滚步骤（消息历史）

1. 配置 `agent.mastra.memory.mode=history-adapter`（或 `runtime.engine=legacy`）。
2. `facade.abortAll()`，等待在途 run settle。
3. 停止写 Mastra；保留 Mastra 数据（不要删）。
4. legacy 继续读旧 SessionStore/KV（未删）。
5. 若切写后 legacy 未更新：把 Mastra 中新增消息按 thread→conv 映射**只读导出**，人工决定是否回填；不要自动双写。
6. 校验最近 N 条会话/回复；确认无重复工具副作用。
7. 记录回滚时间/原因/数据差异。

### 6.3 回滚步骤（审批）

- 切回 ConfirmStore；Bridge pending 标记 `rolled_back`；不自动批准。
- 已在 Mastra 批准的 run：让它完成或取消；不要用 legacy 重放同一工具。

### 6.4 回滚步骤（Storage）

- Postgres → LibSQL：配置切回；保留 PG 数据；不要删 schema。
- LibSQL 文件损坏：从备份恢复；核对 WAL。
- schema 升级失败：用 `pg_restore`/文件备份回滚；记录 Mastra schema 版本。

### 6.5 回滚禁区

- 不要在工具已执行后自动切换引擎重跑。
- 不要删除旧 KV/文件/归档，直到观察期结束。
- 不要用 Mastra 的“重放/恢复”去补 legacy 的写操作；副作用可能重复。

---

## 7. 部署 Runbook（灰度）

### 7.1 发布前

- [ ] 备份完成并校验
- [ ] `pnpm test` 全绿
- [ ] dry-run 0 error
- [ ] Postgres/LibSQL 健康
- [ ] 审批 Bridge 正常
- [ ] 回滚脚本演练
- [ ] 值班/观察窗口

### 7.2 发布顺序

1. 部署代码（`engine=legacy`，Mastra 依赖已装但未启用）。
2. 初始化 storage（如未做）。
3. 打开 `engine=mastra`，`gray.users=[testUser]`。
4. 验证：单聊、群聊、工具、审批、取消、重启、Web 会话。
5. 扩到 `gray.groups=[testGroup]`。
6. 5% → 25% → 50% → 100%（每步观察 ≥24h 或按变更单）。
7. 100% 后进入 soak；不立即删 legacy。

### 7.3 监控指标

| 指标 | 来源 | 告警阈值（建议） |
|---|---|---|
| run 成功率 | DevLog/UsageStats | 较 baseline 下降 >5% |
| `run_error`/`reply_failed` | terminal 事件 | 突增 2x |
| P95 时延/首 token | DevLog | 较 baseline +30% |
| 工具失败率 | UsageStats byTool | 突增 |
| 审批 pending/超时 | ApprovalBridge | pending > N 或超时率 >10% |
| storage 错误 | health/日志 | 任何持续错误 |
| thread owner 冲突 | 迁移/健康 | >0 |
| 内存/连接数 | 进程/health | 持续上涨 |
| 重复副作用 | TaskStore `effect_unknown` | >0 需人工 |

### 7.4 告警处置

- `thread owner conflict`：停止该 scope 写入；核对 identity；不要强行改 owner。
- `storage unavailable`：切回 legacy 读；不要继续写 Mastra。
- `approval expired`：通知主人；不自动执行。
- `effect_unknown`：停止自动恢复；人工核对外部状态。
- `message write failed`：降级为 legacy 单写；记录差异。

---

## 8. 灾难恢复

### 8.1 LibSQL

- 备份：停写后复制 `data/mastra/*.db`（含 `-wal`/`-shm`）或用 `.backup`。
- 恢复：停进程 → 替换文件 → 校验 `PRAGMA integrity_check` → 启动 → `health()`。
- 损坏：从最近备份 + 旧 KV 重建（消息可重放导入）。

### 8.2 Postgres

- 备份：`pg_dump --format=custom --schema=mastra`；定期演练 `pg_restore` 到临时库。
- 恢复：新建 schema/库 → restore → 校验表/行数 → 切连接串。
- PITR：按组织 WAL 策略；Mastra 表与业务表同库时注意恢复一致性。

### 8.3 数据丢失

- 旧 KV/文件保留只读 → 可从源重建。
- 消息稳定 id/hash → 可幂等重导。
- 审批/Workflow snapshot 丢失 → 不自动恢复写操作；人工核对。
- 归档丢失 → ledger 的 refs 会失败；`context_recall` 返回明确错误，不伪造原文。

### 8.4 多进程/多实例

- 本地 LibSQL 文件只允许单进程写；多实例必须 Postgres。
- 锁：现有 SessionStore 锁是进程内；Mastra storage 有自己的并发控制，但项目侧仍需 per-thread 单飞（`convRunQueues`）或 DB 唯一约束。
- 定时任务：多实例会重复触发；现有 `ScheduleStore` 无分布式锁，迁移不解决；需单独评估（不要用 Mastra Schedules 掩盖）。

---

## 9. Storage 升级

1. 读 Mastra 对应版本 storage migration 指南。
2. 备份目标库。
3. 在临时库跑 `storage.init()`/迁移脚本。
4. 校验 schema/索引/行数。
5. 生产维护窗口执行；`disableInit:true` 时先手动 init。
6. 回滚：恢复备份；保留旧 schema。
7. 记录版本/日期/执行人。

---

## 10. 迁移验收清单

- [ ] 源/目标 thread 数、消息数、抽样 hash 一致
- [ ] 工具调用/结果配对 0 孤儿
- [ ] 压缩 ledger/archive_refs 可恢复
- [ ] cacheEpoch/activeTools 保留
- [ ] 多对话/active 指针/标题/预览一致
- [ ] 群共享/私聊/跨群/跨 bot 隔离
- [ ] 官方 ID 不串、不清错
- [ ] Web `/sessions`/`/conversations` 可读
- [ ] 审批 pending 可发现/恢复/超时不执行
- [ ] 重启后历史/审批/任务状态正确
- [ ] 写工具无重复执行
- [ ] 回滚演练成功
- [ ] 观察期无 P0/P1
- [ ] 旧数据只读保留期与删除审批
