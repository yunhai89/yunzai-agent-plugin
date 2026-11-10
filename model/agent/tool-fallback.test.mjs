/**
 * 工具能力与失败替代回归 —— 搜索接口不可用时应能换用其它联网能力。
 * 运行：node model/agent/tool-fallback.test.mjs
 */
import {
  CAP,
  toolCapabilities,
  capabilitySearchTerms,
  classifyToolFailure,
  suggestAlternativeTools,
  enrichToolFailure,
} from './tool-fallback.js'

let passed = 0
let failed = 0
function ok(c, m) { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }
function eq(a, b, m) { const s = JSON.stringify(a) === JSON.stringify(b); ok(s, `${m}${s ? '' : `  (got ${JSON.stringify(a)})`}`) }
async function test(name, fn) { console.log(`\n[${name}]`); try { await fn() } catch (e) { failed++; console.error('  ✗ THROW', e?.message || e); console.error(e?.stack) } }

const tool = (name, description = '', { category = 'query', meta = {}, required = [] } = {}) => ({
  name, description, category, meta,
  parameters: { type: 'object', properties: {}, required },
})

await test('能力推断：联网搜索/抓取/浏览器/本地检索区分', () => {
  eq(toolCapabilities(tool('web_search', '联网搜索')), [CAP.NET, CAP.NET_SEARCH], 'web_search → net.search')
  eq(toolCapabilities(tool('web_extract', '从 URL 提取正文')), [CAP.NET, CAP.NET_FETCH], 'web_extract → net.fetch')
  const crawl = toolCapabilities(tool('web_crawl', '抓取网页，真浏览器渲染'))
  ok(crawl.includes(CAP.NET_FETCH) && crawl.includes(CAP.NET_BROWSE), 'web_crawl → fetch + browse')
  eq(toolCapabilities(tool('memory_search', '搜索长期记忆')), [], 'memory_search 不是联网工具')
  eq(toolCapabilities(tool('get_group_file_url', '获取群文件下载链接 URL')), [], '本地群文件链接不是联网工具')
  eq(toolCapabilities(tool('kb_search', '检索知识库')), [], 'kb_search 不是联网工具')
  eq(toolCapabilities(tool('tool_search', '搜索工具目录')), [], 'tool_search 不是联网工具')
  eq(toolCapabilities(tool('mcp__docs', '搜索网页和 API 文档')), [CAP.NET, CAP.NET_SEARCH], '第三方联网工具按描述推断')
  eq(toolCapabilities(tool('mcp__fetch', 'Fetch a URL and return the page content')), [CAP.NET, CAP.NET_FETCH], 'MCP 抓取工具按描述推断')
  eq(toolCapabilities(tool('mcp__filesystem_search', 'Search local files')), [], 'MCP 本地检索不误判为联网')
  eq(toolCapabilities(tool('custom', 'x', { meta: { capabilities: ['net.fetch'] } })), [CAP.NET, CAP.NET_FETCH], '显式 meta.capabilities 生效')
  eq(toolCapabilities(tool('custom2', 'x', { meta: { capabilities: 'net.search' } })), [CAP.NET, CAP.NET_SEARCH], '字符串形式的 capabilities 也兼容')
})

await test('能力检索词：中文“联网/浏览器”可命中', () => {
  const terms = capabilitySearchTerms(tool('web_crawl', '抓取网页，真浏览器渲染'))
  ok(terms.includes('联网') && terms.includes('浏览器') && terms.includes('抓取'), '包含中文能力词')
})

await test('失败归类：网络/鉴权/限流/不存在/未配置/拦截', () => {
  eq(classifyToolFailure({ error: '所有搜索源均失败 → ddg: fetch failed' }).kind, 'network', '搜索源全挂 → network')
  ok(classifyToolFailure({ error: 'connect ETIMEDOUT' }).retryable, 'timeout 可重试')
  eq(classifyToolFailure({ error: 'HTTP 401 unauthorized' }).kind, 'auth', '401 → auth')
  eq(classifyToolFailure({ error: 'SearXNG HTTP 403' }).kind, 'auth', '403 → auth')
  eq(classifyToolFailure({ error: 'HTTP 404 not found' }).kind, 'not_found', '404 → not_found')
  eq(classifyToolFailure({ error: '429 too many requests' }).kind, 'rate_limit', '429 → rate_limit')
  eq(classifyToolFailure({ error: '无可用搜索源（未配置任何搜索 API Key）' }).kind, 'unavailable', '未配置 → unavailable')
  eq(classifyToolFailure({ error: 'rejected_by_policy', reason: '仅主人可用' }).kind, 'blocked', '策略拒绝 → blocked')
  eq(classifyToolFailure({ error: 'fetch failed', code: 'ENOTFOUND' }).kind, 'network', 'ENOTFOUND → network')
  eq(classifyToolFailure({ error: 'search_unavailable', reason: '所有搜索源均失败 → ddg: fetch failed' }).kind, 'network', 'search_unavailable + 网络原因 → network（错误码不覆盖真实原因）')
  eq(classifyToolFailure({ error: 'search_unavailable' }).kind, 'unavailable', '只有错误码 → unavailable')
})

await test('替代建议：失败搜索 → 优先直接抓取/浏览器，排除本地检索与纯下载', () => {
  const registry = {
    list: () => [
      tool('web_search', '联网搜索'),
      tool('web_extract', '从 URL 提取正文'),
      tool('web_crawl', '抓取网页，真浏览器渲染', { required: ['url'] }),
      tool('memory_search', '搜索长期记忆'),
      tool('bilibili__download', 'B站下载', { meta: { capabilities: ['net', 'net.download'] } }),
    ],
  }
  const alts = suggestAlternativeTools({
    registry,
    failedTool: tool('web_search', '联网搜索'),
    content: { error: '所有搜索源均失败 → fetch failed' },
    ctx: { role: 'member' },
    policy: { decide: () => ({ decision: 'allow' }) },
  })
  eq(alts.map((a) => a.name), ['web_crawl', 'web_extract'], '只推荐直连能力，按互补性排序')
  eq(alts[0].required, ['url'], '带必填参数提示')
  ok(alts.every((a) => a.name !== 'memory_search'), '不推荐非联网工具')
  ok(alts.every((a) => a.name !== 'bilibili__download'), '不推荐纯下载工具')
})

await test('替代建议：RBAC 过滤无权工具；master 可见只读浏览器工具', () => {
  const registry = {
    list: () => [
      tool('web_search', '联网搜索'),
      tool('web_crawl', '抓取网页'),
      tool('stagehand__goto', '浏览器打开 URL', { category: 'system', meta: { capabilities: ['net', 'net.fetch', 'net.browse'] } }),
      tool('stagehand__act', '浏览器执行动作', { category: 'system', meta: { interactive: true, capabilities: ['net', 'net.browse'] } }),
    ],
  }
  const policy = {
    decide: (ctx, t) => (t.category === 'system' && !ctx.isMaster ? { decision: 'deny' } : { decision: 'allow' }),
  }
  const member = suggestAlternativeTools({
    registry, failedTool: tool('web_search', '联网搜索'), content: { error: 'fetch failed' },
    ctx: { role: 'member' }, policy,
  })
  ok(!member.some((a) => a.name.startsWith('stagehand__')), '普通成员不推荐 system 工具')
  const master = suggestAlternativeTools({
    registry, failedTool: tool('web_search', '联网搜索'), content: { error: 'fetch failed' },
    ctx: { role: 'master', isMaster: true }, policy,
  })
  ok(master.some((a) => a.name === 'stagehand__goto'), 'master 可见 stagehand__goto')
  ok(!master.some((a) => a.name === 'stagehand__act'), '交互/写类 act 不自动推荐')
})

await test('替代建议：同站搜索在“标识不存在”时优先，同上游在基础设施故障时降权', () => {
  const registry = {
    list: () => [
      tool('bilibili__search', 'B站视频搜索'),
      tool('web_search', '联网搜索'),
      tool('bilibili__video', 'B站视频详情'),
    ],
  }
  const notFound = suggestAlternativeTools({
    registry,
    failedTool: tool('bilibili__video', 'B站视频详情'),
    content: { error: '视频不存在（404）' },
    ctx: { role: 'member' },
  })
  eq(notFound[0]?.name, 'bilibili__search', '找不到视频 → 先同站搜索')
  const network = suggestAlternativeTools({
    registry,
    failedTool: tool('bilibili__search', 'B站视频搜索'),
    content: { error: 'fetch failed' },
    ctx: { role: 'member' },
  })
  ok(network[0]?.name !== 'bilibili__video', 'B站上游故障时不同站内详情工具优先')
  ok(network.some((a) => a.name === 'web_search'), '保留通用搜索作为跨源备选')
})

await test('enrichToolFailure：注入 _failure/_alternatives/_next，保留原 _hint', () => {
  const registry = {
    list: () => [
      tool('web_search', '联网搜索'),
      tool('web_crawl', '抓取网页'),
    ],
  }
  const out = enrichToolFailure(JSON.stringify({
    error: '所有搜索源均失败',
    reason: 'tavily: fetch failed',
    _hint: '工具自己的提示',
  }), {
    tool: tool('web_search', '联网搜索'),
    registry,
    ctx: { role: 'member' },
    hint: '通用失败提示',
  })
  eq(out._failure.kind, 'network', '_failure.kind')
  ok(out._failure.retryable === true, '_failure.retryable')
  eq(out._alternatives?.[0]?.name, 'web_crawl', '_alternatives 带可用替代')
  ok(/_alternatives|web_crawl/.test(out._next), '_next 指向替代能力')
  ok(out._hint.includes('工具自己的提示') && out._hint.includes('通用失败提示'), '保留工具 _hint 并追加通用提示')
})

await test('enrichToolFailure：非联网/参数错误不塞无关换工具建议', () => {
  const registry = { list: () => [tool('web_search', '联网搜索')], has: () => true }
  const out = enrichToolFailure(JSON.stringify({ error: 'invalid_arguments', reason: '缺少 text 参数' }), {
    tool: tool('memory', '写入长期记忆', { category: 'personal' }),
    registry,
    hint: '通用失败提示',
  })
  eq(out._failure.kind, 'invalid', '保留失败分类')
  eq(out._next, undefined, '不生成换工具建议')
  eq(out._alternatives, undefined, '不推荐联网替代')
  ok(out._hint.includes('通用失败提示'), '仍带回灌提示')
})

await test('enrichToolFailure：未注册工具 → 引导 tool_search，不臆造能力', () => {
  const registry = { list: () => [], has: () => false }
  const out = enrichToolFailure(JSON.stringify({ error: "Tool 'web_serch' not found" }), {
    tool: { name: 'web_serch', description: '', parameters: {} },
    registry,
    hint: '通用失败提示',
  })
  eq(out._failure.kind, 'not_found', '归类 not_found')
  ok(/tool_search/.test(out._next || ''), '引导先查工具目录')
})

await test('enrichToolFailure：MCP 纯文本错误也归一（网络类给替代）', () => {
  const registry = { list: () => [tool('web_search', '联网搜索'), tool('web_crawl', '抓取网页')], has: () => true }
  const out = enrichToolFailure('Error: fetch failed', {
    tool: tool('web_search', '联网搜索'),
    registry,
    hint: '通用失败提示',
  })
  eq(out._failure.kind, 'network', '纯文本网络错误也归类 network')
  ok(out._alternatives?.some((a) => a.name === 'web_crawl'), '附联网替代工具')
  eq(enrichToolFailure('普通文本结果', { tool: tool('web_search', '联网搜索') }), null, '非错误文本不强行改写')
})

console.log(`\n========================================`)
console.log(`通过 ${passed}，失败 ${failed}`)
console.log(`========================================`)
if (failed > 0) process.exitCode = 1
