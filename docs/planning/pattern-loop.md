# 规律闭环（Pattern Loop）· 暂缓开发存档

> 状态：**暂缓，不进入实现**。本文只保存设计结论，避免后续重复讨论。
> 记录日期：2026-11-03

## 目标

让 Agent 在后台自动完成：

```text
发现规律 → 实践规律 → 应用规律
```

不需要用户逐条采纳；日常应用全自动，但安全硬边界不可越过。

## 已确认的产品决定

- 自动应用范围：`memory + behavior/prompt + skill`
- 永远不自动：工具创建/权限、主人/审批/安全策略、模型/API Key/网络出口/日志开关
- 实践方式：历史回放 + 影子评估；行为类再小流量灰度
- 存储：`data/evolution/patterns/<scopeId>/<patternId>.json`
- Web 端：只读展示；不新增任何本功能的配置项、开关或审批按钮
- 默认生效；不提供开关
- 参数硬编码为最优值，不写进 `config.yaml`

## 硬编码参数

| 参数 | 值 |
|---|---|
| 发现周期 | 每 20 轮 |
| 最少证据 | 3 条，跨 2 天/2 个会话 |
| 单次候选上限 | 3 条 |
| 单 scope 活跃规律上限 | 3 条 |
| 规律长度上限 | 120 字 |
| 发现置信度下限 | 0.6 |
| 实践最少案例 | 8 个 |
| 实践胜率门槛 | 62% |
| 行为灰度比例 | 10% |
| 灰度时长 | 24 小时 |
| 应用后监控 | 72 小时 / 50 轮 |
| 规律有效期 | 30 天 |
| 日 token 预算 | 300,000 |
| 回滚阈值 | 纠正率 +10pp / 工具错误率 +5pp / 延迟 +20% |

## 关键安全修正：领域隔离

用户可能在 A 领域聊很多轮后突然切到 B 领域；规律不能跨领域误用。

每条规律必须带：

```json
{
  "domain": "docker-port-conflict",
  "domainKeywords": ["docker", "compose", "端口", "container", "宿主机"],
  "appliesWhen": "用户询问 Docker / compose 端口映射或宿主机端口冲突",
  "doesNotApplyWhen": "用户讨论写作、翻译、生活问题，或只是把‘端口’作为比喻",
  "anchorExamples": ["docker compose 起不来，2536 端口被占用"],
  "negativeExamples": ["帮我写一首关于端口的诗", "这段翻译里的 port 怎么理解"]
}
```

运行时：

1. 规律不进入全局 system prompt。
2. 每轮由 `PatternSelector` 按 scope + 领域关键词 + 反例 + 小模型边界判定。
3. 只在命中适用域时，追加到本轮 messages 尾部的 system 提示。
4. 切换领域时立即跳过旧领域规律。
5. 单轮最多注入 2 条。
6. 实践必须包含异域负样本；异域误用 0 容忍。
7. 应用后出现一次确认的跨领域误用 → 自动回滚。

## 代码落点（未实现）

- `model/evolution/pattern.js`
- `model/evolution/pattern-store.js`
- `model/evolution/pattern-prompt.js`
- `apps/agent.js`：初始化与每轮 tick
- `model/agent/Agent.js`：按轮注入规律提示，不修改全局 system
- `model/prompt/library.js`：规律提示模板
- `model/web/api.js`：只读 `GET /api/patterns`
- Web 只读页面：规律、证据、实践结果、版本、跳过次数、回滚记录

## 验收用例

1. A 领域 20 轮后生成规律。
2. 用户切到 B 领域时，规律不注入，记录 `skipReason=out_of_domain`。
3. 用户回到 A 领域，规律重新可用。
4. B 领域被误用一次 → 自动回滚。
5. 宽泛规律在发现阶段直接拒绝。
6. 不能修改权限/工具/安全配置。

## 暂缓原因

当前先做 P0：精简配置项、模型上下文窗口自动解析、按真实上下文用量动态压缩。规律闭环在 P0 稳定后再启动。
