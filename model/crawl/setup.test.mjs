/**
 * crawl4ai 抓取环境自检/自动安装的离线断言。
 * 运行：node model/crawl/setup.test.mjs
 */
import { pickInstallMode, formatCrawlSetupStatus, formatCrawlInstallResult, maybeAutoInstallCrawl4ai } from './setup.js'

let passed = 0
let failed = 0
const ok = (c, m) => { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m}${JSON.stringify(a) === JSON.stringify(b) ? '' : `（实际 ${JSON.stringify(a)}）`}`)
async function test(name, fn) { console.log(`\n[${name}]`); try { await fn() } catch (e) { failed++; console.error('  ✗ THROW', e?.message || e) } }

const cfg = (crawl = {}) => ({
  kb: { crawlEnable: true, crawl: { engine: 'crawl4ai', execution: 'local', autoInstall: true, ...crawl } },
})

await test('安装模式：只缺浏览器时补浏览器，其余完整安装', () => {
  eq(pickInstallMode({ version: '0.9.0', reason: 'browser_missing' }), 'browser', 'browser_missing → browser')
  eq(pickInstallMode({ version: '0.9.0', reason: 'browser_probe_timeout' }), 'browser', 'browser_probe_timeout → browser')
  eq(pickInstallMode({ version: '0.9.0', reason: 'browser_probe_failed' }), 'full', 'Playwright 损坏 → full')
  eq(pickInstallMode({ version: '', reason: 'browser_missing' }), 'full', '无版本号（venv 不可用）→ full')
  eq(pickInstallMode({ reason: 'spawn_failed' }), 'full', 'spawn_failed → full')
  eq(pickInstallMode({}), 'full', '空状态 → full')
})

await test('状态报告：浏览器缺失/安装中/沙箱档', () => {
  const missing = formatCrawlSetupStatus({
    engine: 'crawl4ai', execution: 'local', ready: false, autoInstall: true,
    reason: 'browser_missing', version: '0.9.0', python: '/x/.crawl4ai-venv/bin/python3',
    browsersDir: '/x/.crawl4ai-browsers', log: '/x/data/crawl/setup.log', last: null,
  })
  ok(/缺少 Playwright Chromium/.test(missing), '说明浏览器缺失')
  ok(/#抓取环境 安装/.test(missing), '给出安装命令')
  ok(/0\.9\.0/.test(missing), '显示 crawl4ai 版本')

  const installing = formatCrawlSetupStatus({ engine: 'crawl4ai', execution: 'local', installing: true, installMode: 'browser', ready: false })
  ok(/安装中/.test(installing), '安装中状态')

  const sandbox = formatCrawlSetupStatus({ engine: 'crawl4ai', execution: 'sandbox', ready: false })
  ok(/E2B 模板/.test(sandbox), '沙箱档提示模板预装')

  const fetchMode = formatCrawlSetupStatus({ engine: 'fetch', ready: false })
  ok(/不需要浏览器/.test(fetchMode), 'fetch 引擎不需要浏览器')
})

await test('安装结果推送：成功/失败都生成聊天反馈', () => {
  const okMsg = formatCrawlInstallResult({ ok: true, mode: 'browser', log: '/x/data/crawl/setup.log' })
  ok(/✅/.test(okMsg), '成功带 ✅')
  ok(/补装 Chromium/.test(okMsg), '说明补装浏览器')
  ok(/无需重启/.test(okMsg), '提示已生效无需重启')

  const failMsg = formatCrawlInstallResult({
    ok: false, mode: 'full', code: 1,
    tail: '\x1b[31mERROR boom\x1b[0m\n|■■■■■■■■  10% of 100 MiB\nTraceback: pip failed',
    log: '/x/data/crawl/setup.log',
  })
  ok(/❌/.test(failMsg), '失败带 ❌')
  ok(/退出码：1/.test(failMsg), '包含退出码')
  ok(/纯 HTTP fetch/.test(failMsg), '说明继续降级 fetch')
  ok(/ERROR boom/.test(failMsg) && /Traceback: pip failed/.test(failMsg), '包含日志尾部')
  ok(!/■|% of /.test(failMsg), '过滤进度条噪音')
  ok(/#抓取环境 修复/.test(failMsg), '给出重试命令')
})

await test('自动安装：开关/引擎/执行面/已就绪/安装中', async () => {
  let calls = 0
  const start = async (o) => { calls++; return { started: true, mode: o.mode } }
  const status = (over = {}) => async () => ({ ready: false, installing: false, last: null, reason: 'browser_missing', version: '1.0', ...over })

  eq((await maybeAutoInstallCrawl4ai({ deps: { cfg: cfg(), getStatus: status(), start } })).started, true, '缺浏览器 → 启动安装')
  eq(calls, 1, '安装启动一次')

  eq((await maybeAutoInstallCrawl4ai({ deps: { cfg: cfg({ engine: 'fetch' }), getStatus: status(), start } })).skipped, 'engine_fetch', 'fetch 引擎跳过')
  eq((await maybeAutoInstallCrawl4ai({ deps: { cfg: cfg({ execution: 'sandbox' }), getStatus: status(), start } })).skipped, 'execution_sandbox', '沙箱执行面跳过')
  eq((await maybeAutoInstallCrawl4ai({ deps: { cfg: cfg({ autoInstall: false }), getStatus: status(), start } })).skipped, 'auto_install_off', '关闭自动安装跳过')
  eq((await maybeAutoInstallCrawl4ai({ deps: { cfg: cfg(), getStatus: status({ ready: true }), start } })).skipped, 'ready', '已就绪跳过')
  eq((await maybeAutoInstallCrawl4ai({ deps: { cfg: cfg(), getStatus: status({ installing: true }), start } })).skipped, 'installing', '安装中跳过')
  eq(calls, 1, '跳过分支不重复启动安装')
})

await test('自动安装：失败冷却 + 强制修复', async () => {
  let calls = 0
  const start = async (o) => { calls++; return { started: true, mode: o.mode } }
  const getStatus = async () => ({
    ready: false, installing: false, reason: 'browser_missing', version: '1.0',
    last: { ok: false, finishedAt: Date.now() - 60_000 },
  })
  eq((await maybeAutoInstallCrawl4ai({ deps: { cfg: cfg(), getStatus, start } })).skipped, 'cooldown', '失败 1 分钟后自动冷却')
  eq(calls, 0, '冷却期不启动')
  eq((await maybeAutoInstallCrawl4ai({ force: true, deps: { cfg: cfg(), getStatus, start } })).started, true, 'force 绕过冷却')
  eq(calls, 1, 'force 启动一次')
})

console.log('\n========================================')
console.log(`通过 ${passed}，失败 ${failed}`)
console.log('========================================')
if (failed > 0) process.exitCode = 1
