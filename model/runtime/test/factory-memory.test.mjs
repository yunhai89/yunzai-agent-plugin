/**
 * S7：Runtime Facade 在 memory.mode=mastra 时创建 MemoryBridge 并交给 apps。
 *
 * 运行：node model/runtime/test/factory-memory.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRuntimeFacade } from '../factory.js'
import { MastraMemoryBridge } from '../memory-bridge.js'
import { SessionStore } from '../../agent/session.js'
import { memoryKv } from '../../agent/store/kv.js'
import { ToolRegistry } from '../../agent/tools/registry.js'

let passed = 0, failed = 0
const ok = (c, m) => { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }
const eq = (a, b, m) => { const s = JSON.stringify(a) === JSON.stringify(b); ok(s, `${m}${s ? '' : `（实际 ${JSON.stringify(a)}）`}`) }

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'yz-factory-memory-'))
const baseCfg = {
  providerId: 'p', modelId: 'm', apiKey: 'k', model: 'm', protocol: 'openai', preset: 'openai', baseURL: 'https://example.test/v1',
  llmProviders: [{ id: 'p', protocol: 'openai', preset: 'openai', baseURL: 'https://example.test/v1', apiKey: 'k' }],
  llmModels: [{ id: 'm', providerId: 'p', model: 'm' }],
  runtime: { engine: 'mastra' },
  mastra: {
    storage: { driver: 'libsql', libsqlFile: 'mastra.db' },
    memory: { mode: 'mastra' },
    closeTimeoutMs: 5_000,
  },
}

console.log('\n[memory.mode=mastra → Facade.history]')
{
  const session = new SessionStore({ kv: memoryKv() })
  const f = await createRuntimeFacade({
    cfg: baseCfg, dataDir: TMP, legacy: { makeAgent: () => ({}) },
    chat: { tools: new ToolRegistry(), session, makeAgent: () => ({}), identity: { botId: '123', adapter: 'onebot' } },
  })
  ok(f.history instanceof MastraMemoryBridge, 'history 为 MemoryBridge')
  ok(f.session === f.history, 'session 即 bridge')
  eq((await f.health()).history, 'mastra', 'health history=mastra')
  const c = await f.history.createConversation('u1', 'g1', 'H')
  await f.history.appendConversation('u1', 'g1', c.id, [{ role: 'user', content: 'FACTORY' }])
  eq((await f.history.getConversation('u1', 'g1', c.id))[0].content, 'FACTORY', 'bridge 可用')
  await f.close()
}

console.log('\n[memory.mode=sessionstore → 不创建 bridge]')
{
  const session = new SessionStore({ kv: memoryKv() })
  const cfg = { ...baseCfg, mastra: { ...baseCfg.mastra, memory: { mode: 'sessionstore' } } }
  const f = await createRuntimeFacade({
    cfg, dataDir: TMP, legacy: { makeAgent: () => ({}) },
    chat: { tools: new ToolRegistry(), session, makeAgent: () => ({}) },
  })
  eq(f.history, null, 'history=null')
  eq((await f.health()).history, 'sessionstore', 'health history=sessionstore')
  await f.close()
}

fs.rmSync(TMP, { recursive: true, force: true })
console.log(`\n========================================`)
console.log(`通过 ${passed}，失败 ${failed}`)
console.log(`========================================`)
if (failed > 0) process.exitCode = 1
