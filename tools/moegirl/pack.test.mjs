/**
 * 工具包装载自检：tool.config.js schema + defineToolPack 注册结果。
 * 运行：node tools/moegirl/pack.test.mjs
 */
import { fileURLToPath } from 'node:url'
import { loadPackConfigDir, registerPackConfig, getToolConfig, getSchemaDefaults } from '../../model/toolkit/pack-config.js'

const packDir = fileURLToPath(new URL('.', import.meta.url))

let passed = 0
let failed = 0
function ok(c, m) { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }
function eq(a, b, m) { const s = JSON.stringify(a) === JSON.stringify(b); ok(s, `${m}${s ? '' : `（实际 ${JSON.stringify(a)}，期望 ${JSON.stringify(b)}）`}`) }

try {
  const schema = await loadPackConfigDir(packDir, 'moegirl')
  ok(!!schema, 'tool.config.js 可加载')
  registerPackConfig(schema)
  const defaults = getSchemaDefaults(schema)
  eq(defaults.enable, true, 'schema 默认启用')
  eq(defaults.searchLimit, 8, 'schema 默认搜索条数')
  eq(defaults.maxPageChars, 12000, 'schema 默认正文上限')

  const cfg = getToolConfig('moegirl')
  if (cfg.enable === false) {
    console.log('  ⊘ 当前用户配置已关闭 moegirl，跳过注册断言')
  } else {
    const pack = (await import('./index.js')).default
    const tools = pack.resolve({})
    eq(tools.map((t) => t.name), [
      'moegirl__search', 'moegirl__page', 'moegirl__post_search', 'moegirl__post', 'moegirl__feed',
    ], '五个工具注册')
    ok(tools.every((t) => t.category === 'query'), '全部为只读 query 类别')
    ok(tools.every((t) => typeof t.execute === 'function'), '全部有 execute')
  }
} catch (e) {
  failed++
  console.error('  ✗ THROW', e?.message || e)
}

console.log(`\n通过 ${passed}，失败 ${failed}`)
process.exit(failed > 0 ? 1 : 0)
