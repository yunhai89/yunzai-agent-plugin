/**
 * 官方 QQ ID（含 `:`）会话契约 —— PR0 只记录现状，不修复。
 *
 * 事实（commit 9323c5d）：
 *   - 官方机器人 userId 形如 `<self_id>:<openid>` / `qg_<...>`，groupId 也可能是官方群 ID；
 *   - SessionStore.listAll() 用 `rest.split(':')` 取前两段；
 *   - SessionStore.listAllConversations() 用 split 后末两段反推 user/group；
 *   - apps/agent.js #清空所有记录 用 split 后固定下标取 keyUid。
 * 结果：官方 ID 在全局列表里被截断，清理命令找不到自己的会话（见 KNOWN-BUG 用例）。
 * 迁移前必须修（04 数据迁移 §身份），本测试用于区分「既有缺陷」与「迁移回归」。
 *
 * 运行：node model/runtime/test/contracts/official-id.test.mjs
 */
import { SessionStore } from '../../../agent/session.js'
import { memoryKv } from '../../../agent/store/kv.js'

let passed = 0
let failed = 0
function ok(c, m) {
  if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) }
}
function eq(a, b, m) {
  const same = JSON.stringify(a) === JSON.stringify(b)
  ok(same, `${m}${same ? '' : `  (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`}`)
}
/** 记录既有缺陷：条件成立 = 缺陷仍在（绿）；条件不成立 = 行为已变化，需更新测试 */
function knownBug(c, m, expected) {
  if (c) { passed++; console.log('  ✓ KNOWN-BUG', m) } else { failed++; console.error('  ✗ KNOWN-BUG 已变化（请更新契约）', m, expected ? `（期望修复后：${expected}）` : '') }
}

const OFFICIAL_USER = '1903797111:807AC1596B40D96591A5ACBEB3CFFA4D'
const OFFICIAL_GROUP = '1903797111:8A2B3C4D5E6F708192A3B4C5D6E7F809'
const PLAIN_USER = '123456'
const PLAIN_GROUP = '987654321'

async function freshStore() {
  return new SessionStore({ kv: memoryKv() })
}

console.log('\n[控制组：普通 QQ 号解析正确]')
{
  const s = await freshStore()
  await s.append(s.key(PLAIN_GROUP, PLAIN_USER), [{ role: 'user', content: 'hi' }])
  const c = await s.createConversation(PLAIN_USER, PLAIN_GROUP)
  await s.appendConversation(PLAIN_USER, PLAIN_GROUP, c.id, [{ role: 'user', content: 'hello' }])
  const all = await s.listAll()
  eq(all.length, 1, 'listAll 找到 1 条')
  eq([all[0].group, all[0].user], [PLAIN_GROUP, PLAIN_USER], 'listAll 普通 ID 解析正确')
  const convs = await s.listAllConversations()
  eq(convs.length, 1, 'listAllConversations 找到 1 条')
  eq([convs[0].scopeGroupId, convs[0].scopeUserId], [PLAIN_GROUP, PLAIN_USER], 'listAllConversations 普通 ID 解析正确')
}

console.log('\n[官方私聊 ID：listAllConversations]')
{
  const s = await freshStore()
  const c = await s.createConversation(OFFICIAL_USER, null)
  await s.appendConversation(OFFICIAL_USER, null, c.id, [{ role: 'user', content: 'hi' }])

  const mine = await s.listConversations(OFFICIAL_USER, null)
  eq(mine.length, 1, '按用户列对话仍正确（前缀匹配不受冒号影响）')

  const convs = await s.listAllConversations()
  eq(convs.length, 1, '全局列表找到 1 条')
  eq(convs[0].scopeUserId, OFFICIAL_USER, '全局列表保留完整官方 userId（S6 元数据修复）')
  eq(convs[0].scopeGroupId, '', '私聊 scopeGroupId 为空')
}

console.log('\n[官方群 + 官方用户：listAllConversations]')
{
  const s = await freshStore()
  const c = await s.createConversation(OFFICIAL_USER, OFFICIAL_GROUP)
  await s.appendConversation(OFFICIAL_USER, OFFICIAL_GROUP, c.id, [{ role: 'user', content: 'hi' }])

  const mine = await s.listConversations(OFFICIAL_USER, OFFICIAL_GROUP)
  eq(mine.length, 1, '按用户+群列对话正确')

  const convs = await s.listAllConversations()
  eq(convs.length, 1, '全局列表找到 1 条')
  eq(convs[0].scopeUserId, OFFICIAL_USER, '官方群会话保留完整 userId')
  eq(convs[0].scopeGroupId, OFFICIAL_GROUP, '官方群会话保留完整 groupId')
}

console.log('\n[官方 ID：listAll 旧式 group:user 会话]')
{
  const s = await freshStore()
  await s.append(s.key(OFFICIAL_GROUP, OFFICIAL_USER), [{ role: 'user', content: 'hi' }])
  const all = await s.listAll()
  eq(all.length, 1, 'listAll 找到 1 条')
  knownBug(
    all[0].user !== OFFICIAL_USER || all[0].group !== OFFICIAL_GROUP,
    'listAll 用 split 前两段解析，官方 ID 被截断',
    'group/user 应等于完整官方 ID',
  )
}

console.log('\n[官方 ID：legacy shared 键回归]')
{
  const s = await freshStore()
  // 旧共享键（v1.26.30 前）没有群号后缀；group ID 含冒号时按前缀扫描仍应命中
  const oldKey = `Yz:agent:sess:conv:${OFFICIAL_GROUP}:__group__:${1}`
  await s.kv.set(oldKey, { id: '1', title: 'old', messages: [{ role: 'user', content: 'hi' }], createdAt: 1, updatedAt: 1 })
  const list = await s.listConversations(`__group__:${OFFICIAL_GROUP}`, OFFICIAL_GROUP)
  eq(list.length, 1, '旧共享键仍能列出（前缀不受 group 冒号影响）')
}

console.log(`\n========================================`)
console.log(`通过 ${passed}，失败 ${failed}`)
console.log(`========================================`)
if (failed > 0) process.exitCode = 1
