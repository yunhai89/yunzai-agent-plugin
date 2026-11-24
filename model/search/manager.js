/**
 * SearchManager —— 多源搜索 + 免费引擎回退链。
 *
 * 参考 dsh-free-search（MIT）的引擎分层与失败分类：
 *  - 免费无 key：Bing / DDG / AnySearch / Exa(keyless) / Tavily(keyless) / Keenable / Firecrawl / Parallel / You.com / SearXNG
 *  - 有 key 增强：Exa / Tavily / Brave / Perplexity / Keenable / Firecrawl / Parallel / You.com
 *  - 失败分类：auth / quota / bot-wall / transient / invalid；auth/quota 冷却，transient 重试一次
 *  - 同查询短 TTL 缓存、域名黑白名单、safeSearch/time_range 透传
 *
 * 旧的 SearchManager({ providers }) 用法保持兼容。
 */
import { createTavilyProvider } from './providers/tavily.js'
import { createExaProvider } from './providers/exa.js'
import { createPerplexityProvider } from './providers/perplexity.js'
import { createBraveProvider } from './providers/brave.js'
import { createSearXNGProvider } from './providers/searxng.js'
import { createDDGProvider } from './providers/ddg.js'
import { createBingProvider } from './providers/bing.js'
import { createAnySearchProvider } from './providers/anysearch.js'
import { createKeenableProvider } from './providers/keenable.js'
import { createFirecrawlProvider } from './providers/firecrawl.js'
import { createParallelProvider } from './providers/parallel.js'
import { createYouProvider } from './providers/you.js'

/**
 * 合并多查询搜索结果（供 web_search 多角度核验）。
 *  - 按 URL 去重（忽略协议外差异：大小写/hash/尾斜杠；同一页面被多个查询命中只保留一次）；
 *  - answers 按查询汇总；失败查询单列 failures——覆盖缺口必须让模型看见，才能如实说明"没查到"；
 *  - sources 汇总实际参与的去重源名，便于判断是否真正多源。
 * @param {Array<{query:string,result?:object,error?:string}>} items
 * @param {{maxResults?:number}} opts
 */
export function mergeSearchResults(items, { maxResults = 12 } = {}) {
  const norm = (u) => String(u || '').trim().toLowerCase().replace(/#.*$/, '').replace(/\/+$/, '')
  const seen = new Set()
  const results = []
  const answers = []
  const failures = []
  const providers = new Set()
  const queries = []
  for (const it of items || []) {
    const query = String(it?.query || '').trim()
    if (query) queries.push(query)
    if (it?.error) { failures.push({ query, error: String(it.error).slice(0, 200) }); continue }
    const res = it?.result
    if (!res) continue
    if (res.provider) providers.add(res.provider)
    for (const s of res.sources || []) providers.add(s)
    if (res.answer) answers.push({ query, answer: res.answer })
    for (const r of res.results || []) {
      const key = norm(r?.url)
      if (key && seen.has(key)) continue
      if (key) seen.add(key)
      if (results.length < maxResults) results.push({ ...r, query, source: r.source || res.provider || '' })
    }
  }
  return { provider: 'multi', queries, results, answers, failures, sources: [...providers] }
}

const ZH_ORDER = ['bing', 'anysearch', 'searxng', 'exa', 'tavily', 'keenable', 'parallel', 'firecrawl', 'you', 'ddg', 'brave', 'perplexity']
const EN_ORDER = ['exa', 'tavily', 'parallel', 'keenable', 'firecrawl', 'you', 'bing', 'anysearch', 'searxng', 'ddg', 'brave', 'perplexity']
const CJK_RE = /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/

function classifyFailure(e) {
  const msg = String(e?.message || e || '')
  if (/authentication|unauthor|invalid.*key|401|403|未登录|鉴权|密钥/i.test(msg)) return 'auth'
  if (/quota|credit|402|额度|余额|billing|usage limit/i.test(msg)) return 'quota'
  if (/captcha|challenge|unusual traffic|bot|verification|429|rate.?limit/i.test(msg)) return 'bot-wall'
  if (/timeout|timed out|aborted|ECONN|ENOTFOUND|EAI_AGAIN|fetch failed|network|请求失败/i.test(msg)) return 'transient'
  return 'invalid'
}

const COOLDOWN_MS = {
  auth: 30 * 60 * 1000,
  quota: 15 * 60 * 1000,
  'bot-wall': 2 * 60 * 1000,
  transient: 0,
  invalid: 0,
}

const QUALITY_GATED = new Set(['bing', 'ddg', 'anysearch', 'searxng'])
const QUERY_STOP = /[\s，。！？、,.!?:：;；()（）\[\]【】"'“”‘’/\\|-]+/
const MAX_EXPLICIT_ENGINES = 4

/** 归一显式搜索源列表：小写、去重、去 auto/空值、最多 4 个 */
export function normalizeEngineList(v) {
  const list = Array.isArray(v) ? v : (v == null || v === '' ? [] : [v])
  const out = []
  for (const x of list) {
    const name = String(x || '').trim().toLowerCase()
    if (!name || name === 'auto' || out.includes(name)) continue
    out.push(name)
    if (out.length >= MAX_EXPLICIT_ENGINES) break
  }
  return out
}

/** 中文/英文查询的粗粒度词元：中文取 2-gram，英文取长度 ≥3 的词 */
function queryTokens(q) {
  const s = String(q || '').toLowerCase()
  const out = new Set()
  for (const w of s.split(QUERY_STOP)) {
    const t = w.trim()
    if (!t) continue
    if (CJK_RE.test(t)) {
      for (let i = 0; i + 1 < t.length; i++) out.add(t.slice(i, i + 2))
    } else if (t.length >= 3) out.add(t)
  }
  return [...out]
}

/**
 * 结果质量评估：只用于自动模式下的免费 HTML/聚合引擎。
 * Bing 在中文长查询上经常把词拆成单字，返回字典/首页等泛结果；只要质量分低就继续试下一个引擎。
 */
export function assessSearchQuality(provider, result, query = '') {
  const results = Array.isArray(result?.results) ? result.results : []
  if (result?.answer) return { score: 100, poor: false, reason: null }
  if (!results.length) return { score: 0, poor: true, reason: 'empty' }
  const domains = new Set()
  let snippetChars = 0
  let titleChars = 0
  const text = []
  for (const r of results) {
    const host = hostOf(r?.url)
    if (host) domains.add(host)
    const title = String(r?.title || '')
    const body = String(r?.content || r?.snippet || '')
    titleChars += title.length
    snippetChars += body.length
    text.push(`${title} ${body}`.toLowerCase())
  }
  const hay = text.join('\n')
  const toks = queryTokens(query)
  const hit = toks.filter((t) => hay.includes(t)).length
  const overlap = toks.length ? hit / toks.length : 1
  const requiredHits = toks.length >= 4 ? Math.min(3, Math.ceil(toks.length * 0.4)) : 1
  const score = Math.round(
    Math.min(1, results.length / 5) * 30 +
    Math.min(1, domains.size / 3) * 25 +
    Math.min(1, (snippetChars / results.length) / 50) * 20 +
    overlap * 25,
  )
  const reasons = []
  if (results.length < 3) reasons.push(`only_${results.length}_results`)
  if (domains.size < 2) reasons.push('single_domain')
  if (snippetChars / results.length < 12) reasons.push('thin_snippets')
  if (titleChars / results.length < 6) reasons.push('short_titles')
  if (toks.length && overlap === 0) reasons.push('no_query_overlap')
  if (requiredHits > 1 && hit < requiredHits) reasons.push('weak_query_overlap')
  const gated = QUALITY_GATED.has(String(provider || '').toLowerCase())
  const hardPoor = (toks.length >= 2 && hit < requiredHits)
    || domains.size < 2
    || ((snippetChars / results.length) < 12 && overlap < 0.2)
  const finalScore = hardPoor && score >= 45 ? 39 : score
  return { score: finalScore, poor: gated && (finalScore < 45 || hardPoor), reason: reasons.join(',') || (finalScore < 45 ? `score_${finalScore}` : null) }
}

function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase() } catch { return '' }
}

function domainMatch(host, list) {
  return (list || []).some((d) => {
    const x = String(d || '').trim().toLowerCase().replace(/^\.+/, '')
    if (!x) return false
    return host === x || host.endsWith('.' + x)
  })
}

export class SearchManager {
  constructor({ providers = [], logger = () => {}, engine = 'auto', fallbackOrder = null, cacheMinutes = 5, safeSearch = 'off', blockedDomains = [], timeout = null, lang = 'zh', bingMarket = '' } = {}) {
    this.providers = providers
    this.logger = logger
    this.engine = engine || 'auto'
    this.fallbackOrder = Array.isArray(fallbackOrder) && fallbackOrder.length ? fallbackOrder.map(String) : null
    this.cacheMs = Math.max(0, Number(cacheMinutes) || 0) * 60 * 1000
    this.safeSearch = String(safeSearch || 'off').toLowerCase()
    this.blockedDomains = Array.isArray(blockedDomains) ? blockedDomains : []
    this.timeout = timeout
    this.lang = lang
    this.bingMarket = bingMarket
    this._cache = new Map()
    this._cool = new Map()
  }

  get availableProviders() {
    return this.providers.filter((p) => !p.available || p.available()).map((p) => p.name)
  }

  /** 供工具回传给模型的源状态：可用性 + 是否冷却 + 冷却原因。 */
  get providerStatus() {
    const out = []
    for (const p of this.providers) {
      if (p.available && !p.available()) continue
      const cooling = this._cooling(p.name)
      const c = this._cool.get(p.name)
      out.push({
        name: p.name,
        cooling,
        ...(cooling && c ? { cooldownUntil: c.until, cooldownReason: c.cls } : {}),
      })
    }
    return out
  }

  /** 可供模型换源重试的源（排除冷却中的）。 */
  get retryableProviders() {
    return this.providerStatus.filter((p) => !p.cooling).map((p) => p.name)
  }

  _providerOptions(opts = {}) {
    return {
      ...opts,
      max_results: Math.min(Math.max(Number(opts.max_results) || 8, 1), 20),
      safe_search: String(opts.safe_search || this.safeSearch || 'off').toLowerCase(),
      bingMarket: opts.bingMarket || this.bingMarket,
      lang: this.lang,
    }
  }

  _cooling(name) {
    const c = this._cool.get(name)
    if (!c) return false
    if (Date.now() < c.until) return true
    this._cool.delete(name)
    return false
  }

  _markCooldown(name, cls) {
    const ms = COOLDOWN_MS[cls] || 0
    if (ms > 0) this._cool.set(name, { until: Date.now() + ms, cls })
  }

  _order(query, opts = {}) {
    const names = this.providers.map((p) => p.name)
    const explicit = String(opts.engine || this.engine || 'auto').toLowerCase()
    if (explicit !== 'auto' && names.includes(explicit)) {
      const out = [explicit, ...(this.fallbackOrder || (CJK_RE.test(query) ? ZH_ORDER : EN_ORDER))]
        .filter((n, i, a) => n && a.indexOf(n) === i)
      for (const n of names) if (!out.includes(n)) out.push(n)
      return out
    }
    const base = this.fallbackOrder || (CJK_RE.test(query) ? ZH_ORDER : EN_ORDER)
    const out = []
    for (const n of base) if (names.includes(n) && !out.includes(n)) out.push(n)
    for (const n of names) if (!out.includes(n)) out.push(n)
    return out
  }

  _cacheKey(query, opts) {
    return JSON.stringify({
      q: String(query || ''),
      engine: opts.engine || this.engine,
      max: opts.max_results ?? null,
      safe: opts.safe_search ?? this.safeSearch,
      time: opts.time_range ?? null,
      include: opts.include_domains ?? null,
      exclude: opts.exclude_domains ?? null,
    })
  }

  _filter(results, opts) {
    const include = Array.isArray(opts.include_domains) ? opts.include_domains : []
    const exclude = Array.isArray(opts.exclude_domains) ? opts.exclude_domains : []
    return (results || []).filter((r) => {
      const host = hostOf(r.url)
      if (!host) return false
      if (domainMatch(host, this.blockedDomains) || domainMatch(host, exclude)) return false
      if (include.length && !domainMatch(host, include)) return false
      return true
    })
  }

  async search(query, opts = {}) {
    const q = String(query || '').trim()
    if (!q) throw new Error('缺少查询词')
    const key = this._cacheKey(q, opts)
    if (this.cacheMs) {
      const hit = this._cache.get(key)
      if (hit && Date.now() - hit.at < this.cacheMs) return hit.value
    }
    const order = this._order(q, opts)
    const errors = []
    const tried = []
    const attempts = []
    let firstEmpty = null
    let bestPoor = null
    const explicit = String(opts.engine || this.engine || 'auto').toLowerCase()
    const qualityGate = explicit === 'auto'
    const providerOptions = this._providerOptions(opts)

    for (const name of order) {
      const p = this.providers.find((x) => x.name === name)
      if (!p || (p.available && !p.available())) continue
      if (this._cooling(name)) {
        errors.push(`${name}: cooling down`)
        attempts.push({ name, ok: false, cooling: true, error: 'cooling down' })
        continue
      }
      tried.push(name)
      try {
        const result = await p.search(q, providerOptions)
        if (!result) continue
        const results = this._filter(result.results, providerOptions)
        if (!result.answer && !results.length) {
          attempts.push({ name, ok: false, count: 0, error: 'empty' })
          if (!firstEmpty) firstEmpty = { ...result, results: [], sources: tried.slice() }
          continue
        }
        const quality = assessSearchQuality(name, { ...result, results }, q)
        if (qualityGate && quality.poor) {
          const poor = { ...result, results, provider: result.provider || name }
          if (!bestPoor || quality.score > bestPoor.score) bestPoor = { score: quality.score, value: poor }
          errors.push(`${name}: poor quality (${quality.reason || `score_${quality.score}`})`)
          attempts.push({ name, ok: false, poor: true, count: results.length, quality: quality.score, error: quality.reason || `score_${quality.score}` })
          this.logger('warn', `[search] ${name} 结果质量差 (${quality.score})：${quality.reason || '-'}，继续尝试下一个引擎`)
          continue
        }
        this._cool.delete(name)
        attempts.push({ name, ok: true, count: results.length, quality: quality.score })
        const note = errors.length ? `Note: ${errors.slice(-3).join('; ')}; using ${name}.` : undefined
        const out = {
          ...result, results, provider: result.provider || name,
          quality: quality.score, providers: attempts, available_engines: this.retryableProviders,
          ...(note ? { note } : {}),
        }
        if (this.cacheMs) this._cache.set(key, { at: Date.now(), value: out })
        if (this._cache.size > 100) this._cache.delete(this._cache.keys().next().value)
        return out
      } catch (e) {
        const cls = classifyFailure(e)
        this.logger('warn', `[search] ${name} failed (${cls}): ${e?.message || e}`)
        if (cls === 'transient') {
          try {
            const r2 = await p.search(q, providerOptions)
            if (r2?.results?.length || r2?.answer) {
              this._cool.delete(name)
              const results2 = this._filter(r2.results, providerOptions)
              const quality2 = assessSearchQuality(name, { ...r2, results: results2 }, q)
              attempts.push({ name, ok: true, retried: true, count: results2.length, quality: quality2.score })
              const out = {
                ...r2, results: results2, provider: r2.provider || name,
                quality: quality2.score, providers: attempts, available_engines: this.retryableProviders,
              }
              if (this.cacheMs) this._cache.set(key, { at: Date.now(), value: out })
              return out
            }
          } catch (e2) {
            this.logger('warn', `[search] ${name} retry failed: ${e2?.message || e2}`)
          }
        }
        this._markCooldown(name, cls)
        errors.push(`${name}: ${e?.message || e}`)
        attempts.push({ name, ok: false, error: e?.message || String(e), errorClass: cls })
      }
    }

    if (bestPoor) {
      const note = `Note: 所有可用引擎结果质量偏低；已返回最佳结果（${errors.slice(-5).join('; ')}）。结果不理想时可换 engine/engines 重搜。`
      return {
        ...bestPoor.value, sources: tried, note, quality: bestPoor.score,
        providers: attempts, available_engines: this.retryableProviders,
      }
    }
    if (firstEmpty) {
      return { ...firstEmpty, sources: tried, providers: attempts, available_engines: this.retryableProviders }
    }
    if (!tried.length) {
      throw Object.assign(new Error('无可用搜索源'), { code: 'search_unavailable', attempts, alternatives: this.retryableProviders })
    }
    throw Object.assign(new Error(`所有搜索源均失败 → ${errors.join('；')}`), {
      code: 'search_unavailable', attempts, alternatives: this.retryableProviders,
    })
  }

  /**
   * 显式多源搜索：只查询调用方指定的 engines（不再自动回退），并行后按 URL 去重合并。
   * 用途：模型发现默认结果不理想时，主动换几个源重搜并把结果结合起来。
   * 返回额外字段：providers（每源状态/质量）、available_engines（可换的其它源）。
   */
  async searchEngines(query, engines, opts = {}) {
    const q = String(query || '').trim()
    if (!q) throw new Error('缺少查询词')
    const names = normalizeEngineList(engines)
    if (!names.length) return this.search(q, opts)
    const providerOptions = this._providerOptions(opts)
    const settled = await Promise.all(names.map(async (name) => {
      try {
        const p = this.providers.find((x) => x.name === name)
        if (!p) throw Object.assign(new Error(`未知或未启用的搜索源：${name}`), { code: 'unknown_engine' })
        if (p.available && !p.available()) throw Object.assign(new Error(`搜索源不可用：${name}`), { code: 'engine_unavailable' })
        if (this._cooling(name)) throw Object.assign(new Error(`搜索源冷却中：${name}`), { code: 'engine_cooling' })
        const result = await p.search(q, providerOptions)
        const results = this._filter(result?.results, providerOptions)
        const quality = assessSearchQuality(name, { ...result, results }, q)
        const count = results.length
        const ok = !!(result?.answer || count)
        this._cool.delete(name)
        return {
          name, ok, count, quality: quality.score,
          result: { ...(result || {}), results, provider: result?.provider || name },
          ...(ok ? {} : { error: 'empty' }),
        }
      } catch (e) {
        const cls = classifyFailure(e)
        this._markCooldown(name, cls)
        return { name, ok: false, count: 0, quality: null, error: e?.message || String(e), errorClass: cls }
      }
    }))
    const items = settled.map((s) => (s.ok
      ? { query: q, result: s.result }
      : { query: q, error: `${s.name}: ${s.error || '无结果'}` }))
    const merged = mergeSearchResults(items, {
      maxResults: Math.min(Math.max(Number(opts.max_results) || 8, 8), 20),
    })
    const okItems = settled.filter((s) => s.ok)
    const providers = settled.map((s) => ({
      name: s.name, ok: s.ok, count: s.count,
      quality: s.quality,
      ...(s.ok ? {} : { error: s.error || 'empty', ...(s.errorClass ? { errorClass: s.errorClass } : {}) }),
    }))
    const failed = providers.filter((p) => !p.ok).map((p) => p.name)
    return {
      ...merged,
      provider: okItems.length === 1 ? okItems[0].name : 'multi',
      quality: okItems.length ? Math.max(...okItems.map((s) => Number(s.quality) || 0)) : 0,
      providers,
      available_engines: this.retryableProviders,
      // 部分失败已由 providers/failures 明示；这里只在全部失败时给一句汇总，避免重复占上下文。
      note: okItems.length ? undefined : `指定的搜索源均未返回可用结果：${failed.join(', ')}；可换 engines 或改写查询重试。`,
    }
  }

  async searchMany(queries, opts = {}) {
    const list = (Array.isArray(queries) ? queries : [queries])
      .map((q) => String(q || '').trim())
      .filter(Boolean)
      .slice(0, 4)
    if (!list.length) throw new Error('缺少查询词（queries 为空）')
    const engines = normalizeEngineList(opts.engines)
    const runOne = engines.length
      ? (q) => this.searchEngines(q, engines, opts)
      : (q) => this.search(q, opts)
    const settled = await Promise.allSettled(list.map(runOne))
    const items = settled.map((s, i) => (s.status === 'fulfilled'
      ? { query: list[i], result: s.value }
      : { query: list[i], error: s.reason?.message || String(s.reason) }))
    const merged = mergeSearchResults(items)
    if (engines.length) {
      // 聚合每条查询的每源状态：count 求和、quality 取最高、任一成功即 ok。
      const byName = new Map()
      for (const s of settled) {
        if (s.status !== 'fulfilled' || !Array.isArray(s.value?.providers)) continue
        for (const p of s.value.providers) {
          const cur = byName.get(p.name) || { name: p.name, ok: false, count: 0, quality: null }
          cur.ok = cur.ok || p.ok === true
          cur.count += Number(p.count) || 0
          if (p.quality != null) cur.quality = Math.max(Number(cur.quality) || 0, Number(p.quality) || 0)
          if (!p.ok && !cur.error) { cur.error = p.error || 'empty'; if (p.errorClass) cur.errorClass = p.errorClass }
          byName.set(p.name, cur)
        }
      }
      merged.engines = engines
      merged.providers = [...byName.values()]
      merged.available_engines = this.retryableProviders
      if (merged.providers.length) merged.quality = Math.max(...merged.providers.map((p) => Number(p.quality) || 0))
    }
    this.logger('debug', `[search] searchMany ${list.length} queries${engines.length ? ` × ${engines.join('/')}` : ''} → ${merged.results.length} merged results${merged.failures.length ? `（${merged.failures.length} 条查询失败）` : ''}`)
    return merged
  }

  async extract(urls, opts = {}) {
    const errs = []
    let tried = 0
    for (const p of this.providers) {
      if (!p.available() || !p.extract) continue
      tried++
      try {
        return await p.extract(urls, opts)
      } catch (e) {
        this.logger('warn', `[extract] ${p.name} failed: ${e?.message || e}`)
        errs.push(`${p.name}: ${e?.message || e}`)
      }
    }
    if (!tried) throw new Error('无可用提取源（可在配置中填 Tavily key 以启用 web_extract）')
    throw new Error(`所有提取源均失败 → ${errs.join('；')}`)
  }
}

/**
 * 从配置构建 SearchManager。
 * config: { tavily/exa/perplexity/brave/searxng/anysearch/keenable/firecrawl/parallel/you, engine, fallbackOrder,
 *           safeSearch, cacheMinutes, blockedDomains, lang, bingMarket, bing, ddg, timeout, fetcher, logger }
 */
export function createSearchManager(config = {}) {
  const providers = []
  const fetcher = config.fetcher
  const timeoutOf = (name) => {
    const per = (name === 'ddg' && typeof config.ddg === 'object') ? config.ddg?.timeout : config?.[name]?.timeout
    const n = Number(per ?? config.timeout)
    return Number.isFinite(n) && n > 0 ? n : undefined
  }
  const add = (p) => { if (p) providers.push(p) }

  if (config.bing !== false) add(createBingProvider({ fetcher, timeout: timeoutOf('bing') || 15000, bingMarket: config.bingMarket, lang: config.lang }))
  if (config.ddg !== false) add(createDDGProvider({ fetcher, timeout: timeoutOf('ddg') || 15000 }))
  if (config.anysearch !== false) add(createAnySearchProvider({ apiKey: config.anysearch?.apiKey, fetcher, timeout: timeoutOf('anysearch') || 12000 }))
  if (config.searxng?.url) add(createSearXNGProvider({ ...config.searxng, fetcher, timeout: timeoutOf('searxng') || 15000 }))
  if (config.exa !== false) add(createExaProvider({ ...config.exa, fetcher, timeout: timeoutOf('exa') || 30000 }))
  if (config.tavily !== false) add(createTavilyProvider({ ...config.tavily, fetcher, timeout: timeoutOf('tavily') || 15000 }))
  if (config.keenable !== false) add(createKeenableProvider({ apiKey: config.keenable?.apiKey, fetcher, timeout: timeoutOf('keenable') || 25000 }))
  if (config.firecrawl !== false) add(createFirecrawlProvider({ apiKey: config.firecrawl?.apiKey, fetcher, timeout: timeoutOf('firecrawl') || 20000 }))
  if (config.parallel !== false) add(createParallelProvider({ apiKey: config.parallel?.apiKey, fetcher, timeout: timeoutOf('parallel') || 25000 }))
  if (config.you !== false) add(createYouProvider({ apiKey: config.you?.apiKey, fetcher, timeout: timeoutOf('you') || 15000 }))
  if (config.brave?.apiKey) add(createBraveProvider({ ...config.brave, fetcher, timeout: timeoutOf('brave') || 15000 }))
  if (config.perplexity?.apiKey) add(createPerplexityProvider({ ...config.perplexity, fetcher, timeout: timeoutOf('perplexity') || 60000 }))

  return new SearchManager({
    providers,
    logger: config.logger || (() => {}),
    engine: config.engine || 'auto',
    fallbackOrder: config.fallbackOrder,
    cacheMinutes: config.cacheMinutes ?? 5,
    safeSearch: config.safeSearch || 'off',
    blockedDomains: config.blockedDomains || [],
    timeout: config.timeout,
    lang: config.lang || 'zh',
    bingMarket: config.bingMarket || '',
  })
}
