# PR1 实施报告（S1 · 依赖与运行时骨架）

> 对应 [07 开发计划](07-development-plan.md) 的 **S1 / PR1**。
> 基线：PR0 完成后的 `dev` 工作树。
> 目标：**可创建/关闭嵌入式 Mastra，但不接生产流量；默认 legacy 行为不变**。
> 状态：**完成**（S1 出口 Go，2026-11-20 真机验证通过）。

---

## 1. 交付物

| 路径 | 内容 |
|---|---|
| `model/runtime/facade.js` | `AgentRuntimeFacade`：engine 选择、`runChat/streamChat` 兼容、health、close |
| `model/runtime/factory.js` | 按配置创建 Facade；Mastra 动态加载；失败回退 |
| `model/runtime/mastra-runtime.js` | 嵌入式 `Mastra` + Storage/Vector 生命周期与关闭顺序 |
| `model/runtime/storage-factory.js` | LibSQL/PostgreSQL + 可选 Vector；绝对路径、DSN/env、close |
| `model/runtime/identity.js` | resource/thread 规范（adapter + botId + scopeId，≤128，safeScopePart） |
| `model/runtime/errors.js` | abort/timeout/provider/tool/storage 错误归一与 `withTimeout` |
| `model/runtime/schemas/config.js` | Zod schema、非法值修复、默认 legacy、DSN 摘要脱敏 |
| `config/default_config/config.yaml` | 新增 `agent.runtime.*` / `agent.mastra.*`，默认 legacy |
| `utils/Config.js` | 归一/修复 runtime/mastra；旧配置缺省自动补默认 |
| `apps/agent.js` | `_buildRuntime` 末尾创建 Facade，登记到 RuntimeScope；面板显示引擎 |

依赖（已写入 `package.json` / `pnpm-lock.yaml`）：

- `@mastra/core@1.85.0`
- `@mastra/memory@1.41.2`
- `@mastra/libsql@1.31.1`
- `@mastra/pg@1.37.0`
- `ai@7.0.177`
- `@ai-sdk/openai@4.0.121` / `@ai-sdk/anthropic@4.0.106` / `@ai-sdk/google@4.0.122`
- `zod@^3.25.76`（原 `3.23.0`，不升 4；`zod-stagehand` 保持 4.4.3）

安装影响：本机 `node_modules` 约 345MB → 560MB（+215MB）；legacy 不 import Mastra，启动扫描不受影响。

---

## 2. 关键实现约束

### 2.1 默认 legacy 不加载 Mastra

`factory.js` 只在 `runtime.engine === 'mastra'` 时动态 `import('./mastra-runtime.js')`。
默认 legacy 路径只创建 Facade（无 Mastra import、无 DB、无 storage 连接）。

### 2.2 PR1 不切聊天流量

即使配置 `engine: mastra`：

- 创建 Mastra/Storage 骨架；
- `facade.chatEngine` 仍为 `legacy`（Mastra runner 还没有 `runChat`）；
- `runChat` 走现有 `makeAgent`，并记录一次 `mastra_chat_not_wired` 警告；
- PR4 才把 `runChat` 指向 Mastra Agent。

这样 PR1 的开关不会改变任何用户可见行为。

### 2.3 失败回退

- `runtime.fallbackToLegacy: true`（默认）：Mastra/storage 初始化失败 → 记录 `initError`，Facade 回退 legacy；
- `false`：初始化失败向上抛，`buildRuntime` 失败并回滚 scope（fail-closed）。

### 2.4 Storage

- LibSQL 默认 `<plugin>/data/mastra/mastra.db`，运行时转**绝对路径**；
- `libsqlUrl` 支持 `:memory:`（仅测试）、绝对 `file:`、`libsql://`；
- 相对 `file:` 明确拒绝（官方：会按 cwd 解析，不同 cwd 打开不同库）；
- PostgreSQL DSN 只读 `connectionStringEnv`（默认 `MASTRA_DATABASE_URL`），不写配置/日志/health；
- Vector 默认关闭；开启时 LibSQL 复用 storage URL，Postgres 复用 DSN；
- 关闭顺序：`mastra.shutdown` → `memory.settled` → `vector.close` → `storage.close`，每步有超时且失败不阻断后续。

### 2.5 Identity

`resourceId = yz_<adapter>_<botId>_<scopeId>`，`threadId` 再带 `_c<conv>` / `_scheduled` / `_sub_<agent>_<task>`。
全部经 `safeScopePart`，只允许 `[A-Za-z0-9_-]`，≤128；官方 ID 含 `:` 不会进入键。
这修掉了「scope 不含 self_id，两个机器人账号共享数据」的结构性缺口（为 PR5 迁移做准备；不改现有 Session 键）。

---

## 3. 测试

新增：

| 文件 | 断言 |
|---|---|
| `model/runtime/test/config.test.mjs` | 39 |
| `model/runtime/test/identity.test.mjs` | 26 |
| `model/runtime/test/errors.test.mjs` | 13 |
| `model/runtime/test/storage.test.mjs` | 19 |
| `model/runtime/test/mastra-runtime.test.mjs` | 14 |
| `model/runtime/test/facade.test.mjs` | 27 |
| `stress/e2e/runtime-facade-wiring.mjs` | 15（真实 apps 装配/热重载/关闭） |
| **合计** | **153** |

全量（本机，带真实运行配置）：

```
测试文件 通过 160 / 失败 0 / 跳过 12（共 172）
断言 7,571
lint 0 errors / 50 warnings
```

Postgres 真实测试：未设置 `MASTRA_TEST_DATABASE_URL`，按设计 skip；缺 DSN 的 fail-closed 已测。

---

## 4. 真机验证（S1 出口）

### 4.1 默认 legacy

原始日志：`/tmp/opencode/pr1-legacy2.log`

| 检查 | 结果 |
|---|---|
| 启动 | 插件加载 11 应用；面板 `运行时：legacy` |
| Mastra 加载 | 未加载、未创建 Facade Mastra（`mastraReady=false`） |
| `data/mastra` | **不存在** |
| 聊天 | 18:33:19 收到 `#ai PR1 legacy 最终验证...`，18:33:21 回复 `legacy-final`（约 1.6s） |
| 退出 | 18:34:09 `Facade 已关闭（scope_close）`，code 5（stdin 关闭约定） |
| 错误 | 无 `ERROR` / 应用加载失败 |

### 4.2 `engine=mastra`

原始日志：`/tmp/opencode/pr1-mastra2.log`

| 检查 | 结果 |
|---|---|
| Facade 日志 | `Mastra 骨架已创建（storage=libsql，3404ms；未接聊天流量）` |
| 面板引擎 | `运行时：mastra（storage=libsql，未接流量）` |
| DB 文件 | `data/mastra/mastra.db` 已创建（另有 `-wal/-shm`，LibSQL 正常 WAL） |
| 聊天仍 legacy | 18:31:13 收到 `#ai PR1 mastra 骨架最终验证...`，18:31:15 回复 `mastra-final`（未出现 Mastra 聊天日志） |
| 退出关闭 | 18:32:08 `Facade 已关闭（scope_close）`，code 5 |
| 错误 | 无 `ERROR` / 初始化失败 |

补充：首次真机创建（`pr1-mastra.log`）为 3753ms；独立冒烟 `node scripts/mastra-smoke.mjs` 为 963ms（legacy 创建+关闭 3ms；Mastra 关闭 1ms）。差异来自首次加载 LibSQL/WASM 与完整运行时启动，PR1 只记录、不承诺阈值。

### 4.3 结论

**Go（S1 通过）**：

- 默认 legacy：不加载 Mastra、不建库、聊天与 PR0 一致；
- `engine=mastra`：嵌入式 Mastra + LibSQL 骨架可创建、health 通过、聊天仍走 legacy；
- 热重载：`legacy → mastra → legacy` 重组，旧 Facade/Mastra 关闭；
- 退出：`Bot.exit` 的 `exit` 事件能等待 Facade/Storage 关闭；
- 全量测试 160/0/12、7,571 断言、lint 0 error；
- 依赖版本锁定，未改现有 Session/Recall/Profile/TaskStore/Web 契约。

允许进入 PR2（AI SDK ModelFactory）。PR2 仍不接聊天流量；必须保持 OpenAI/Anthropic mock parity，并给 Gemini 明确结论。

---

## 5. 回滚

- 配置改回 `agent.runtime.engine: legacy`（默认值）；
- 删除 `data/mastra/` 即删除骨架库（不含现有会话/记忆数据）；
- 依赖可保留（legacy 不加载）；彻底回滚则删除新增依赖与 `model/runtime/*`，`apps/agent.js` 去掉 Facade 创建；
- 不涉及现有 Session KV、Recall、Profile、TaskStore、Web API 数据。
