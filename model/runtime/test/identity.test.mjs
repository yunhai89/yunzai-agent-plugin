/**
 * Identity 契约（PR1）：resource/thread 必须含 adapter + botId + scopeId。
 *
 * 运行：node model/runtime/test/identity.test.mjs
 */
import {
  buildIdentity, deriveScopeId, normalizeAdapter, normalizeBotId,
  assertIdentityPart, isValidIdentity, IDENTITY_MAX_LEN,
} from '../identity.js'

let passed = 0
let failed = 0
function ok(c, m) {
  if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) }
}
function eq(a, b, m) {
  const same = JSON.stringify(a) === JSON.stringify(b)
  ok(same, `${m}${same ? '' : `  (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`}`)
}

console.log('\n[OneBot]')
{
  const ctx = { selfId: '2721779039', scopeId: 'g123_u456', adapterKind: 'onebot' }
  const id = buildIdentity({ ctx, conversationId: 3 })
  eq(id.adapter, 'onebot', 'adapter=onebot')
  eq(id.resourceId, 'yz_onebot_2721779039_g123_u456', 'resource 含 botId+scopeId')
  eq(id.threadId, 'yz_onebot_2721779039_g123_u456_c3', 'thread 带 conversationId')
  ok(isValidIdentity(id.resourceId) && isValidIdentity(id.threadId), '字符集合法')
}

console.log('\n[官方 QQ：冒号被净化 + bot 隔离]')
{
  const ctx = {
    selfId: '1903797111',
    scopeId: 'g1903797111-8A2B_u1903797111-807AC',
    official: true, adapterKind: 'qqbot',
  }
  const a = buildIdentity({ ctx, conversationId: 1 })
  eq(a.adapter, 'qqbot', 'adapter=qqbot')
  ok(!a.resourceId.includes(':'), 'resource 不含冒号')
  ok(a.resourceId.startsWith('yz_qqbot_1903797111_'), 'resource 以 appid 开头')
  const b = buildIdentity({ ctx: { ...ctx, selfId: '1903797112' }, conversationId: 1 })
  ok(a.resourceId !== b.resourceId, '不同 botId → 不同 resource（防串数据）')
  const c = buildIdentity({ ctx: { ...ctx, scopeId: 'g1903797111-8A2B_u1903797111-OTHER' }, conversationId: 1 })
  ok(a.resourceId !== c.resourceId, '不同用户 → 不同 resource')
}

console.log('\n[频道 / 定时 / 子 Agent]')
{
  const guild = { selfId: '1903797111', scopeId: 'guild_x', official: true, adapterKind: 'QQGuild' }
  eq(buildIdentity({ ctx: guild }).adapter, 'qqguild', 'QQGuild → qqguild')
  const ctx = { selfId: '1903797111', scopeId: 'u_x', official: true, adapterKind: 'qqbot' }
  const sched = buildIdentity({ ctx, kind: 'scheduled' })
  eq(sched.threadId, 'yz_qqbot_1903797111_u_x_scheduled', '定时独立 thread')
  const sub = buildIdentity({ ctx, kind: 'sub', agentName: '研究员', childTaskId: 'task:1' })
  ok(sub.threadId.includes('_sub_') && sub.threadId.includes('task-1'), '子 Agent thread 独立且净化')
  ok(!sub.threadId.includes(':'), '子 Agent thread 不含冒号')
}

console.log('\n[scope 推导 / 缺失值]')
{
  eq(deriveScopeId({ userId: '123', groupId: '456', isGroup: true }), 'g456_u123', '群成员 scope')
  eq(deriveScopeId({ userId: '123', groupId: '456', isGroup: true, isolation: false }), 'g456', '群共享 scope')
  eq(deriveScopeId({ userId: '123' }), 'u_123', '私聊 scope')
  const id = buildIdentity({ ctx: { userId: '123' }, conversationId: null })
  eq(id.botId, 'bot', '缺失 selfId → bot')
  eq(id.threadId, 'yz_onebot_bot_u_123_cdefault', '缺失 conversationId → default')
}

console.log('\n[长度封顶 / 非法输入]')
{
  const long = 'x'.repeat(300)
  const id = buildIdentity({ ctx: { selfId: long, scopeId: `u_${long}`, adapterKind: 'onebot' }, conversationId: long })
  ok(id.resourceId.length <= IDENTITY_MAX_LEN, `resource ≤ ${IDENTITY_MAX_LEN}`)
  ok(id.threadId.length <= IDENTITY_MAX_LEN, `thread ≤ ${IDENTITY_MAX_LEN}`)
  ok(isValidIdentity(id.threadId), '封顶后仍合法')
  const again = buildIdentity({ ctx: { selfId: long, scopeId: `u_${long}`, adapterKind: 'onebot' }, conversationId: long })
  eq(again.threadId, id.threadId, '同一输入同一结果（稳定哈希）')

  let threw = false
  try { assertIdentityPart('a:b') } catch { threw = true }
  ok(threw, '非法字符拒绝')
  ok(!isValidIdentity('a b'), '空格无效')
  eq(normalizeAdapter({ official: true, adapterKind: 'QQGuild' }), 'qqguild', 'adapter 归一')
  eq(normalizeBotId({ self_id: '123' }), '123', 'self_id 兼容')
}

console.log(`\n========================================`)
console.log(`通过 ${passed}，失败 ${failed}`)
console.log(`========================================`)
if (failed > 0) process.exitCode = 1
