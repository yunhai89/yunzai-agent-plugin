/**
 * 萌娘百科真实接口自检（可选）。
 * 运行：MOEGIRL_INTEGRATION=1 node tools/moegirl/integration.test.mjs
 * 未设置时打印 SKIP_FILE:，由测试运行器记为跳过，不联网。
 */
if (process.env.MOEGIRL_INTEGRATION !== '1') {
  console.log('SKIP_FILE: 未设置 MOEGIRL_INTEGRATION=1（真实萌娘百科接口测试默认不跑）')
  process.exit(0)
}

const { searchEntries, searchFullText, getPageBundle, searchArticles, getArticle } = await import('./api.js')

let passed = 0
let failed = 0
function ok(c, m) { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }

const opts = { timeoutMs: 20000, minIntervalMs: 300, cacheTtlMs: 0 }

try {
  let e = await searchEntries('初音未来', opts)
  if (!e.entries.length) {
    await new Promise((r) => setTimeout(r, 800))
    e = await searchEntries('初音未来', opts)
  }
  ok(Array.isArray(e.entries) && e.entries.length > 0, 'SearchEntry 返回词条')
  ok(e.entries.some((x) => x.title.includes('初音未来')), '命中初音未来')
  ok(typeof e.total === 'number' && e.total > 0, '返回命中总数')

  const p = await getPageBundle('初音未来', { maxChars: 1500 }, opts)
  ok(p.title === '初音未来', '词条标题')
  ok(p.pageId > 0, '词条 pageId')
  ok(p.extract.length > 0, 'MediaWiki 正文')
  ok(p.extract.length <= 1600, '正文按 maxChars 截断')
  ok(Array.isArray(p.tags), '标签数组')

  const posts = await searchArticles('初音未来', 3, opts)
  ok(Array.isArray(posts.posts) && posts.posts.length > 0, 'SearchArticles 返回帖子')
  ok(posts.posts.every((x) => x.id), '帖子 id 存在')
  if (posts.posts[0]?.id) {
    const a = await getArticle(posts.posts[0].id, opts)
    ok(a.id === posts.posts[0].id, '帖子详情 id 一致')
    ok(Array.isArray(a.media), '帖子媒体数组')
  }

  const ft = await searchFullText('初音未来', 3, opts)
  ok(ft.total > 0 && ft.results.length > 0, 'MediaWiki 全文搜索')
} catch (e) {
  failed++
  console.error('  ✗ THROW', e?.message || e)
}

console.log(`\n真实接口 通过 ${passed}，失败 ${failed}`)
process.exit(failed > 0 ? 1 : 0)
