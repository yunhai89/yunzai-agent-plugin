/**
 * 契约（PR0 / KNOWN-BUG）：官方 QQ ID 含 `:` 时，`#清空所有记录` 找不到自己的会话。
 *
 * 现状（commit 9323c5d）：apps/agent.js clearMyData 用 split(':') 后固定下标取 keyUid：
 *   conv:<gid>:<uid>:<convId> → 官方 uid=`<self_id>:<openid>` 时只取到 `<self_id>`，与完整 uid 不等，
 *   因此扫描到的会话/活跃指针不会被删除。recall/profile 等按完整 uid 清理，不受影响。
 *
 * 本测试只记录行为，不修复。修复（04 §身份）后本测试会失败，届时把 KNOWN-BUG 改成“已清理”断言。
 *
 * 运行：node --import ./stress/e2e/hooks.mjs stress/e2e/official-id-clear.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), `e2e-official-clear-${process.pid}-`))
process.env.E2E_TMP = TMP
process.env.E2E_REAL_AGENT = '1'
await import(pathToFileURL(path.join(import.meta.dirname, 'hooks.mjs')).href)

const cfgMod = await import('./stubs/Config.js')
cfgMod.__setConfig({ agent: {
  apiKey: 'sk-offline-fixture', model: 'offline-fixture',
  compaction: { enable: true, archiveDir: path.join(TMP, 'archive') },
  devLog: { dir: path.join(TMP, 'devlog') },
  multiagent: { enable: false }, sandbox: { mode: 'off' },
  toolEvo: { enable: false }, sticker: { enable: false },
  tools: { builtin: false }, schedule: { taskEnabled: false },
  webApi: { enable: false }, skill: { dir: path.join(TMP, 'skills') },
  qqBot: { enable: false },
} })

let passed = 0
let failed = 0
const ok = (c, m) => { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }
const knownBug = (c, m) => { if (c) { passed++; console.log('  ✓ KNOWN-BUG', m) } else { failed++; console.error('  ✗ KNOWN-BUG 已变化（请更新契约）', m) } }

const { Chat, getRuntime } = await import('../../apps/agent.js')
const rt = await getRuntime()

const OFFICIAL_UID = '1903797111:807AC1596B40D96591A5ACBEB3CFFA4D'
const PLAIN_UID = '1234'

function makeChat(uid, replies) {
  const chat = new Chat({})
  chat.e = {
    user_id: uid, self_id: '1903797111', msg: '#清空所有记录', isGroup: false, group_id: null,
    message: [], sender: { user_id: uid, nickname: 'fixture' },
    reply: async (text) => { replies.push(String(text)); return { message_id: 'offline' } },
  }
  return chat
}

console.log('\n[控制组：普通 QQ 号清理成功]')
{
  const conv = await rt.session.createConversation(PLAIN_UID, null)
  await rt.session.appendConversation(PLAIN_UID, null, conv.id, [{ role: 'user', content: 'PLAIN_MARKER' }])
  const replies = []
  const chat = makeChat(PLAIN_UID, replies)
  await chat.clearMyData()
  await chat.clearMyData()
  ok(replies.at(-1).includes('已清空你的所有记录'), '普通用户清理命令报告成功')
  const after = await rt.session.listConversations(PLAIN_UID, null)
  ok(after.length === 0, '普通用户会话已清理')
}

console.log('\n[官方 ID：清理命令必须清掉自己的会话（S6 修复）]')
{
  const conv = await rt.session.createConversation(OFFICIAL_UID, null)
  await rt.session.appendConversation(OFFICIAL_UID, null, conv.id, [{ role: 'user', content: 'OFFICIAL_MARKER' }])
  const replies = []
  const chat = makeChat(OFFICIAL_UID, replies)
  await chat.clearMyData()
  await chat.clearMyData()
  ok(replies.at(-1).includes('已清空你的所有记录'), '官方用户清理命令同样报告成功（现状）')

  const after = await rt.session.listConversations(OFFICIAL_UID, null)
  ok(after.length === 0, '官方 ID 会话已清理')
  const raw = await rt.kv.get(rt.session.convKey(OFFICIAL_UID, null, conv.id))
  ok(!raw, '底层 KV 记录已删除')
}

console.log(`\n========================================`)
console.log(`通过 ${passed}，失败 ${failed}`)
console.log(`========================================`)
if (failed > 0) process.exitCode = 1
