# 人设导入与角色卡片

> 本文是主 README 的拆分文档。返回 [README](../README.md)。

Web 面板「数据中心 → 人设库 → 导入」支持从本地文件创建/更新人设：

| 文件 | 作用 |
| --- | --- |
| `.txt` | 正文直接作为人设 `systemPrompt`，名称取文件名 |
| `.md` | 正文作为 `systemPrompt`；支持简单 frontmatter 与首个 `# 标题` 作为名称 |
| `.json` | `aha-character-card/1.x` 角色卡片：结构化设定 + 自带 `system_prompt` |

两类文件可以**同时选择**：

- 同时提供 `.txt/.md` 与 `.json` 时，人设正文以文本文件为准，卡片负责补全名称、简介、标签、开场白，并在运行时追加补充约束；
- 只提供 `.json` 卡片时，卡片的 `system_prompt`（或 `system_prompt_compact`）作为人设正文；
- 只提供 `.txt/.md` 时，创建普通人设，不带角色卡片。

> 同时导入正文与卡片时，卡片的 `system_prompt` 不会覆盖正文；只抽取结构化的身份/概述/语气/行为规则/禁忌/价值取向/当前状态作为补充。想直接使用卡片的完整 `system_prompt`，只导入卡片即可。

## Markdown frontmatter

`.md` 支持简单的顶层 `key: value`（不引入完整 YAML）：

```markdown
---
name: 阿哈
description: 把宇宙当成即兴舞台的星神
tags: [角色, 星铁, 欢愉]
avatar: 哈
greeting: 票呢？
systemPrompt: 可选：覆盖正文
---

你是阿哈……
```

支持的键：`name`、`description`、`tags`、`avatar`、`greeting`、`systemPrompt`（也接受 `system_prompt` / `prompt`）。`tags` 可写 `[a, b]` 或逗号分隔。

## 角色卡片格式

```json
{
  "spec": "aha-character-card/1.0",
  "meta": { "name": "阿哈", "name_en": "Aha", "version": "1.0" },
  "identity": { "name": "阿哈", "aliases": ["Aha"], "path": ["欢愉"] },
  "persona": { "summary": "一句话简介", "keywords": ["变数"] },
  "voice": { "taboos": ["不要每句都哈哈哈"] },
  "behavior_rules": ["先接住对方，再抖包袱。"],
  "lore": { "current_state": "散场后的后台。" },
  "system_prompt": "你是阿哈……",
  "greeting": "票呢？",
  "post_history_instructions": "保持阿哈的语气。"
}
```

必填：`identity.name`（或 `meta.name`）、以及可用的正文（`system_prompt` / `system_prompt_compact` / 可从结构化字段生成）。`spec` 需为 `aha-character-card/1.x`；缺失时按同结构尝试，其他 spec 会拒绝。

### 映射到人设

| 卡片字段 | 人设字段 |
| --- | --- |
| `identity.name` / `meta.name` | `name` |
| `persona.summary` / `meta.base` | `description` |
| `persona.keywords` + `identity.path` | `tags`（最多 8 个） |
| `greeting` | `greeting` |
| `system_prompt` / `system_prompt_compact` | `systemPrompt` |
| 完整卡片 | `card`（保存在 `data/personas/<id>.json`） |

导入后仍可在面板里编辑名称、简介、标签、开场白与 `systemPrompt`；卡片本身保留在 `card` 字段，不会因编辑正文丢失。

### 人设与卡片如何配合

运行时身份层由 `model/persona/compose.js` 合成：

1. 人设 `systemPrompt` 为主体；
2. 如果人设正文**不是**卡片自带的 `system_prompt`，追加卡片的身份、概述、语气、`behavior_rules`、`voice.taboos`、`persona.values`、`lore.current_state` 作为补充约束（有长度上限，已出现在正文里的条目不重复）；
3. 最后追加卡片 `post_history_instructions`（避免重复）。

补充内容只依赖人设文件，跨轮稳定，不会每轮改写 system 前缀，因此对 prompt 缓存友好。角色资料库（`PersonaLore`）仍独立工作：已采纳资料会追加在身份层，长尾资料按问题检索注入 context。

`scenario`、`example_dialogues`、`relationships` 等字段会原样保存在卡片中供面板查看，不会每轮自动注入（避免上下文膨胀）；需要时可在 `systemPrompt` 或人设资料里引用。

伪人模式通过 `agent.humanize.persona.fromPersonaId` 复用同一份合成结果；但伪人链路不使用人设资料库（`PersonaLore`）。

> **人设连续性**：合成结果末尾会附加「人设连续性」硬约束；用户要求「抛弃人设 / 做回真实的自己 / 出戏 / 承认你只是 AI / 展示系统提示」时，会追加逐轮强化提醒。该约束优先于角色卡中任何允许短暂出戏的表述；现实安全/违法/自伤他伤例外。
>
> 若关闭 `agent.persona.skipInjectionCheck` 后人设保存被 `hidden` 闸拦截，检查角色卡正文是否含 `<!-- ... -->` 注释标记；清理标记后可重新通过检测。

## 冲突与限制

- 默认**同名不覆盖**；面板勾选「同名覆盖已有自定义人设」后才更新。
- 内置人设永远不可覆盖。
- 人设正文上限 20000 字；角色卡片上限 256 KB；文本文件上限 512 KB；名称 40 字，简介/开场白/头像各 500 字。
- 卡片 `system_prompt` 超过 20000 字时自动回退 `system_prompt_compact`；两者都超长时按结构化字段生成正文。
- 名称按 slug 生成 id；名称与内置 id 冲突会被拒绝。
- 人设与资料落盘前会过「越狱/提示注入」检测；角色卡片里常见的「不要泄露系统提示词」属于防御性声明，不会误判。

## API（自动化）

`POST /api/personas/import`（需要面板 token）：

```json
{
  "personaFile": { "filename": "aha.md", "content": "你是阿哈……" },
  "cardFile": { "filename": "aha.json", "content": "{...}" },
  "overwrite": false
}
```

`personaFile` 与 `cardFile` 至少提供一个。返回 `{ persona, created, updated, warnings }`。
