/** Keenable：有 key 走 REST，无 key 走公开 MCP 匿名额度 */
import { mcpCallTool, mcpContentText, parseTitleBlocks, looksRelevant } from '../mcp.js'

function relativeRange(timeRange) {
  const t = String(timeRange || '').toLowerCase()
  return t === 'day' ? '12h' : t === 'week' ? '7d' : t === 'month' ? '30d' : t === 'year' ? '1y' : ''
}

export function createKeenableProvider({ apiKey = '', fetcher, timeout = 25000 } = {}) {
  const f = fetcher || globalThis.fetch
  const key = String(apiKey || '').trim()
  return {
    name: 'keenable',
    free: true,
    available: () => true,
    async search(query, options = {}) {
      if (!f) throw new Error('Keenable 缺少 fetcher')
      const timeRange = relativeRange(options.time_range)
      if (key) {
        const res = await f('https://api.keenable.ai/v1/search', {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json', 'x-api-key': key },
          body: JSON.stringify({ query, mode: 'realtime', ...(timeRange ? { published_after: timeRange } : {}) }),
          signal: AbortSignal.timeout(timeout),
        })
        const body = await res.text().catch(() => '')
        if (res.ok === false || res.status >= 400) throw new Error(`Keenable HTTP ${res.status}: ${body.slice(0, 160)}`)
        let data
        try { data = JSON.parse(body) } catch { throw new Error('Keenable 返回非 JSON') }
        const results = (data.results || []).filter((r) => r.url).map((r) => ({
          title: String(r.title || ''),
          url: r.url,
          content: String(r.snippet || r.description || '').slice(0, 300),
        }))
        return { provider: 'keenable', query, answer: null, results: looksRelevant(query, results) ? results : [], citations: null, raw: data }
      }

      const result = await mcpCallTool(f, {
        endpoint: 'https://api.keenable.ai/mcp',
        tool: 'search_web_pages',
        args: { query, ...(timeRange ? { published_after: timeRange } : {}) },
        timeoutMs: timeout,
        label: 'Keenable MCP',
      })
      const text = mcpContentText(result)
      const results = parseTitleBlocks(text, { snippetsKey: 'Snippets' })
        .slice(0, options.max_results || 10)
      return {
        provider: 'keenable', query, answer: null,
        results: looksRelevant(query, results) ? results : [],
        citations: null, raw: { text: text.slice(0, 500) },
      }
    },
  }
}
