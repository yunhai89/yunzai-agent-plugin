# PR0 基线报告（S0 · 基线冻结）

> 对应 [07 开发计划](07-development-plan.md) 的 **S0 / PR0**。
> 状态：**完成**（离线基线 + 真机验证通过；S0 出口 Go）。
> 基线提交：`9323c5d31a83df6b63fb478da40cd596eee84dc6`（`dev`，与 `master` 同点）。

---

## 1. 环境与方法

| 项 | 值 |
|---|---|
| 日期 | 2026-11-20 |
| 操作系统 | Linux（本机） |
| Node | v26.13.1 |
| pnpm | 12.21.0 |
| 安装 | `pnpm install --frozen-lockfile`（成功） |
| 测试 | `pnpm test`（`scripts/run-tests.mjs`，逐文件子进程） |
| Lint | `pnpm lint`（ESLint） |
| 网络/API Key | 离线基线全程不需要；真实 Provider / QQ 凭证只在 §7 真机验证使用 |

复现命令：

```bash
cd /root/yunzai-agent-plugin
pnpm install --frozen-lockfile
pnpm test
pnpm lint
```

原始日志（本机临时目录，不随仓库提交）：

- `/tmp/opencode/pr0/install.log`
- `/tmp/opencode/pr0/test-baseline.log`
- `/tmp/opencode/pr0/lint-baseline.log`
- `/tmp/opencode/pr0/test-after.log`（新增 PR0 资产后）
- `/tmp/opencode/pr0/lint-after.log`

---

## 2. 改动前基线

| 指标 | 结果 |
|---|---|
| 测试文件 | **通过 147 / 失败 0 / 跳过 12 / 共 159** |
| 断言 | **7,230** |
| Lint | **0 errors / 50 warnings** |
| 工作树 | 干净（仅审计文档） |

跳过文件（均为需要外部前置条件，按设计 `SKIP_FILE:` / 驱动器排除）：

| 文件 | 原因 |
|---|---|
| `model/agent/vector-gpu.test.mjs` | 需要 `cuvs-node` + NVIDIA GPU |
| `model/diagram/kroki.integration.test.mjs` | 需要 Kroki 服务 |
| `model/sandbox/e2b.integration.test.mjs` | 需要 E2B |
| `model/stagehand/browser.integration.test.mjs` | 需要浏览器 |
| `stress/real/cache-hit-sim.mjs` | 真实 Provider 驱动 |
| `stress/real/memory-cache-smoke.mjs` | 真实 Provider 驱动 |
| `stress/real/real-llm-smoke.mjs` | 真实 Provider 驱动 |
| `stress/real/untrusted-guard-smoke.mjs` | 真实 Provider 驱动 |
| `stress/anti-misread/real-llm.mjs` | 真实 Provider 驱动 |
| `stress/anti-misread/run-real.mjs` | 真实 Provider 驱动器 |
| `stress/e2e/e2e-fullchain.mjs` | 真实链路驱动器 |
| `stress/e2e/hooks.mjs` | loader hook，不是测试 |

---

## 3. PR0 新增资产

| 路径 | 作用 |
|---|---|
| `model/runtime/test/fixtures/scripted-legacy-provider.js` | 脚本化 legacy Provider，输出 `AssistantResult` |
| `model/runtime/test/fixtures/scripted-model.js` | 脚本化 AI SDK `LanguageModelV4` 子集（`doGenerate`/`doStream`） |
| `model/runtime/test/fixtures/ai-sdk-bridge.js` | AI SDK result/chunk → legacy `AssistantResult` 的测试桥（PR2/PR4 替换为真实实现） |
| `model/runtime/test/fixtures/scenarios.js` | P1–P14 场景、工具、步数与断言 |
| `model/runtime/test/fixtures/parity-harness.js` | legacy / bridge 双跑、trace 归一、结构化 diff |
| `model/runtime/test/fixtures/tool-name.js` | 工具名 sanitize、63 字符、冲突后缀、双向映射 |
| `model/runtime/test/fixtures/usage.js` | AI SDK / OpenAI usage 双向映射；未观测 ≠ 0 |
| `model/runtime/test/contracts/official-id.test.mjs` | 官方 ID 含 `:` 的列表/清理现状（KNOWN-BUG） |
| `model/runtime/test/contracts/agent-result.test.mjs` | `Agent.run` 结果字段、审批 fail-closed、ConfirmStore 语义 |
| `model/runtime/test/contracts/tool-name.test.mjs` | 名称 sanitize / 冲突契约 |
| `model/runtime/test/contracts/ai-sdk-bridge.test.mjs` | AI SDK 流式 chunk 聚合 / finishReason / usage 契约 |
| `model/runtime/test/parity.test.mjs` | P1–P14 parity 门禁 |
| `stress/e2e/official-id-clear.mjs` | 真实 `apps/agent.js` + 桩 Yunzai：官方 ID 清理现状（KNOWN-BUG） |
| `model/web/auth.console-token.test.mjs`（修） | 默认值断言改读 `config/default_config`，避免用户配置污染全量测试 |

> 说明：PR0 不引入 Mastra/AI SDK 依赖；`scripted-model.js` 只按官方公开形状锁定 fixture 子集，PR2 安装 `ai` 后必须用官方类型复核。

---

## 4. 改动后测试

| 指标 | 结果 |
|---|---|
| 测试文件 | **通过 153 / 失败 0 / 跳过 12 / 共 165** |
| 断言 | **7,418**（+188） |
| Lint | **0 errors / 50 warnings**（警告数与基线一致） |

新增文件断言数：

| 文件 | 断言 |
|---|---|
| `model/runtime/test/contracts/agent-result.test.mjs` | 39 |
| `model/runtime/test/contracts/official-id.test.mjs` | 14 |
| `model/runtime/test/contracts/tool-name.test.mjs` | 14 |
| `model/runtime/test/contracts/ai-sdk-bridge.test.mjs` | 12 |
| `model/runtime/test/parity.test.mjs` | 104 |
| `stress/e2e/official-id-clear.mjs` | 5 |
| **合计** | **188** |

新增测试全部通过；旧测试无回归。

> 环境说明：本机为真机验证生成了 `config/config.yaml`（`webApi.enable=false`，避免占用 YunCat 的 6098 端口）。`model/web/auth.console-token.test.mjs` 原先直接读用户配置断言「默认 true」，带该配置跑会误报 152/1；PR0 内已改为只读 `config/default_config`（测试隔离修复，不改运行时），因此现在带真机配置也是 153/0/12。

---

## 5. KNOWN-BUG（只记录，不修复）

以下缺陷在 PR0 用测试固定为「当前行为」，修复时测试会失败并提示更新契约，避免把修复误判成回归。

| # | 现象 | 证据 | 影响 | 计划修复 |
|---|---|---|---|---|
| KB-1 | 官方 ID 含 `:`，`listAllConversations()` 用 split 末两段反推，userId 被截断、groupId 错位 | `model/runtime/test/contracts/official-id.test.mjs`；`model/agent/session.js:242-266` | Web 全局对话列表 scope 错误；跨用户/群隔离判断失真 | 04 §身份；PR5 迁移前 |
| KB-2 | 官方 ID 含 `:`，`listAll()` 用 split 前两段解析，group/user 都被截断 | 同上；`model/agent/session.js:134-146` | 旧式会话列表/清理按错误 scope 展示 | 同上 |
| KB-3 | `#清空所有记录` 用 split 固定下标取 keyUid，官方用户找不到自己的会话 | `stress/e2e/official-id-clear.mjs`；`apps/agent.js:4125-4138` | 用户以为已清空，实际会话/消息仍在 | 同上 |
| KB-4 | `ConfirmStore` 纯内存，进程重启后 pending 全部丢失 | `model/runtime/test/contracts/agent-result.test.mjs`；`model/agent/confirm.js` | 重启后审批永久挂起/无法恢复；写工具不会重放但任务状态丢失 | PR4 ApprovalBridge |
| KB-5 | 工具名可含中文/点号/超长，迁移 Mastra 后会被静默 sanitize | `model/runtime/test/contracts/tool-name.test.mjs`；Mastra `formatTools` | 历史 tool_call/审批/统计名称错位 | PR3 ToolAdapter + NameMap |

已知但不在 PR0 测试内、已在 00 审计记录的问题（如 `#qqbot*` 权限门、`undici` 代理、无 SIGINT 关闭钩子）继续按 02 的 PR 计划处理。

---

## 6. 决策确认（D1–D12）

用户在 2026-11-20 指示「按开发计划进行开发」，视为接受 02 §7.2 的推荐项。记录如下：

| # | 决策 | 结论 | 说明 |
|---|---|---|---|
| D1 | JS + JSDoc vs 全量 TS | **JS + JSDoc** | 不引入构建链；Zod 只用于配置/Workflow/新工具边界（ADR-001/014） |
| D2 | Phase 2 是否让 Mastra Memory 接管历史 | **先 Phase 1；PR5 验证后再定** | 未获批则停在 S6，不做迁移（ADR-004） |
| D3 | Mastra Semantic Recall | **默认关闭** | 成本/去重/隔离风险；需要时单独评审 |
| D4 | Observational Memory | **不采用** | 无损压缩契约不能被有损观察替代 |
| D5 | `@mastra/mcp` | **暂不引入** | 其 Zod ^4.2 peer 与当前 3.25 计划冲突；保留现有 MCP 客户端 |
| D6 | Mastra Schedules | **不采用** | 保留 ScheduleStore（所有权/重启/命令契约） |
| D7 | TaskStore 迁 Mastra storage | **不迁** | 保留 sqlite；Workflow 只写投影字段（ADR-013） |
| D8 | 子 Agent 改 Mastra subagents | **PR7 评估** | 先保留 spawn/check/extend/orchestrator（ADR-012） |
| D9 | 修 `#qqbot*`/`#知识库列表`/`#人设详情` 权限 | **修，独立安全 PR** | 不混入 Mastra 主链路 PR |
| D10 | 补 `undici` 让 `agent.proxy` 生效 | **补** | 独立依赖 PR；需真实代理测试 |
| D11 | 生产是否多进程 | **本期单进程** | 多进程需 Postgres/共享存储/锁，另行评审；当前部署按单进程验收 |
| D12 | 观察期 | **≥2 周或 ≥1 发布周期** | 100% 灰度后执行；P0/P1 立即回滚 |

> D9/D10 是既有缺陷修复，不改变 PR0「不改运行时」边界；在 PR3/PR4 之前单独提交。

---

## 7. 真机验证（S0 出口）

### 7.1 环境

| 项 | 值 |
|---|---|
| Yunzai | `/root/Yunzai`（TRSS-Yunzai 3.1.3） |
| 插件安装 | bind mount 到 `plugins/agents-plugin`（真实路径，避免 ESM symlink realpath 破坏 `../../../lib`） |
| 适配器 | `stdin`（框架主人 `stdin:stdin`）+ 插件自带 QQ 官方机器人适配器 |
| QQ 机器人 | AppID `1903797111`（凭证只写入 gitignored `config/config.yaml`，不进入仓库/文档） |
| LLM | `opencode-go` / `deepseek-v4.1-flash`（`https://opencode.ai/zen/go/v1`） |
| 配置 | `privateChat=true`、`trigger=at`、`webApi=false`、`crawl.autoInstall=false`，避免端口/下载干扰 |

> **真机隔离更正（2026-11-20 晚）**：同机 `/root/Yunzai/plugins/yuncat` 也会响应私聊消息；PR0–PR3b 用 `#ai` 私聊得到的回复可能由 YunCat 接管，不能作为本插件全链路证据（插件面板/QQ 适配器日志仍有效）。PR4a 已临时禁用 YunCat、把 stdin `user_id` 改为 `tester` 后复验本插件真实链路（见 [PR4a-report.md](PR4a-report.md) §5）。

### 7.2 连通性预检

| 检查 | 结果 |
|---|---|
| QQ `getAppAccessToken` | 通过（token 长度 78，TTL ≈ 3767s） |
| LLM `chat/completions` | 通过（回复「可用」，finish=stop，约 3.6s；usage 含 cache 字段） |

### 7.3 进程内验证

启动命令（测试用；生产按正常 `node app.js` 即可）：

```bash
cd /root/Yunzai
( sleep 40; printf '#ai 你好，请只回复：真机连通\n'; sleep 100 ) | FORCE_TTY=1 node .
```

结果（原始日志 `/tmp/opencode/pr0/yunzai3.log`）：

| 检查 | 结果 |
|---|---|
| 插件加载 | `agents-plugin v1.51.1`，11 个应用，0 个应用载入失败 |
| 插件目录 | `/root/Yunzai/plugins/agents-plugin`（bind mount，真实路径，`../../../lib` 解析正确） |
| QQ 适配器 | `[qqbot:client] 启动 appId=1903797111`；`[qqbot:gateway] 连接 wss://api.sgroup.qq.com/websocket` |
| QQ 网关 | `READY session=a4ff869f-... intents=33554432`；`适配器就绪：1/1 个账号` |
| 触发链路 | stdin 收到 `#ai 你好，请只回复：真机连通`（系统消息 17:40:26.420） |
| Agent 回复 | 17:40:27.777 输出 `真机连通`（真实 `opencode-go / deepseek-v4.1-flash`，约 1.3s） |
| 错误 | 日志无 `ERROR` / `reply_failed` / `run error` / 应用加载失败 |
| 退出 | stdin 关闭后进程以 code 5 正常退出（stdin 适配器约定） |

说明：

- 本次验证走了**真实 Yunzai 进程 → 插件 `Chat` 入口 → 真实 LLM → 回复发送**，不是离线桩。
- QQ 网关已 `READY`，证明 AppID/AppSecret、intents、WebSocket 接收链路可用；**真实 QQ 用户入站消息**需要人在 QQ 客户端发送，本次环境没有可操作的 QQ 客户端，因此未伪造该步骤。测试配置保持 `privateChat=true`、`chatPermission=all`（仅 gitignored 本机配置），主人可随时启动进程后私聊机器人完成入站验证。
- 未把 QQ AppSecret / LLM Key 写入任何仓库文件或本文档。

### 7.4 出口结论

**Go（S0 通过）**：

- 基线可一键复现：147/0/12、7,230 断言、lint 0 error；
- PR0 新增 5 个契约/parity 测试文件 + 1 个 e2e，全部通过；总数 153/0/12、7,418 断言；
- P1–P14 parity harness 可跑，legacy/bridge trace 全等；
- 既有缺陷已用 `KNOWN-BUG` 固定，未在 PR0 修复；
- 真实 Yunzai + 真实 LLM + QQ 网关 READY 验证通过；
- D1–D12 已确认（D2/D8/D11/D12 为条件项，按里程碑复核）。

**允许进入 PR1（依赖与运行时骨架）**。PR1 必须保持 `engine: legacy` 默认、现有测试全绿、可关闭 Mastra 且无资源泄漏。

---

## 8. 回滚

PR0 只新增测试与 fixture，不改运行时、不改依赖、不改配置默认值：

- 回滚 = 删除新增测试/fixture/文档与 `scripts/run-tests.mjs` 的一行注册；
- 生产配置是 gitignored 的本机文件，删除 `/root/Yunzai/plugins/agents-plugin` 挂载点即可恢复原状；
- 不涉及数据库、缓存、会话数据迁移。
