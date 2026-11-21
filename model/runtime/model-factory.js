/**
 * ModelFactory（PR2）：现有 provider/model 配置 → AI SDK LanguageModel。
 *
 * 只读现有 `llmProviders[] / llmModels[] / providerId / modelId / utilityModel /
 * vision / fallbackModels[]`，不另建配置真源。
 *
 * 能力边界（PR2 有意保守，宁 legacy-only 不静默降级）：
 *  - openai 兼容：走 `.chat()`（/chat/completions），支持 baseURL/headers/session header/fetch；
 *  - anthropic：`.messages()`，支持 thinking budget；
 *  - gemini：**legacy-only**（现有 @google/genai Interactions API 与 AI SDK Google 不同面，
 *    且 PR2 无真实 Key 完成 Spike；见 PR2 报告）；
 *  - 其它厂商自定义 thinking 字段（DeepSeek `thinking:{type}`、Qwen `enable_thinking` 等）：
 *    AI SDK 不会透传未知字段，标记 legacy-only，不假装支持；
 *  - fallback：仅提供 model 列表 + 非流式手动重试 helper；工具已执行/已出流时禁止回退。
 */
import { createOpenAI } from '@ai-sdk/openai'
import { createAnthropic } from '@ai-sdk/anthropic'
import { generateText } from 'ai'
import { presets as openaiPresets } from '../openai/presets.js'
import { presets as anthropicPresets } from '../anthropic/presets.js'
import { resolveThinkingStyle, clampThinkingBudget } from '../llm/thinking.js'
import { RuntimeConfigError, normalizeRuntimeError } from './errors.js'

const DEFAULTS = {
  anthropicDefaultMaxTokens: 4096,
}

function str(v) { return v == null ? '' : String(v) }

function presetMap(protocol) {
  return protocol === 'anthropic' ? anthropicPresets : openaiPresets
}

function makeRef({ provider = {}, entry = {}, fallback = {}, flat = null, model = '', source = 'registry' } = {}) {
  const cfg = flat || {}
  return {
    source,
    providerId: str(provider.id || cfg.providerId || ''),
    providerName: str(provider.name || cfg.providerName || ''),
    protocol: str(provider.protocol || cfg.protocol || 'openai'),
    preset: str(provider.preset || cfg.preset || ''),
    baseURL: str(provider.baseURL || cfg.baseURL || ''),
    apiKey: str(provider.apiKey || cfg.apiKey || ''),
    model: str(model || entry.model || cfg.model || ''),
    temperature: entry.temperature ?? fallback.temperature ?? cfg.temperature,
    maxTokens: entry.maxTokens ?? fallback.maxTokens ?? cfg.max_tokens ?? cfg.maxTokens,
    headers: { ...(cfg.headers || {}), ...(provider.headers || {}), ...(fallback.headers || {}) },
    sessionHeader: str(provider.sessionHeader || cfg.sessionHeader || ''),
    ...(fallback.id ? { fallbackId: fallback.id } : {}),
  }
}

/** 主模型解析：优先 providerId/modelId，回退旧扁平镜像字段（仅当有 apiKey） */
export function resolveMainRef(cfg = {}) {
  const providers = Array.isArray(cfg.llmProviders) ? cfg.llmProviders : []
  const models = Array.isArray(cfg.llmModels) ? cfg.llmModels : []
  const provider = providers.find((p) => p && p.id === cfg.providerId)
  const entry = models.find((m) => m && m.id === cfg.modelId)
  if (provider && entry && entry.providerId === provider.id) {
    return makeRef({ provider, entry, source: 'registry' })
  }
  if (cfg.apiKey) {
    return makeRef({ flat: cfg, entry: {}, model: cfg.model, source: 'flat' })
  }
  return null
}

/** 任意引用：条目 id → 模型名字符串 → 主模型仅换模型名 */
export function resolveRefByString(cfg = {}, value, mainRef = null) {
  const v = str(value).trim()
  const main = mainRef || resolveMainRef(cfg)
  if (!v) return main
  const models = Array.isArray(cfg.llmModels) ? cfg.llmModels : []
  const providers = Array.isArray(cfg.llmProviders) ? cfg.llmProviders : []
  let entry = models.find((m) => m && m.id === v)
  if (!entry) entry = models.find((m) => m && str(m.model) === v)
  if (entry) {
    const provider = providers.find((p) => p && p.id === entry.providerId)
    if (provider) return makeRef({ provider, entry, source: 'utility' })
    // 条目存在但厂商被删：保留模型名，回退主端点（与 legacy ModelRouter 一致）
    return main ? { ...main, model: str(entry.model || v), source: 'utility_bare' } : null
  }
  return main ? { ...main, model: v, source: 'bare' } : null
}

export function resolveUtilityRef(cfg = {}, mainRef = null) {
  return resolveRefByString(cfg, cfg.utilityModel, mainRef)
}

/** 视觉模型：显式连接优先；否则用注册表匹配；都没有则复用主模型 */
export function resolveVisionRef(cfg = {}, mainRef = null) {
  const v = cfg.vision || {}
  const main = mainRef || resolveMainRef(cfg)
  if (v.model) {
    if (v.protocol || v.preset || v.baseURL || v.apiKey) {
      return makeRef({
        flat: { protocol: v.protocol || main?.protocol, preset: v.preset || main?.preset, baseURL: v.baseURL || '', apiKey: v.apiKey || '', model: v.model, maxTokens: v.maxTokens },
        source: 'vision_explicit',
      })
    }
    const resolved = resolveRefByString(cfg, v.model, main)
    return resolved ? { ...resolved, source: 'vision', maxTokens: v.maxTokens ?? resolved.maxTokens } : null
  }
  return main
}

/** fallback 列表：每条独立 baseURL/apiKey/protocol（可跨厂商） */
export function resolveFallbackRefs(cfg = {}, mainRef = null) {
  const main = mainRef || resolveMainRef(cfg)
  const out = []
  for (const [i, fb] of (Array.isArray(cfg.fallbackModels) ? cfg.fallbackModels : []).entries()) {
    if (!fb || !fb.model || !fb.apiKey) continue
    const ref = makeRef({
      flat: {
        protocol: fb.protocol || main?.protocol || 'openai',
        preset: fb.preset || '',
        baseURL: fb.baseURL || '',
        apiKey: fb.apiKey,
        model: fb.model,
        maxTokens: fb.maxTokens ?? main?.maxTokens,
        temperature: fb.temperature ?? main?.temperature,
        headers: fb.headers,
      },
      fallback: { ...fb, id: fb.id || `fb_${i + 1}` },
      source: 'fallback',
    })
    out.push(ref)
  }
  return out
}

/** thinking 归一：支持自动 depth/budget 与旧手动对象 */
export function normalizeThinkingSpec({ thinking = null, depth = null, budget = null } = {}) {
  if (depth && depth !== 'off') return { enabled: true, depth, budget: clampThinkingBudget(budget) || null, source: 'auto' }
  if (!thinking || thinking === 'off' || thinking === false) return { enabled: false, depth: 'off', budget: 0, source: 'off' }
  if (typeof thinking === 'object' && (thinking.type === 'disabled' || thinking.enabled === false)) {
    return { enabled: false, depth: 'off', budget: 0, source: 'manual' }
  }
  const b = clampThinkingBudget(thinking?.budget_tokens ?? thinking?.budgetTokens ?? budget)
  const d = thinking?.depth && thinking.depth !== 'off' ? thinking.depth : (b >= 16384 ? 'high' : b >= 8192 ? 'medium' : 'low')
  return { enabled: true, depth: d, budget: b || 8192, source: 'manual' }
}

/**
 * 旧 thinking 语义 → AI SDK providerOptions。
 * 只映射有官方 AI SDK 选项的厂商；其余返回 legacyOnly。
 */
export function resolveThinkingOptions({ ref, thinking = null, depth = null, budget = null } = {}) {
  const spec = normalizeThinkingSpec({ thinking, depth, budget })
  const style = resolveThinkingStyle({ protocol: ref?.protocol || 'openai', preset: ref?.preset || '', model: ref?.model || '' })
  if (!spec.enabled) return { ...spec, style, providerOptions: {}, supported: true, legacyOnly: false }
  if (style === 'reasoning_effort' && ref?.protocol === 'openai') {
    const effort = spec.depth === 'high' ? 'high' : spec.depth === 'low' ? 'low' : 'medium'
    return { ...spec, style, providerOptions: { openai: { reasoningEffort: effort } }, supported: true, legacyOnly: false }
  }
  if (style === 'anthropic_budget' && ref?.protocol === 'anthropic') {
    const b = clampThinkingBudget(spec.budget) || 8192
    return { ...spec, style, providerOptions: { anthropic: { thinking: { type: 'enabled', budgetTokens: b } } }, supported: true, legacyOnly: false }
  }
  // DeepSeek/Qwen/MiMo/GLM/豆包等自定义 thinking 字段：AI SDK provider 不转发未知字段
  return { ...spec, style, providerOptions: {}, supported: false, legacyOnly: true, reason: `thinking_style_${style}_unsupported` }
}

/**
 * modelSettings：temperature/maxOutputTokens；Anthropic 思考预算必须小于 max_tokens。
 * @returns {{modelSettings:object, adjustedMaxTokens:boolean}}
 */
export function resolveModelSettings(ref = {}, { thinkingOptions: _thinkingOptions = null, temperature = undefined, maxTokens = undefined } = {}) {
  const t = temperature ?? ref.temperature
  const m = maxTokens ?? ref.maxTokens
  const modelSettings = {}
  if (Number.isFinite(Number(t))) modelSettings.temperature = Number(t)
  let max = Number.isFinite(Number(m)) ? Number(m) : undefined
  if (max == null && ref.protocol === 'anthropic') max = DEFAULTS.anthropicDefaultMaxTokens
  if (Number.isFinite(max) && max > 0) modelSettings.maxOutputTokens = max
  // AI SDK Anthropic 会在 body 里加 thinking budget（max_tokens = maxOutputTokens + budgetTokens），
  // 因此这里不再手动加 headroom，避免双重膨胀；实际 body 仍满足 max_tokens > budget。
  return { modelSettings, adjustedMaxTokens: false }
}


/** 协议/预设支持矩阵：PR2 明确 legacy-only，避免静默换 API 面 */
export function modelSupport(ref = {}) {
  const protocol = str(ref.protocol || 'openai')
  const preset = str(ref.preset || '')
  if (protocol === 'gemini' || protocol === 'google' || preset === 'gemini') {
    return { legacyOnly: true, reason: 'gemini_legacy_only' }
  }
  if (protocol === 'openai' && preset === 'azure') {
    return { legacyOnly: true, reason: 'azure_legacy_only' }
  }
  if (protocol !== 'openai' && protocol !== 'anthropic') {
    return { legacyOnly: true, reason: `protocol_${protocol}_unsupported` }
  }
  return { legacyOnly: false, reason: null }
}

/** 创建单个 AI SDK LanguageModel；未知/legacy-only 协议抛错 */
export function createLanguageModel(ref, { fetchImpl = null, sessionId = '', logger: _logger = null } = {}) {
  if (!ref || !ref.model) throw new RuntimeConfigError('缺少 model')
  if (!ref.apiKey) throw new RuntimeConfigError(`模型 ${ref.model} 缺少 apiKey`)
  const support = modelSupport(ref)
  if (support.legacyOnly) {
    throw new RuntimeConfigError(`${ref.model || ref.protocol} 在 PR2 为 legacy-only（${support.reason}）`, { code: support.reason })
  }
  const protocol = str(ref.protocol || 'openai')
  const isAnthropic = protocol === 'anthropic'
  const preset = presetMap(protocol)[ref.preset] || {}
  const headers = { ...(preset.headers || {}), ...(ref.headers || {}) }
  const sessionHeader = str(ref.sessionHeader || preset.sessionHeader || '')
  if (sessionHeader) headers[sessionHeader] = str(sessionId) || `yz-${ref.providerId || protocol}-${ref.model}`.replace(/[^A-Za-z0-9_.-]/g, '-')
  const common = {
    apiKey: ref.apiKey,
    ...(ref.baseURL ? { baseURL: ref.baseURL } : {}),
    ...(Object.keys(headers).length ? { headers } : {}),
    ...(typeof fetchImpl === 'function' ? { fetch: fetchImpl } : {}),
    name: preset.name || ref.preset || protocol,
  }
  try {
    if (isAnthropic) return createAnthropic(common).messages(ref.model)
    return createOpenAI(common).chat(ref.model)
  } catch (e) {
    throw new RuntimeConfigError(`创建 ${protocol} provider 失败：${e?.message || e}`, { cause: e })
  }
}

/** ModelFactory：一次解析、多处复用；不缓存 provider 客户端（AI SDK model 本身无状态） */
export class ModelFactory {
  constructor({ cfg = {}, fetchImpl = null, sessionId = '', logger = null } = {}) {
    this.cfg = cfg
    this.fetchImpl = fetchImpl
    this.sessionId = sessionId
    this.logger = logger
    this._mainRef = resolveMainRef(cfg)
  }

  get mainRef() { return this._mainRef }
  get configured() { return !!this._mainRef?.apiKey }

  _resolve(ref, source = '') {
    if (!ref) return null
    const support = modelSupport(ref)
    if (support.legacyOnly) {
      return { model: null, ref, legacyOnly: true, reason: support.reason, source: source || ref.source }
    }
    const model = createLanguageModel(ref, { fetchImpl: this.fetchImpl, sessionId: this.sessionId, logger: this.logger })
    return { model, ref, legacyOnly: false, source: source || ref.source }
  }

  main() { return this._resolve(this._mainRef, 'main') }
  utility() { return this._resolve(resolveUtilityRef(this.cfg, this._mainRef), 'utility') }
  vision() { return this._resolve(resolveVisionRef(this.cfg, this._mainRef), 'vision') }
  fallbacks() { return resolveFallbackRefs(this.cfg, this._mainRef).map((r) => this._resolve(r, 'fallback')).filter(Boolean) }
  resolve(value) { return this._resolve(resolveRefByString(this.cfg, value, this._mainRef), 'resolve') }

  /** 主模型 + fallback 的 AI SDK model 数组（给 Mastra Agent 的 model 数组预留） */
  modelList() {
    const main = this.main()
    return [main, ...this.fallbacks()].filter((x) => x && !x.legacyOnly && x.model)
  }

  describe() {
    const ref = this._mainRef
    return {
      configured: this.configured,
      protocol: ref?.protocol || null,
      preset: ref?.preset || null,
      model: ref?.model || null,
      baseURL: ref?.baseURL ? '(set)' : '(default)',
      fallbackCount: resolveFallbackRefs(this.cfg, this._mainRef).length,
      legacyOnlyPresets: ['gemini', 'azure'],
    }
  }
}

export function createModelFactory(opts = {}) {
  return new ModelFactory(opts)
}

/**
 * 非流式 fallback 重试。**只用于工具执行前/无工具阶段**；
 * 已执行工具或已向用户输出半截流时不得调用（避免重复副作用/重复文本）。
 */
export async function generateWithFallback({ models = [], prompt, messages = null, ...options } = {}) {
  if (options.tools) throw new RuntimeConfigError('generateWithFallback 禁止带 tools：工具已执行的阶段不允许换模型重放')
  if (!models.length) throw new RuntimeConfigError('generateWithFallback 需要至少一个 model')
  const attempts = []
  let last = null
  for (const item of models) {
    const model = item?.model || item
    const ref = item?.ref || null
    try {
      const r = await generateText({ model, ...(messages ? { messages } : { prompt }), ...options })
      attempts.push({ ok: true, model: ref?.model || model?.modelId || '', protocol: ref?.protocol || '' })
      return { result: r, used: { model: ref?.model || model?.modelId || '', protocol: ref?.protocol || '' }, attempts }
    } catch (e) {
      const norm = normalizeRuntimeError(e, { phase: 'provider' })
      attempts.push({ ok: false, model: ref?.model || model?.modelId || '', protocol: ref?.protocol || '', code: norm.code })
      last = e
      if (!norm.retryable) break
    }
  }
  const err = new RuntimeConfigError('所有模型均失败', { cause: last })
  err.code = 'provider_all_failed'
  err.attempts = attempts
  throw err
}
