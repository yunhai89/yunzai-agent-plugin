/**
 * Runtime Facade 契约（PR1）。
 *
 * 关键：PR1 即使 engine=mastra，聊天仍回退 legacy（Mastra runner 没有 runChat）；
 * Facade 只负责选择/健康/生命周期，行为不变。
 *
 * 运行：node model/runtime/test/facade.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRuntimeFacade } from '../factory.js'
import { AgentRuntimeFacade } from '../facade.js'

let passed = 0
let failed = 0
function ok(c, m) {
  if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) }
}
function eq(a, b, m) {
  const same = JSON.stringify(a) === JSON.stringify(b)
  ok(same, `${m}${same ? '' : `  (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`}`)
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'yz-mastra-facade-'))
const calls = []
const LEGACY_RESULT = { content: 'legacy', messages: [], usage: null, turns: 1, taskId: 't1', stopReason: 'stop' }
const legacy = {
  runChat: async (input, opts) => { calls.push({ input, opts }); return { ...LEGACY_RESULT } },
  makeAgent: () => ({ run: async () => ({ ...LEGACY_RESULT, content: 'made' }) }),
}

console.log('\n[默认 legacy：不加载 Mastra]')
{
  const f = await createRuntimeFacade({ cfg: {}, dataDir: TMP, legacy })
  eq(f.engine, 'legacy', 'requested=legacy')
  eq(f.chatEngine, 'legacy', 'chat=legacy')
  eq(f.mastraReady, false, '未创建 Mastra')
  const res = await f.runChat('hi', { ctx: { userId: 'u' }, taskId: 't1' })
  eq(res.content, 'legacy', '走 legacy runner')
  eq(calls.length, 1, 'legacy 被调用')
  const h = await f.health()
  eq(h.ok, true, 'health ok')
  eq(h.storage, null, '无 storage')
  await f.close()
  eq((await f.health()).closed, true, 'close 后 closed')
}

console.log('\n[engine=mastra：建骨架但聊天仍 legacy]')
{
  const dir = path.join(TMP, 'm1')
  fs.mkdirSync(dir, { recursive: true })
  const logs = []
  const f = await createRuntimeFacade({
    cfg: { runtime: { engine: 'mastra' }, mastra: { storage: { driver: 'libsql', libsqlFile: 'f.db' }, closeTimeoutMs: 5_000 } },
    dataDir: dir,
    legacy,
    logger: (level, ...args) => logs.push([level, ...args].join(' ')),
  })
  eq(f.engine, 'mastra', 'requested=mastra')
  eq(f.mastraReady, true, 'Mastra 骨架已建')
  eq(f.chatEngine, 'legacy', 'PR1 聊天仍 legacy')
  const res = await f.runChat('hi')
  eq(res.content, 'legacy', '聊天走 legacy')
  const h = await f.health()
  eq(h.ok, true, 'health ok')
  eq(h.storage.driver, 'libsql', 'health 有 storage')
  ok(logs.some((l) => l.includes('尚未接线')), '记录 mastra_chat_not_wired 警告')
  await f.close()
  await f.close()
}

console.log('\n[Mastra 失败 → fallbackToLegacy]')
{
  const logs = []
  const f = await createRuntimeFacade({
    cfg: { runtime: { engine: 'mastra', fallbackToLegacy: true }, mastra: { storage: { driver: 'postgres', connectionStringEnv: 'NO_SUCH_DSN' } } },
    dataDir: TMP,
    legacy,
    logger: (level, ...args) => logs.push([level, ...args].join(' ')),
  })
  eq(f.engine, 'mastra', '请求引擎保留')
  eq(f.mastraReady, false, 'Mastra 未建')
  eq(f.initError?.code, 'storage_init_failed', '记录 initError')
  eq((await f.runChat('hi')).content, 'legacy', '仍可聊天')
  ok(logs.some((l) => l.includes('回退 legacy')), '记录回退日志')
  await f.close()
}

console.log('\n[fallbackToLegacy=false：fail-closed]')
{
  let e = null
  try {
    await createRuntimeFacade({
      cfg: { runtime: { engine: 'mastra', fallbackToLegacy: false }, mastra: { storage: { driver: 'postgres', connectionStringEnv: 'NO_SUCH_DSN' } } },
      dataDir: TMP,
      legacy,
    })
  } catch (err) { e = err }
  eq(e?.code, 'storage_init_failed', '初始化失败直接抛出')
}

console.log('\n[forRequest / streamChat / makeAgent 兼容]')
{
  const f = await createRuntimeFacade({ cfg: {}, legacy, dataDir: TMP })
  const runner = f.forRequest({ ctx: { userId: 'u1' }, taskId: 'task-9' })
  const res = await runner.runChat('x')
  eq(res.taskId, 't1', 'result 原样返回')
  eq(calls.at(-1).opts.taskId, 'task-9', 'taskId 注入')
  eq(calls.at(-1).opts.ctx.userId, 'u1', 'ctx 注入')
  const s = await runner.streamChat('y')
  eq(s.runId, 't1', 'streamChat runId')
  eq(s.result.content, 'legacy', 'streamChat result')
  const f2 = await createRuntimeFacade({ cfg: {}, legacy: { makeAgent: legacy.makeAgent }, dataDir: TMP })
  eq((await f2.runChat('z')).content, 'made', 'makeAgent 兼容路径')
  await f.close()
  await f2.close()
}

console.log('\n[灰度选择 / Runner]')
{
  let called = 0
  const runner = { runChat: async () => { called++; return { content: 'mastra', stopReason: 'stop', turns: 1, usage: null, taskId: 'x' } } }
  const f = new AgentRuntimeFacade({
    engine: 'mastra', legacy, chatRunner: runner, gray: { users: ['u1'], groups: ['g1'], percent: 0 }, config: {},
  })
  eq(f.chatEngine, 'mastra', 'chatEngine=mastra')
  eq(f.shouldUseMastra({ userId: 'u1' }), true, '显式用户命中')
  eq(f.shouldUseMastra({ userId: 'u2', groupId: 'g1' }), true, '显式群命中')
  eq(f.shouldUseMastra({ userId: 'u2', groupId: 'g2' }), false, '未命中不回退?')
  const r = await f.runChat('hi', { ctx: { userId: 'u1' } })
  eq([r.content, called], ['mastra', 1], '命中走 Runner')
  const f2 = new AgentRuntimeFacade({ engine: 'mastra', legacy, chatRunner: { runChat: async () => ({ unsupported: 'x' }) }, gray: { users: ['u1'] }, config: {} })
  const r2 = await f2.runChat('hi', { ctx: { userId: 'u1' } })
  eq(r2.content, 'legacy', 'Runner 不支持回退 legacy')
  const f3 = new AgentRuntimeFacade({ engine: 'mastra', legacy, chatRunner: runner, gray: { users: [], groups: [], percent: 50 }, config: {} })
  const hit = Array.from({ length: 40 }, (_, i) => f3.shouldUseMastra({ userId: `p${i}` })).filter(Boolean).length
  ok(hit > 0 && hit < 40, `percent 稳定抽样命中 ${hit}/40`)
  await f.close(); await f2.close(); await f3.close()
}


console.log('\n[灰度取消：Facade abort 中止 Runner]')
{
  let seenSignal = null
  const runner = {
    runChat: async (_input, opts) => {
      seenSignal = opts.signal
      await new Promise((resolve, reject) => {
        if (opts.signal?.aborted) return reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
        opts.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true })
      })
    },
  }
  const f = new AgentRuntimeFacade({ engine: 'mastra', legacy, chatRunner: runner, gray: { users: ['u1'] }, config: {} })
  const p = f.runChat('x', { ctx: { userId: 'u1' }, taskId: 'task-abort' })
  await new Promise((r) => setTimeout(r, 5))
  const hit = await f.abort('task-abort')
  let e = null
  try { await p } catch (err) { e = err }
  eq(hit, true, 'abort 命中在途 run')
  eq(e?.name, 'AbortError', 'Runner 收到取消')
  ok(seenSignal?.aborted === true, 'signal 已中止')
  await f.close()
}

fs.rmSync(TMP, { recursive: true, force: true })

console.log(`\n========================================`)
console.log(`通过 ${passed}，失败 ${failed}`)
console.log(`========================================`)
if (failed > 0) process.exitCode = 1
