/**
 * usage 归一 fixture：所有 P1–P14 场景用同一份「AI SDK 形态」usage 描述，
 * legacy / bridge 两条链路各自映射，再比较归一结果。
 *
 * 注意：输入故意使用 AI SDK 7 的字段名（inputTokens/outputTokens/cachedInputTokens），
 * PR2 接真实 `ai` 包时要用官方类型核对；这里仅锁定当前 fixture 契约。
 */

/** AI SDK 形态 → OpenAI / DeepSeek 形态（legacy Provider 返回值） */
export function toOpenAIUsage(u) {
  if (!u || typeof u !== 'object') return null
  if (u.prompt_tokens != null || u.input_tokens != null) return u
  // 未上报 usage（不是 0）：保持 null，避免把「未观测」伪装成「0 token」
  if (u.inputTokens == null && u.outputTokens == null && u.totalTokens == null) return null
  const input = typeof u.inputTokens === 'object' && u.inputTokens
    ? Number(u.inputTokens.total) || 0
    : Number(u.inputTokens) || 0
  const output = typeof u.outputTokens === 'object' && u.outputTokens
    ? Number(u.outputTokens.total) || 0
    : Number(u.outputTokens) || 0
  const total = Number.isFinite(Number(u.totalTokens)) ? Number(u.totalTokens) : input + output
  const out = { prompt_tokens: input, completion_tokens: output, total_tokens: total }
  const cached = u.cachedInputTokens ?? u.inputTokens?.cacheRead
  const reasoning = u.reasoningTokens ?? u.outputTokens?.reasoning
  if (input === 0 && output === 0 && cached == null) return null
  if (cached != null) out.prompt_tokens_details = { cached_tokens: Number(cached) || 0 }
  if (reasoning != null) out.completion_tokens_details = { reasoning_tokens: Number(reasoning) || 0 }
  return out
}

/** 是否携带缓存观测字段（未观测 ≠ 0） */
export function hasCacheObservation(u) {
  return !!u && (u.cachedInputTokens != null || u.cacheRead != null || u.prompt_tokens_details?.cached_tokens != null)
}
