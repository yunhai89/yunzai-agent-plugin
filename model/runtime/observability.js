/**
 * AI SDK → 项目既有口径的 observability 映射（PR2）。
 *
 * 不改变现有 DevLog/UsageStats；只把 AI SDK LanguageModelV4 的 detailed usage /
 * finishReason 收敛成 `normalizeUsage()` 能吃的 OpenAI 形状。
 *
 * 关键：缓存字段只在 Provider 真的上报时存在；未观测 ≠ 0。
 */
import { normalizeUsage } from '../agent/messages.js'

/**
 * AI SDK detailed usage → OpenAI/DeepSeek 形状。
 * @param {object|null} usage
 * @returns {object|null}
 */
export function aiSdkUsageToOpenAI(usage, { protocol = 'openai' } = {}) {
  if (!usage || typeof usage !== 'object') return null
  // 已经是 OpenAI 形状：原样返回
  if (usage.prompt_tokens != null || usage.input_tokens != null) return usage
  const inputObj = usage.inputTokens && typeof usage.inputTokens === 'object' ? usage.inputTokens : null
  const outputObj = usage.outputTokens && typeof usage.outputTokens === 'object' ? usage.outputTokens : null
  const input = inputObj ? Number(inputObj.total) || 0 : Number(usage.inputTokens) || 0
  const output = outputObj ? Number(outputObj.total) || 0 : Number(usage.outputTokens) || 0
  const cacheRead = inputObj?.cacheRead ?? usage.cachedInputTokens
  const cacheWrite = inputObj?.cacheWrite ?? usage.cacheWriteTokens
  const reasoning = outputObj?.reasoning ?? usage.reasoningTokens
  // 未上报 usage：AI SDK 会给出 {inputTokens:{},outputTokens:{}}（无 total/cache）→ null，不是 0
  if (inputObj && outputObj && inputObj.total == null && outputObj.total == null && cacheRead == null && cacheWrite == null) return null
  if (!input && !output && !inputObj && !outputObj) return null
  // Anthropic 的 input_tokens 不含缓存：映射回 Anthropic 形状，避免 normalizeUsage 把
  // total 当 plain 再减 cacheRead（会把 uncached 算成 total-cacheRead）。
  if (protocol === 'anthropic') {
    const out = {
      input_tokens: inputObj?.noCache != null ? Number(inputObj.noCache) || 0 : Math.max(0, input - (Number(cacheRead) || 0) - (Number(cacheWrite) || 0)),
      output_tokens: output,
      ...(cacheRead != null ? { cache_read_input_tokens: Number(cacheRead) || 0 } : {}),
      ...(cacheWrite != null ? { cache_creation_input_tokens: Number(cacheWrite) || 0 } : {}),
      ...(reasoning != null ? { completion_tokens_details: { reasoning_tokens: Number(reasoning) || 0 } } : {}),
    }
    return out
  }
  const out = {
    prompt_tokens: input,
    completion_tokens: output,
    total_tokens: Number(usage.totalTokens) || input + output,
  }
  if (cacheRead != null) out.prompt_tokens_details = { cached_tokens: Number(cacheRead) || 0 }
  if (cacheWrite != null) out.input_tokens_details = { cache_write_tokens: Number(cacheWrite) || 0 }
  if (reasoning != null) out.completion_tokens_details = { reasoning_tokens: Number(reasoning) || 0 }
  return out
}

/** AI SDK usage → 项目统一 usage（normalizeUsage 产物） */
export function normalizeAiSdkUsage(usage, { protocol = 'openai' } = {}) {
  return normalizeUsage(aiSdkUsageToOpenAI(usage, { protocol }))
}

/** AI SDK finishReason（string 或 {unified,raw}）→ legacy Provider finishReason */
export function aiSdkFinishReason(reason, { protocol = 'openai' } = {}) {
  const r = reason && typeof reason === 'object' ? (reason.unified || reason.raw) : reason
  if (r === 'tool-calls') return protocol === 'anthropic' ? 'tool_use' : 'tool_calls'
  if (r === 'content-filter') return protocol === 'anthropic' ? 'refusal' : 'content_filter'
  if (protocol === 'anthropic') {
    if (r === 'stop') return 'end_turn'
    if (r === 'length') return 'max_tokens'
    if (r === 'error') return 'error'
  }
  return r || 'stop'
}

/** 合并多次调用的 usage（fallback/多步），复用 normalizeUsage 的 observed* 口径 */
export function sumAiSdkUsage(list = []) {
  const arr = (list || []).map(normalizeAiSdkUsage).filter(Boolean)
  if (!arr.length) return null
  const out = {
    input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0, uncached: 0,
    cacheObserved: arr.some((u) => u.cacheObserved),
    observedInput: 0, observedOutput: 0, observedUncached: 0,
  }
  for (const u of arr) {
    out.input += u.input || 0
    out.output += u.output || 0
    out.total += u.total || 0
    out.cacheRead += u.cacheRead || 0
    out.cacheWrite += u.cacheWrite || 0
    out.uncached += u.uncached || 0
    if (u.cacheObserved) {
      out.observedInput += u.observedInput || 0
      out.observedOutput += u.observedOutput || 0
      out.observedUncached += u.observedUncached || 0
    }
  }
  return out
}
