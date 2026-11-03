/**
 * 模型上下文窗口解析 —— API 优先，静态目录回退，最后学习/保守兜底。
 *
 * 目标：用户不再需要手填 contextWindow / 压缩水位。Agent 在每轮决定思考档位后，
 * 用真实模型 + 思考模式解析本轮可用输入预算，再据此动态压缩。
 *
 * 顺序：
 *   1. 运行时 /models 元数据（caps-source 已缓存；OpenRouter/Anthropic/Gemini/DeepSeek/...）
 *   2. model-catalog.json（无接口或接口缺字段的厂商）
 *   3. 运行时学习（厂商报 context 超限后自动下调，7 天有效）
 *   4. 128K 保守兜底（source=fallback，标记不精确）
 *
 * 注意：上下文窗口有三种语义：
 *   total = 输入+输出共享一个窗口；input = 输入单独预算；unknown = 厂商未说明。
 * 压缩使用 inputBudget（可用输入预算），不是总窗口。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getApiContext } from './caps-source.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CATALOG_PATH = path.join(__dirname, 'model-catalog.json')

const DEFAULT_CONTEXT = 128000
const DEFAULT_OUTPUT = 8192
const LEARN_TTL = 7 * 86400e3
const CALIBRATION_TTL = 3600e3

let _catalog = { entries: [], sourceUrls: {} }
try {
  const raw = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'))
  _catalog = {
    entries: (Array.isArray(raw.entries) ? raw.entries : []).map((e) => {
      let re = null
      try { re = e.match ? new RegExp(String(e.match), 'i') : null } catch { re = null }
      return { ...e, _re: re }
    }).filter((e) => e._re),
    sourceUrls: raw.sourceUrls || {},
    updatedAt: raw.updatedAt || null,
  }
} catch { /* 目录缺失时全部走兜底 */ }

const _learned = new Map() // model -> { inputBudget, at }
const _calibration = new Map() // model -> { ratio, at }

const normModel = (model) => String(model || '').trim().replace(/^models\//i, '').toLowerCase()
const positive = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.floor(Number(v)) : null)

const PRESET_SOURCE_ALIAS = { doubao: 'volcengine', kimi: 'moonshot', moonshot: 'moonshot' }

function pickCatalog(model, preset = '') {
  const id = normModel(model)
  if (!id) return null
  // 网关/聚合器会带厂商前缀：openai/gpt-6.1、deepseek/deepseek-v4.1-flash、moonshotai/kimi-k3。
  // 先用完整 id 匹配，再尝试最后一段模型名；若当前 preset 有对应厂商数据，优先用该厂商条目，
  // 避免 qwen/... 在 Groq 与 DashScope 之间、minimax/... 在 Groq 与 MiniMax 之间串台。
  const p = String(preset || '').toLowerCase()
  const source = PRESET_SOURCE_ALIAS[p] || p
  const preferred = source ? _catalog.entries.filter((e) => String(e.source || '').toLowerCase() === source) : []
  const groups = preferred.length ? [preferred, _catalog.entries] : [_catalog.entries]
  const candidates = [id, id.includes('/') ? id.split('/').pop() : ''].filter(Boolean)
  for (const group of groups) {
    for (const c of candidates) {
      for (const e of group) {
        if (e._re.test(c)) return e
      }
    }
  }
  return null
}

function normalizeThinking(meta, requested) {
  const t = meta?.thinking
  const modes = Array.isArray(t?.modes) ? t.modes : null
  const supported = t?.supported
  let on = requested === true
  if (supported === false) on = false
  if (modes && modes.length) {
    if (on && !modes.includes('on')) on = modes.includes('off') ? false : true // 强制思考模型保持 on
    if (!on && !modes.includes('off') && modes.includes('on')) on = true
  }
  return on ? 'on' : 'off'
}

function inputBudgetOf(contextWindow, maxInputTokens, maxOutputTokens, kind) {
  const cw = positive(contextWindow)
  const mi = positive(maxInputTokens)
  const mo = positive(maxOutputTokens)
  // input：输入是独立预算，优先用厂商标注的 maxInput，没有则用 context。
  if (kind === 'input') {
    if (mi) return Math.max(1024, mi)
    if (cw) return Math.max(1024, cw)
    return DEFAULT_CONTEXT
  }
  // total：输入+输出共享窗口。若厂商另给了更小的显式 maxInput，以它为准；
  // 否则从总窗口扣输出。输出预留最多占窗口一半——部分厂商会把 max_output_tokens
  // 标成与窗口相同（甚至更大），全额扣减会把输入预算压到 1K，导致每轮都压缩。
  if (mi && cw && mi < cw) return Math.max(1024, mi)
  if (cw) {
    const reserve = mo ? Math.min(mo, Math.floor(cw * 0.5)) : 0
    return Math.max(1024, cw - reserve)
  }
  if (mi) return Math.max(1024, mi)
  return DEFAULT_CONTEXT
}

function finalize(meta, { model, thinking, source, sourceId = null }) {
  const mode = normalizeThinking(meta, thinking)
  const byModeCtx = meta?.thinking?.contextWindowByMode || {}
  const byModeIn = meta?.thinking?.maxInputByMode || {}
  const byModeOut = meta?.thinking?.maxOutputByMode || {}
  // 有的接口只给 max_input_tokens（Anthropic 等），它本身就是窗口口径，不能落回 128K。
  const contextWindow = positive(byModeCtx[mode]) || positive(meta?.contextWindow) || positive(meta?.maxInputTokens) || DEFAULT_CONTEXT
  const maxInputTokens = positive(byModeIn[mode]) || positive(meta?.maxInputTokens) || null
  const maxOutputTokens = positive(byModeOut[mode]) || positive(meta?.maxOutputTokens) || null
  const contextWindowKind = meta?.contextWindowKind || 'total'
  const inputBudget = inputBudgetOf(contextWindow, maxInputTokens, maxOutputTokens, contextWindowKind)
  return {
    model: String(model || ''),
    contextWindow,
    maxInputTokens,
    maxOutputTokens,
    inputBudget,
    contextWindowKind,
    thinkingMode: mode,
    source,
    sourceId,
    catalogUpdatedAt: _catalog.updatedAt,
  }
}

/**
 * 解析当前模型在指定思考模式下的上下文预算。
 * @param {{model?:string, protocol?:string, preset?:string, thinking?:boolean}} opts
 * @returns {{contextWindow:number,maxInputTokens:number|null,maxOutputTokens:number|null,inputBudget:number,contextWindowKind:string,thinkingMode:'on'|'off',source:string,sourceId:string|null}}
 */
export function resolveModelContext({ model = '', protocol: _protocol = 'openai', preset = '', thinking = false } = {}) {
  const id = normModel(model)
  const entry = pickCatalog(model, preset)

  // 1) 运行时官方元数据；接口缺的字段用本地目录补（尤其 thinking / maxOutput）
  const api = getApiContext(model)
  if (api) {
    const meta = {
      contextWindow: api.contextWindow ?? api.maxInputTokens ?? entry?.contextWindow,
      maxInputTokens: api.maxInputTokens ?? entry?.maxInputTokens,
      maxOutputTokens: api.maxOutputTokens ?? entry?.maxOutputTokens,
      contextWindowKind: api.contextWindowKind || entry?.contextWindowKind || 'total',
      thinking: api.thinking || entry?.thinking || null,
    }
    const out = finalize(meta, { model, thinking, source: 'api', sourceId: 'models-api' })
    // 学习到的上限比 API 更小（真实报错）时优先采用，避免反复顶穿
    const learned = _learned.get(id)
    if (learned && Date.now() - learned.at < LEARN_TTL && learned.inputBudget < out.inputBudget) {
      return { ...out, inputBudget: learned.inputBudget, source: 'learned', sourceId: `learned:${learned.inputBudget}` }
    }
    return out
  }

  // 2) 本地目录
  if (entry) {
    const learned = _learned.get(id)
    const out = finalize(entry, { model, thinking, source: 'catalog', sourceId: entry.id })
    if (learned && Date.now() - learned.at < LEARN_TTL && learned.inputBudget < out.inputBudget) {
      return { ...out, inputBudget: learned.inputBudget, source: 'learned', sourceId: `learned:${learned.inputBudget}` }
    }
    return out
  }

  // 3) 学习到的上限
  const learned = _learned.get(id)
  if (learned && Date.now() - learned.at < LEARN_TTL) {
    return finalize(
      { contextWindow: learned.inputBudget, maxInputTokens: learned.inputBudget, maxOutputTokens: null, contextWindowKind: 'input' },
      { model, thinking, source: 'learned', sourceId: `learned:${learned.inputBudget}` },
    )
  }

  // 4) 保守兜底
  return finalize(
    { contextWindow: DEFAULT_CONTEXT, maxInputTokens: DEFAULT_CONTEXT, maxOutputTokens: DEFAULT_OUTPUT, contextWindowKind: 'input' },
    { model, thinking, source: 'fallback', sourceId: 'default-128k' },
  )
}

/** 厂商报 context 超限时记录真实上限（取已用量的 90%，留一点余量） */
export function learnContextLimit(model, usedTokens) {
  const id = normModel(model)
  const used = positive(usedTokens)
  if (!id || !used) return null
  const inputBudget = Math.max(2048, Math.floor(used * 0.9))
  _learned.set(id, { inputBudget, at: Date.now() })
  return inputBudget
}

/** 从厂商报错里识别「上下文超限」，用于自动降档与重试 */
export function isContextOverflowError(error) {
  const text = String(error?.message || error || '')
  if (!text) return false
  const code = String(error?.code || error?.type || '')
  if (/context_length_exceeded|context.*too.*long|prompt.*too.*long|request.*too.*large|input.*too.*long/i.test(code + ' ' + text)) return true
  if (/maximum context length|context window|context length|input token count|maximum prompt|max.*input.*tokens/i.test(text)) return true
  if (/(上下文|输入).{0,12}(超|过长|超出|上限)|超过.{0,12}(上下文|窗口|最大)/.test(text)) return true
  return false
}

/**
 * 从超限报错里学习真实上限：
 *  - 能解析出厂商声明的窗口（如 "maximum context length is 131072 tokens"）→ 取 95%；
 *  - 否则退回「本次已用量 × 0.9」。
 */
export function learnContextFromError(model, error, usedTokens) {
  const text = String(error?.message || error || '')
  const candidates = [
    /maximum context length (?:is|of)\s*([\d,]+)/i,
    /context (?:window|length)[^\d]{0,24}([\d,]+)/i,
    /maximum (?:number of )?(?:input )?tokens[^\d]{0,24}([\d,]+)/i,
    /prompt is too long[^\d]{0,24}([\d,]+)/i,
    /(?:上下文|窗口|输入)[^\d]{0,12}([\d,]{4,})/,
  ]
  let stated = null
  for (const re of candidates) {
    const m = text.match(re)
    const n = m ? Number(String(m[1]).replace(/,/g, '')) : 0
    if (Number.isFinite(n) && n >= 2048) { stated = n; break }
  }
  const id = normModel(model)
  const used = positive(usedTokens)
  const budget = stated ? Math.floor(stated * 0.95) : (used ? Math.floor(used * 0.9) : null)
  if (!id || !budget) return null
  const inputBudget = Math.max(2048, budget)
  _learned.set(id, { inputBudget, at: Date.now() })
  return inputBudget
}

/** 用真实 prompt_tokens 校准 token 估算（进程内，1 小时 TTL） */
export function notePromptUsage(model, estimated, actual) {
  const id = normModel(model)
  const est = positive(estimated)
  const act = positive(actual)
  if (!id || !est || !act) return null
  const ratio = Math.max(0.5, Math.min(2, act / est))
  _calibration.set(id, { ratio, at: Date.now() })
  return ratio
}

/** 当前模型的估算校准系数（默认 1） */
export function getPromptCalibration(model) {
  const hit = _calibration.get(normModel(model))
  if (!hit) return 1
  if (Date.now() - hit.at >= CALIBRATION_TTL) { _calibration.delete(normModel(model)); return 1 }
  return hit.ratio
}

/** 测试/诊断：清空学习与校准缓存 */
export function clearModelContextCache() {
  _learned.clear()
  _calibration.clear()
}

export const MODEL_CONTEXT_DEFAULTS = { DEFAULT_CONTEXT, DEFAULT_OUTPUT, LEARN_TTL, CALIBRATION_TTL }
