/**
 * 统一搜索服务 —— 公共出口。
 *
 * 免费引擎优先（Bing / DDG / AnySearch / Exa keyless / Tavily keyless / Keenable /
 * Firecrawl / Parallel / You.com / SearXNG），可选 key 引擎（Exa/Tavily/Brave/Perplexity 等）；
 * 失败分类 + 冷却 + 同查询缓存 + 域名过滤。
 *
 * 用法：
 *   import { createSearchManager, makeSearchTools } from '../../model/search/index.js'
 *   const mgr = createSearchManager({ engine: 'auto' })
 *   const result = await mgr.search('AI Agent 2026')
 *   const tools = new ToolRegistry().register(...makeSearchTools(mgr))
 */

export { formatResults, formatExtract } from './base.js'
export { SearchManager, createSearchManager, mergeSearchResults } from './manager.js'
export { makeSearchTools } from './tools.js'
export { createTavilyProvider } from './providers/tavily.js'
export { createExaProvider } from './providers/exa.js'
export { createPerplexityProvider } from './providers/perplexity.js'
export { createBraveProvider } from './providers/brave.js'
export { createSearXNGProvider } from './providers/searxng.js'
export { createDDGProvider } from './providers/ddg.js'
export { createBingProvider } from './providers/bing.js'
export { createAnySearchProvider } from './providers/anysearch.js'
export { createKeenableProvider } from './providers/keenable.js'
export { createFirecrawlProvider } from './providers/firecrawl.js'
export { createParallelProvider } from './providers/parallel.js'
export { createYouProvider } from './providers/you.js'
