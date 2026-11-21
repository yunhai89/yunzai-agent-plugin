/** You.com 免 key 匿名档（每天 100 次）/ 可选 API key */
import { cleanText } from '../mcp.js'

export function createYouProvider({ apiKey = '', fetcher, timeout = 15000 } = {}) {
  const f = fetcher || globalThis.fetch
  const key = String(apiKey || '').trim()
  return {
    name: 'you',
    free: true,
    available: () => true,
    async search(query, options = {}) {
      if (!f) throw new Error('You.com 缺少 fetcher')
      const params = new URLSearchParams({
        query,
        count: String(Math.min(Math.max(options.max_results || 10, 1), 20)),
      })
      const res = await f(`${key ? 'https://ydc-index.io/v1/search' : 'https://api.you.com/v1/agents/search'}?${params}`, {
        headers: {
          accept: 'application/json',
          ...(key ? { 'X-API-Key': key } : {}),
        },
        signal: AbortSignal.timeout(timeout),
      })
      const body = await res.text().catch(() => '')
      if (res.ok === false || res.status >= 400) {
        throw new Error(`You.com HTTP ${res.status}: ${body.replace(/\s+/g, ' ').slice(0, 160)}`)
      }
      let data
      try { data = JSON.parse(body) } catch { throw new Error('You.com 返回非 JSON') }
      const hits = data.results?.web || []
      const results = hits
        .filter((r) => r.url)
        .map((r) => {
          const snippet = Array.isArray(r.snippets)
            ? r.snippets.filter((s) => typeof s === 'string' && s).join(' ')
            : (r.description || '')
          return {
            title: cleanText(r.title || ''),
            url: r.url,
            content: cleanText(snippet).slice(0, 300),
          }
        })
      return { provider: 'you', query, answer: null, results, citations: null, raw: data }
    },
  }
}
