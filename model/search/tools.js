/** Agent 工具 —— 包装 SearchManager 为 ToolRegistry 兼容工具 */
import { formatResults, formatExtract } from './base.js'
import { normalizeEngineList } from './manager.js'

const ENGINES = ['auto', 'bing', 'ddg', 'anysearch', 'exa', 'tavily', 'keenable', 'firecrawl', 'parallel', 'you', 'searxng', 'brave', 'perplexity']
const PROVIDER_ENUMS = ENGINES.filter((x) => x !== 'auto')

function pick(obj, keys) {
  const o = {}
  for (const k of keys) if (obj[k] != null) o[k] = obj[k]
  return o
}

export function makeSearchTools(manager, defaults = {}) {
  return [
    {
      name: 'web_search',
      description: '联网搜索（免费引擎优先 + 自动回退：Bing / DDG / AnySearch / Exa(keyless) / Tavily(keyless) / Keenable / Firecrawl / Parallel / You.com / SearXNG；配置 key 后可用 Brave / Perplexity 及增强额度）。输入查询词，返回排序后的相关结果 + 可选 AI 答案；用于获取实时信息或超出知识范围的内容。核验关键事实时用 queries 一次并行发 2~4 个不同角度（官方一手/不同措辞/找反证），结果按 URL 去重合并。**若返回结果不理想（空/答非所问/质量提示偏低/只有转载/来源太单一），不要直接拿它回答：用 engines 显式指定 2~4 个其它搜索源（如 ["bing","ddg","exa"]）重搜，或换 engine 单个源重搜，工具会把多源结果去重合并并返回各源状态；结合多轮搜索结果再下结论。** 若所有搜索源都不可用，会返回结构化错误并附 alternatives，不要只反复重试本工具。',
      category: 'query',
      meta: { summary: '联网搜索（免费引擎优先/自动回退）', capabilities: ['net', 'net.search'] },
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '单个搜索查询（简单问题用它；需要多角度核验时改用 queries）' },
          queries: {
            type: 'array', items: { type: 'string' }, maxItems: 4,
            description: '并行多角度查询（2~4 条：同一事实换措辞/换来源/官方一手/反方观点/辟谣反证），与 query 二选一；结果自动去重合并',
          },
          engine: { type: 'string', enum: ENGINES, description: '指定首选引擎（auto=按语言自动选；失败仍自动回退其它引擎）' },
          engines: {
            type: 'array', items: { type: 'string', enum: PROVIDER_ENUMS }, maxItems: 4,
            description: '显式并行查询多个搜索源（1~4 个，如 ["bing","ddg","exa"]），结果按 URL 去重合并并返回各源质量/失败状态；用于默认结果不理想时换源重搜。指定后只跑这些源，不再自动回退。',
          },
          include_domains: { type: 'array', items: { type: 'string' }, description: '只在指定域名内搜索（如官方站点，用于核对一手来源）' },
          exclude_domains: { type: 'array', items: { type: 'string' }, description: '排除指定域名（如已知内容农场）' },
          max_results: { type: 'integer', description: '返回结果数（默认 8）' },
          topic: { type: 'string', description: '搜索类别（general/news/finance）' },
          time_range: { type: 'string', enum: ['day', 'week', 'month', 'year'], description: '时间过滤' },
          safe_search: { type: 'string', enum: ['off', 'moderate', 'strict'], description: '安全搜索（Bing/DDG 支持）' },
        },
      },
      async execute(params = {}) {
        const engines = normalizeEngineList(params.engines).filter((e) => PROVIDER_ENUMS.includes(e))
        const opts = {
          ...defaults,
          ...pick(params, ['max_results', 'topic', 'time_range', 'search_depth', 'include_domains', 'exclude_domains', 'country', 'engine', 'safe_search']),
          ...(engines.length ? { engines } : {}),
        }
        const alternatives = (r = null) => {
          const pool = [...(r?.available_engines || []), ...(manager.retryableProviders || manager.availableProviders || [])]
          return [...new Set(pool)].filter((n) => !engines.includes(n))
        }
        const queries = []
        if (Array.isArray(params.queries)) {
          for (const q of params.queries) { const s = String(q || '').trim(); if (s) queries.push(s) }
        }
        const single = String(params.query || '').trim()
        if (single) queries.unshift(single)
        const list = [...new Set(queries)].slice(0, 4)
        if (!list.length) return '(未提供查询词：请用 query 或 queries)'
        try {
          if (list.length === 1) {
            const r = engines.length
              ? await manager.searchEngines(list[0], engines, opts)
              : await manager.search(list[0], opts)
            const failures = Array.isArray(r?.failures) ? r.failures : []
            if (engines.length && !r?.results?.length && !r?.answers?.length) {
              return {
                error: 'search_unavailable',
                reason: failures.map((f) => `「${f.query}」${f.error}`).join('；') || r?.note || '指定搜索源均未返回可用结果',
                queries: list,
                engines,
                failures,
                providers: r?.providers || [],
                alternatives: alternatives(r),
                hint: '结果不理想可换 engines/engine 或改写查询重试；也可用 web_crawl / web_extract 直接读权威页面。',
              }
            }
            return formatResults(r)
          }
          const merged = await manager.searchMany(list, opts)
          const failures = Array.isArray(merged.failures) ? merged.failures : []
          // 全部查询都失败时给出结构化错误（而不是让模型把 failures 文本当“没搜到”），
          // 便于 Agent 侧识别为网络/上游故障并给出可换的搜索源。
          if (!merged.results?.length && !merged.answers?.length && failures.length >= list.length) {
            return {
              error: 'search_unavailable',
              reason: failures.map((f) => `「${f.query}」${f.error}`).join('；'),
              queries: list,
              ...(engines.length ? { engines } : {}),
              failures,
              ...(merged.providers ? { providers: merged.providers } : {}),
              alternatives: alternatives(merged),
              hint: '结果不理想可换 engines/engine 或改写查询重试。',
            }
          }
          return formatResults(merged)
        } catch (e) {
          return {
            error: 'search_unavailable',
            reason: e?.message || String(e),
            queries: list,
            ...(engines.length ? { engines } : {}),
            ...(Array.isArray(e?.attempts) ? { providers: e.attempts } : {}),
            alternatives: alternatives({ available_engines: e?.alternatives }),
            hint: '可换 engines/engine 或改写查询重试。',
          }
        }
      },
    },
    {
      name: 'web_extract',
      description: '从指定 URL 提取干净的正文内容（当前提取源为 Tavily，需在配置中填写 tavily.apiKey；未配置时请改用 web_crawl 工具）。核对关键来源/交叉验证时用它读一手页面正文；搜索接口不可用时也可直接读已知 URL。',
      category: 'query',
      meta: { summary: '从 URL 提取网页正文', resultCap: 12000, capabilities: ['net', 'net.fetch'] },
      parameters: {
        type: 'object',
        properties: {
          urls: { type: 'array', items: { type: 'string' }, description: '要提取的 URL 列表' },
        },
        required: ['urls'],
      },
      async execute(params = {}) {
        try {
          const res = await manager.extract(params.urls)
          return formatExtract(res)
        } catch (e) {
          return { error: 'extract_unavailable', reason: e?.message || String(e), urls: params.urls }
        }
      },
    },
  ]
}
