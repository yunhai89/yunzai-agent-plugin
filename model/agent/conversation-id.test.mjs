/**
 * 会话短 ID：用户/Web 使用短 ID，内部仍保留完整 scope。
 * 运行：node model/agent/conversation-id.test.mjs
 */
import { shortConversationId, isShortConversationId } from './conversation-id.js'
import { SessionStore } from './session.js'
import { memoryKv } from './store/kv.js'

let pass = 0, fail = 0
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m) } else { fail++; console.error('  ✗ FAIL', m) } }
const eq = (a, b, m) => { const s = JSON.stringify(a) === JSON.stringify(b); ok(s, `${m}${s ? '' : `（实际 ${JSON.stringify(a)}）`}`) }

console.log('[短 ID 生成]')
{
  const base = { scopeUserId: 'u1', scopeGroupId: 'g1', conversationId: '1', adapter: 'onebot', botId: '123' }
  const a = shortConversationId(base)
  ok(/^c[0-9a-z]{8}$/.test(a), `格式为 c + 8 位 base36（${a}）`)
  ok(isShortConversationId(a), 'isShortConversationId 识别')
  eq(shortConversationId(base), a, '同输入稳定')
  ok(shortConversationId({ ...base, scopeUserId: 'u2' }) !== a, '不同用户不同 ID')
  ok(shortConversationId({ ...base, scopeGroupId: 'g2' }) !== a, '不同群不同 ID')
  ok(shortConversationId({ ...base, conversationId: '2' }) !== a, '不同对话不同 ID')
  ok(shortConversationId({ ...base, botId: '456' }) !== a, '不同 bot 不同 ID')
  ok(a.length < '1903797111:8DCD37C891FF0FDD5ADA545EE4AA06FA'.length, '明显短于官方 ID')
}

console.log('\n[SessionStore 短 ID]')
{
  const s = new SessionStore({ kv: memoryKv() })
  const c = await s.createConversation('u1', 'g1', '旧存储')
  ok(/^c[0-9a-z]{8}$/.test(c.shortId), 'createConversation 返回 shortId')
  const list = await s.listConversations('u1', 'g1')
  eq(list[0].shortId, c.shortId, 'listConversations 带 shortId')
  const hit = await s.resolveConversationRef(c.shortId, { userId: 'u1', groupId: 'g1' })
  eq(hit?.id, c.id, '短 ID 可解析回内部 id')
  ok(await s.setActiveConversation('u1', 'g1', c.shortId), 'setActiveConversation 接受短 ID')
  eq(await s.getActiveConversation('u1', 'g1'), c.id, 'active 仍存内部 id')
  eq(await s.resolveConversationRef('999', { userId: 'u1', groupId: 'g1' }), null, '未知数字不误匹配')
  eq(await s.resolveConversationRef('c00000000', { userId: 'u1', groupId: 'g1' }), null, '未知短 ID 返回 null')
  eq((await s.getConversationMeta('u1', 'g1', c.id))?.shortId, c.shortId, 'getConversationMeta 带 shortId')
}

console.log('\n[官方 scope（含冒号）与旧会话]')
{
  const kv = memoryKv()
  const user = '1903797111:807AC1596B40D96591A5ACBEB3CFFA4D'
  const s = new SessionStore({ kv })
  const c = await s.createConversation(user, null, 'Web 会话')
  const all = await s.listAllConversations()
  eq(all[0].scopeUserId, user, 'listAllConversations 不把官方 scope 截断')
  eq(all[0].shortId, c.shortId, '全局列表 shortId 与创建时一致')
  const ref = await s.resolveConversationRef(c.shortId)
  eq([ref?.id, ref?.scopeUserId, ref?.scopeGroupId], [c.id, user, ''], '全局短 ID 解析出完整 scope')
  ok(await s.setActiveConversation(user, null, c.shortId), 'setActiveConversation 接受短 ID')

  // 旧数据：对象里没有 shortId/scope 字段，只能从 KV 键恢复（官方 userId 本身含冒号）
  const legacy = new SessionStore({ kv: memoryKv() })
  const legacyUser = '1903797111:8DCD37C891FF0FDD5ADA545EE4AA06FA'
  const key = `Yz:agent:sess:conv:private:${legacyUser}:1`
  await legacy.kv.set(key, { id: '1', title: '旧会话', messages: [{ role: 'user', content: 'hi' }], createdAt: 1, updatedAt: 2 })
  const legacyList = await legacy.listAllConversations()
  eq(legacyList[0].scopeUserId, legacyUser, '旧键中的官方 scope 解析正确')
  eq(legacyList[0].shortId, shortConversationId({ scopeUserId: legacyUser, scopeGroupId: '', conversationId: '1' }), '旧会话得到确定性短 ID')
  const legacyRef = await legacy.resolveConversationRef(legacyList[0].shortId)
  eq([legacyRef?.id, legacyRef?.scopeUserId], ['1', legacyUser], '旧会话短 ID 可回放')
}

console.log('\n[旧群共享键]')
{
  const kv = memoryKv()
  const oldKey = 'Yz:agent:sess:conv:g1:__group__:c1'
  await kv.set(oldKey, { id: 'c1', title: '旧共享会话', messages: [], createdAt: 1, updatedAt: 2 })
  const s = new SessionStore({ kv })
  const scoped = await s.listConversations('__group__:g1', 'g1')
  const all = await s.listAllConversations()
  eq(all[0].scopeUserId, '__group__:g1', '旧共享键规范化为 __group__:<gid>')
  eq(all[0].shortId, scoped[0].shortId, 'Web 与 #聊天列表 对同一旧会话的短 ID 一致')
}

console.log(`\n会话短 ID 测试：通过 ${pass}，失败 ${fail}`)
if (fail > 0) process.exitCode = 1
