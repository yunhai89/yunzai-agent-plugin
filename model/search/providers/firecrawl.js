/** Firecrawl 搜索：官方免 key 匿名额度；可选 API key 提升限额 */
import { cleanText, looksRelevant } from '../mcp.js'

const TBS = { day: 'qdr:d', week: 'qdr:w', month: 'qdr:m', year: 'qdr:y' }

export function createFirecrawlProvider({ apiKey = '', fetcher, timeout = 20000 } = {}) {
  const f = fetcher || globalThis.fetch
  const key = String(apiKey || '').trim()
  return {
    name: 'firecrawl',
    free: true,
    available: () => true,
    async search(query, options = {}) {
      if (!f) throw new Error('Firecrawl 缺少 fetcher')
      const body = {
        query,
        limit: Math.min(Math.max(options.max_results || 5, 1), 10),
        ...(TBS[String(options.time_range || '').toLowerCase()] ? { tbs: TBS[String(options.time_range).toLowerCase()] } : {}),
      }
      const res = await f('https://api.firecrawl.dev/v2/search', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          ...(key ? { authorization: `Bearer ${key}` } : {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeout),
      })
      const raw = await res.text().catch(() => '')
      if (res.ok === false || res.status >= 400) {
        if (!key && res.status === 403 && /vpn|proxy|api key from here|without an api key/i.test(raw)) {
          throw new Error('Firecrawl 免 key 档拒绝了当前出口 IP（请配置 firecrawl.apiKey 或换网络）')
        }
        throw new Error(`Firecrawl HTTP ${res.status}: ${raw.replace(/\s+/g, ' ').slice(0, 160)}`)
      }
      let data
      try { data = JSON.parse(raw) } catch { throw new Error('Firecrawl 返回非 JSON') }
      const results = (data.data?.web || [])
        .filter((r) => r.url)
        .map((r) => ({
          title: cleanText(r.title || ''),
          url: r.url,
          content: cleanText(r.description || '').slice(0, 300),
        }))
      return {
        provider: 'firecrawl', query, answer: null,
        results: looksRelevant(query, results) ? results : [],
        citations: null, raw: data,
      }
    },
  }
}
