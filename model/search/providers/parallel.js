/** Parallel：无 key 走官方 MCP 匿名额度，有 key 走 REST */
import { mcpCallTool, mcpContentText, parseParallelResult, cleanText } from '../mcp.js'

const SESSION_ID = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('')

function mapResults(list) {
  return (list || [])
    .filter((r) => r.url)
    .map((r) => {
      const excerpt = (r.excerpts || []).find((e) => String(e || '').trim())
      return {
        title: cleanText(r.title || ''),
        url: r.url,
        content: cleanText(excerpt || r.snippet || r.description || '').slice(0, 300),
        ...(r.publish_date ? { published: String(r.publish_date) } : {}),
      }
    })
}

export function createParallelProvider({ apiKey = '', fetcher, timeout = 25000 } = {}) {
  const f = fetcher || globalThis.fetch
  const key = String(apiKey || '').trim()
  return {
    name: 'parallel',
    free: true,
    available: () => true,
    async search(query, options = {}) {
      if (!f) throw new Error('Parallel 缺少 fetcher')
      const maxResults = Math.min(Math.max(options.max_results || 5, 1), 20)
      if (key) {
        const res = await f('https://api.parallel.ai/v1/search', {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json', 'x-api-key': key },
          body: JSON.stringify({
            objective: query,
            search_queries: [query],
            mode: 'fast',
            advanced_settings: { max_results: maxResults },
          }),
          signal: AbortSignal.timeout(timeout),
        })
        const raw = await res.text().catch(() => '')
        if (res.ok === false || res.status >= 400) throw new Error(`Parallel HTTP ${res.status}: ${raw.slice(0, 160)}`)
        let data
        try { data = JSON.parse(raw) } catch { throw new Error('Parallel 返回非 JSON') }
        return { provider: 'parallel', query, answer: null, results: mapResults(data.results), citations: null, raw: data }
      }

      const result = await mcpCallTool(f, {
        endpoint: 'https://search.parallel.ai/mcp',
        tool: 'web_search',
        args: { objective: query, search_queries: [query], session_id: SESSION_ID },
        timeoutMs: timeout,
        label: 'Parallel MCP',
      })
      const text = mcpContentText(result)
      const list = parseParallelResult(text)
      return {
        provider: 'parallel', query, answer: null,
        results: mapResults(list).slice(0, maxResults),
        citations: null, raw: { text: text.slice(0, 500) },
      }
    },
  }
}
