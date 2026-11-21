/**
 * 工具名映射契约（PR0 / KNOWN-BUG 基线）。
 *
 * 现状：插件内部工具名不做 sanitize，模型/历史/审批直接使用原名（可含中文、点号、空格）。
 * 迁移到 Mastra 后名称会被 `[A-Za-z0-9_-]` + 63 字符规则静默改写；本测试先锁定目标映射语义，
 * PR3 接线时必须复用同一实现（见 fixtures/tool-name.js 注释）。
 *
 * 运行：node model/runtime/test/contracts/tool-name.test.mjs
 */
import { sanitizeToolName, buildToolNameMap, TOOL_NAME_MAX } from '../fixtures/tool-name.js'

let passed = 0
let failed = 0
function ok(c, m) {
  if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) }
}
function eq(a, b, m) {
  const same = JSON.stringify(a) === JSON.stringify(b)
  ok(same, `${m}${same ? '' : `  (got ${JSON.stringify(a)})`}`)
}

console.log('\n[工具名 sanitize]')
eq(sanitizeToolName('web_search'), 'web_search', '合法名称原样保留')
eq(sanitizeToolName('搜索'), '__', '中文替换为下划线')
eq(sanitizeToolName('a.b c'), 'a_b_c', '点号/空格替换为下划线')
eq(sanitizeToolName('1st_tool'), '_1st_tool', '数字开头补下划线')
eq(sanitizeToolName('mcp__server__tool'), 'mcp__server__tool', '已有下划线保留')
eq(sanitizeToolName('x'.repeat(80)).length, TOOL_NAME_MAX, `超长截断到 ${TOOL_NAME_MAX}`)

console.log('\n[工具名冲突]')
const a = `${'a'.repeat(63)}_one`
const b = `${'a'.repeat(63)}_two`
const map = buildToolNameMap([a, b, 'ok_tool'])
eq(map.toMastra.get('ok_tool'), 'ok_tool', '无冲突名称直接映射')
eq(map.toMastra.get(a).length, TOOL_NAME_MAX, '冲突一方仍不超过 63 字符')
ok(map.toMastra.get(b).endsWith('_2'), '第二个冲突名加 _2 后缀')
eq(map.toLegacy.get(map.toMastra.get(a)), a, '双向映射可回查 A')
eq(map.toLegacy.get(map.toMastra.get(b)), b, '双向映射可回查 B')
eq(map.collisions.length, 1, '冲突被记录')
eq(map.collisions[0].legacy, b, '冲突记录指向后注册者')

let threw = false
try { buildToolNameMap(['dup', 'dup']) } catch { threw = true }
ok(threw, '重复原名直接拒绝（不静默覆盖）')

console.log(`\n========================================`)
console.log(`通过 ${passed}，失败 ${failed}`)
console.log(`========================================`)
if (failed > 0) process.exitCode = 1
