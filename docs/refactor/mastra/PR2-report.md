# PR2 实施报告（S2 · 模型接入层）

> 对应 [07 开发计划](07-development-plan.md) 的 **S2 / PR2**。
> 目标：AI SDK ModelFactory + OpenAI/Anthropic mock parity + thinking/fallback/代理结论；**不接聊天流量**。

---

## 1. 交付物

| 路径 | 内容 |
|---|---|
| `model/runtime/model-factory.js` | 现有配置 → AI SDK LanguageModel；main/utility/vision/fallback；thinking/modelSettings |
| `model/runtime/observability.js` | AI SDK detailed usage/finishReason → 项目 `normalizeUsage` 口径 |
| `model/runtime/proxy-fetch.js` | `undici` 代理 fetch（http/https；SOCKS 明确不支持；env 代理） |
| `model/runtime/test/model-factory.test.mjs` | preset/URL/header/body/thinking/fallback/代理 |
| `model/runtime/test/provider-parity.test.mjs` | 同一上游 JSON 下 legacy vs AI SDK 的 content/finish/usage |
| `scripts/mastra-model-smoke.mjs` | 真实主模型双通道冒烟（AI SDK + legacy） |
| `package.json` / `pnpm-lock.yaml` | 新增 `undici@8.13.0` |

依赖沿用 PR1 锁定版本：`@mastra/core@1.85.0`、`ai@7.0.177`、`@ai-sdk/openai@4.0.121`、`@ai-sdk/anthropic@4.0.106`、`@ai-sdk/google@4.0.122`；未改 Zod 3.25.76。

---

## 2. ModelFactory

只读现有配置链：

```
providerId/modelId → llmProviders[] / llmModels[] → protocol/preset/baseURL/apiKey/model
```

不新建第二套配置。解析结果：

- `main()`：主模型；
- `utility()`：`agent.utilityModel`（条目 id → 模型名 → 主端点）；
- `vision()`：`agent.vision`（显式连接优先 → 注册表匹配 → 主模型）；
- `fallbacks()`：`agent.fallbackModels[]`，每条独立 baseURL/apiKey/protocol；
- `resolve(ref)`：任意条目 id / 模型名；
- `modelList()`：主 + fallback 的 AI SDK model 数组（给 PR4 Mastra 预留）。

OpenAI 兼容统一用 `.chat()`（`/chat/completions`），避免默认走 Responses API；Anthropic 用 `.messages()`。

### 2.1 preset 矩阵

实际 preset 表：OpenAI 14 个、Anthropic 7 个。PR2 支持 **19 个**（12 OpenAI + 7 Anthropic）：

- OpenAI：`openai/deepseek/dashscope/doubao/zhipu/moonshot/mimo/minimax/openrouter/opencode/opencode-go/commandcode`
- Anthropic：`anthropic/deepseek/mimo/minimax/opencode/opencode-go/commandcode`
- **legacy-only**：`gemini`（API 面不同）、`azure`（需要 Azure 专属 provider；AI SDK OpenAI 不能等价模拟）

测试逐 preset 验证：URL 基于 baseURL、body.model/messages、响应解析、`x-opencode-session`、自定义 UA。

---

## 3. Thinking / modelSettings

| 厂商/风格 | PR2 映射 | 状态 |
|---|---|---|
| OpenAI / OpenRouter / 网关 GPT 的 `reasoning_effort` | `providerOptions.openai.reasoningEffort` | 支持 |
| Anthropic 扩展思考 | `providerOptions.anthropic.thinking = {type:'enabled', budgetTokens}` | 支持 |
| DeepSeek `thinking:{type}` | AI SDK 不转发未知字段 | **legacy-only** |
| Qwen `enable_thinking` / MiMo/GLM/豆包 toggle | 同上 | **legacy-only** |
| Gemini `thinkingConfig` | Gemini 整体 legacy-only | **legacy-only** |

结论：**不能假设 AI SDK 会透传厂商自定义 thinking 字段**。`resolveThinkingOptions()` 对不支持风格返回 `legacyOnly:true` + 原因，不静默降级；PR4 切主链路时必须保证这些模型继续走 legacy 或保留旧 provider 分支。

`resolveModelSettings()`：temperature/maxOutputTokens；Anthropic 未填 max 时默认 4096。AI SDK Anthropic 会在 body 里自动加 thinking budget（`max_tokens = maxOutputTokens + budgetTokens`），因此不再手动加 headroom，避免双重膨胀；测试验证实际 body `max_tokens > budget`。

---

## 4. Fallback / utility / vision / embedding

- **Fallback**：提供 `modelList()` 与 `generateWithFallback()`（非流式、工具执行前）。
  - 只对 `provider_unavailable`（429/5xx/网络/超时）换模型；401/403 不重试。
  - `options.tools` 存在时直接拒绝：工具已执行后换模型会重复副作用。
  - 流式半截保护：PR2 不使用该 helper 做流式；PR4 必须用 Mastra model 数组/手动半截保护。
- **Utility/Vision**：复用现有 `llmModels`/`llmProviders` 与 `vision` 解析，不新增配置。
- **Embedding**：不重复实现；继续使用现有 `buildEmbed`/`/embeddings`。AI SDK embedding 留到 PR5 向量/记忆时评估，避免第二套向量维度配置。

---

## 5. 代理（D10）

- 新增 `undici@8.13.0`，修掉“`agent.proxy` 依赖未声明、实际静默直连”。
- `model/runtime/proxy-fetch.js`：
  - `createProxyFetch(proxy)` → `ProxyAgent` + `undici.fetch`；
  - `resolveProxyFetch(proxy)`：显式代理优先，否则 env（HTTPS_PROXY/HTTP_PROXY/ALL_PROXY）；
  - 本地/内网地址仍直连；
  - SOCKS 明确告警并直连（undici 不支持），不假装支持；
  - 代理创建失败 → 直连并告警，不阻塞启动。
- ModelFactory 接受 `fetchImpl` 并传给 AI SDK provider；测试验证自定义 fetch 被调用。
- 真实代理环境未提供，未做代理链路真机请求；仅验证构造/透传。

---

## 6. Gemini Spike 结论

**结论：PR2 不迁移 Gemini，继续 legacy-only。**

依据：

1. 现有 Gemini 走 `@google/genai` Interactions API（`ai.interactions.create`、`Step[]`、`thought_summary`），AI SDK Google 是 `generateContent`，不是同一 API 面。
2. 本次环境没有可用的 Gemini Key，无法完成工具回放/thinking/usage/流式/取消/结构化输出 Spike。
3. 未通过全部 Spike 前切换会静默减功能，违反“不得静默减功能”。

代码上 `modelSupport()` 对 `gemini` 返回 `legacyOnly:true`；`ModelFactory.main()` 不创建 AI SDK model；直接 `createLanguageModel()` 抛错。PR8 前必须重新评估。

---

## 7. 测试

| 指标 | 结果 |
|---|---|
| 测试文件 | **162 通过 / 0 失败 / 12 跳过（174）** |
| 断言 | **7,713** |
| Lint | **0 errors / 50 warnings** |

新增：

| 文件 | 断言 |
|---|---|
| `model/runtime/test/model-factory.test.mjs` | 131 |
| `model/runtime/test/provider-parity.test.mjs` | 11 |
| **合计** | **142** |

Provider parity 使用同一份上游 JSON 同时驱动 legacy Provider 与 AI SDK：
- OpenAI：content/finish/usage（含 cache/reasoning）一致；
- Anthropic：content/finish/usage（input 含 cache_read/cache_creation）一致；
- 未上报 usage → `null`（不是 0）。

---

## 8. 真机验证

### 8.1 真实主模型双通道

命令：`node scripts/mastra-model-smoke.mjs`（本机真实 `opencode-go / deepseek-v4.1-flash`）：

| 通道 | 结果 |
|---|---|
| AI SDK `generateText` | “模型可用”，`finishReason=stop`，`totalTokens=61`，约 4.5s |
| legacy `Provider.chat` | “模型可用”，约 3.6s |

两次独立请求的 reasoning 长度不同，usage 数值不要求逐字相等；同一响应下的映射一致性由 `provider-parity.test.mjs` 锁定。

> 未做真实 thinking 调用：本机没有 OpenAI reasoning 模型 / Anthropic Key。OpenAI effort 与 Anthropic budget 的 body 映射已用 mock fetch 验证；PR4 灰度前必须在真实 Key 上再验一次（尤其 Anthropic thinking signature 回放）。

### 8.2 Yunzai 真机

原始日志：`/tmp/opencode/pr2-yunzai.log`

| 检查 | 结果 |
|---|---|
| 启动 | `agents-plugin v1.51.1`，面板 `运行时：legacy` |
| Mastra | 未加载、未创建数据库（`data/mastra` 不存在） |
| 聊天 | 19:33:41 收到 `#ai PR2 真机回归...`，19:33:43 回复 `pr2-ok`（约 1.5s，真实 `opencode-go/deepseek-v4.1-flash`） |
| 退出 | 19:34:31 `Facade 已关闭（scope_close）`，code 5（stdin 关闭约定） |
| 错误 | 无 `ERROR` / 应用加载失败 |

结论：PR2 只新增模型层模块，未接入聊天流量，真机 legacy 行为不变。

---

## 9. 回滚

- ModelFactory/proxy-fetch/observability 未被主链路引用；删除模块或改回 legacy 不影响运行。
- `undici` 若不希望保留，可回滚依赖；`agent.proxy` 会恢复“静默直连”的既有问题。
- 未改 Session/Recall/Profile/TaskStore/Web API、未写 Mastra 数据库。

---

## 10. 结论

**Go（S2 通过）**：

- 19 个可迁移 preset 的 URL/header/body/响应解析通过 mock；
- OpenAI/Anthropic 同一响应下 content/finish/usage 归一一致；
- thinking 支持边界明确：OpenAI effort / Anthropic budget；其余 legacy-only，不静默降级；
- Gemini/Azure 明确 legacy-only；
- fallback 只对可重试错误、禁止带 tools；
- 代理补 `undici` 并验证 fetch 透传（真实代理环境未提供）；
- 真实主模型 AI SDK + legacy 双通道通过；Yunzai 真机 legacy 回归通过。

允许进入 PR3（Tool Adapter，先只读）。
