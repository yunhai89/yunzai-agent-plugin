# PR3b 实施报告（S4 前半 · 写工具 + 审批 + TaskStore）

> 对应 [07 开发计划](07-development-plan.md) 的 **S4 / PR3b**。
> 状态：**PR3b 完成**；PR4a 已在 [PR4a-report.md](PR4a-report.md) 完成，S4 非流式灰度已标记完成。
> 目标：写工具走 Mastra 原生 `requireApproval`/`beforeApproval`，审批持久化、可恢复、不可重放。

---

## 1. 交付物

| 路径 | 内容 |
|---|---|
| `model/runtime/approval-bridge.js` | 持久化审批：5 位短 id、CAS、argsHash、超时/取消/按 run 取消、重启恢复 |
| `model/runtime/tool-hooks.js` | `decideExecution`（RBAC/alwaysConfirm/shouldConfirm/masterSkip）+ TaskStore 守卫 |
| `model/runtime/tool-adapter.js`（扩展） | 写工具 `requireApproval`/`beforeApproval`、执行前审批复核、TaskStore 包装 |
| `model/runtime/test/approval-bridge.test.mjs` | 审批状态机/超时/恢复/并发 |
| `model/runtime/test/tool-hooks.test.mjs` | 决策顺序、防重放、effect_unknown、fail-closed |
| `model/runtime/test/tool-adapter-write.test.mjs` | 写工具审批/参数变化/只执行一次 |
| `model/runtime/test/approval-mastra.test.mjs` | 真实 Mastra：suspend → 批准 → 执行一次；拒绝不执行 |

未修改 legacy Agent 主链路；未接 Mastra 聊天灰度。

---

## 2. 审批语义

### 2.1 决策顺序（与 legacy `_executeOne` 对齐）

1. `meta.alwaysConfirm` → 需审批；
2. `policy.decide`：deny → 拒绝；confirm → 需审批；
3. `meta.shouldConfirm(args, ctx) === false` → 免审；
4. `masterSkipConfirm && ctx.isMaster` → 直接放行（回调 `onMasterAutoApprove`）；
5. 否则需审批；无 ctx 时只保留 `alwaysConfirm` 语义。

### 2.2 ApprovalBridge

- pending 落 KV（默认 `Yz:agent:approval:id:<id>`），不再重启即丢；
- 5 位短 id，主人可 `#确认 10001`；
- `pending → resolving → approved/denied/expired/cancelled`，CAS 只成功一次；
- `argsHash` 复核，审批后参数变化拒绝；
- 超时（默认 5 分钟）→ `expired` + `onExpire`；
- `cancelRun(runId)` 用于取消/回滚；
- `restore()` 进程重建后恢复 pending 并重排定时器；
- 只存 `argsPreview`（≤500 字）和 ctx 摘要，不落完整写参数。

### 2.3 Mastra 原生审批

- 写工具 `requireApproval`：返回是否进入 approval gate；
- `beforeApproval`：deny → `{proceed:false, output:{error:'rejected_by_policy'}}`；
  confirm → 创建 ApprovalBridge pending 并 suspend；无 runId/审批桥 → fail-closed `rejected_by_confirm`。
- `execute` 前再次复核：必须有 approved 记录且 argsHash 一致；masterSkipConfirm 例外；
- Mastra `execute` 上下文没有 `toolCallId` 时，用 `runId + toolName + argsHash` 匹配已批记录，并以稳定合成 callId 记账。

### 2.4 TaskStore 守卫

- `tool_planned`（写工具只存 argsHash，不落原文）→ `tool_started` → `tool_result`；
- `tool_planned/tool_started` 写失败 → `journal_unavailable`，**不执行**；
- 同一 callId 已有 applied 写结果且 replay=never → `duplicate_suppressed`；
- 只有 started 无 result 的写 → `effect_unknown`，要求人工核对；
- 只读 `replay=safe` 可安全重跑；`tool_result` 写失败不阻断返回值（交由上层标记 journal degraded）。

---

## 3. 真实 Mastra 审批 E2E

`approval-mastra.test.mjs` 使用真实 `Agent` + LibSQL storage：

1. 第一轮模型返回写工具调用；
2. `generate` 返回 `finishReason:'suspended'`，工具未执行；
3. `listSuspendedRuns()` 可从 storage 发现；
4. ApprovalBridge 批准；
5. `approveToolCallGenerate({runId, toolCallId})` 恢复；
6. 工具**只执行一次**，最终文本 `done`。

拒绝路径：`declineToolCallGenerate` 后工具执行次数为 0。

---

## 4. 测试

| 指标 | 结果 |
|---|---|
| 测试文件 | **168 通过 / 0 失败 / 12 跳过（180）** |
| 断言 | **7,864** |
| Lint | **0 errors / 50 warnings** |

新增 94 断言：

| 文件 | 断言 |
|---|---|
| `approval-bridge.test.mjs` | 27 |
| `tool-hooks.test.mjs` | 32 |
| `tool-adapter-write.test.mjs` | 22 |
| `approval-mastra.test.mjs` | 13 |

---

## 5. 真机验证

原始日志：`/tmp/opencode/pr3b-yunzai.log`

| 检查 | 结果 |
|---|---|
| 启动 | `agents-plugin v1.51.1`；面板 `运行时：legacy` |
| Mastra | 未加载、未创建 `data/mastra` |
| 聊天 | 20:29:08 收到 `#ai PR3b 真机回归...`，20:29:09 回复 `pr3b-ok`（约 1.5s） |
| 退出 | 20:29:58 `Facade 已关闭（scope_close）`，code 5 |
| 错误 | 无 `ERROR` / 应用加载失败 |

说明：PR3b 的写工具/审批未接主链路，真机验证确认 legacy 行为不变；审批本身由 `approval-mastra.test.mjs` 用真实 Mastra Agent + LibSQL storage 验证（suspend → 批准 → 只执行一次 / 拒绝不执行）。

---

## 6. PR4a 未完成项（明确）

以下属于 S4 后半，**尚未实现**，不能把 S4 标记完成：

- Facade 将 gray 用户/群路由到 Mastra Agent；
- 消息适配（SessionStore ↔ Mastra/AI SDK）；
- system prompt/记忆/画像/压缩/反思/finalizer 的 Mastra 等价接线；
- `#确认/#拒绝/#待确认` 命令与 Web `/api/confirm` 改为 ApprovalBridge；
- 审批通过后的 `approveToolCallGenerate` 由 Facade 自动恢复并发送最终回复；
- 流式（PR4b）与灰度扩群。

PR3b 的模块可被 PR4a 直接复用：`approval-bridge.js`、`tool-hooks.js`、`tool-adapter.js`（allowWrite）。

---

## 7. 回滚

- 写工具 Adapter 未被主链路引用；删除新模块即可。
- ApprovalBridge 不启动则无 KV 写入。
- 未改配置默认值、未改现有 ConfirmStore/命令；legacy 行为不变。
