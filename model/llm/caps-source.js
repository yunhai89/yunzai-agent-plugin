/**
 * 模型能力「官方数据」来源 —— 从厂商 /models 端点拉取模态元数据，缓存供 detectCapabilities 同步读取。
 *
 * 背景：多数 OpenAI 兼容厂商（含小米 MiMo）的 /models 只返回 id，无模态字段；而 OpenRouter 等
 * 会在 `architecture.input_modalities` / `supported_parameters` 中声明模态与工具能力。本模块：
 *  - primeModelCaps() 拉取并缓存（best-effort，永不抛错）；
 *  - getApiCaps(model) 供 detectCapabilities 同步叠加（仅正向能力，不因缺字段关闭内置判定）；
 *  - capsFromModelItem() 为纯解析函数（可离线测试）。
 *
 * 无官方数据时回退内置 REGISTRY 与 agent.media.caps 覆盖（config 优先级最高）。
 *
 * 学习层（learnThinkingCapability）：注册表/官方数据都没有明确表态时，思考能力默认「乐观启用」，
 * 由 provider 在厂商真实拒绝思考字段时回调这里下调——名单式判定对新型号必然滞后，观察才是真源。
 */

const TTL_MS = 6 * 3600 * 1000
const _cache = new Map() // modelId -> { caps, context, at }

const normKey = (model) => String(model || '').trim().replace(/^models\//i, '')

/** 同步读取已缓存的官方能力；无/过期返回 null */
export function getApiCaps(model) {
  const hit = _cache.get(normKey(model))
  if (hit && Date.now() - hit.at < TTL_MS) return hit.caps
  return null
}

/** 同步读取已缓存的官方上下文元数据；无/过期返回 null */
export function getApiContext(model) {
  const hit = _cache.get(normKey(model))
  if (hit && Date.now() - hit.at < TTL_MS) return hit.context
  return null
}

/** 清空缓存（测试/诊断用） */
export function clearApiCaps() { _cache.clear() }

// ───────────────────────── 运行时学习：思考能力 ─────────────────────────
// 背景：能力注册表靠模型名正则，永远追不上模型迭代（deepseek-v4.1-flash 只命中泛化 /deepseek/ 规则、
// 未来新命名同理）。因此「没有明确表态」时默认乐观启用思考——由厂商在请求层用真实拒绝来纠正：
// provider 遇「不认思考字段」错误会剥离重试一次（降级为不思考、不阻断），并把这次观察记到这里；
// 之后 detectCapabilities 直接返回 false（不再反复失败），[chat] 日志与自动决策同步关闭。
// 进程内记忆（进程重启/模型换端点后重新试探一次）；与官方数据同 TTL，避免一次性拒绝被永久放大。
const _learnedThinking = new Map() // modelId -> { capable, at }

/**
 * 记录一次「思考参数是否被厂商接受」的观察（provider 层调用）。
 * @param {string} model 模型 id
 * @param {boolean} capable true=厂商接受思考参数；false=厂商拒绝（已剥离重试）
 */
export function learnThinkingCapability(model, capable) {
  const id = String(model || '').trim()
  if (!id) return
  _learnedThinking.set(id, { capable: capable === true, at: Date.now() })
}

/** 同步读取已学习的思考能力；无记录/过期返回 undefined */
export function getLearnedThinking(model) {
  const id = String(model || '')
  const hit = _learnedThinking.get(id)
  if (!hit) return undefined
  if (Date.now() - hit.at >= TTL_MS) {
    _learnedThinking.delete(id)
    return undefined
  }
  return hit.capable
}

/** 清空学习记录（测试/诊断用） */
export function clearLearnedThinking() { _learnedThinking.clear() }

/** 解析 /models 单项 → 上下文窗口元数据（无信息返回 null）。
 *  不同厂商字段差异很大：OpenRouter context_length / top_provider.max_completion_tokens；
 *  Anthropic max_input_tokens / max_tokens；Gemini inputTokenLimit / outputTokenLimit；
 *  DeepSeek context_window / max_output_tokens；OpenCode limit.context/input/output；
 *  DashScope / 百度 / 腾讯的嵌套 model_info / ModelSpec 也在这里统一。 */
export function contextFromModelItem(item) {
  if (!item || typeof item !== 'object') return null
  const num = (v) => {
    const n = Number(v)
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : null
  }
  const limit = item.limit && typeof item.limit === 'object' ? item.limit : {}
  const top = item.top_provider && typeof item.top_provider === 'object' ? item.top_provider : {}
  const info = item.model_info && typeof item.model_info === 'object' ? item.model_info : {}
  const spec = (item.ModelSpec && typeof item.ModelSpec === 'object') ? item.ModelSpec : {}
  const meta = item.metadata && typeof item.metadata === 'object' ? item.metadata : {}
  const arch = item.architecture && typeof item.architecture === 'object' ? item.architecture : {}

  const contextWindow = num(
    item.context_length ?? item.context_window ?? item.max_context_length ?? item.max_context_window ?? item.max_model_len ??
    item.inputTokenLimit ?? limit.context ?? info.context_window ?? info.context_length ??
    info.max_context_length ?? info.max_model_len ?? meta.context_length ?? meta.context_window ??
    spec.ContextLength ?? spec.ContextWindow ?? item.context ?? null,
  )
  const maxInputTokens = num(
    item.max_input_tokens ?? item.maxInputTokens ?? item.maxPromptLength ??
    item.prompt_tokens ?? limit.input ?? limit.max_input ?? info.max_input_tokens ?? info.max_input_len ??
    spec.MaxInputToken ?? spec.MaxInputLen ?? null,
  )
  const maxOutputTokens = num(
    item.max_output_tokens ?? item.max_completion_tokens ?? item.maxOutputTokens ??
    item.outputTokenLimit ?? top.max_completion_tokens ?? limit.output ?? limit.max_output ??
    item.max_completions_tokens ?? info.max_output_tokens ?? info.max_output_len ??
    spec.MaxOutputToken ?? spec.MaxOutputLen ??
    // Anthropic /v1/models 用 max_tokens 表示输出上限；OpenAI 等没有该字段，不会误读。
    item.max_tokens ?? null,
  )
  // Gemini / Anthropic / xAI / Cohere 的 context 字段本身可能是输入上限；OpenRouter / DeepSeek 多为总窗口。
  const kind = (
    item.inputTokenLimit || item.max_input_tokens || item.maxPromptLength || item.prompt_tokens ||
    limit.input || limit.max_input || info.max_input_tokens || info.max_input_len ||
    spec.MaxInputToken || spec.MaxInputLen ? 'input' : 'total'
  )

  const caps = item.capabilities && typeof item.capabilities === 'object' ? item.capabilities : {}
  const reasoning = item.reasoning && typeof item.reasoning === 'object' ? item.reasoning : null
  const spRaw = arch.supported_parameters || item.supported_parameters
  const sp = Array.isArray(spRaw) ? spRaw.map((x) => String(x).toLowerCase()) : []
  const efforts = reasoning?.supported_efforts || item.effort?.supported_levels
  const supportsReasoning = !!(
    item.supports_reasoning || item.thinking === true || caps.thinking || caps.reasoning ||
    reasoning || (Array.isArray(efforts) && efforts.length) || sp.some((x) => /reason|thinking/.test(x))
  )
  const mandatory = reasoning?.mandatory === true || item.thinking === 'enabled'
  const thinking = supportsReasoning ? {
    supported: true,
    modes: mandatory ? ['on'] : ['off', 'on'],
    contextWindowByMode: {},
    maxOutputByMode: {},
    ...(Array.isArray(efforts) && efforts.length ? { efforts } : {}),
  } : null

  if (!contextWindow && !maxInputTokens && !maxOutputTokens) return null
  return {
    contextWindow: contextWindow || maxInputTokens || null,
    maxInputTokens,
    maxOutputTokens,
    contextWindowKind: kind,
    ...(thinking ? { thinking } : {}),
  }
}

/**
 * 解析 /models 单项 → 正向能力位（无信息返回 null）。
 * 支持 OpenRouter：architecture.input_modalities / supported_parameters；
 * 兼容通用：modalities / input_modalities / capabilities。
 */
export function capsFromModelItem(item) {
  if (!item || typeof item !== 'object') return null
  const caps = {}
  const arch = (item.architecture && typeof item.architecture === 'object') ? item.architecture : {}
  const inputsRaw = arch.input_modalities || item.input_modalities || item.modalities
  const inputs = Array.isArray(inputsRaw) ? inputsRaw.map((x) => String(x).toLowerCase()) : []
  if (inputs.includes('image')) caps.vision = true
  if (inputs.includes('file') || inputs.includes('pdf')) caps.file = true
  if (inputs.includes('audio')) caps.audio = true
  if (inputs.includes('video')) caps.video = true

  const c = item.capabilities
  if (c && typeof c === 'object') {
    if (c.vision || c.image || c.image_input) caps.vision = true
    if (c.video || c.video_input) caps.video = true
    if (c.audio || c.audio_input) caps.audio = true
    if (c.tools || c.function_calling) caps.tools = true
    if (c.reasoning || c.thinking) caps.thinking = true
  }

  const spRaw = arch.supported_parameters || item.supported_parameters
  const sp = Array.isArray(spRaw) ? spRaw.map((x) => String(x).toLowerCase()) : []
  if (sp.includes('tools')) caps.tools = true
  if (sp.some((x) => /reason|thinking/.test(x))) caps.thinking = true

  return Object.keys(caps).length ? caps : null
}

/**
 * 拉取并缓存指定模型的官方能力。best-effort：任何失败静默忽略（回退注册表）。
 * @param {object} o { protocol, baseURL, apiKey, preset, models:[...], fetchImpl, timeoutMs }
 */
export async function primeModelCaps({ protocol = 'openai', baseURL, apiKey, models = [], fetchImpl, timeoutMs = 8000, contextOnly = false } = {}) {
  const want = (Array.isArray(models) ? models : [models]).map((m) => String(m || '').trim()).filter(Boolean)
  if (!baseURL || !apiKey || !want.length) return
  const f = fetchImpl || globalThis.fetch
  if (typeof f !== 'function') return

  const base = String(baseURL).replace(/\/+$/, '')
  let url, headers
  if (protocol === 'anthropic') {
    url = `${base.replace(/\/v1\/?$/, '')}/v1/models`
    headers = { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
  } else if (protocol === 'gemini') {
    const root = base.replace(/\/v1beta(?:\/openai)?\/?$/, '').replace(/\/v1beta\/?$/, '')
    url = `${root}/v1beta/models`
    headers = { 'x-goog-api-key': apiKey }
  } else {
    url = `${base}/models`
    headers = { Authorization: `Bearer ${apiKey}` }
  }

  try {
    const res = await f(url, { headers, signal: AbortSignal.timeout(timeoutMs) })
    if (!res?.ok) return
    const data = await res.json().catch(() => null)
    // 兼容 OpenAI（data）、Anthropic（data）、DashScope（output.models）、
    // 腾讯 TokenHub（Response.ModelSet）、Together（裸数组）等形状。
    const arr = Array.isArray(data) ? data
      : Array.isArray(data?.data) ? data.data
        : Array.isArray(data?.models) ? data.models
          : Array.isArray(data?.output?.models) ? data.output.models
            : Array.isArray(data?.Response?.ModelSet) ? data.Response.ModelSet
              : []
    const norm = (s) => String(s || '').replace(/^models\//i, '')
    const wantSet = new Set(want.map(norm))
    for (const item of arr) {
      const rawId = item?.id || item?.model || item?.name || item?.ModelId || item?.model_name
      const id = norm(rawId)
      if (!id || !wantSet.has(id)) continue
      const caps = contextOnly ? null : capsFromModelItem(item)
      const context = contextFromModelItem(item)
      if (caps || context) _cache.set(id, { caps, context, at: Date.now() })
    }
  } catch { /* 忽略：回退内置注册表 / 本地上下文目录 / 配置覆盖 */ }
}
