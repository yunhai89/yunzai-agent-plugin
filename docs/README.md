# 文档索引

主 README 只保留项目介绍、安装与快速排障；完整内容按主题拆分在这里。

## 入门

- [项目亮点与能力地图](features.md) —— 全部能力清单与状态
- [分支、更新与重启](updating.md) —— 分支策略、自动更新、重启/重载边界
- [QQ 官方机器人接入](protocols/qq-official.md) —— 自实现适配器、ID 规则、主人配置、Markdown、按钮卡片
- [Web 管理面板](web-panel.md) —— 面板入口、配置中心、日志/会话/任务视图
- [指令一览](commands.md) —— 全部聊天、管理、运维指令

## 配置与运行时

- [配置参考](configuration.md) —— `agent.*` 全量配置说明
- [工具进化](tool-evolution.md) —— 生成 → 验证 → 审批 → 版本化
- [记忆体系与上下文缓存](memory-and-context.md) —— MEMORY/USER、召回、压缩、缓存经济性
- [安全与信任边界](security.md) —— RBAC、审批、注入防御、沙箱边界

## 执行面

- [终端执行与 E2B 沙箱](execution/e2b.md) —— 云托管 / 自托管 / 网络策略
- [网页抓取](execution/web-crawl.md) —— crawl4ai 与 HTTP 降级
- [GPU 向量检索部署](deploy/gpu-vector.md) —— cuvs-node / cuVS BruteForce / CAGRA 真机验证与回滚
- [Stagehand 浏览器自动化](execution/stagehand.md) —— goto / observe / extract / act
- [表情包](sticker.md) —— 自动发现、视觉打标、频率管控

## 开发与运维

- [架构与目录](architecture.md) —— 模块分层与配置治理
- [扩展开发](extensions.md) —— 工具包 / 技能入口
- [开发指南](../开发指南.md) —— 工具 / 技能完整 SDK 与示例
- [运维](operations.md) —— 环境变量、SearXNG、日志字段、自检
- [常见问题（完整 FAQ）](troubleshooting.md) —— 全量排障
- [更新日志](changelog.md) —— 最近版本记录
- [鸣谢、联系与许可证](credits.md) —— 参考项目与联系方式

## 重构审计（Mastra）

- [Mastra 重构文档索引](refactor/mastra/README.md) —— 审计基线、目标架构、PR 计划、迁移 Runbook、测试验收、ADR
- [现状源码审计](refactor/mastra/00-code-audit.md) —— 调用链、功能/数据清单、技术债、证据索引
- [目标架构](refactor/mastra/01-target-architecture.md) —— Runtime Facade、Agent/Workflow/Tool/Memory/Storage 接线
- [改造矩阵与 PR 计划](refactor/mastra/02-refactor-plan.md) —— 逐文件处置、PR0–PR9、灰度/回滚
- [开发指南](refactor/mastra/03-development-guide.md) —— 环境、配置、存储、新增 Agent/Workflow/Tool、排障
- [数据迁移与 Runbook](refactor/mastra/04-data-migration-and-runbook.md) —— 身份规范、备份、dry-run、校验、回滚、灾难恢复
- [测试与验收](refactor/mastra/05-test-and-acceptance.md) —— 测试矩阵、parity、真实 Provider、性能基线
- [决策记录](refactor/mastra/06-decision-log.md) —— JS/TS、Memory、压缩、Workflow、Storage、MCP、审批、下线
- [执行版开发计划](refactor/mastra/07-development-plan.md) —— WBS、12 个双周迭代、里程碑、RACI、质量门禁、第一迭代任务
- [PR0 基线报告](refactor/mastra/PR0-baseline.md) —— 基线测试、fixture、KNOWN-BUG、决策确认、真机验证
- [PR1 实施报告](refactor/mastra/PR1-report.md) —— 依赖、Facade/Storage/Identity 骨架、测试、真机验证
- [PR2 实施报告](refactor/mastra/PR2-report.md) —— ModelFactory、preset/thinking/fallback/代理、Gemini 结论
- [PR3 实施报告](refactor/mastra/PR3-report.md) —— 只读 Tool Adapter、名称/schema/ctx/结果管线、真实工具接线
- [PR3b 实施报告](refactor/mastra/PR3b-report.md) —— 写工具、持久审批、TaskStore 守卫、Mastra suspend/approve
- [PR4a 实施报告](refactor/mastra/PR4a-report.md) —— Mastra 非流式聊天灰度、历史/上下文/工具/回退、完整 Yunzai 真机
- [PR4b/4c 实施报告](refactor/mastra/PR4b-report.md) —— 流式、取消、原生 ApprovalBridge、重启 resume、灰度群
- [S6 Memory Phase 1 报告](refactor/mastra/S6-report.md) —— MessageAdapter、压缩/ledger、多对话/隔离、官方 ID 修复

[← 返回主 README](../README.md)
