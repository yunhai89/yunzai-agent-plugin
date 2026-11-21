# Mastra 底层重构：审计、方案与开发文档

> 状态：**审计 + 目标设计 + 实施计划；S0–S4、S6 完成；PR4b/4c 功能完成，S5 72h 观察待执行；S7+ 未开始**。本目录不包含已落地的 Mastra 运行时；文中除“现状”外，所有新接口、文件名、配置项均标注为**目标设计**，不是仓库现有代码。
>
> 审查基线：`dev` 分支 `9323c5d31a83df6b63fb478da40cd596eee84dc6`（2026-11-20）。该提交与 `master` 相同（`git rev-list --left-right --count master...dev` = `0 0`），远程 `origin/HEAD -> origin/master`，远程没有 `dev` 分支。
>
> 依赖基线：Node `v26.13.1`、pnpm `12.21.0`、锁文件 `pnpm-lock.yaml`（lockfileVersion 9.0）、Ubuntu 24.04.5。Mastra 目标版本以 2026-11-20 npm registry 的实际解析为准，见下表；**实施时必须重新核验并锁定精确版本**。

## 文档索引

| 文档 | 内容 | 读者 |
|---|---|---|
| [00-code-audit.md](00-code-audit.md) | 审查基线、依赖/目录/测试、现状调用链、功能与数据清单、技术债、证据索引 | 架构评审、技术负责人 |
| [01-target-architecture.md](01-target-architecture.md) | 目标架构、Runtime Facade、Agent/Workflow/Tool/Memory/Storage/Provider/Stream 接线、建议目录树与关键伪代码 | 架构师、实现者 |
| [02-refactor-plan.md](02-refactor-plan.md) | 逐文件改造矩阵、PR0–PR9 计划、依赖顺序、灰度/回滚、legacy 退出条件、待决策项 | 项目负责人、PR 评审 |
| [03-development-guide.md](03-development-guide.md) | 环境、依赖、配置、启动、LibSQL/Postgres 切换、新增 Agent/Workflow/Tool、调试、测试与排障 | 后续开发者 |
| [04-data-migration-and-runbook.md](04-data-migration-and-runbook.md) | 身份/Scope 规范、会话与记忆迁移、备份、dry-run、校验、部署、灰度、监控、回滚、灾难恢复 | 运维、SRE |
| [05-test-and-acceptance.md](05-test-and-acceptance.md) | 测试矩阵、fixture、legacy/mastra parity、真实 Provider、性能基线与验收表 | QA、实现者 |
| [06-decision-log.md](06-decision-log.md) | ADR：JS/TS、Memory 映射、压缩、Workflow 边界、Storage、MCP、审批、legacy 下线 | 全体 |
| [07-development-plan.md](07-development-plan.md) | 执行版开发计划：WBS、12 个双周迭代、里程碑、RACI、质量门禁、第一迭代任务 | 项目负责人、实现者、QA/运维 |
| [PR0-baseline.md](PR0-baseline.md) | S0 基线报告：环境、测试/断言数、fixture、KNOWN-BUG、D1–D12 确认、真机验证 | 实现者、QA |
| [PR1-report.md](PR1-report.md) | S1 实施报告：依赖、Facade/Storage/Identity/配置骨架、测试、真机验证 | 实现者、QA、运维 |
| [PR2-report.md](PR2-report.md) | S2 实施报告：ModelFactory、preset 矩阵、thinking/fallback/代理、Gemini 结论 | 实现者、QA |
| [PR3-report.md](PR3-report.md) | S3 实施报告：只读 Tool Adapter、名称/schema/ctx/结果管线、真实工具接线 | 实现者、QA |
| [PR3b-report.md](PR3b-report.md) | S4 前半：写工具、持久审批、TaskStore 守卫、Mastra suspend/approve E2E | 实现者、QA |
| [PR4a-report.md](PR4a-report.md) | S4 后半：Mastra 非流式聊天灰度、历史/上下文/工具/回退、完整 Yunzai 真机 | 实现者、QA |
| [PR4b-report.md](PR4b-report.md) | PR4b/4c：流式、取消、原生 ApprovalBridge、重启 resume、灰度群 | 实现者、QA |
| [S6-report.md](S6-report.md) | S6 Memory Phase 1：MessageAdapter、压缩/ledger、多对话/隔离、官方 ID 修复 | 实现者、QA |

## 推荐阅读顺序

1. 先读 **00** 的“关键发现”和“技术债分类”，确认问题边界。
2. 再读 **01** 的“目标架构图”“Runtime Facade”“Memory/Identity”三节，这是方案的核心。
3. 评审 **02** 的改造矩阵和 PR0–PR2，决定是否进入实施。
4. 用 **07** 的执行版计划排期、分工和第一迭代任务；S0 结果看 **PR0-baseline**。
5. 实施前读 **04** 的迁移前置条件与 **05** 的 parity 方法。
6. 有争议的选择看 **06** 的 ADR，每个 ADR 都列出备选方案和代价。

## 版本与兼容矩阵（2026-11-20 核验）

| 包 | 目标版本 | engines / peer | 核验方式 |
|---|---|---|---|
| `@mastra/core` | `1.85.0` | Node `>=22.13.0`；peer `zod ^3.25.0 \|\| ^4.0.0` | npm registry `latest` + 包内 `package.json`/`.d.ts` |
| `@mastra/memory` | `1.41.2` | Node `>=22.13.0`；peer `@mastra/core >=1.83.0-0 <2.0.0-0` | 同上 |
| `@mastra/libsql` | `1.31.1` | Node `>=22.13.0`；peer core `>=1.84.0-0 <2.0.0-0` | 同上 |
| `@mastra/pg` | `1.37.0` | Node `>=22.13.0`；peer core `>=1.84.0-0 <2.0.0-0` | 同上 |
| `mastra`（CLI/Studio，可选） | `1.40.1` | Node `>=22.13.0`；peer core `>=1.83.0-0 <2.0.0-0` | 仅开发工具，不进入生产拓扑 |
| `ai` | `7.0.177` | Node `>=22`；peer `zod ^3.25.76 \|\| ^4.1.8` | npm registry |
| `@ai-sdk/openai` | `4.0.121` | Node `>=22`；peer `zod ^3.25.76 \|\| ^4.1.8` | npm registry |
| `@ai-sdk/anthropic` | `4.0.106` | Node `>=22`；peer 同上 | npm registry |
| `@ai-sdk/google` | `4.0.122` | Node `>=22`；peer 同上 | npm registry |
| `zod` | **需从 `3.23.0` 升到 `^3.25.76`** | 当前 3.23.0 **不满足** Mastra/AI SDK peer | `node_modules/zod/package.json` + lockfile |
| `zod-stagehand` | 保持 `npm:zod@4.4.3` | Stagehand 4.0.0 自带 zod 4.4.3，别名不能被主 zod 升级破坏 | `node_modules/@browserbasehq/stagehand/package.json`、`model/stagehand/schema.js` |

结论：

- **Node 必须 >= 22.13.0**（Mastra v1 官方迁移指南明确要求）。当前开发机满足；Yunzai 宿主若仍跑 Node 20/22.12，必须先升级，不能靠 polyfill。
- **Zod 必须先升到 3.25.76+**，但**不建议直接升 Zod 4**：仓库只有 `model/diagram/spec.js` 直接 `import { z } from 'zod'`，主 zod 升到 3.25.76 风险低；升 4 会牵动该模块与既有 schema 行为，且 `@mastra/mcp@2.10` 反而要求 `zod ^4.2`，如果以后接原生 MCP 再单独评估。
- `@mastra/*` 不能只升一个包：core/memory/libsql/pg 必须按同一批锁定并在 CI 做 `pnpm install --frozen-lockfile`。
- `@mastra/mcp` 暂不引入：peer 要求 Zod 4.2，且现有 `model/mcp` 已有完整 JSON-RPC/stdio/http 客户端与权限桥；先用适配层保留。
- `mastra` CLI/Studio 只作为开发期可选工具；生产不启动 Mastra Server、不新增 Hono 端口。
- `@mastra/memory@1.41.2` 自身依赖 `zod ^4.6.7`（嵌套依赖，不是 app 的 peer）；app 主 Zod 仍用 3.25.76，二者可共存。若未来把 Memory 的 schema 暴露给应用代码，需单独验证 Zod 版本边界。

### 核验来源（访问日期 2026-11-20）

- npm registry `latest` + 包内 `package.json`/`.d.ts`：
  - `@mastra/core@1.85.0`（engines `>=22.13.0`，peer `zod ^3.25.0 || ^4.0.0`；依赖含 `@ai-sdk/provider-v7@npm:@ai-sdk/provider@4.0.38`）
  - `@mastra/memory@1.41.2`、`@mastra/libsql@1.31.1`、`@mastra/pg@1.37.0`、`mastra@1.40.1`
  - `ai@7.0.177`、`@ai-sdk/openai@4.0.121`、`@ai-sdk/anthropic@4.0.106`、`@ai-sdk/google@4.0.122`
- 官方文档：
  - Agents overview：https://mastra.ai/docs/agents/overview
  - `Agent.generate()`：https://mastra.ai/reference/agents/generate
  - Agent stream：https://mastra.ai/reference/streaming/agents/stream
  - Workflows：https://mastra.ai/docs/workflows/overview
  - Memory：https://mastra.ai/docs/memory/overview
  - Tools：https://mastra.ai/docs/agents/tools
  - Human-in-the-loop：https://mastra.ai/docs/agents/human-in-the-loop
  - Storage：https://mastra.ai/docs/storage/overview
  - LibSQL：https://mastra.ai/integrations/databases/libsql
  - PostgreSQL：https://mastra.ai/integrations/databases/postgresql
  - v1 migration：https://mastra.ai/reference/migrations/upgrade-to-v1/overview
  - AI SDK：https://ai-sdk.dev/docs
- 关键 API 已用 `@mastra/core@1.85.0` 包内类型/源码核对：`createTool({id,inputSchema,execute})`、`requireApproval`/`beforeApproval`、`Agent.generate/stream/approveToolCall/declineToolCall/listSuspendedRuns`、`createWorkflow/createStep/suspend/resume`、`LibSQLStore/LibSQLVector/PostgresStore/PgVector`、chunk 类型 `text-delta/reasoning-delta/tool-call/tool-call-approval/tool-call-suspended/tool-result/step-finish/finish/error`。

## 当前状态与免责声明

- 本目录对应 **commit `9323c5d` + 上述依赖版本**。后续代码变更后，所有 `路径:行号` 证据都需要重新核对。
- 文中“目标设计”代码示例使用 TypeScript 语法仅用于表达类型；**推荐实现语言仍是 ESM JavaScript + JSDoc**，理由见 ADR-001。示例不能直接粘贴运行。
- 本任务没有修改业务源码、依赖、配置、数据库或测试，也没有提交/推送。基线测试与 lint 只读执行，结果见 00 文档。
- 任何“性能提升”“行为等价”结论都必须由 05 文档的 parity/性能测试证明；未测试前一律视为待验证。
