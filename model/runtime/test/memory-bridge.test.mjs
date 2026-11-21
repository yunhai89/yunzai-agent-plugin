/**
 * S7 / Memory Phase 2：MastraMemoryBridge 契约。
 *
 * 覆盖：conversation API、active、删除、状态、压缩写回、legacy 按需迁移、
 * 官方 ID、跨 bot/群/用户隔离、owner 冲突、并发 append、重启持久化、清空。
 *
 * 运行：node model/runtime/test/memory-bridge.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Memory } from '@mastra/memory'
import { createStorage } from '../storage-factory.js'
import { MastraMemoryBridge, resolveMemoryIdentity } from '../memory-bridge.js'
import { SessionStore } from '../../agent/session.js'
import { memoryKv } from '../../agent/store/kv.js'

let passed = 0
let failed = 0
const ok = (c, m) => { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }
const eq = (a, b, m) => { const s = JSON.stringify(a) === JSON.stringify(b); ok(s, `${m}${s ? '' : `（实际 ${JSON.stringify(a)}）`}`) }
const deep = (a, b, m) => {
  const norm = (v) => {
    if (Array.isArray(v)) return v.map(norm)
    if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, norm(v[k])]))
    return v
  }
  const s = JSON.stringify(norm(a)) === JSON.stringify(norm(b))
  ok(s, `${m}${s ? '' : `（实际 ${JSON.stringify(a)}）`}`)
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'yz-memory-bridge-'))

async function makeBridge({ file = ':memory:', legacy = null, botId = '123', kv = null } = {}) {
  const storage = await createStorage({ driver: 'libsql', libsqlUrl: file === ':memory:' ? ':memory:' : `file:${file}` })
  const memory = new Memory({
    storage: storage.store, vector: false,
    options: { lastMessages: false, semanticRecall: false, workingMemory: { enabled: false } },
  })
  const bridge = new MastraMemoryBridge({
    memory, storage: storage.store, legacySession: legacy, kv: kv || memoryKv(), botId,
  })
  return { storage, memory, bridge }
}

console.log('\n[conversation API / active / delete]')
{
  const { storage, bridge } = await makeBridge()
  const c1 = await bridge.createConversation('u1', 'g1', '一')
  const c2 = await bridge.createConversation('u1', 'g1', '二')
  eq(await bridge.getActiveConversation('u1', 'g1'), c2.id, '后创建为 active')
  eq((await bridge.listConversations('u1', 'g1')).length, 2, '列表 2 个')
  await bridge.appendConversation('u1', 'g1', c1.id, [{ role: 'user', content: 'A' }, { role: 'assistant', content: 'a' }])
  eq((await bridge.getConversation('u1', 'g1', c1.id)).length, 2, '读回 2 条')
  await bridge.setActiveConversation('u1', 'g1', c1.id)
  eq(await bridge.getActiveConversation('u1', 'g1'), c1.id, '切换 active')
  await bridge.deleteConversation('u1', 'g1', c1.id)
  eq(await bridge.getActiveConversation('u1', 'g1'), c2.id, '删除 active 后回退')
  eq((await bridge.listConversations('u1', 'g1')).length, 1, '删除后 1 个')
  await storage.close()
}

console.log('\n[append/set/state/meta]')
{
  const { storage, bridge } = await makeBridge()
  const c = await bridge.createConversation('u2', null, '状态')
  await bridge.appendConversation('u2', null, c.id, [{ role: 'user', content: 'q' }], { cacheEpoch: 2, activeTools: ['a'] })
  eq(await bridge.getConversationState('u2', null, c.id), { activeTools: ['a'], cacheEpoch: 2 }, 'append extra 写状态')
  await bridge.appendConversation('u2', null, c.id, [{ role: 'assistant', content: 'r' }])
  eq((await bridge.getConversation('u2', null, c.id)).length, 2, '追加后 2 条')
  await bridge.setConversation('u2', null, c.id, [{ role: 'user', content: 'new' }], { cacheEpoch: 3 })
  eq(await bridge.getConversationState('u2', null, c.id), { activeTools: null, cacheEpoch: 3 }, 'set 全量覆写状态')
  eq((await bridge.getConversation('u2', null, c.id)).length, 1, 'set 后 1 条')
  const meta = await bridge.getConversationMeta('u2', null, c.id)
  eq(meta.id, c.id, 'meta id')
  ok(meta.updatedAt > 0, 'meta updatedAt')
  await storage.close()
}

console.log('\n[工具/推理往返]')
{
  const { storage, bridge } = await makeBridge()
  const c = await bridge.createConversation('u3', 'g3', '工具')
  const src = [
    { role: 'user', content: '天气' },
    { role: 'assistant', content: '', reasoning: '想一想', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'weather', arguments: '{"city":"北京"}' } }] },
    { role: 'tool', tool_call_id: 'c1', name: 'weather', content: '{"temp":22}' },
    { role: 'assistant', content: '晴 22' },
  ]
  await bridge.appendConversation('u3', 'g3', c.id, src)
  deep(await bridge.getConversation('u3', 'g3', c.id), src, '工具/推理逐字段一致')
  await storage.close()
}

console.log('\n[legacy 按需迁移：单写 Mastra]')
{
  const legacy = new SessionStore({ kv: memoryKv() })
  const c = await legacy.createConversation('u4', 'g4', '旧会话')
  await legacy.appendConversation('u4', 'g4', c.id, [
    { role: 'user', content: 'OLD-USER' },
    { role: 'assistant', content: 'OLD-REPLY' },
  ], { cacheEpoch: 4, compactLedger: { v: 2, facts: [{ text: 'f' }] } })
  const { storage, bridge } = await makeBridge({ legacy })
  eq((await bridge.listConversations('u4', 'g4'))[0].source, 'legacy', '迁移前双读 legacy')
  eq((await bridge.getConversation('u4', 'g4', c.id)).map((m) => m.content), ['OLD-USER', 'OLD-REPLY'], '读取触发导入')
  eq((await bridge.listConversations('u4', 'g4'))[0].source, 'mastra', '导入后以 Mastra 为准')
  eq((await bridge.getConversationState('u4', 'g4', c.id)).cacheEpoch, 4, '导入保留 cacheEpoch')
  await bridge.appendConversation('u4', 'g4', c.id, [{ role: 'user', content: 'NEW' }])
  eq((await legacy.getConversation('u4', 'g4', c.id)).length, 2, 'legacy 未被追加（单写）')
  eq((await bridge.getConversation('u4', 'g4', c.id)).length, 3, 'Mastra 追加成功')
  eq((await bridge.listAllConversations()).length, 1, '导入后全局列表不重复')
  await storage.close()
}

console.log('\n[官方 ID：冒号净化 / 隔离]')
{
  const { storage, bridge } = await makeBridge()
  const user = '1903797111:807AC1596B40D96591A5ACBEB3CFFA4D'
  const group = '1903797111:8A2B3C4D5E6F708192A3B4C5D6E7F809'
  const c = await bridge.createConversation(user, group, '官方', { official: true, adapterKind: 'qqbot', selfId: '1903797111' })
  await bridge.appendConversation(user, group, c.id, [{ role: 'user', content: 'OFFICIAL' }], {}, { official: true, adapterKind: 'qqbot', selfId: '1903797111' })
  const ident = resolveMemoryIdentity({ userId: user, groupId: group, conversationId: c.id, ctx: { official: true, adapterKind: 'qqbot', selfId: '1903797111' } })
  ok(!ident.threadId.includes(':'), 'threadId 不含冒号')
  ok(ident.threadId.startsWith('yz_qqbot_1903797111_'), 'qqbot thread 前缀正确')
  ok(ident.threadId.length <= 128, 'threadId ≤128（超长官方 ID 截断）')
  eq((await bridge.listAllConversations()).length, 1, '全局列表 1 个')
  const item = (await bridge.listAllConversations())[0]
  eq(item.scopeUserId, user, 'scopeUserId 完整')
  eq(item.scopeGroupId, group, 'scopeGroupId 完整')
  await storage.close()
}

console.log('\n[隔离：用户/群/bot]')
{
  const { storage, bridge } = await makeBridge()
  const a = await bridge.createConversation('u5', 'g5', 'A', { selfId: '111' })
  await bridge.appendConversation('u5', 'g5', a.id, [{ role: 'user', content: 'BOT-111' }], {}, { selfId: '111' })
  const b1 = await bridge.createConversation('u5', 'g5', 'B1', { selfId: '222' })
  const b = await bridge.createConversation('u5', 'g5', 'B2', { selfId: '222' })
  await bridge.appendConversation('u5', 'g5', b.id, [{ role: 'user', content: 'BOT-222' }], {}, { selfId: '222' })
  const c = await bridge.createConversation('u6', 'g5', 'C', { selfId: '111' })
  await bridge.appendConversation('u6', 'g5', c.id, [{ role: 'user', content: 'USER-6' }], {}, { selfId: '111' })
  ok(a.id !== b.id, '不同 bot 的对话 id 独立（bot 级 seq）')
  eq((await bridge.getConversation('u5', 'g5', b.id, { selfId: '111' })), [], 'bot 隔离')
  const u6list = await bridge.listConversations('u6', 'g5', { selfId: '111' })
  eq(u6list.map((x) => x.id), [c.id], '用户 u6 只看到自己的对话')
  const u5list = await bridge.listConversations('u5', 'g5', { selfId: '111' })
  eq(u5list.length, 1, '用户 u5 在 bot111 下只看到 1 个对话')
  eq(u5list[0].id, a.id, '用户 u5 看到自己的对话 id')
  eq((await bridge.getConversation('u5', 'g6', a.id, { selfId: '111' })), [], '群隔离')
  const all = await bridge.listAllConversations()
  eq(all.filter((x) => x.scopeUserId === 'u5').length, 3, '全局列表保留两个 bot 的 3 个 thread')
  await storage.close()
}

console.log('\n[owner 冲突]')
{
  const { storage, bridge } = await makeBridge()
  const ident = resolveMemoryIdentity({ userId: 'u7', groupId: 'g7', conversationId: '1', ctx: { selfId: '123' } })
  const now = new Date()
  await bridge.memory.saveThread({
    thread: { id: ident.threadId, resourceId: 'other-resource', title: 'wrong', createdAt: now, updatedAt: now, metadata: { kind: 'chat', conversationId: '1' } },
  })
  let err = null
  try { await bridge.getConversation('u7', 'g7', '1', { selfId: '123' }) } catch (e) { err = e }
  eq(err?.code, 'memory_thread_owner_conflict', 'owner 冲突抛错')
  await storage.close()
}

console.log('\n[并发 append：同 thread 串行]')
{
  const { storage, bridge } = await makeBridge()
  const c = await bridge.createConversation('u8', 'g8', '并发')
  await Promise.all(Array.from({ length: 10 }, (_, i) => bridge.appendConversation('u8', 'g8', c.id, [{ role: 'user', content: `M${i}` }])))
  const conv = await bridge.getConversation('u8', 'g8', c.id)
  eq(conv.length, 10, '10 条全部保留')
  eq(conv.map((m) => m.content).sort(), Array.from({ length: 10 }, (_, i) => `M${i}`).sort(), '内容无丢失')
  await storage.close()
}

console.log('\n[clearAllConversations]')
{
  const legacy = new SessionStore({ kv: memoryKv() })
  const old = await legacy.createConversation('u9', 'g9', '旧')
  await legacy.appendConversation('u9', 'g9', old.id, [{ role: 'user', content: 'x' }])
  const { storage, bridge } = await makeBridge({ legacy })
  const c = await bridge.createConversation('u9', 'g9', '新')
  await bridge.appendConversation('u9', 'g9', c.id, [{ role: 'user', content: 'y' }])
  const n = await bridge.clearAllConversations('u9', 'g9')
  ok(n >= 2, `清空计数 ${n}`)
  eq(await bridge.listConversations('u9', 'g9'), [], '列表清空')
  eq(await bridge.peekActiveConversation('u9', 'g9'), null, 'active 清空')
  eq(await legacy.getConversation('u9', 'g9', old.id), [], 'legacy 对话对象也清空')
  await storage.close()
}

console.log('\n[重启持久化]')
{
  const file = path.join(TMP, 'persist', 'memory.db')
  const a = await makeBridge({ file })
  const c = await a.bridge.createConversation('u10', 'g10', '持久化')
  await a.bridge.appendConversation('u10', 'g10', c.id, [{ role: 'user', content: 'PERSIST' }], { cacheEpoch: 5 })
  await a.storage.close()
  const b = await makeBridge({ file })
  eq((await b.bridge.getConversation('u10', 'g10', c.id))[0].content, 'PERSIST', '重启后消息仍在')
  eq((await b.bridge.getConversationState('u10', 'g10', c.id)).cacheEpoch, 5, '重启后状态仍在')
  await b.storage.close()
}

fs.rmSync(TMP, { recursive: true, force: true })
console.log(`\n========================================`)
console.log(`通过 ${passed}，失败 ${failed}`)
console.log(`========================================`)
if (failed > 0) process.exitCode = 1
