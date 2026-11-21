# Mastra 底层重构：审计、方案与开发文档

> 状态：**极早期初步开发（pre-alpha）**。S0–S4、S6、S7 已完成；S5 功能完成、72h 观察待执行；S8–S11 未开始。代码已可在 `engine: legacy` 下部署运行，Mastra 仅按用户/群灰度；但能力覆盖、稳定性与效果**远不如 `master`**，请勿用于生产。
>
> 审查基线：`dev @ 9323c5d`（2026-11-20）。当前 `dev` 已包含 S0–S6 的实现（最新提交以仓库为准），`master` 仍是唯一维护线。文中历史审计的 `路径:行号` 以基线为准；除“现状”外，目标设计章节仍标注为**目标设计**，落地代码以仓库为准。
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
| [S7-report.md](S7-report.md) | S7 Memory Phase 2：MemoryBridge、迁移/校验/回滚、Web 兼容、重启/隔离 | 实现者、QA、运维 |

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

- **这是 `dev` 分支上的实验性重构，处于极早期初步开发（pre-alpha）**。它可以安装、启动、部署运行，但 Mastra 灰度链路的能力覆盖、稳定性、长会话、异常恢复与外围 parity 都未达标，**实际效果远不如 `master`**；日常使用与生产部署请使用 `master`。
- 已完成：S0 基线、S1 Runtime Facade/Storage/Identity、S2 ModelFactory、S3 只读 Tool Adapter、S4 写工具/审批/非流式与流式灰度、S6 Memory Phase 1、S7 Memory Phase 2 与迁移。S5 的 72h 观察期尚未执行；S8–S11 未开始。
- 默认配置仍是 `runtime.engine: legacy`；只有 `mastra.gray` 命中的用户/群走 Mastra 聊天，未被命中或初始化失败会回退 legacy。`memory.mode=sessionstore` 时历史唯一真源是 `SessionStore`；切到 `mastra` 后 Mastra Memory 唯一写，SessionStore 只读/迁移源（ADR-004 Phase 2）。
- 文档中的**审计基线**是 `9323c5d`；S0–S6 的落地代码、测试和报告已在该基线上继续提交，历史 `路径:行号` 证据需按当前代码重新核对。
- 文中“目标设计”代码示例使用 TypeScript 语法仅用于表达类型；**推荐实现语言仍是 ESM JavaScript + JSDoc**，理由见 ADR-001。示例不能直接粘贴运行。
- 任何“性能提升”“行为等价”结论都必须由 [05](05-test-and-acceptance.md) 的 parity/性能测试证明；未测试前一律视为待验证。
- 重构期间的版本号、配置结构和数据格式都可能随时变化；升级前备份 `data/` 与 `config/config.yaml`，并保留可回滚到 `master` 的路径。
