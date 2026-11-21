# PR3 实施报告（S3 · 只读工具 Adapter）

> 对应 [07 开发计划](07-development-plan.md) 的 **S3 / PR3a**。
> 目标：`LegacyTool → Mastra Tool`，先只读；名称/参数/结果/截断/注入与 legacy 一致；**不接主链路**。

---

## 1. 交付物

| 路径 | 内容 |
|---|---|
| `model/runtime/tool-name.js` | 工具名 sanitize、63 字符、冲突后缀、双向映射 |
| `model/runtime/tool-result.js` | 工具结果管线：stringify → 失败富化 → resultCap → 注入标注 |
| `model/runtime/tool-adapter.js` | `createTool` 适配、`jsonSchema` + AJV、RequestContext、只读过滤 |
| `model/runtime/test/tool-adapter.test.mjs` | 名称/schema/ctx/结果/取消/写工具过滤 |
| `stress/e2e/tool-adapter-wiring.mjs` | 真实 `apps/agent.js` 的 82 个工具 → 26 个只读工具 |
| `model/agent/tool-result.js`（改） | 抽出 `truncateJson` / `TOOL_FAIL_HINT` 作为唯一实现 |
| `model/agent/Agent.js`（改） | 改为 import 共享实现；行为不变 |

未修改工具实现、未接 Mastra Agent、未做审批/写工具（PR3b/PR4）。

---

## 2. 适配规则

### 2.1 名称

- `sanitizeToolName`：`[^a-zA-Z0-9_-]` → `_`，首字符非字母/`_` 补 `_`，截断 63。
- `ToolNameMap`：注册顺序决定谁拿原名；冲突加 `_2`/`_3`；双向 `mastraName/legacyName`。
- `buildToolNameMap` 对重复原名直接抛错；`ToolNameMap.add` 对同一原名幂等（Adapter 重复注册安全）。

### 2.2 Schema

- 不转 Zod：`jsonSchema(parameters, { validate })`。
- `validate` 复用现有 AJV `validateToolArgs`：
  - 支持 draft-07 / 2019-09 / 2020-12；
  - schema 编译失败 fail-closed；
  - 错误进入 Standard Schema `issues`，Mastra 返回字段级错误。
- 不设 `outputSchema`（避免输出校验改变既有语义）。

### 2.3 ctx

- `execute(input, context)` 从 `context.requestContext.get('yz.ctx')` 读取；
- 兼容普通对象 `requestContext['yz.ctx']`（`requireApproval` 视图）；
- 合并 `signal`/`taskId` 到工具 ctx，不写全局；
- 无 ctx 时工具仍执行（保持旧嵌入/子 Agent 语义），只传 signal/taskId。

### 2.4 结果

与 legacy `_executeOne` 尾部一致：

1. `stringifyArgs`；
2. 失败富化 `enrichToolFailure`（`_hint`/`_failure`/`_alternatives`）；
3. `meta.resultCap ?? maxToolResultChars` 结构化截断（JSON 仍可 parse）；
4. 注入扫描命中才加 `<untrusted_data>`（`untrustedGuard=false` 可关）；
5. 返回字符串；`toModelOutput` 统一成 `{type:'content', value:[{type:'text',text}]}`。

`truncateJson`/`TOOL_FAIL_HINT` 已从 `Agent.js` 抽到 `model/agent/tool-result.js`，legacy 与 Adapter 共用，避免两套口径漂移。Agent 单测 643 断言仍通过。

### 2.5 只读边界

- `resolveExecutionMeta(tool).effect !== 'read'` → `ToolAdapterError('tool_not_readonly')`，`adaptReadonlyTools` 记录到 `skipped`；
- 写工具、审批、TaskStore/账本、幂等恢复均未接入（PR3b/PR4）。

---

## 3. 测试

| 指标 | 结果 |
|---|---|
| 测试文件 | **164 通过 / 0 失败 / 12 跳过（176）** |
| 断言 | **7,770** |
| Lint | **0 errors / 50 warnings** |

新增：

| 文件 | 断言 |
|---|---|
| `model/runtime/test/tool-adapter.test.mjs` | 43 |
| `stress/e2e/tool-adapter-wiring.mjs` | 14 |
| **合计** | **57** |

真实运行时接线（`tool-adapter-wiring.mjs`）：

- 82 个内置工具中 **26 个只读**被适配；
- **56 个写/外部副作用工具**被跳过并记录；
- `web_search` / `memory_search` / `kb_search` / `context_recall` / `calculate` / `reminder_list` 均存在；
- 所有 Mastra 名合法（≤63、`[A-Za-z0-9_-]`）且可反向；
- `reminder_list` 经 RequestContext 读取 ctx 并返回空列表。

---

## 4. 真机验证（S3 出口）

原始日志：`/tmp/opencode/pr3-yunzai.log`

| 检查 | 结果 |
|---|---|
| 启动 | `agents-plugin v1.51.1`；面板 `运行时：legacy` |
| 工具装载 | 82 个工具（含 16 个外部工具包）；无工具分类/加载错误 |
| Mastra | 未加载、未创建数据库（`data/mastra` 不存在） |
| 聊天 | 20:05:05 收到 `#ai PR3 真机回归...`，20:05:06 回复 `pr3-ok`（约 1.4s） |
| 退出 | 20:05:55 `Facade 已关闭（scope_close）`，code 5 |
| 错误 | 无 `ERROR` / 应用加载失败 |

结论：Agent 的 `truncateJson/TOOL_FAIL_HINT` 抽离与只读 Adapter 未改变 legacy 聊天/工具行为。

---

## 5. 回滚

- Adapter 未被主链路引用；删除模块/测试即可。
- `Agent.js` 的共享抽离是纯重构，回滚只需恢复本地 `truncateJson`/`TOOL_FAIL_HINT`。
- 未改工具实现、未写 Mastra 数据、未改配置默认值。

---

## 6. 结论

**Go（S3 通过）**：

- 只读工具名称/schema/ctx/结果/截断/失败富化/注入标注与 legacy 一致；
- 真实 82 个工具中 26 个只读可适配，56 个写工具被明确拒绝；
- `truncateJson`/`TOOL_FAIL_HINT` 已收敛为唯一实现，Agent 643 断言无回归；
- 全量 164/0/12、7,770 断言；Yunzai 真机 legacy 回归通过。

允许进入 PR3b（写工具 + 审批）与 PR4（Mastra Agent 主链路）。
