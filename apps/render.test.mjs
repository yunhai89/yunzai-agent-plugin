/**
 * apps/render.js 回归自检（纯离线：桩掉 Yunzai 渲染器，不启动真实 Chromium、不联网）。
 * 运行：node apps/render.test.mjs
 *
 * 锁住统一渲染器后的契约：
 *   ① 所有卡片/回复图只走 Yunzai renderer.render，插件不再 launch 独立 puppeteer；
 *   ② screenshot 的 tplFile 唯一化（时间戳+随机串）且只清理超过保留窗口的同名前缀文件；
 *   ③ PDF 只复用 Yunzai Puppeteer 后端的 browser（不再单独启动浏览器），并带总超时；
 *      纯图片后端（shotium 等）返回 null，调用方降级；
 *   ④ renderHd 走 Yunzai renderer，PNG 输出，不再使用独立 page.fullPage。
 *
 * 桩法：registerHooks 把 apps/render.js 里的动态 import
 *   '../../../lib/puppeteer/puppeteer.js'（Yunzai 渲染器，仅生产目录存在）
 * 重定向到本测试临时目录里的假模块，行为经 globalThis.__RENDER_TEST__ 注入。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import Config from '../utils/Config.js'

let passed = 0
let failed = 0
function ok(c, m) { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }
function eq(a, b, m) { const s = JSON.stringify(a) === JSON.stringify(b); ok(s, `${m}${s ? '' : `  (got ${JSON.stringify(a)}，期望 ${JSON.stringify(b)})`}`) }
async function test(name, fn) { console.log(`\n[${name}]`); try { await fn() } catch (e) { failed++; console.error('  ✗ THROW', e?.message || e); console.error(e?.stack) } }

// ── 自有临时目录（桩文件 + 截图模板都放这里；Config.path.temp 被指到 TEMP_DIR）──
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'render-test-'))
const TEMP_DIR = path.join(TMP, 'tempshots')
fs.mkdirSync(TEMP_DIR, { recursive: true })
const cleanupTmp = () => { try { fs.rmSync(TMP, { recursive: true, force: true }) } catch { /* noop */ } }
process.on('exit', cleanupTmp)
const YUNZAI_STUB = path.join(TMP, 'stub-yunzai-puppeteer.mjs')

fs.writeFileSync(YUNZAI_STUB, `const m = globalThis.__RENDER_TEST__
export default {
  async render(name, data) {
    m.renderCalls.push({ name, data })
    if (m.renderBehavior === 'hang') return new Promise(() => {})
    if (m.renderBehavior === 'fail') throw new Error('mock: yunzai render failed')
    return Buffer.from(m.renderResult)
  },
  async browserInit() {
    m.browserInitCalls++
    if (m.browserBehavior === 'none') return null
    return m.browser
  },
}
`)

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (/\/lib\/puppeteer\/puppeteer\.js$/.test(specifier)) return { url: pathToFileURL(YUNZAI_STUB).href, shortCircuit: true }
    return nextResolve(specifier, context)
  },
})

// ── 假 page / 假行为注入 ──
const mock = {
  renderCalls: [],
  renderBehavior: 'ok', // ok | fail | hang
  renderResult: 'mock-render',
  browserInitCalls: 0,
  browserBehavior: 'ok', // ok | none
  pageCalls: [],
  failPdf: false,
  newPages: 0,
}
mock.makePage = () => {
  const calls = mock.pageCalls
  return {
    async setJavaScriptEnabled(v) { calls.push(['setJavaScriptEnabled', v]) },
    async setContent(html, o) { calls.push(['setContent', html, o]) },
    async pdf(opt) {
      calls.push(['pdf', opt])
      if (mock.failPdf) throw new Error('mock: pdf timeout')
      return Buffer.from('mock-pdf')
    },
    async close() { calls.push(['close']) },
  }
}
mock.browser = {
  async newPage() { mock.newPages++; return mock.makePage() },
}
globalThis.__RENDER_TEST__ = mock
globalThis.segment = { image: (u) => ({ type: 'image', data: { file: u } }) }

function reset() {
  mock.renderCalls.length = 0
  mock.renderBehavior = 'ok'
  mock.renderResult = 'mock-render'
  mock.browserInitCalls = 0
  mock.browserBehavior = 'ok'
  mock.pageCalls.length = 0
  mock.failPdf = false
  mock.newPages = 0
}

// 生产代码的 Config.path.temp 指向仓库 data/temp → 本测试一律改写到自己临时目录
Config.path.temp = TEMP_DIR

const render = await import('./render.js')
const pdfCallOf = () => mock.pageCalls.find((c) => c[0] === 'pdf')

await test('① screenshot：只调用 Yunzai 渲染器，返回 segment.image', async () => {
  reset()
  const img = await render.screenshot('agents-plugin/card', '<div>卡片</div>')
  eq(mock.renderCalls.length, 1, 'renderer.render 恰好 1 次')
  eq(mock.renderCalls[0].name, 'agents-plugin/card', 'name 透传')
  ok(mock.renderCalls[0].data.tplFile && fs.existsSync(mock.renderCalls[0].data.tplFile), 'tplFile 已写入')
  eq(mock.renderCalls[0].data.imgType, 'jpeg', '默认 jpeg')
  eq(mock.renderCalls[0].data.quality, 95, '默认 q95')
  eq(mock.newPages, 0, '没有启动/使用独立 page')
  ok(img?.type === 'image' && String(img.data.file).startsWith('base64://'), '返回 base64 segment.image')
  eq(Buffer.from(String(img.data.file).slice('base64://'.length), 'base64').toString(), 'mock-render', '图片内容来自 Yunzai 渲染器')
})

await test('① renderCardImage：渲染失败 → null，且只调用一次（不再同参重试）', async () => {
  reset()
  mock.renderBehavior = 'fail'
  const img = await render.renderCardImage('<div>卡片</div>', { timeoutMs: 3000 })
  eq(img, null, '失败 → null（调用方降级文本）')
  eq(mock.renderCalls.length, 1, '失败路径 renderer.render 仍恰好 1 次')
})

await test('① renderCardImage：渲染器挂住 → 到点返回 null，且只调用一次', async () => {
  reset()
  mock.renderBehavior = 'hang'
  // withTimeout 的超时定时器是 unref 的，测试里必须自己保活，否则事件循环先空转。
  const keepAlive = setInterval(() => {}, 50)
  try {
    const t0 = Date.now()
    const img = await render.renderCardImage('<div>卡片</div>', { timeoutMs: 1000 })
    const dt = Date.now() - t0
    eq(img, null, '超时 → null')
    eq(mock.renderCalls.length, 1, '挂住时也只调用一次')
    ok(dt >= 900 && dt < 4000, `总耗时受 timeoutMs 约束（实际 ${dt}ms）`)
  } finally { clearInterval(keepAlive) }
})

await test('② tplFile 唯一化：连续两次渲染文件名不同，且不删掉对方刚写入的模板', async () => {
  fs.rmSync(TEMP_DIR, { recursive: true, force: true })
  fs.mkdirSync(TEMP_DIR, { recursive: true })
  reset()
  await render.screenshot('agents-plugin/card', '<p>1</p>')
  const f1 = mock.renderCalls[0].data.tplFile
  ok(fs.existsSync(f1), '第一次的 tplFile 已写入临时目录')
  eq(fs.readFileSync(f1, 'utf8'), '<p>1</p>', '模板内容为本次 HTML（渲染器读到最新内容）')

  await render.screenshot('agents-plugin/card', '<p>2</p>')
  const f2 = mock.renderCalls[1].data.tplFile
  ok(f1 !== f2, '两次 tplFile 名不同（不会命中渲染器陈旧模板缓存）')
  ok(fs.existsSync(f1), '第二次的清理没有删掉第一次刚写入的模板（并发互删根因已修）')
  ok(fs.existsSync(f2), '第二次自己的模板存在')
  eq(path.basename(f1).startsWith('agents-plugin_card__'), true, `safe 前缀（/ → _）：${path.basename(f1)}`)
})

await test('② 清理只删「超过保留窗口」的同名前缀文件，其它前缀不碰', async () => {
  const KEEP_MS = 10 * 60 * 1000 // SHOT_KEEP_MS
  const oldSame = path.join(TEMP_DIR, 'agents-plugin_card__old.html')
  const oldOther = path.join(TEMP_DIR, 'agents-other__old.html')
  fs.writeFileSync(oldSame, 'old')
  fs.writeFileSync(oldOther, 'old')
  const old = new Date(Date.now() - KEEP_MS - 60_000)
  fs.utimesSync(oldSame, old, old)
  fs.utimesSync(oldOther, old, old)
  const before = fs.readdirSync(TEMP_DIR).length

  reset()
  await render.screenshot('agents-plugin/card', '<p>3</p>')
  ok(!fs.existsSync(oldSame), '过期同名前缀文件被清理')
  ok(fs.existsSync(oldOther), '其它前缀的过期文件不动（清理按 safe 前缀限定）')
  eq(fs.readdirSync(TEMP_DIR).length, before, '本次只增一个模板、删一个过期文件 → 数量不变')
  ok(fs.existsSync(mock.renderCalls[0].data.tplFile), '本次模板保留（刚写入的不在清理窗口内）')
})

await test('③ renderCardBuffer / renderHd：统一 Yunzai 渲染器，PNG 长图不再用独立 page', async () => {
  reset()
  mock.renderResult = 'mock-card'
  const buf = await render.renderCardBuffer('<p>card</p>', { name: 'agents-plugin/x', timeoutMs: 3000 })
  ok(Buffer.isBuffer(buf) && buf.toString() === 'mock-card', 'renderCardBuffer 返回 Buffer')
  eq(mock.renderCalls[0].data.imgType, 'jpeg', '卡片默认 jpeg')
  eq(mock.newPages, 0, '没有使用独立 page')

  reset()
  mock.renderResult = 'mock-hd'
  const hd = await render.renderHd('agents-plugin/hd', '<p>hd</p>')
  ok(Buffer.isBuffer(hd) && hd.toString() === 'mock-hd', 'renderHd 返回 Buffer')
  eq(mock.renderCalls[0].data.imgType, 'png', '长图使用 png')
  eq(mock.renderCalls[0].data.quality, 100, '长图 q100')
  eq(mock.newPages, 0, '长图也不使用独立 page')
})

await test('③ renderPdf：复用 Yunzai Puppeteer 后端 browser，不再单独 launch；带总超时', async () => {
  reset()
  const out = path.join(TEMP_DIR, 'out.pdf')
  const p = await render.renderPdf('<p>pdf</p>', { path: out })
  eq(p, out, '成功返回写入路径')
  eq(fs.readFileSync(out, 'utf8'), 'mock-pdf', 'PDF 内容落地正确')
  eq(mock.browserInitCalls, 1, '复用 Yunzai 渲染器的 browserInit')
  eq(mock.newPages, 1, '使用 Yunzai 浏览器的 page')
  const c = pdfCallOf()
  ok(c, 'page.pdf 被调用')
  ok(Number(c[1]?.timeout) >= 30000, `page.pdf timeout ≥ 30000（实际 ${c[1]?.timeout}）`)
  eq(mock.pageCalls.find((x) => x[0] === 'setJavaScriptEnabled')?.[1], false, 'PDF 页面关闭 JS')

  reset()
  mock.failPdf = true
  const p2 = await render.renderPdf('<p>pdf</p>', { path: path.join(TEMP_DIR, 'out2.pdf') })
  eq(p2, null, 'page.pdf 抛错（超时）→ 返回 null，调用方降级')
})

await test('③ renderPdf：纯图片后端（无 browserInit 返回 null）→ 降级，不报错', async () => {
  reset()
  mock.browserBehavior = 'none'
  const out = path.join(TEMP_DIR, 'out3.pdf')
  const p = await render.renderPdf('<p>pdf</p>', { path: out })
  eq(p, null, '纯图片后端 → null')
  eq(mock.newPages, 0, '不尝试创建独立 page')
  ok(!fs.existsSync(out), '不产出空 PDF')
})

await test('④ renderReplyImage：markdown 回复图同样只走 Yunzai 渲染器', async () => {
  reset()
  mock.renderResult = 'mock-reply'
  const img = await render.renderReplyImage('**你好**', { timeoutMs: 3000 })
  eq(mock.renderCalls.length, 1, 'renderer.render 恰好 1 次')
  eq(mock.renderCalls[0].name, 'agents-plugin/reply', '回复图 name')
  eq(mock.newPages, 0, '没有独立 page')
  ok(img?.type === 'image' && String(img.data.file).startsWith('base64://'), '返回 segment.image')
})

await test('⑤ 帮助图渲染超时：默认 5 分钟，可配 helpTimeoutMs（不拖累普通卡片）', async () => {
  eq(render.HELP_RENDER_TIMEOUT_DEFAULT_MS, 300000, '默认 300000ms（5 分钟）')
  eq(render.helpRenderTimeoutMs({}), 300000, '未配置 → 默认 300000')
  eq(render.helpRenderTimeoutMs(undefined), 300000, 'undefined → 默认 300000')
  eq(render.helpRenderTimeoutMs({ helpTimeoutMs: 60000 }), 60000, '显式配置生效')
  eq(render.helpRenderTimeoutMs({ helpTimeoutMs: 0 }), 300000, '0/非法 → 默认 300000')
  eq(render.helpRenderTimeoutMs({ helpTimeoutMs: -1 }), 300000, '负数 → 默认 300000')
  eq(render.helpRenderTimeoutMs({ timeoutMs: 8000 }), 300000, '普通卡片 timeoutMs 不影响帮助图（各自独立预算）')
})

await test('⑥ 静态审计：所有渲染模块只依赖 Yunzai 渲染器，不直连浏览器', () => {
  const files = [
    '../apps/render.js', '../apps/help.js', '../apps/research.js',
    '../model/agent/render.js', '../model/render/index.js', '../model/render/md.js',
    '../model/render/theme.js', '../model/render/inline-images.js',
    '../model/research/render.js', '../model/document/topdf.js',
  ]
  const bad = /(?:from\s*['"](?:puppeteer|puppeteer-core|playwright|playwright-core)['"]|import\s*\(\s*['"](?:puppeteer|puppeteer-core|playwright|playwright-core)['"]|\.launch\s*\()/
  for (const f of files) {
    const src = fs.readFileSync(new URL(f, import.meta.url), 'utf8')
    ok(!bad.test(src), `${f.replace('../', '')} 不直接 import / launch 浏览器`)
  }
})

cleanupTmp()

console.log('\n========================================')
console.log(`apps/render 测试：通过 ${passed}，失败 ${failed}`)
console.log('========================================')
process.exitCode = failed ? 1 : 0
