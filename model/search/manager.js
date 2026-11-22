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
    let firstEmpty = null
    let bestPoor = null
    const explicit = String(opts.engine || this.engine || 'auto').toLowerCase()
    const qualityGate = explicit === 'auto'
    const providerOptions = {
      ...opts,
      max_results: Math.min(Math.max(Number(opts.max_results) || 8, 1), 20),
      safe_search: String(opts.safe_search || this.safeSearch || 'off').toLowerCase(),
      bingMarket: opts.bingMarket || this.bingMarket,
      lang: this.lang,
    }

    for (const name of order) {
      const p = this.providers.find((x) => x.name === name)
      if (!p || (p.available && !p.available())) continue
      if (this._cooling(name)) { errors.push(`${name}: cooling down`); continue }
      tried.push(name)
      try {
        const result = await p.search(q, providerOptions)
        if (!result) continue
        const results = this._filter(result.results, providerOptions)
        if (!result.answer && !results.length) {
          if (!firstEmpty) firstEmpty = { ...result, results: [], sources: tried.slice() }
          continue
        }
        const quality = assessSearchQuality(name, { ...result, results }, q)
        if (qualityGate && quality.poor) {
          const poor = { ...result, results, provider: result.provider || name }
          if (!bestPoor || quality.score > bestPoor.score) bestPoor = { score: quality.score, value: poor }
          errors.push(`${name}: poor quality (${quality.reason || `score_${quality.score}`})`)
          this.logger('warn', `[search] ${name} 结果质量差 (${quality.score})：${quality.reason || '-'}，继续尝试下一个引擎`)
          continue
        }
        this._cool.delete(name)
        const note = errors.length ? `Note: ${errors.slice(-3).join('; ')}; using ${name}.` : undefined
        const out = { ...result, results, provider: result.provider || name, ...(note ? { note } : {}) }
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
              const out = { ...r2, results: this._filter(r2.results, providerOptions), provider: r2.provider || name }
              if (this.cacheMs) this._cache.set(key, { at: Date.now(), value: out })
              return out
            }
          } catch (e2) {
            this.logger('warn', `[search] ${name} retry failed: ${e2?.message || e2}`)
          }
        }
        this._markCooldown(name, cls)
        errors.push(`${name}: ${e?.message || e}`)
      }
    }

    if (bestPoor) {
      const note = `Note: 所有可用引擎结果质量偏低；已返回最佳结果（${errors.slice(-5).join('; ')}）。`
      return { ...bestPoor.value, sources: tried, note, quality: bestPoor.score }
    }
    if (firstEmpty) return { ...firstEmpty, sources: tried }
    if (!tried.length) throw new Error('无可用搜索源')
    throw new Error(`所有搜索源均失败 → ${errors.join('；')}`)
  }

  async searchMany(queries, opts = {}) {
    const list = (Array.isArray(queries) ? queries : [queries])
      .map((q) => String(q || '').trim())
      .filter(Boolean)
      .slice(0, 4)
    if (!list.length) throw new Error('缺少查询词（queries 为空）')
    const settled = await Promise.allSettled(list.map((q) => this.search(q, opts)))
    const items = settled.map((s, i) => (s.status === 'fulfilled'
      ? { query: list[i], result: s.value }
      : { query: list[i], error: s.reason?.message || String(s.reason) }))
    const merged = mergeSearchResults(items)
    this.logger('debug', `[search] searchMany ${list.length} queries → ${merged.results.length} merged results${merged.failures.length ? `（${merged.failures.length} 条查询失败）` : ''}`)
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
