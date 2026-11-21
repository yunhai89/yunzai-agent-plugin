/**
 * ApprovalBridge 契约（PR3b）。
 *
 * 运行：node model/runtime/test/approval-bridge.test.mjs
 */
import { memoryKv } from '../../agent/store/kv.js'
import { ApprovalBridge, hashArgs, stableJson } from '../approval-bridge.js'

let passed = 0
let failed = 0
function ok(c, m) {
  if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) }
}
function eq(a, b, m) {
  const same = JSON.stringify(a) === JSON.stringify(b)
  ok(same, `${m}${same ? '' : `  (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`}`)
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

console.log('\n[创建 / 短 id / 脱敏]')
const kv = memoryKv()
const resolved = []
const expired = []
const noticed = []
const bridge = new ApprovalBridge({
  kv, timeoutMs: 5000,
  notify: (id, rec) => noticed.push({ id, rec }),
  onResolve: (rec) => resolved.push(rec),
  onExpire: (rec) => expired.push(rec),
})
{
  const rec = await bridge.create({
    runId: 'run-1', toolCallId: 'call-1', toolName: 'save_note',
    args: { text: 'secret content' }, ctx: { userId: 'u1', groupId: 'g1' }, scopeKey: 'g1:u1:1',
  })
  ok(/^\d{5}$/.test(rec.id) && !rec.id.startsWith('0'), `5 位短 id（${rec.id}）`)
  eq(rec.status, 'pending', '初始 pending')
  eq(rec.argsHash, hashArgs({ text: 'secret content' }), 'argsHash')
  ok(String(rec.argsPreview).includes('secret content'), 'argsPreview 供审批展示')
  eq(rec.args, undefined, '不落完整 args')
  eq(noticed.length, 1, 'notify 调用')
  eq((await bridge.pendingCount('g1:u1:1')), 1, 'pendingCount')
  eq((await bridge.list({ status: 'pending' })).length, 1, 'list pending')
}

console.log('\n[批准 / 拒绝 / CAS]')
{
  const rec = await bridge.list({ status: 'pending' })
  const id = rec[0].id
  const r1 = await bridge.approve(id, { actor: 'master', argsHash: hashArgs({ text: 'secret content' }) })
  eq([r1.ok, r1.record.status, r1.record.decision], [true, 'approved', true], '批准成功')
  const r2 = await bridge.approve(id, { actor: 'master' })
  eq([r2.ok, r2.code], [false, 'not_pending'], '重复批准 not_pending')
  eq(resolved.length, 1, 'onResolve 一次')

  const r3 = await bridge.create({ runId: 'run-1', toolCallId: 'call-2', toolName: 't', args: { a: 1 }, ctx: { userId: 'u1' } })
  const bad = await bridge.approve(r3.id, { argsHash: 'deadbeef' })
  eq([bad.ok, bad.code, (await bridge.get(r3.id)).status], [false, 'args_mismatch', 'pending'], 'argsHash 不符拒绝且保持 pending')
  const deny = await bridge.deny(r3.id, { actor: 'master', reason: 'no' })
  eq([deny.ok, deny.record.status, deny.record.decision], [true, 'denied', false], '拒绝成功')
}

console.log('\n[取消 / 按 run 取消]')
{
  const a = await bridge.create({ runId: 'run-2', toolCallId: 'c1', toolName: 't', args: {}, ctx: { userId: 'u' } })
  const b = await bridge.create({ runId: 'run-2', toolCallId: 'c2', toolName: 't', args: {}, ctx: { userId: 'u' } })
  const c = await bridge.cancel(a.id, 'user_cancelled')
  eq([c.ok, c.record.status], [true, 'cancelled'], '单个取消')
  const n = await bridge.cancelRun('run-2', 'run_cancelled')
  eq(n, 1, '按 run 取消剩余 1 条')
  eq((await bridge.get(b.id)).status, 'cancelled', 'run 取消状态')
}

console.log('\n[超时]')
{
  const b = new ApprovalBridge({ kv: memoryKv(), timeoutMs: 10, onExpire: (r) => expired.push(r) })
  const rec = await b.create({ runId: 'r', toolCallId: 'c', toolName: 't', args: {}, ctx: {} })
  await wait(35)
  const got = await b.get(rec.id)
  eq(got.status, 'expired', '超时 → expired')
  ok(expired.some((x) => x.id === rec.id), 'onExpire 调用')
  eq((await b.approve(rec.id)).code, 'not_pending', '超时后不能批准')
  b.close()
}

console.log('\n[重启恢复]')
{
  const kv2 = memoryKv()
  const b1 = new ApprovalBridge({ kv: kv2, timeoutMs: 60_000 })
  const rec = await b1.create({ runId: 'run-r', toolCallId: 'call-r', toolName: 't', args: { x: 1 }, ctx: { userId: 'u' }, scopeKey: 's' })
  b1.close()
  const b2 = new ApprovalBridge({ kv: kv2, timeoutMs: 60_000 })
  eq(await b2.restore(), 1, '恢复 1 条 pending')
  const pending = await b2.list({ status: 'pending' })
  eq(pending[0].id, rec.id, 'id 一致')
  eq((await b2.approve(rec.id, { argsHash: hashArgs({ x: 1 }) })).ok, true, '恢复后可批准')
  eq(await b2.restore(), 0, '已结算不再恢复')
  b2.close()
}

console.log('\n[并发 CAS：只成功一次]')
{
  const b = new ApprovalBridge({ kv: memoryKv(), timeoutMs: 60_000 })
  const rec = await b.create({ runId: 'r', toolCallId: 'c', toolName: 't', args: {}, ctx: {} })
  const results = await Promise.all([b.approve(rec.id), b.deny(rec.id)])
  eq(results.filter((r) => r.ok).length, 1, '并发只成功一次')
  eq((await b.get(rec.id)).status, 'approved', '首个结算生效')
  b.close()
}

console.log('\n[stableJson / hashArgs]')
{
  eq(stableJson({ b: 2, a: 1 }), stableJson({ a: 1, b: 2 }), '键序稳定')
  ok(hashArgs({ a: 1 }) !== hashArgs({ a: 2 }), '不同参数不同 hash')
}

bridge.close()

console.log(`\n========================================`)
console.log(`通过 ${passed}，失败 ${failed}`)
console.log(`========================================`)
if (failed > 0) process.exitCode = 1
