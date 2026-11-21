/**
 * Tool hooks 契约（PR3b）：RBAC/审批决策 + TaskStore 守卫。
 *
 * 运行：node model/runtime/test/tool-hooks.test.mjs
 */
import { decideExecution, executeWithTaskStore, formatApprovalLine } from '../tool-hooks.js'
import { createPolicy } from '../../agent/policy.js'

let passed = 0
let failed = 0
function ok(c, m) {
  if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) }
}
function eq(a, b, m) {
  const same = JSON.stringify(a) === JSON.stringify(b)
  ok(same, `${m}${same ? '' : `  (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`}`)
}

const member = { userId: 'u1', scopeUserId: 'u1', groupId: 'g1', isGroup: true, role: 'member', isMaster: false }
const master = { ...member, userId: 'm1', scopeUserId: 'm1', role: 'master', isMaster: true }
const readTool = { name: 'web_search', category: 'query', meta: {} }
const writeTool = { name: 'save_note', category: 'system', meta: { alwaysConfirm: true } }

console.log('\n[decideExecution]')
{
  eq((await decideExecution({ tool: readTool, ctx: null })).decision, 'allow', 'read 无 ctx 允许')
  eq((await decideExecution({ tool: writeTool, ctx: null })).decision, 'confirm', 'alwaysConfirm 无 ctx 仍需确认')
  eq((await decideExecution({ tool: writeTool, ctx: master, masterSkipConfirm: true })).decision, 'allow', 'masterSkipConfirm 放行')
  eq((await decideExecution({ tool: writeTool, ctx: master, masterSkipConfirm: true })).autoApproved, true, '标记 autoApproved')

  const policy = createPolicy()
  const systemNoConfirm = { name: 'sys', category: 'system', meta: {} }
  eq((await decideExecution({ tool: systemNoConfirm, ctx: member, policy })).decision, 'deny', 'policy 拒绝')
  eq((await decideExecution({ tool: systemNoConfirm, ctx: master, policy })).decision, 'allow', 'master policy allow')
  const msgTool = { name: 'msg', category: 'message', meta: {} }
  eq((await decideExecution({ tool: msgTool, ctx: member, policy })).decision, 'deny', 'member message deny')
  const admin = { ...member, role: 'admin' }
  eq((await decideExecution({ tool: msgTool, ctx: admin, policy })).decision, 'confirm', 'admin message confirm')

  const veto = { name: 'allowlist', category: 'system', meta: { alwaysConfirm: true, shouldConfirm: async () => false } }
  eq((await decideExecution({ tool: veto, ctx: member })).decision, 'allow', 'shouldConfirm=false 免审')
  const force = { name: 'force', category: 'system', meta: { alwaysConfirm: true, shouldConfirm: async () => true } }
  eq((await decideExecution({ tool: force, ctx: master, masterSkipConfirm: true })).decision, 'allow', 'master 仍可跳过')
}

class FakeTaskStore {
  constructor({ exists = true, failPlanned = false, failStarted = false, failResult = false, steps = [] } = {}) {
    this.exists = exists
    this.failPlanned = failPlanned
    this.failStarted = failStarted
    this.failResult = failResult
    this.steps = steps
    this.events = []
  }
  async getCheckpoint() {
    if (!this.exists) return { ok: false, code: 'not_found' }
    return { ok: true, steps: this.steps }
  }
  async event(e) {
    if (!this.exists) return { ok: false, code: 'not_found' }
    if (e.kind === 'tool_planned' && this.failPlanned) throw new Error('db down')
    if (e.kind === 'tool_started' && this.failStarted) return { ok: false, code: 'db_down' }
    if (e.kind === 'tool_result' && this.failResult) throw new Error('result write down')
    this.events.push(e)
    return { ok: true, inserted: true }
  }
}

console.log('\n[TaskStore：正常读写]')
{
  const ts = new FakeTaskStore()
  let calls = 0
  const r = await executeWithTaskStore({
    taskStore: ts, taskId: 't1', callId: 'c1', ctx: member, tool: readTool, args: { q: 'x' },
    effect: 'read', replay: 'safe', execute: async () => { calls++; return { ok: true } },
  })
  eq(r.value, { ok: true }, '返回结果')
  eq(r.journaled, true, '已记账')
  eq(calls, 1, '执行一次')
  eq(ts.events.map((e) => e.kind), ['tool_planned', 'tool_started', 'tool_result'], '事件顺序')
  eq(ts.events[0].payload.argsHash != null, true, 'planned 带 argsHash')
  eq(ts.events[2].payload.effectState, 'none', 'read effectState=none')

  const ts2 = new FakeTaskStore()
  let writeCalls = 0
  await executeWithTaskStore({
    taskStore: ts2, taskId: 't1', callId: 'w1', ctx: member, tool: writeTool, args: { text: 'x' },
    effect: 'write', replay: 'never', execute: async () => { writeCalls++; return { ok: true } },
  })
  eq(writeCalls, 1, '写执行一次')
  eq(ts2.events[2].payload.effectState, 'applied', 'write applied')
  eq(ts2.events[0].payload.args, undefined, '写工具不落完整 args')
}

console.log('\n[TaskStore：防重放 / effect_unknown]')
{
  const ts = new FakeTaskStore({ steps: [{ callId: 'w1', ok: true, effectState: 'applied', resultPreview: '{"ok":true}' }] })
  let calls = 0
  const r = await executeWithTaskStore({
    taskStore: ts, taskId: 't1', callId: 'w1', ctx: member, tool: writeTool, args: {},
    effect: 'write', replay: 'never', execute: async () => { calls++; return { ok: true } },
  })
  eq(calls, 0, '已 applied 的写不重放')
  eq([r.code, r.reused], ['duplicate_suppressed', true], 'duplicate_suppressed')

  const ts2 = new FakeTaskStore({ steps: [{ callId: 'w2', ok: null, effectState: null }] })
  let calls2 = 0
  const r2 = await executeWithTaskStore({
    taskStore: ts2, taskId: 't1', callId: 'w2', ctx: member, tool: writeTool, args: {},
    effect: 'write', replay: 'never', execute: async () => { calls2++; return { ok: true } },
  })
  eq(calls2, 0, 'started 无 result 的写不重放')
  eq(r2.code, 'effect_unknown', 'effect_unknown')

  const ts3 = new FakeTaskStore({ steps: [{ callId: 'r1', ok: true, effectState: 'none' }] })
  let calls3 = 0
  await executeWithTaskStore({
    taskStore: ts3, taskId: 't1', callId: 'r1', ctx: member, tool: readTool, args: {},
    effect: 'read', replay: 'safe', execute: async () => { calls3++; return { ok: true } },
  })
  eq(calls3, 1, '只读可安全重放')
}

console.log('\n[TaskStore：fail-closed]')
{
  const ts = new FakeTaskStore({ failPlanned: true })
  let calls = 0
  let e = null
  try {
    await executeWithTaskStore({ taskStore: ts, taskId: 't1', callId: 'c', ctx: member, tool: writeTool, args: {}, effect: 'write', execute: async () => { calls++; } })
  } catch (err) { e = err }
  eq(e?.code, 'journal_unavailable', 'planned 失败 → journal_unavailable')
  eq(calls, 0, '未执行')

  const ts2 = new FakeTaskStore({ failStarted: true })
  let e2 = null
  try {
    await executeWithTaskStore({ taskStore: ts2, taskId: 't1', callId: 'c', ctx: member, tool: writeTool, args: {}, effect: 'write', execute: async () => { calls++; } })
  } catch (err) { e2 = err }
  eq(e2?.code, 'journal_unavailable', 'started 失败 → journal_unavailable')
  eq(calls, 0, '未执行')

  const ts3 = new FakeTaskStore({ failResult: true })
  const r = await executeWithTaskStore({ taskStore: ts3, taskId: 't1', callId: 'c', ctx: member, tool: writeTool, args: {}, effect: 'write', execute: async () => ({ ok: true }) })
  eq(r.value, { ok: true }, 'result 写失败不影响返回值')
}

console.log('\n[无 taskStore / not_found：直接执行]')
{
  let calls = 0
  const r = await executeWithTaskStore({ execute: async () => { calls++; return 'x' } })
  eq([r.value, r.journaled, calls], ['x', false, 1], '无账本直接执行')
  const ts = new FakeTaskStore({ exists: false })
  const r2 = await executeWithTaskStore({ taskStore: ts, taskId: 't', callId: 'c', ctx: member, execute: async () => 'y' })
  eq([r2.value, r2.journaled], ['y', false], '任务不存在不记孤账')
}

console.log('\n[approval line]')
{
  const line = formatApprovalLine({ id: '10001', toolName: 'save_note', argsPreview: 'x', expiresAt: Date.now() + 1000, ctx: { userId: 'u1', groupId: 'g1' } })
  ok(line.includes('10001') && line.includes('save_note') && line.includes('u1'), '包含 id/工具/申请人')
}

console.log(`\n========================================`)
console.log(`通过 ${passed}，失败 ${failed}`)
console.log(`========================================`)
if (failed > 0) process.exitCode = 1
