/** Exa provider —— 有 key 走 REST 语义搜索；无 key 走公开 MCP 匿名额度 */
import { mcpCallTool, mcpContentText, parseTitleBlocks } from '../mcp.js'

const BASE = 'https://api.exa.ai'

export function createExaProvider({ apiKey, baseURL = BASE, fetcher, timeout = 30000 } = {}) {
  const f = fetcher || globalThis.fetch
  const key = String(apiKey || '').trim()
  return {
    name: 'exa',
    free: true,
    available: () => true,
    async search(query, options = {}) {
      if (!f) throw new Error('Exa 缺少 fetcher')
      if (!key) {
        const result = await mcpCallTool(f, {
          endpoint: 'https://mcp.exa.ai/mcp',
          tool: 'web_search_exa',
          args: { query, numResults: Math.min(Math.max(options.max_results || 5, 1), 20) },
          timeoutMs: timeout,
          label: 'Exa MCP',
        })
        const text = mcpContentText(result)
        const results = parseTitleBlocks(text, { snippetsKey: 'Highlights' })
          .slice(0, options.max_results || 10)
        return {
          provider: 'exa', query, answer: null, results,
          citations: null, raw: { text: text.slice(0, 500) },
        }
      }
      const body = {
        query,
        type: options.type || 'auto',
        numResults: options.max_results || 10,
        ...(options.category ? { category: options.category } : {}),
        ...(options.include_domains ? { includeDomains: options.include_domains } : {}),
        ...(options.exclude_domains ? { excludeDomains: options.exclude_domains } : {}),
        contents: {
          highlights: options.highlights === false ? undefined : (options.highlights_query ? { query: options.highlights_query, numSentences: 3, highlightsPerUrl: 2 } : true),
          ...(options.text ? { text: { maxCharacters: 3000 } } : {}),
        },
      }
      const res = await f(`${baseURL}/search`, {
        method: 'POST',
        headers: { 'x-api-key': key, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeout),
      })
      if (res.ok === false || res.status >= 400) throw new Error(`Exa HTTP ${res.status}: ${await res.text().catch(() => '')}`)
      const json = await res.json()
      return {
        provider: 'exa', query,
        answer: json.answer || null,
        results: (json.results || []).map((r) => ({
          title: r.title,
          url: r.url,
          content: (r.highlights && r.highlights.length ? r.highlights.join('\n') : r.text) || '',
          score: r.score,
        })),
        citations: null, raw: json,
      }
    },
  }
}
