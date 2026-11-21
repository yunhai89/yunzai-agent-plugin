/**
 * S7 / Memory Phase 2：迁移脚本核心契约。
 *
 * 运行：node model/runtime/test/memory-migrate.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Memory } from '@mastra/memory'
import { createStorage } from '../storage-factory.js'
import { MastraMemoryBridge } from '../memory-bridge.js'
import {
  planMigration, applyMigration, verifyMigration, rollbackMigration,
  stableMessageId, readCheckpoint,
} from '../memory-migrate.js'
import { CompactionArchive } from '../../agent/compact/archive.js'

let passed = 0
let failed = 0
const ok = (c, m) => { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }
const eq = (a, b, m) => { const s = JSON.stringify(a) === JSON.stringify(b); ok(s, `${m}${s ? '' : `（实际 ${JSON.stringify(a)}）`}`) }

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'yz-memory-migrate-'))
const archive = new CompactionArchive({ dir: path.join(TMP, 'archive') })

async function makeBridge() {
  const storage = await createStorage({ driver: 'libsql', libsqlUrl: ':memory:' })
  const memory = new Memory({
    storage: storage.store, vector: false,
    options: { lastMessages: false, semanticRecall: false, workingMemory: { enabled: false } },
  })
  const bridge = new MastraMemoryBridge({ memory, storage: storage.store, kv: { async get() { return null }, async set() {}, async del() {}, async scan() { return [] } }, botId: '123' })
  return { storage, bridge }
}

function sourceConversation(extra = {}) {
  return {
    scopeUserId: 'u1', scopeGroupId: 'g1', conversationId: '1', title: '迁移', createdAt: 1000, updatedAt: 2000,
    cacheEpoch: 2,
    compactLedger: { v: 2, facts: [{ text: 'f1', at: 1 }], archive_refs: [] },
    messages: [
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '', reasoning: '思考', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'weather', arguments: '{"city":"北京"}' } }] },
      { role: 'tool', tool_call_id: 'c1', name: 'weather', content: '{"temp":22}' },
      { role: 'assistant', content: '晴 22' },
    ],
    ...extra,
  }
}

console.log('\n[dry-run：官方 ID / 工具 / ledger / archive ref]')
{
  const officialUser = '1903797111:807AC1596B40D96591A5ACBEB3CFFA4D'
  const officialGroup = '1903797111:8A2B3C4D5E6F708192A3B4C5D6E7F809'
  const convKey = `${officialUser}:${officialGroup}:1`
  const saved = archive.save({ convKey, epoch: 3, messages: [{ role: 'user', content: 'old' }] })
  const plan = planMigration({
    input: { conversations: [sourceConversation({
      scopeUserId: officialUser, scopeGroupId: officialGroup,
      compactLedger: { v: 2, facts: [{ text: 'f1' }], archive_refs: [{ ref: saved.ref, hash: saved.hash, msgs: 1 }] },
      cacheEpoch: 3,
    })] },
    botId: '1903797111', adapter: 'qqbot', archive,
  })
  eq(plan.ok, true, 'dry-run 0 error')
  eq(plan.stats.messages, 4, '4 条消息')
  eq(plan.threads[0].resourceId.startsWith('yz_qqbot_1903797111_'), true, 'identity 含 bot')
  ok(!plan.threads[0].threadId.includes(':'), 'threadId 无冒号')
  ok(plan.threads[0].threadId.length <= 128, 'threadId ≤128')
}

console.log('\n[dry-run：损坏数据 / 归档缺失]')
{
  const bad = planMigration({
    input: { conversations: [
      { scopeUserId: 'u1', conversationId: '1', messages: [{ role: 'tool', tool_call_id: 'none', name: 'x', content: 'y' }] },
      { scopeUserId: 'u1', conversationId: '2', messages: [{ role: 'user', content: 123 }] },
      { scopeUserId: 'u1', conversationId: '3', messages: [], compactLedger: { archive_refs: [{ ref: '9-deadbeef.json' }] } },
    ] },
    botId: '123', adapter: 'onebot', archive,
  })
  ok(!bad.ok, '损坏数据被拒绝')
  ok(bad.errors.some((e) => /孤立 tool/.test(e.message)), '孤立 tool 报错')
  ok(bad.errors.some((e) => /content/.test(e.message)), '非法 content 报错')
  ok(bad.errors.some((e) => /archive_ref/.test(e.message)), '归档缺失报错')
}

console.log('\n[apply + verify + 幂等 + rollback]')
{
  const { storage, bridge } = await makeBridge()
  const plan = planMigration({ input: { conversations: [sourceConversation()] }, botId: '123', adapter: 'onebot', archive })
  eq(plan.ok, true, 'plan ok')
  const cp = path.join(TMP, 'checkpoint.json')
  const r1 = await applyMigration({ plan, bridge, checkpointFile: cp, backupDir: path.join(TMP, 'backup') })
  eq([r1.ok, r1.applied, r1.skipped], [true, 1, 0], '首次 apply')
  ok(fs.existsSync(path.join(TMP, 'backup', 'migration-source.json')), '源备份已写')
  const cp1 = readCheckpoint(cp)
  eq(cp1.threads[plan.threads[0].threadId].status, 'done', 'checkpoint done')
  eq(cp1.threads[plan.threads[0].threadId].createdThread, true, '记录 createdThread')

  const v1 = await verifyMigration({ plan, bridge, archive })
  eq([v1.ok, v1.checkedThreads, v1.checkedMessages], [true, 1, 4], 'verify 全量通过')

  const r2 = await applyMigration({ plan, bridge, checkpointFile: cp })
  eq([r2.ok, r2.applied, r2.skipped], [true, 0, 1], '重复 apply 幂等跳过')
  eq((await bridge.getConversation('u1', 'g1', '1')).length, 4, '重复 apply 不重复消息')

  const rb = await rollbackMigration({ checkpointFile: cp, bridge })
  eq([rb.ok, rb.deletedThreads], [true, 1], 'rollback 删除 thread')
  eq(await bridge.getThreadRaw(plan.threads[0].threadId), null, 'thread 已删除')
  await storage.close()
}

console.log('\n[冲突：目标已有非空 thread]')
{
  const { storage, bridge } = await makeBridge()
  const plan = planMigration({ input: { conversations: [sourceConversation()] }, botId: '123', adapter: 'onebot', archive })
  const t = plan.threads[0]
  await bridge.ensureThreadForMigration({ userId: t.scopeUserId, groupId: t.scopeGroupId, conversationId: t.conversationId, title: '已有', createdAt: t.createdAt })
  await bridge.appendConversation(t.scopeUserId, t.scopeGroupId, t.conversationId, [{ role: 'user', content: 'PRE' }])
  const r = await applyMigration({ plan, bridge, checkpointFile: path.join(TMP, 'conflict.json') })
  eq(r.ok, false, '拒绝覆盖')
  ok(r.errors.some((e) => /拒绝覆盖/.test(e.message)), '给出冲突原因')
  eq((await bridge.getConversation(t.scopeUserId, t.scopeGroupId, t.conversationId))[0].content, 'PRE', '原消息未丢')
  await storage.close()
}

console.log('\n[隔离：多 scope / bot]')
{
  const { storage, bridge } = await makeBridge()
  const plan = planMigration({
    input: { conversations: [
      sourceConversation({ scopeUserId: 'u1', scopeGroupId: 'g1', conversationId: '1' }),
      sourceConversation({ scopeUserId: 'u2', scopeGroupId: 'g1', conversationId: '1', messages: [{ role: 'user', content: 'U2' }] }),
      sourceConversation({ scopeUserId: 'u1', scopeGroupId: 'g2', conversationId: '1', messages: [{ role: 'user', content: 'G2' }] }),
    ] },
    botId: '123', adapter: 'onebot', archive,
  })
  eq(plan.stats.threads, 3, '3 个 thread')
  const cp = path.join(TMP, 'iso.json')
  const r = await applyMigration({ plan, bridge, checkpointFile: cp })
  eq(r.ok, true, 'apply 成功')
  eq((await bridge.getConversation('u1', 'g1', '1')).length, 4, 'u1/g1')
  eq((await bridge.getConversation('u2', 'g1', '1'))[0].content, 'U2', 'u2/g1')
  eq((await bridge.getConversation('u1', 'g2', '1'))[0].content, 'G2', 'u1/g2')
  await storage.close()
}

console.log('\n[稳定 id]')
{
  const a = stableMessageId('thread', 0, { role: 'user', content: 'x' })
  const b = stableMessageId('thread', 0, { role: 'user', content: 'x' })
  const c = stableMessageId('thread', 1, { role: 'user', content: 'x' })
  ok(a === b, '同输入同 id')
  ok(a !== c, 'seq 不同 id 不同')
}

fs.rmSync(TMP, { recursive: true, force: true })
console.log(`\n========================================`)
console.log(`通过 ${passed}，失败 ${failed}`)
console.log(`========================================`)
if (failed > 0) process.exitCode = 1
