/**
 * 离线自检 —— mock fetch 驱动多源搜索。
 * 运行：node model/search/test.mjs
 */
import {
  createSearchManager,
  SearchManager,
  mergeSearchResults,
  makeSearchTools,
  createTavilyProvider,
  createExaProvider,
  createPerplexityProvider,
  createBraveProvider,
  createSearXNGProvider,
  createDDGProvider,
  createBingProvider,
  createAnySearchProvider,
  createKeenableProvider,
  createFirecrawlProvider,
  createParallelProvider,
  createYouProvider,
  formatResults,
  formatExtract,
} from './index.js'

let passed = 0
let failed = 0
function ok(c, m) { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }
function eq(a, b, m) { const s = JSON.stringify(a) === JSON.stringify(b); ok(s, `${m}${s ? '' : `  (got ${JSON.stringify(a)})`}`) }
async function test(name, fn) { console.log(`\n[${name}]`); try { await fn() } catch (e) { failed++; console.error('  ✗ THROW', e?.message || e) } }

function mockFetch(json, { status = 200 } = {}) {
  return async () => ({
    ok: status < 400, status, headers: { get: () => null },
    async json() { return json }, async text() { return JSON.stringify(json) },
  })
}

function mockHtmlFetch(html) {
  return async () => ({ ok: true, status: 200, headers: { get: () => null }, async text() { return html } })
}

// ---------- 1. Tavily provider ----------
await test('provider/tavily：搜索 + 归一化', async () => {
  const f = mockFetch({ answer: '42', results: [{ title: 'A', url: 'https://a.com', content: '内容A', score: 0.9 }] })
  const p = createTavilyProvider({ apiKey: 'tvly-test', fetcher: f })
  ok(p.available(), 'available')
  const r = await p.search('test')
  eq(r.provider, 'tavily', 'provider name')
  eq(r.answer, '42', 'answer')
  eq(r.results[0].title, 'A', 'result title')
  eq(r.results[0].score, 0.9, 'score 透传')
})

// ---------- 2. Exa provider ----------
await test('provider/exa：语义搜索 + highlights', async () => {
  const f = mockFetch({ results: [{ title: '论文', url: 'https://arxiv.org/1', score: 0.82, highlights: ['关键段落1', '关键段落2'] }] })
  const p = createExaProvider({ apiKey: 'exa-test', fetcher: f })
  ok(p.available(), 'available')
  const r = await p.search('AI agent')
  eq(r.provider, 'exa', 'provider')
  eq(r.results[0].content, '关键段落1\n关键段落2', 'highlights → content')
})

// ---------- 3. Perplexity provider ----------
await test('provider/perplexity：答案引擎 + 引用', async () => {
  const f = mockFetch({
    choices: [{ message: { role: 'assistant', content: '答案是42' }, finish_reason: 'stop' }],
    citations: ['https://a.com', 'https://b.com'],
    search_results: [{ title: '来源A', url: 'https://a.com', date: '2026-01-01' }],
  })
  const p = createPerplexityProvider({ apiKey: 'pplx-test', fetcher: f })
  ok(p.available(), 'available')
  const r = await p.search('答案是什么')
  eq(r.answer, '答案是42', 'answer from content')
  eq(r.citations.length, 2, '2 citations')
  eq(r.results[0].title, '来源A', 'search_results → results')
})

// ---------- 4. Brave provider ----------
await test('provider/brave：独立索引搜索', async () => {
  const f = mockFetch({ web: { results: [{ title: 'B', url: 'https://b.com', description: '描述B' }] } })
  const p = createBraveProvider({ apiKey: 'bsa-test', fetcher: f })
  ok(p.available(), 'available')
  const r = await p.search('test')
  eq(r.provider, 'brave', 'provider')
  eq(r.results[0].content, '描述B', 'description → content')
})

// ---------- 5. SearXNG provider ----------
await test('provider/searxng：自建元搜索', async () => {
  const f = mockFetch({ results: [{ title: 'S', url: 'https://s.com', content: '内容S', score: 0.8 }] })
  const p = createSearXNGProvider({ url: 'http://localhost:8080', fetcher: f })
  ok(p.available(), 'available (有 URL)')
  const r = await p.search('test')
  eq(r.provider, 'searxng', 'provider')
  eq(r.results[0].title, 'S', 'result')
})

await test('provider/searxng：实例只回 HTML → 给出可执行报错（需开启 json 格式）', async () => {
  const f = async () => ({
    ok: true, status: 200,
    headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? 'text/html; charset=utf-8' : null) },
    async text() { return '<!doctype html><html><body>searxng html</body></html>' },
    async json() { throw new Error('not json') },
  })
  const p = createSearXNGProvider({ url: 'http://localhost:8080', fetcher: f })
  let err = null
  try { await p.search('test') } catch (e) { err = e }
  ok(err && /json/i.test(err.message) && /formats|settings\.yml/i.test(err.message), '提示在 settings.yml 开启 json')
})

await test('provider/searxng：403（实例未开 json）→ 可执行报错', async () => {
  const f = async () => ({
    ok: false, status: 403,
    headers: { get: () => 'text/html' },
    async text() { return '<html><body>403 Forbidden</body></html>' },
    async json() { throw new Error('x') },
  })
  const p = createSearXNGProvider({ url: 'http://localhost:8080', fetcher: f })
  let err = null
  try { await p.search('t') } catch (e) { err = e }
  ok(err && /403/.test(err.message) && /search\.formats/.test(err.message), '提示在 search.formats 开启 json')
})

// ---------- 6. DDG provider ----------
await test('provider/ddg：本地兜底（始终可用）', async () => {
  const html = '<a class="result-link" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com">Example</a><td class="result-snippet">an example site</td>'
  const f = mockHtmlFetch(html)
  const p = createDDGProvider({ fetcher: f })
  ok(p.available(), 'always available')
  const r = await p.search('test')
  eq(r.provider, 'ddg', 'provider')
  eq(r.results[0].url, 'https://example.com', 'URL 解码')
  eq(r.results[0].title, 'Example', 'title')
})

// ---------- 6b. 免费引擎 provider ----------
await test('provider/bing：HTML SERP 解析 + bing 跳转链接解码', async () => {
  const html = `<li class="b_algo"><h2><a href="https://www.bing.com/ck/a?u=a1aHR0cHM6Ly9leGFtcGxlLmNvbQ">Example</a></h2><p>snippet</p></li>`
  const p = createBingProvider({ fetcher: mockHtmlFetch(html) })
  const r = await p.search('example')
  eq(r.provider, 'bing', 'provider')
  eq(r.results[0].url, 'https://example.com', '解码 bing 跳转')
  eq(r.results[0].title, 'Example', '标题')
})

await test('provider/anysearch：匿名 JSON 搜索', async () => {
  const p = createAnySearchProvider({ fetcher: mockFetch({ code: 0, data: { results: [{ title: 'A', url: 'https://a.com', snippet: 'sa' }] } }) })
  const r = await p.search('a')
  eq(r.provider, 'anysearch', 'provider')
  eq(r.results[0].content, 'sa', 'snippet')
})

await test('provider/exa：无 key 走 MCP', async () => {
  const text = 'data: {"jsonrpc":"2.0","result":{"content":[{"type":"text","text":"Title: A\\nURL: https://a.com\\nHighlights:\\nfoo"}]}}\n\n'
  const p = createExaProvider({ fetcher: async () => ({ ok: true, status: 200, async text() { return text } }) })
  const r = await p.search('a')
  eq(r.provider, 'exa', 'provider')
  eq(r.results[0].url, 'https://a.com', 'MCP URL')
  eq(r.results[0].content, 'foo', 'MCP highlights')
})

await test('provider/tavily：无 key 走 keyless', async () => {
  const p = createTavilyProvider({ fetcher: mockFetch({ results: [{ title: 'T', url: 'https://t.com', content: 'tc' }] }) })
  const r = await p.search('t')
  eq(r.provider, 'tavily', 'provider')
  eq(r.results[0].content, 'tc', 'keyless 结果')
  ok(!p.extract, '无 key 不提供 extract（避免假可用）')
})

await test('provider/keenable：无 key 走 MCP', async () => {
  const text = 'data: {"jsonrpc":"2.0","result":{"content":[{"type":"text","text":"Title: K\\nURL: https://k.com\\nSnippets:\\nks"}]}}\n\n'
  const p = createKeenableProvider({ fetcher: async () => ({ ok: true, status: 200, async text() { return text } }) })
  const r = await p.search('k')
  eq(r.provider, 'keenable', 'provider')
  eq(r.results[0].url, 'https://k.com', 'MCP URL')
  eq(r.results[0].content, 'ks', 'MCP snippet')
})

await test('provider/firecrawl / you / parallel：免费解析', async () => {
  const fc = createFirecrawlProvider({ fetcher: mockFetch({ data: { web: [{ title: 'F', url: 'https://f.com', description: 'fd' }] } }) })
  eq((await fc.search('f')).results[0].content, 'fd', 'Firecrawl description')

  const you = createYouProvider({ fetcher: mockFetch({ results: { web: [{ title: 'Y', url: 'https://y.com', snippets: ['ys'] }] } }) })
  eq((await you.search('y')).results[0].content, 'ys', 'You.com snippets')

  const parallelText = 'data: {"jsonrpc":"2.0","result":{"content":[{"type":"text","text":"{\\"results\\":[{\\"url\\":\\"https://p.com\\",\\"title\\":\\"P\\",\\"excerpts\\":[\\"pe\\"]}]}"}]}}\n\n'
  const par = createParallelProvider({ fetcher: async () => ({ ok: true, status: 200, async text() { return parallelText } }) })
  eq((await par.search('p')).results[0].content, 'pe', 'Parallel excerpt')
})

// ---------- 7. 管理器回退链 ----------
await test('manager：provider 失败 → 自动回退下一个', async () => {
  // tavily 抛错 → brave 成功
  const tavily = { name: 'tavily', available: () => true, async search() { throw new Error('tavily down') } }
  const brave = createBraveProvider({ apiKey: 'bsa', fetcher: mockFetch({ web: { results: [{ title: 'OK', url: 'https://ok.com', description: 'fallback works' }] } }) })
  const mgr = new (await import('./manager.js')).SearchManager({ providers: [tavily, brave] })
  const r = await mgr.search('test')
  eq(r.provider, 'brave', '回退到 brave')
  eq(r.results[0].title, 'OK', 'brave 结果')
})

await test('manager：全部失败 → 聚合各源原因（不再只抛最后一个 fetch failed）', async () => {
  const a = { name: 'searxng', available: () => true, async search() { throw new Error('SearXNG HTTP 403') } }
  const b = { name: 'ddg', available: () => true, async search() { throw new Error('fetch failed') } }
  const mgr = new (await import('./manager.js')).SearchManager({ providers: [a, b] })
  let err = null
  try { await mgr.search('t') } catch (e) { err = e }
  ok(err && /searxng: SearXNG HTTP 403/.test(err.message) && /ddg: fetch failed/.test(err.message), '聚合两个源的原因')
})

// ---------- 7b. 空结果必须回退（SearXNG 200 + results=[] 不再吞掉 DDG）----------
await test('manager：源返回空结果 → 回退下一源', async () => {
  const empty = { name: 'searxng', available: () => true, async search() { return { provider: 'searxng', query: 't', results: [] } } }
  const ddg = { name: 'ddg', available: () => true, async search() { return { provider: 'ddg', query: 't', results: [{ title: 'D', url: 'https://d.com', content: 'c' }] } } }
  const mgr = new SearchManager({ providers: [empty, ddg] })
  const r = await mgr.search('t')
  eq(r.provider, 'ddg', '回退到 ddg')
  eq(r.results[0].title, 'D', 'ddg 结果')
})

await test('manager：所有源都空 → 返回空结果（不抛错，附尝试源）', async () => {
  const a = { name: 'a', available: () => true, async search() { return { provider: 'a', query: 't', results: [] } } }
  const b = { name: 'b', available: () => true, async search() { return { provider: 'b', query: 't', results: [] } } }
  const mgr = new SearchManager({ providers: [a, b] })
  const r = await mgr.search('t')
  eq(r.results.length, 0, '空结果返回')
  eq(r.provider, 'a', '返回首个空源')
})

// ---------- 7c. DDG 双端点 + html 版解析 ----------
await test('ddgSearch：lite 端点空 → 尝试 html 端点', async () => {
  const { ddgSearch } = await import('../agent/tools/web.js')
  let calls = 0
  const f = async (url) => {
    calls++
    if (url.includes('lite')) return { ok: true, status: 200, async text() { return '<html>no results</html>' } }
    return { ok: true, status: 200, async text() { return '<a class="result__a" href="https://h.com">H</a><a class="result__snippet">snip</a>' } }
  }
  const r = await ddgSearch('t', { fetcher: f, limit: 5 })
  eq(r.length, 1, 'html 端点结果')
  eq(r[0].url, 'https://h.com', 'URL 解析')
  eq(calls, 2, '两个端点都尝试')
})

await test('manager：同查询缓存 + auth 失败冷却', async () => {
  let calls1 = 0
  const authFail = { name: 'authfail', available: () => true, async search() { calls1++; throw new Error('authentication failed (HTTP 401)') } }
  const okP = { name: 'ok', available: () => true, async search() { return { provider: 'ok', query: 'q', results: [{ title: 'OK', url: 'https://ok.com', content: 'x' }] } } }
  const mgr = new SearchManager({ providers: [authFail, okP], cacheMinutes: 5 })
  const r1 = await mgr.search('q')
  eq(r1.provider, 'ok', 'auth 失败回退')
  ok(/authfail/.test(r1.note || ''), 'note 记录失败源')
  await mgr.search('q')
  eq(calls1, 1, '缓存命中后不再调用失败源')
})

// ---------- 7.5 质量门禁：Bing 差结果自动换引擎 ----------
await test('质量门禁：Bing 泛结果 → 自动换 anysearch', async () => {
  const poorBing = {
    name: 'bing', available: () => true,
    async search() {
      return { provider: 'bing', query: 'q', results: [
        { title: '星（汉语文字）', url: 'https://baike.baidu.com/item/星', content: '星字的释义。' },
        { title: '星 - 维基词典', url: 'https://zh.wiktionary.org/wiki/星', content: '星的读音。' },
        { title: '星星', url: 'https://baike.baidu.com/item/星星', content: '星星的意思。' },
        { title: '星', url: 'https://www.zdic.net/hans/星', content: '汉字。' },
        { title: '星字组词', url: 'https://www.zdic.net/hans/星', content: '组词。' },
      ] }
    },
  }
  const good = {
    name: 'anysearch', available: () => true,
    async search() {
      return { provider: 'anysearch', query: 'q', results: [
        { title: '星穹铁道 4.8 版本前瞻汇总', url: 'https://example.com/a', content: '星穹铁道 4.8 版本前瞻：新角色与活动。' },
        { title: '崩坏星穹铁道 4.8 前瞻直播', url: 'https://example.org/b', content: '4.8 版本前瞻直播时间与兑换码。' },
        { title: '星穹铁道 4.8 卡池', url: 'https://example.net/c', content: '4.8 版本卡池与版本活动汇总。' },
      ] }
    },
  }
  const mgr = new SearchManager({ providers: [poorBing, good], fallbackOrder: ['bing', 'anysearch'] })
  const r = await mgr.search('星穹铁道 4.8 版本 前瞻')
  eq(r.provider, 'anysearch', '差结果后回退 anysearch')
  ok(/poor quality/.test(r.note || ''), 'note 记录 Bing 质量差')
  const forced = await mgr.search('星穹铁道 4.8 版本 前瞻', { engine: 'bing' })
  eq(forced.provider, 'bing', '显式 engine=bing 时尊重用户选择')
})

// ---------- 7d. 显式多源：engines 并行、去重、状态回传 ----------
await test('manager：engines 显式多源并行、跨源去重、回传各源状态', async () => {
  const calls = []
  const p1 = {
    name: 'p1', available: () => true,
    async search(q) {
      calls.push('p1')
      return { provider: 'p1', query: q, results: [
        { title: 'A', url: 'https://a.com', content: 'q 相关内容一' },
        { title: 'B', url: 'https://b.com', content: 'q 相关内容二' },
      ] }
    },
  }
  const p2 = {
    name: 'p2', available: () => true,
    async search(q) {
      calls.push('p2')
      return { provider: 'p2', query: q, results: [
        { title: 'A2', url: 'https://a.com/', content: 'q 重复' },
        { title: 'C', url: 'https://c.com', content: 'q 相关内容三' },
      ] }
    },
  }
  const p3 = { name: 'p3', available: () => true, async search() { calls.push('p3'); return { provider: 'p3', results: [] } } }
  const mgr = new SearchManager({ providers: [p1, p2, p3], fallbackOrder: ['p3'] })
  const r = await mgr.searchEngines('q', ['p1', 'p2'], { max_results: 8 })
  eq(calls.sort().join(','), 'p1,p2', '只调用指定源，不自动回退 p3')
  eq(r.results.length, 3, '跨源 URL 去重（A/B/C）')
  eq(r.provider, 'multi', '多源成功 provider=multi')
  eq(r.providers.map((p) => `${p.name}:${p.ok}:${p.count}`), ['p1:true:2', 'p2:true:2'], '各源状态')
  eq(r.results.find((x) => x.url.includes('c.com')).source, 'p2', '结果标注来源')
  ok(r.available_engines.includes('p1') && r.available_engines.includes('p3'), '回传可换的可用源')
})

await test('manager：engines 部分失败 → 不换未指定源，失败/状态可见', async () => {
  const p1 = { name: 'p1', available: () => true, async search(q) { return { provider: 'p1', query: q, results: [{ title: 'A', url: 'https://a.com', content: 'c' }] } } }
  const p2 = { name: 'p2', available: () => true, async search() { throw new Error('403 auth failed') } }
  let p3calls = 0
  const p3 = { name: 'p3', available: () => true, async search() { p3calls++; return { provider: 'p3', results: [{ title: 'Z', url: 'https://z.com', content: 'c' }] } } }
  const mgr = new SearchManager({ providers: [p1, p2, p3], fallbackOrder: ['p3'] })
  const r = await mgr.searchEngines('q', ['p1', 'p2'])
  eq(r.results.length, 1, '成功源结果保留')
  eq(r.providers.find((p) => p.name === 'p2')?.ok, false, '失败源状态可见')
  ok(r.failures.length === 1 && /p2/.test(r.failures[0].error), '失败原因单列')
  eq(p3calls, 0, '未指定的 p3 不被调用')
  eq(r.note, undefined, '部分失败不重复写 note（由 providers/failures 明示）')
})

// ---------- 8. createSearchManager：免费引擎默认启用 ----------
await test('createSearchManager：无 key → 免费引擎 + DDG 兜底', async () => {
  // 无 key、无 searxng → Bing/DDG/AnySearch/Exa/Tavily/Keenable/Firecrawl/Parallel/You 免费引擎
  const mgr1 = createSearchManager({ fetcher: mockHtmlFetch('<a class="result-link" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fx.com">X</a><td class="result-snippet">snip</td>') })
  ok(mgr1.availableProviders.includes('ddg') && mgr1.availableProviders.includes('bing'), '无 key 仍有免费引擎')
  ok(mgr1.availableProviders.includes('anysearch') && mgr1.availableProviders.includes('exa') && mgr1.availableProviders.includes('tavily'), 'keyless 引擎可用')

  // 有 searxng → 额外加入
  const mgr2 = createSearchManager({ searxng: { url: 'http://localhost:8080' }, fetcher: mockFetch({ results: [{ title: 'S', url: 'https://s.com', content: 'c' }] }) })
  ok(mgr2.availableProviders.includes('searxng'), 'SearXNG 加入')

  // 有 tavily key → 仍是 tavily（不会重复）
  const mgr3 = createSearchManager({ tavily: { apiKey: 'tvly-x' }, fetcher: mockFetch({ results: [] }) })
  eq(mgr3.availableProviders.filter((x) => x === 'tavily').length, 1, 'Tavily 只注册一次')
})

// ---------- 9. 超时接上（本轮外部服务客户端审计第 4 条 / 既有 L-106）----------
await test('createSearchManager：timeout 真正传到各源', async () => {
  // fetcher 一直挂着，只在 abort 信号触发时 reject —— 用它观察 provider 实际生效的超时
  const hangFetcher = (rec) => (url, opts) => new Promise((_resolve, reject) => {
    if (!rec.t0) rec.t0 = Date.now()
    opts.signal.addEventListener('abort', () => { rec.ms = Date.now() - rec.t0; reject(Object.assign(new Error('aborted'), { name: 'AbortError' })) })
  })

  const rec1 = {}
  // Promise.race 里的 setTimeout 是 ref 计时器：AbortSignal.timeout 是 unref 的，
  // 单靠它进程会因事件循环空转提前退出（unsettled top-level await），故用 race 撑住事件循环。
  const waitMs = (ms) => new Promise((r) => setTimeout(r, ms))
  const onlySearxng = { bing: false, ddg: false, anysearch: false, exa: false, tavily: false, keenable: false, firecrawl: false, parallel: false, you: false }
  const mgr1 = createSearchManager({ ...onlySearxng, searxng: { url: 'http://s', timeout: 80 }, fetcher: hangFetcher(rec1) })
  await Promise.race([mgr1.search('q').catch(() => {}), waitMs(1500)])
  ok(rec1.ms >= 50 && rec1.ms < 1200, `单源 timeout 生效（配 80ms，实测 ${rec1.ms}ms）`)

  const rec2 = {}
  const mgr2 = createSearchManager({ ...onlySearxng, ddg: true, timeout: 80, fetcher: hangFetcher(rec2) })
  await Promise.race([mgr2.search('q').catch(() => {}), waitMs(3000)])
  ok(rec2.ms >= 50 && rec2.ms < 2000, `全局 timeout 对 DDG 兜底生效（实测 ${rec2.ms}ms）`)

  // 都没配 → 不传 timeout，保持各源原默认（DDG 15s：200ms 内不该被 abort）
  const rec3 = {}
  const mgr3 = createSearchManager({ ...onlySearxng, ddg: true, fetcher: hangFetcher(rec3) })
  mgr3.search('q').catch(() => {}) // 挂着的 promise 自带 catch，不 await
  await waitMs(200)
  ok(rec3.ms === undefined, '未配 timeout → 沿用 provider 默认值')
})

// ---------- 10. formatResults + formatExtract ----------
await test('formatResults / formatExtract', async () => {
  const text = formatResults({ answer: '42', results: [{ title: 'A', url: 'https://a.com', content: '内容', score: 0.9 }], citations: ['https://c.com'] })
  ok(text.includes('42') && text.includes('A') && text.includes('https://a.com') && text.includes('引用'), 'formatResults')
  ok(formatResults({ results: [] }).startsWith('(无搜索结果'), '空结果带可执行提示')
  ok(/更换关键词|重试/.test(formatResults({ results: [] })), '空结果提示重试')
  const multi = formatResults({
    provider: 'multi', quality: 80,
    results: [{ title: 'A', url: 'https://a.com', content: 'c', source: 'bing' }],
    providers: [{ name: 'bing', ok: true, count: 1, quality: 80 }, { name: 'ddg', ok: false, error: 'timeout' }],
    failures: [{ query: 'q', error: 'ddg: timeout' }],
    available_engines: ['bing', 'ddg', 'exa'],
  })
  ok(multi.includes('🔁 搜索源') && multi.includes('ddg:失败'), '多源状态可见')
  ok(multi.includes('可用搜索源') && multi.includes('exa'), '失败时给出可换源')
  const low = formatResults({ results: [{ title: 'A', url: 'https://a.com', content: 'c' }], quality: 20, providers: [{ name: 'bing', ok: true, count: 1, quality: 20 }] })
  ok(low.includes('结果质量偏低'), '低质量提示换源')
  const ext = formatExtract({ results: [{ url: 'https://x.com', raw_content: '正文' }] })
  ok(ext.includes('正文'), 'formatExtract')
})

// ---------- 10. tools ----------
await test('makeSearchTools：注册 web_search + web_extract', async () => {
  const mgr = createSearchManager({ fetcher: mockHtmlFetch('<a class="result-link" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fx.com">X</a><td class="result-snippet">snip</td>') })
  const tools = makeSearchTools(mgr)
  eq(tools.length, 2, '2 tools')
  eq(tools[0].name, 'web_search', 'web_search')
  eq(tools[1].name, 'web_extract', 'web_extract')
  const result = await tools[0].execute({ query: 'test' })
  ok(result.includes('X'), 'search 返回格式化结果')
})

await test('makeSearchTools：搜索源全失败 → 结构化 error（供 Agent 注入替代建议）', async () => {
  const mgr = {
    async search() { throw new Error('所有搜索源均失败 → ddg: fetch failed') },
    async searchMany() { throw new Error('所有搜索源均失败 → ddg: fetch failed') },
  }
  const [search] = makeSearchTools(mgr)
  const single = await search.execute({ query: 'x' })
  eq(single.error, 'search_unavailable', '单查询失败 → search_unavailable')
  ok(String(single.reason).includes('所有搜索源均失败'), '保留真实原因')
  eq(search.meta.capabilities, ['net', 'net.search'], '声明联网搜索能力')
})

await test('makeSearchTools：多查询全部失败 → 结构化 error；部分成功仍返回正文', async () => {
  const allFail = {
    async searchMany() {
      return { provider: 'multi', results: [], answers: [], failures: [{ query: 'a', error: 'fetch failed' }, { query: 'b', error: 'timeout' }] }
    },
  }
  const [search] = makeSearchTools(allFail)
  const failed = await search.execute({ queries: ['a', 'b'] })
  eq(failed.error, 'search_unavailable', '全部失败 → error')
  eq(failed.failures.length, 2, '失败明细保留')

  const partial = {
    async searchMany() {
      return { provider: 'multi', results: [{ title: 'A', url: 'https://a.com', content: '正文' }], answers: [], failures: [{ query: 'b', error: 'timeout' }] }
    },
  }
  const [search2] = makeSearchTools(partial)
  const text = await search2.execute({ queries: ['a', 'b'] })
  ok(typeof text === 'string' && text.includes('https://a.com') && text.includes('部分查询未成功'), '部分成功返回正文并提示覆盖缺口')
})

await test('makeSearchTools：web_extract 失败 → 结构化 error', async () => {
  const mgr = { async extract() { throw new Error('所有提取源均失败 → fetch failed') } }
  const [, extract] = makeSearchTools(mgr)
  const r = await extract.execute({ urls: ['https://x.com'] })
  eq(r.error, 'extract_unavailable', '提取失败结构化返回')
  ok(String(r.reason).includes('所有提取源均失败'), '保留真实原因')
})

await test('makeSearchTools：engines 显式多源透传 + 状态可见 + 全失败 alternatives', async () => {
  let seen = null
  const mgr = {
    availableProviders: ['bing', 'ddg', 'exa'],
    async searchEngines(q, engines, opts) {
      seen = { q, engines, opts }
      return {
        provider: 'multi',
        results: [{ title: 'A', url: 'https://a.com', content: '正文', source: 'bing' }],
        answers: [],
        failures: [{ query: q, error: 'ddg: timeout' }],
        providers: [{ name: 'bing', ok: true, count: 1, quality: 80 }, { name: 'ddg', ok: false, count: 0, error: 'timeout' }],
        available_engines: ['bing', 'ddg', 'exa'],
      }
    },
    async search() { throw new Error('should not call search') },
    async searchMany() { throw new Error('should not call searchMany') },
  }
  const [search] = makeSearchTools(mgr)
  ok(search.parameters.properties.engines?.items?.enum?.includes('bing'), 'schema 声明 engines')
  const text = await search.execute({ query: 'x', engines: ['bing', 'ddg'] })
  eq(seen.engines, ['bing', 'ddg'], 'engines 透传到 searchEngines')
  ok(text.includes('🔁 搜索源') && text.includes('ddg:失败'), '多源状态进入模型可见文本')

  const failMgr = {
    availableProviders: ['bing', 'ddg', 'exa'],
    async searchEngines() {
      return {
        provider: 'multi', results: [], answers: [],
        failures: [{ query: 'x', error: 'bing: timeout' }],
        providers: [{ name: 'bing', ok: false, error: 'timeout' }, { name: 'ddg', ok: false, error: 'timeout' }],
        available_engines: ['bing', 'ddg', 'exa'],
      }
    },
  }
  const [failSearch] = makeSearchTools(failMgr)
  const err = await failSearch.execute({ query: 'x', engines: ['bing', 'ddg'] })
  eq(err.error, 'search_unavailable', '指定源全失败 → 结构化错误')
  ok(Array.isArray(err.alternatives) && err.alternatives.includes('exa') && !err.alternatives.includes('bing'), 'alternatives 只给未指定的可用源')
})

// ---------- 11. DDG 解析健壮性（改版兼容）----------
await test('parseDDG：兼容 href 在 class 之前（DDG lite 改版形态）', async () => {
  const { parseDDG } = await import('../agent/tools/web.js')
  const r = parseDDG('<a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com" class="result-link">Example</a><td class="result-snippet">snip</td>')
  eq(r.length, 1, '解析出 1 条（旧正则属性顺序敏感会得 0）')
  eq(r[0].url, 'https://example.com', 'URL 解码')
  eq(r[0].snippet, 'snip', '摘要')
})

await test('parseDDG：兼容单引号属性 + class 在外层 <td>', async () => {
  const { parseDDG } = await import('../agent/tools/web.js')
  const single = parseDDG("<a class='result-link' href='//duckduckgo.com/l/?uddg=https%3A%2F%2Fa.com'>A</a><td class='result-snippet'>sa</td>")
  eq(single[0]?.url, 'https://a.com', '单引号解析')
  const tdWrap = parseDDG('<td class="result-link"><a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fb.com">B</a></td><td class="result-snippet">sb</td>')
  eq(tdWrap[0]?.url, 'https://b.com', 'class 在外层 td 也能取到内部链接')
  eq(tdWrap[0]?.title, 'B', '标题')
})

await test('parseDDGHtml：兼容 href 在 class 之前', async () => {
  const { parseDDGHtml } = await import('../agent/tools/web.js')
  const r = parseDDGHtml('<a rel="nofollow" href="https://h.com" class="result__a">H</a><a class="result__snippet">snip</a>')
  eq(r[0]?.url, 'https://h.com', 'html 版属性顺序无关')
})

await test('ddgSearch：反爬/验证页当作端点失败（不静默返回空）', async () => {
  const { ddgSearch, looksBlocked } = await import('../agent/tools/web.js')
  ok(looksBlocked('<html><body>Unusual traffic detected. Please complete the challenge.</body></html>'), '识别验证页')
  ok(!looksBlocked('<a class="result-link" href="https://x.com">X</a>'), '有结果标记不算验证页')
  const f = async () => ({ ok: true, status: 200, async text() { return '<html><body>Unusual traffic from your network</body></html>' } })
  let err = null
  try { await ddgSearch('原神', { fetcher: f, limit: 5 }) } catch (e) { err = e }
  ok(err && /反爬|验证/.test(err.message), `全部端点验证页 → 抛可诊断错误（实际 ${err && err.message}）`)
})

await test('manager：仅 DDG 且被反爬 → 聚合错误而非"无结果"', async () => {
  const f = async () => ({ ok: true, status: 200, async text() { return '<html>Unusual traffic / challenge</html>' } })
  const mgr = createSearchManager({ fetcher: f })
  let err = null
  try { await mgr.search('王者荣耀') } catch (e) { err = e }
  ok(err && /ddg/i.test(err.message), `抛出聚合失败原因（实际 ${err && err.message}）`)
})

// ---------- 12. 多查询并行 + 去重合并（防信息茧房：多面获取/交叉验证）----------
await test('mergeSearchResults：URL 去重（大小写/hash/尾斜杠）+ 上限 + 失败单列', async () => {
  const merged = mergeSearchResults([
    { query: 'q1', result: { provider: 'tavily', answer: '答1', results: [{ title: 'A', url: 'https://A.com/x#frag', content: 'c1' }, { title: 'B', url: 'https://b.com/', content: 'c2' }] } },
    { query: 'q2', result: { provider: 'brave', results: [{ title: 'A2', url: 'https://a.com/x', content: 'dup' }, { title: 'C', url: 'https://c.com', content: 'c3' }] } },
    { query: 'q3', error: 'ddg: fetch failed' },
  ])
  eq(merged.results.length, 3, '重复 URL 只保留一次（A/B/C）')
  eq(merged.results[0].source, 'tavily', '标注来源源名')
  eq(merged.results[0].query, 'q1', '标注命中查询')
  eq(merged.answers[0].answer, '答1', 'answers 汇总')
  eq(merged.failures.length, 1, '失败查询单列（覆盖缺口可见）')
  eq(merged.sources.sort().join(','), 'brave,tavily', 'sources 汇总去重源')
  const capped = mergeSearchResults([{ query: 'q', result: { provider: 'p', results: Array.from({ length: 30 }, (_, i) => ({ title: `t${i}`, url: `https://x.com/${i}`, content: 'c' })) } }], { maxResults: 12 })
  eq(capped.results.length, 12, '结果上限截断')
})

await test('SearchManager.searchMany：并行多查询、单查询失败不影响其他、最多 4 条', async () => {
  const calls = []
  const p1 = { name: 'p1', available: () => true, async search(q) { calls.push(q); if (q === 'bad') throw new Error('boom'); return { provider: 'p1', query: q, results: [{ title: q, url: `https://site.com/${encodeURIComponent(q)}`, content: q }] } } }
  const mgr = new SearchManager({ providers: [p1] })
  const r = await mgr.searchMany(['a', 'b', 'bad', 'c', 'd', 'e'])
  eq(calls.length, 4, '最多并行 4 条查询')
  eq(r.results.length, 3, '成功查询结果保留（a/b/c）')
  eq(r.failures.length, 1, '失败查询进 failures')
  ok(/boom/.test(r.failures[0].error), '失败原因透出')
  let err = null
  try { await mgr.searchMany([]) } catch (e) { err = e }
  ok(err && /缺少查询词/.test(err.message), '空查询列表报错')
})

await test('web_search：queries 多角度并行 + 去重合并；无查询词给提示', async () => {
  const p = {
    name: 'p', available: () => true,
    async search(q) {
      if (q.includes('反证')) throw new Error('反证查询失败')
      return { provider: 'p', query: q, results: [{ title: q, url: 'https://same.com', content: q }, { title: q + '-2', url: `https://other.com/${encodeURIComponent(q)}`, content: q }] }
    },
  }
  const mgr = new SearchManager({ providers: [p] })
  const tool = makeSearchTools(mgr)[0]
  ok(tool.parameters.properties.queries && !tool.parameters.required, 'schema 支持 queries 且不强制 query')
  const text = await tool.execute({ queries: ['官方 公告', '辟谣 反证'] })
  ok(text.includes('官方 公告') && text.includes('来源: p'), '多查询结果合并 + 来源标注')
  eq((text.match(/https:\/\/same\.com/g) || []).length, 1, '跨查询相同 URL 去重')
  ok(/部分查询未成功/.test(text), '覆盖缺口显式提示')
  const empty = await tool.execute({})
  ok(/未提供查询词/.test(empty), '无查询词提示')
  const single = await tool.execute({ query: '单查询' })
  ok(single.includes('单查询'), '单查询向后兼容')
})

await test('formatResults：合并形态（answers/failures/来源时间元信息）', async () => {
  const text = formatResults({
    provider: 'multi',
    answers: [{ query: 'q1', answer: '答1' }],
    results: [{ title: 'A', url: 'https://a.com', content: 'c', source: 'tavily', published: '2026-10-01', score: 0.9 }],
    failures: [{ query: 'q2', error: 'timeout' }],
  })
  ok(text.includes('💡 [q1] 答1'), 'answers 带查询标签')
  ok(text.includes('来源: tavily') && text.includes('时间: 2026-10-01'), '来源/时间元信息')
  ok(text.includes('⚠️ 部分查询未成功') && text.includes('q2'), '失败提示')
})

// ---------- 总结 ----------
console.log(`\n========================================`)
console.log(`通过 ${passed}，失败 ${failed}`)
console.log(`========================================`)
if (failed > 0) process.exitCode = 1
