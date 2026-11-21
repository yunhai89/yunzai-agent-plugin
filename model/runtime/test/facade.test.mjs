/**
 * S11 Runtime Facade：Mastra-only。
 *
 * 运行：node model/runtime/test/facade.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRuntimeFacade } from '../factory.js'
import { AgentRuntimeFacade } from '../facade.js'
import { SessionStore } from '../../agent/session.js'
import { memoryKv } from '../../agent/store/kv.js'
import { ToolRegistry } from '../../agent/tools/registry.js'

let passed = 0
let failed = 0
const ok = (c, m) => { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }
const eq = (a, b, m) => { const s = JSON.stringify(a) === JSON.stringify(b); ok(s, `${m}${s ? '' : `（实际 ${JSON.stringify(a)}）`}`) }

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'yz-mastra-facade-'))
const calls = []
const runner = {
  runChat: async (input, opts) => { calls.push({ input, opts }); return { content: 'mastra', messages: [], usage: null, turns: 1, taskId: opts.taskId || 'x', stopReason: 'stop' } },
}

console.log('\n[无 Runner：不可用 / 明确报错]')
{
  const f = new AgentRuntimeFacade({ engine: 'mastra', chatRunner: null })
  eq(f.chatEngine, 'unavailable', 'chatEngine=unavailable')
  let e = null
  try { await f.runChat('hi') } catch (err) { e = err }
  eq(e?.code, 'mastra_not_ready', 'runChat 抛 mastra_not_ready')
  await f.close()
}

console.log('\n[Runner：全量走 Mastra]')
{
  const f = new AgentRuntimeFacade({ engine: 'mastra', chatRunner: runner })
  eq(f.chatEngine, 'mastra', 'chatEngine=mastra')
  eq(f.shouldUseMastra({ userId: 'any' }), true, '任意 ctx 都走 Mastra')
  eq(f.shouldUseMastra(null), true, '无 ctx 也走 Mastra')
  const r = await f.runChat('hi', { ctx: { userId: 'u1' }, taskId: 'task-1' })
  eq(r.content, 'mastra', '返回 Runner 结果')
  eq(calls.at(-1).opts.taskId, 'task-1', 'taskId 注入')
  eq(calls.at(-1).opts.ctx.userId, 'u1', 'ctx 注入')
  await f.close()
  eq((await f.health()).closed, true, 'close 后 closed')
}

console.log('\n[Runner 不支持：不静默回退]')
{
  const f = new AgentRuntimeFacade({ engine: 'mastra', chatRunner: { runChat: async () => ({ unsupported: 'model_gemini_legacy_only' }) } })
  let e = null
  try { await f.runChat('hi') } catch (err) { e = err }
  eq(e?.code, 'model_gemini_legacy_only', '抛出明确错误')
  await f.close()
}

console.log('\n[取消]')
{
  let seen = null
  const f = new AgentRuntimeFacade({
    engine: 'mastra',
    chatRunner: {
      runChat: async (_input, opts) => {
        seen = opts.signal
        await new Promise((resolve, reject) => {
          if (opts.signal?.aborted) return reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
          opts.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true })
        })
      },
    },
  })
  const p = f.runChat('x', { taskId: 'task-abort' })
  await new Promise((r) => setTimeout(r, 5))
  eq(await f.abort('task-abort'), true, 'abort 命中')
  let e = null
  try { await p } catch (err) { e = err }
  eq(e?.name, 'AbortError', 'Runner 收到取消')
  ok(seen?.aborted === true, 'signal 已中止')
  await f.close()
}

console.log('\n[Factory：默认 Mastra + MemoryBridge + ChatRunner]')
{
  const cfg = {
    apiKey: 'legacy-provider', model: 'm', protocol: 'legacy',
    runtime: { engine: 'mastra' },
    mastra: { storage: { driver: 'libsql', libsqlFile: 'f.db' }, closeTimeoutMs: 5_000 },
  }
  const f = await createRuntimeFacade({
    cfg, dataDir: TMP,
    chat: { tools: new ToolRegistry(), session: new SessionStore({ kv: memoryKv() }), makeAgent: () => ({}) },
  })
  eq(f.engine, 'mastra', 'engine=mastra')
  eq(f.mastraReady, true, 'Mastra 已建')
  eq(f.chatEngine, 'mastra', 'chat runner 就绪')
  ok(!!f.history, 'MemoryBridge 已建')
  const h = await f.health()
  eq(h.history, 'mastra', 'health history=mastra')
  await f.close()

  let e = null
  try { await createRuntimeFacade({ cfg: { runtime: { engine: 'legacy' } }, dataDir: TMP }) } catch (err) { e = err }
  eq(e?.code, 'legacy_removed', 'legacy 被拒绝')
}

fs.rmSync(TMP, { recursive: true, force: true })
console.log(`\n========================================`)
console.log(`通过 ${passed}，失败 ${failed}`)
console.log(`========================================`)
if (failed > 0) process.exitCode = 1
