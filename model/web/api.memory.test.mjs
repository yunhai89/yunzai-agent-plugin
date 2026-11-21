/**
 * S7：Mastra Memory 接管历史后，Web /api/conversations 与 /api/sessions 仍兼容。
 *
 * 运行：node --import ./stress/e2e/hooks.mjs model/web/api.memory.test.mjs
 */
import express from 'express'
import { Memory } from '@mastra/memory'
import { buildApiRouter } from './api.js'
import { errorMiddleware } from './response.js'
import { createStorage } from '../runtime/storage-factory.js'
import { MastraMemoryBridge } from '../runtime/memory-bridge.js'
import { memoryKv } from '../agent/store/kv.js'

let passed = 0, failed = 0
const ok = (c, m) => { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }
const eq = (a, b, m) => { const s = JSON.stringify(a) === JSON.stringify(b); ok(s, `${m}${s ? '' : `（实际 ${JSON.stringify(a)}）`}`) }

const storage = await createStorage({ driver: 'libsql', libsqlUrl: ':memory:' })
const memory = new Memory({
  storage: storage.store, vector: false,
  options: { lastMessages: false, semanticRecall: false, workingMemory: { enabled: false } },
})
const bridge = new MastraMemoryBridge({ memory, storage: storage.store, legacySession: null, kv: memoryKv(), botId: '1903797111', adapter: 'qqbot' })
const user = '1903797111:807AC1596B40D96591A5ACBEB3CFFA4D'
const group = '1903797111:8A2B3C4D5E6F708192A3B4C5D6E7F809'
const ctx = { official: true, adapterKind: 'qqbot', selfId: '1903797111' }
const c = await bridge.createConversation(user, group, 'Web 会话', ctx)
await bridge.appendConversation(user, group, c.id, [
  { role: 'user', content: 'WEB-USER' },
  { role: 'assistant', content: 'WEB-REPLY' },
], { cacheEpoch: 3 }, ctx)

const app = express()
app.use(express.json())
app.use('/api', buildApiRouter({ runtimeProvider: async () => ({ session: bridge }) }))
app.use(errorMiddleware)
const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)) })
const base = `http://127.0.0.1:${server.address().port}`
const get = async (p) => { const r = await fetch(base + p); return { status: r.status, body: await r.json() } }

console.log('\n[Web conversations/sessions]')
{
  const q = new URLSearchParams({ userId: user, groupId: group })
  const list = await get(`/api/conversations?${q}`)
  eq(list.status, 200, 'conversations 200')
  eq(list.body.code, 0, 'conversations code=0')
  eq(list.body.data.length, 1, '1 个对话')
  eq(list.body.data[0].id, c.id, '对话 id')
  eq(list.body.data[0].count, 2, '消息数来自 Mastra metadata')
  eq(list.body.data[0].scopeUserId, user, '完整官方 userId')
  eq(list.body.data[0].scopeGroupId, group, '完整官方 groupId')

  const all = await get('/api/conversations')
  eq(all.body.data.length, 1, '全局列表 1 个')
  eq(all.body.data[0].scopeUserId, user, '全局列表完整 userId')

  const s = await get(`/api/sessions?${new URLSearchParams({ convId: c.id, userId: user, groupId: group })}`)
  eq(s.body.code, 0, 'sessions code=0')
  eq(s.body.data.messages.map((m) => m.content), ['WEB-USER', 'WEB-REPLY'], '消息可读')
  eq(s.body.data.scopeUserId, user, 'sessions scopeUserId')
}

await new Promise((r) => server.close(r))
await storage.close()
console.log(`\n========================================`)
console.log(`通过 ${passed}，失败 ${failed}`)
console.log(`========================================`)
if (failed > 0) process.exitCode = 1
