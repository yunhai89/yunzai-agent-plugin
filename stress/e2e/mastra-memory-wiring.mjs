/**
 * S7 接线回归：真实 apps runtime → Mastra Memory → rt.session/Agent/Web 同源。
 *
 * 运行：node --import ./stress/e2e/hooks.mjs stress/e2e/mastra-memory-wiring.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), `e2e-mastra-memory-${process.pid}-`))
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
  runtime: { engine: 'mastra', gray: { users: ['tester'], groups: [], percent: 0 } },
  mastra: {
    storage: { driver: 'libsql', libsqlFile: 'mastra/memory.db' },
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

console.log('\n[memory.mode=mastra：rt.session 即 MemoryBridge]')
{
  const rt = await getRuntime()
  ok(rt.session instanceof MastraMemoryBridge, 'rt.session 是 MemoryBridge')
  ok(rt.runtime.history === rt.session, 'Facade.history 与 rt.session 同源')
  eq(rt.runtime.health ? (await rt.runtime.health()).history : null, 'mastra', 'health history=mastra')
  const agent = rt.makeAgent()
  ok(agent.session === rt.session, 'Agent.session 也指向 Bridge')
}

console.log('\n[Mastra 历史读写 / Web 同源]')
{
  const rt = await getRuntime()
  const c = await rt.session.createConversation('tester', null, 'S7')
  await rt.session.appendConversation('tester', null, c.id, [
    { role: 'user', content: 'E2E-USER' },
    { role: 'assistant', content: 'E2E-REPLY' },
  ], { cacheEpoch: 2 })
  const hist = await rt.session.getConversation('tester', null, c.id)
  eq(hist.map((m) => m.content), ['E2E-USER', 'E2E-REPLY'], 'rt.session 读回消息')
  const all = await rt.session.listAllConversations()
  ok(all.some((x) => String(x.id) === String(c.id) && x.source === 'mastra'), 'Web 全局列表可见')
  eq((await rt.session.getConversationState('tester', null, c.id)).cacheEpoch, 2, '状态同源')
}

console.log('\n[scope.close：Mastra Memory 关闭]')
{
  const rt = await getRuntime()
  const r = await rt.scope.close('e2e')
  ok(rt.runtime.closed === true, 'Facade 已关闭')
  ok(!r?.errors?.length, '关闭无异常')
}

fs.rmSync(TMP, { recursive: true, force: true })
console.log(`\n========================================`)
console.log(`通过 ${passed}，失败 ${failed}`)
console.log(`========================================`)
if (failed > 0) process.exitCode = 1
