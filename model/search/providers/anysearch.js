/** AnySearch 免费/匿名搜索（无 key 可用；可选 key 提升额度） */
import { cleanText, looksRelevant } from '../mcp.js'

export function createAnySearchProvider({ apiKey = '', fetcher, timeout = 12000 } = {}) {
  const f = fetcher || globalThis.fetch
  return {
    name: 'anysearch',
    free: true,
    available: () => true,
    async search(query, options = {}) {
      if (!f) throw new Error('AnySearch 缺少 fetcher')
      const headers = { 'content-type': 'application/json', accept: 'application/json' }
      if (apiKey) headers.authorization = `Bearer ${apiKey}`
      const res = await f('https://api.anysearch.com/v1/search', {
        method: 'POST',
        headers,
        body: JSON.stringify({ query, max_results: Math.min(Math.max(options.max_results || 10, 1), 20) }),
        signal: AbortSignal.timeout(timeout),
      })
      const body = await res.text().catch(() => '')
      if (res.ok === false || res.status >= 400) {
        throw new Error(`AnySearch HTTP ${res.status}: ${body.replace(/\s+/g, ' ').slice(0, 160)}`)
      }
      let data
      try { data = JSON.parse(body) } catch { throw new Error('AnySearch 返回非 JSON') }
      if (data.code !== 0) throw new Error(`AnySearch error: ${data.message || data.code}`)
      const results = (data.data?.results || [])
        .filter((r) => r.url)
        .map((r) => ({
          title: cleanText(r.title || ''),
          url: r.url,
          content: cleanText(r.snippet || r.content || '').slice(0, 300),
        }))
      return {
        provider: 'anysearch', query, answer: null,
        results: results.length && !looksRelevant(query, results) ? [] : results,
        citations: null, raw: data,
      }
    },
  }
}
