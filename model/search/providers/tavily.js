/** Tavily provider —— 有 key 走账号档；无 key 走 keyless 匿名额度 */
import { TavilyClient } from '../../tavily/client.js'
import { cleanText } from '../mcp.js'

export function createTavilyProvider({ apiKey, fetcher, timeout = 15000, ...opts } = {}) {
  const f = fetcher || globalThis.fetch
  const key = String(apiKey || '').trim()
  const client = key ? new TavilyClient({ apiKey: key, fetcher: f, ...opts }) : null
  const provider = {
    name: 'tavily',
    free: true,
    available: () => true,
    async search(query, options = {}) {
      if (!f) throw new Error('Tavily 缺少 fetcher')
      if (!client) {
        const res = await f('https://api.tavily.com/search', {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json', 'x-tavily-access-mode': 'keyless' },
          body: JSON.stringify({
            query,
            max_results: Math.min(options.max_results || 5, 20),
            search_depth: 'basic',
          }),
          signal: AbortSignal.timeout(timeout),
        })
        const raw = await res.text().catch(() => '')
        if (res.ok === false || res.status >= 400) throw new Error(`Tavily keyless HTTP ${res.status}: ${raw.slice(0, 160)}`)
        let data
        try { data = JSON.parse(raw) } catch { throw new Error('Tavily 返回非 JSON') }
        return {
          provider: 'tavily', query, answer: data.answer || null,
          results: (data.results || []).filter((r) => r.url).map((r) => ({
            title: cleanText(r.title || ''),
            url: r.url,
            content: cleanText(r.content || '').slice(0, 300),
            score: r.score,
          })),
          citations: null, raw: data,
        }
      }
      const res = await client.search(query, { include_answer: 'basic', max_results: 5, ...options })
      return {
        provider: 'tavily', query,
        answer: res.answer || null,
        results: (res.results || []).map((r) => ({ title: r.title, url: r.url, content: r.content, score: r.score })),
        citations: null, raw: res,
      }
    },
  }
  if (client) {
    provider.extract = async (urls, options = {}) => {
      const res = await client.extract(urls, options)
      return { provider: 'tavily', results: res.results || [], failed: res.failed_results || [], raw: res }
    }
  }
  return provider
}
