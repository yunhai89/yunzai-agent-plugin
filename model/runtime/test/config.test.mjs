/**
 * Runtime/Mastra 配置 schema 契约（PR1）。
 *
 * 运行：node model/runtime/test/config.test.mjs
 */
import {
  parseRuntimeConfig, resolveRuntimeConfig, normalizeAgentRuntimeConfig,
  describeRuntimeConfig, DEFAULT_RUNTIME_CONFIG, DEFAULT_MASTRA_CONFIG,
} from '../schemas/config.js'

let passed = 0
let failed = 0
function ok(c, m) {
  if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) }
}
function eq(a, b, m) {
  const same = JSON.stringify(a) === JSON.stringify(b)
  ok(same, `${m}${same ? '' : `  (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`}`)
}

console.log('\n[旧配置缺省 = legacy]')
{
  const { value, repairs } = parseRuntimeConfig({})
  eq(value.runtime.engine, 'legacy', '没有 runtime 键 → legacy')
  eq(value.runtime.fallbackToLegacy, true, 'fallbackToLegacy 默认 true')
  eq(value.mastra.storage.driver, 'libsql', 'storage 默认 libsql')
  eq(value.mastra.storage.libsqlFile, 'mastra/mastra.db', '默认文件名')
  eq(value.mastra.memory.mode, 'sessionstore', 'Phase 1 默认 sessionstore')
  eq(value.mastra.memory.semanticRecall, false, 'Semantic Recall 默认关')
  eq(value.mastra.vector.enable, false, 'Vector 默认关')
  eq(repairs, [], '无修复项')
}

console.log('\n[非法值 fail-closed]')
{
  const raw = {
    runtime: { engine: 'quantum', fallbackToLegacy: 'yes', gray: { percent: 101, users: 'u' } },
    mastra: { storage: { driver: 'sqlite', max: 0 }, memory: { mode: 'observational' }, closeTimeoutMs: 1 },
  }
  const { value, repairs } = parseRuntimeConfig(raw)
  eq(value.runtime.engine, 'legacy', '非法 engine → legacy')
  eq(value.runtime.fallbackToLegacy, true, '非法布尔 → true')
  eq(value.runtime.gray.percent, 0, 'percent 越界 → 0')
  eq(value.runtime.gray.users, [], 'users 非数组 → []')
  eq(value.mastra.storage.driver, 'libsql', '非法 storage driver → libsql')
  eq(value.mastra.storage.max, 10, 'max 非法 → 10')
  eq(value.mastra.memory.mode, 'sessionstore', '非法 memory mode → sessionstore')
  eq(value.mastra.closeTimeoutMs, 15000, 'closeTimeoutMs 过小 → 15000')
  ok(repairs.length >= 6, `repairs 记录了 ${repairs.length} 项`)
  ok(repairs.some((r) => r.path === 'runtime.engine'), 'repair 路径精确到 runtime.engine')
}

console.log('\n[合法值保留 + 未知字段透传]')
{
  const { value, repairs } = parseRuntimeConfig({
    runtime: { engine: 'mastra', fallbackToLegacy: false, gray: { users: ['u1'], groups: ['g1'], percent: 5 }, future: 1 },
    mastra: { storage: { driver: 'postgres', schemaName: 'mastra_test', future: 'x' }, vector: { enable: true }, memory: { mode: 'mastra' } },
  })
  eq(value.runtime.engine, 'mastra', 'mastra 保留')
  eq(value.runtime.fallbackToLegacy, false, 'false 保留')
  eq(value.runtime.gray.percent, 5, 'percent 保留')
  eq(value.runtime.future, 1, 'runtime 未知字段透传')
  eq(value.mastra.storage.driver, 'postgres', 'postgres 保留')
  eq(value.mastra.storage.future, 'x', 'storage 未知字段透传')
  eq(value.mastra.vector.enable, true, 'vector enable 保留')
  eq(value.mastra.memory.mode, 'mastra', 'Phase 2 可显式配置')
  eq(repairs, [], '合法配置无修复项')
}

console.log('\n[原地归一 / dirty]')
{
  const agent = { runtime: { engine: 'bad' } }
  const logs = []
  const dirty = normalizeAgentRuntimeConfig(agent, { logger: { warn: (...a) => logs.push(a.join(' ')) } })
  eq(dirty, true, '发生修复 → dirty')
  eq(agent.runtime.engine, 'legacy', '原地修正 engine')
  ok(agent.mastra?.storage?.driver === 'libsql', '补全 mastra.storage')
  ok(logs.length > 0 && logs[0].includes('非法'), '记录修复日志')

  const again = normalizeAgentRuntimeConfig(agent, { logger: { warn: () => {} } })
  eq(again, false, '二次归一无变化 → 不脏')
}

console.log('\n[describe 不泄露 DSN]')
{
  const v = resolveRuntimeConfig({
    runtime: { engine: 'mastra' },
    mastra: { storage: { driver: 'postgres', connectionStringEnv: 'MY_PRIVATE_DSN' } },
  })
  const d = describeRuntimeConfig(v)
  eq(d.engine, 'mastra', 'engine')
  eq(d.storage.driver, 'postgres', 'driver')
  eq(d.storage.schemaName, 'mastra', 'schema 可见')
  const text = JSON.stringify(d)
  ok(!/postgres:\/\/|password|apiKey|MY_PRIVATE_DSN/.test(text), '摘要不含 DSN/env 名/密钥')
}

console.log('\n[默认值冻结]')
{
  eq(DEFAULT_RUNTIME_CONFIG.engine, 'legacy', '默认 runtime legacy')
  eq(DEFAULT_MASTRA_CONFIG.memory.mode, 'sessionstore', '默认 memory sessionstore')
  let threw = false
  try { DEFAULT_RUNTIME_CONFIG.engine = 'mastra' } catch { threw = true }
  ok(threw || DEFAULT_RUNTIME_CONFIG.engine === 'legacy', '默认值不可被静默改写')
}

console.log(`\n========================================`)
console.log(`通过 ${passed}，失败 ${failed}`)
console.log(`========================================`)
if (failed > 0) process.exitCode = 1
