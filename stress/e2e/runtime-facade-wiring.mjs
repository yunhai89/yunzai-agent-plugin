/**
 * S11 接线回归：真实 apps runtime → Mastra-only → MemoryBridge → 关闭。
 *
 * 运行：node --import ./stress/e2e/hooks.mjs stress/e2e/runtime-facade-wiring.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), `e2e-runtime-s11-${process.pid}-`))
process.env.E2E_TMP = TMP
process.env.E2E_REAL_AGENT = '1'
await import(pathToFileURL(path.join(import.meta.dirname, 'hooks.mjs')).href)

const cfgMod = await import('./stubs/Config.js')
const base = {
  apiKey: 'sk-offline-fixture', model: 'offline-fixture',
  devLog: { dir: path.join(TMP, 'devlog') },
  multiagent: { enable: false }, sandbox: { mode: 'off' },
  toolEvo: { enable: false }, sticker: { enable: false },
  tools: { builtin: false }, schedule: { taskEnabled: false },
  webApi: { enable: false }, skill: { dir: path.join(TMP, 'skills') },
  qqBot: { enable: false },
  runtime: { engine: 'mastra' },
  mastra: {
    storage: { driver: 'libsql', libsqlFile: 'mastra/e2e.db' },
    memory: { mode: 'mastra', onDemandMigration: true },
    identity: { botId: '123', adapter: 'onebot' },
    closeTimeoutMs: 5_000,
  },
}
cfgMod.__setConfig({ agent: base })

let passed = 0
let failed = 0
const ok = (c, m) => { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }
const eq = (a, b, m) => { const s = JSON.stringify(a) === JSON.stringify(b); ok(s, `${m}${s ? '' : `（实际 ${JSON.stringify(a)}）`}`) }

const { getRuntime } = await import('../../apps/agent.js')
const { MastraMemoryBridge } = await import('../../model/runtime/memory-bridge.js')

console.log('\n[Mastra-only：建库 / Bridge / ChatRunner]')
{
  const rt = await getRuntime()
  ok(!!rt.runtime, 'rt.runtime 已装配')
  eq(rt.runtime.engine, 'mastra', 'engine=mastra')
  eq(rt.runtime.mastraReady, true, 'Mastra 已创建')
  eq(rt.runtime.chatEngine, 'mastra', 'chatRunner 就绪')
  ok(rt.session instanceof MastraMemoryBridge, 'rt.session=MemoryBridge')
  ok(fs.existsSync(path.join(TMP, 'mastra/e2e.db')), 'LibSQL 文件已创建')
  const h = await rt.runtime.health()
  eq([h.ok, h.history, h.storage.driver], [true, 'mastra', 'libsql'], 'health 正确')
}

console.log('\n[legacy 配置：明确拒绝]')
{
  cfgMod.__setConfig({ agent: { ...base, runtime: { engine: 'legacy' } } })
  cfgMod.__emitChange()
  let e = null
  try { await getRuntime() } catch (err) { e = err }
  eq(e?.code, 'legacy_removed', 'legacy 被拒绝')
}

console.log('\n[scope.close：Facade 关闭]')
{
  cfgMod.__setConfig({ agent: base })
  cfgMod.__emitChange()
  const rt = await getRuntime()
  await rt.scope.close('e2e')
  ok(rt.runtime.closed === true, 'scope.close 关闭 Facade')
}

console.log(`\n========================================`)
console.log(`通过 ${passed}，失败 ${failed}`)
console.log(`========================================`)
if (failed > 0) process.exitCode = 1
