/**
 * 写工具 Adapter 契约（PR3b）：requireApproval / beforeApproval / 审批复核 / TaskStore。
 *
 * 运行：node model/runtime/test/tool-adapter-write.test.mjs
 */
import { RequestContext } from '@mastra/core/request-context'
import { ToolRegistry } from '../../agent/tools/registry.js'
import { createPolicy } from '../../agent/policy.js'
import { memoryKv } from '../../agent/store/kv.js'
import { ApprovalBridge, hashArgs } from '../approval-bridge.js'
import { adaptTool, adaptReadonlyTools } from '../tool-adapter.js'
import { ToolNameMap } from '../tool-name.js'

let passed = 0
let failed = 0
function ok(c, m) {
  if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) }
}
function eq(a, b, m) {
  const same = JSON.stringify(a) === JSON.stringify(b)
  ok(same, `${m}${same ? '' : `  (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`}`)
}

const state = { calls: 0 }
const writeTool = {
  name: 'save_note',
  description: '写笔记',
  category: 'system',
  meta: { alwaysConfirm: true, effect: 'write', replay: 'never' },
  parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
  async execute(p) { state.calls++; return { ok: true, text: p.text } },
}
const registry = new ToolRegistry().register(writeTool)
const tool = registry.get('save_note')

class FakeTaskStore {
  constructor() { this.steps = []; this.events = [] }
  async getCheckpoint() { return { ok: true, steps: this.steps } }
  async event(e) {
    this.events.push(e)
    if (e.kind === 'tool_result') {
      const cur = this.steps.find((s) => s.callId === e.callId)
      if (cur) { cur.ok = e.payload.ok; cur.effectState = e.payload.effectState }
      else this.steps.push({ callId: e.callId, ok: e.payload.ok, effectState: e.payload.effectState })
    }
    return { ok: true, inserted: true }
  }
}

const kv = memoryKv()
const notices = []
const approval = new ApprovalBridge({ kv, timeoutMs: 60_000, notify: (id, rec) => notices.push({ id, rec }) })
const taskStore = new FakeTaskStore()
const policy = createPolicy()
const auto = []
const adapted = adaptTool(tool, {
  names: new ToolNameMap(), allowWrite: true, policy, approval, taskStore,
  onMasterAutoApprove: (tc) => auto.push(tc),
})

function rctx({ runId = 'run-1', callId = 'call-1', taskId = 'task-1', ctx } = {}) {
  const rc = new RequestContext()
  rc.set('yz.ctx', ctx)
  rc.set('yz.runId', runId)
  rc.set('yz.taskId', taskId)
  rc.set('yz.toolCallId', callId)
  return { requestContext: rc, toolCallId: callId }
}

const member = { userId: 'u1', scopeUserId: 'u1', groupId: 'g1', isGroup: true, role: 'member', isMaster: false }
const master = { ...member, userId: 'm1', scopeUserId: 'm1', role: 'master', isMaster: true }

console.log('\n[requireApproval]')
{
  eq(await adapted.mastraTool.requireApproval({ text: 'a' }, { requestContext: { 'yz.ctx': member } }), true, 'member + alwaysConfirm 需审批')
  eq(await adapted.mastraTool.requireApproval({ text: 'a' }, { requestContext: { 'yz.ctx': master } }), true, 'master 未开 masterSkipConfirm 仍需审批')
  const bypass = adaptTool(tool, { names: new ToolNameMap(), allowWrite: true, policy, approval, taskStore, masterSkipConfirm: true, onMasterAutoApprove: (x) => auto.push(x) })
  eq(await bypass.mastraTool.requireApproval({ text: 'a' }, { requestContext: { 'yz.ctx': master } }), false, 'masterSkipConfirm 免审')
  eq(auto.length, 1, 'onMasterAutoApprove 调用')
}

console.log('\n[beforeApproval：policy 拒绝 / 无上下文]')
{
  const deny = await adapted.mastraTool.beforeApproval({ text: 'a' }, { requestContext: { 'yz.ctx': member }, toolCallId: 'c' })
  eq([deny.proceed, deny.output.error], [false, 'rejected_by_policy'], 'member 写工具 policy 拒绝')

  const noRun = await adapted.mastraTool.beforeApproval({ text: 'a' }, { requestContext: { 'yz.ctx': master }, toolCallId: 'c' })
  eq([noRun.proceed, noRun.output.error], [false, 'rejected_by_confirm'], '无 runId fail-closed')
}

console.log('\n[beforeApproval：创建 pending，不重复]')
{
  const ctx = rctx({ ctx: master })
  const r1 = await adapted.mastraTool.beforeApproval({ text: 'a' }, ctx)
  eq(r1, undefined, 'confirm → suspend')
  const r2 = await adapted.mastraTool.beforeApproval({ text: 'a' }, ctx)
  eq(r2, undefined, '重复调用仍 suspend')
  eq(notices.length, 1, '只创建一条审批')
  const rec = await approval.getForCall('run-1', 'call-1')
  eq(rec?.status, 'pending', 'pending 已落库')
  eq(rec.argsHash, hashArgs({ text: 'a' }), 'argsHash')
}

console.log('\n[execute：未批准 fail-closed]')
{
  state.calls = 0
  const out = await adapted.mastraTool.execute({ text: 'a' }, rctx({ ctx: master }))
  eq(state.calls, 0, '未批准不执行')
  ok(String(out).includes('rejected_by_confirm'), '返回 rejected_by_confirm')
}

console.log('\n[批准后执行一次 / 防重放]')
{
  const rec = await approval.getForCall('run-1', 'call-1')
  await approval.approve(rec.id, { actor: 'master', argsHash: hashArgs({ text: 'a' }) })
  state.calls = 0
  const out = await adapted.mastraTool.execute({ text: 'a' }, rctx({ ctx: master }))
  eq(state.calls, 1, '批准后执行一次')
  ok(String(out).includes('"ok":true'), '返回工具结果')
  eq(taskStore.events.map((e) => e.kind).slice(-3), ['tool_planned', 'tool_started', 'tool_result'], '写工具记账')

  const out2 = await adapted.mastraTool.execute({ text: 'a' }, rctx({ ctx: master }))
  eq(state.calls, 1, '同 callId 不再执行')
  ok(String(out2).includes('duplicate_suppressed') || String(out2).includes('duplicate'), 'duplicate_suppressed')
}

console.log('\n[审批后参数变化拒绝]')
{
  const ctx = rctx({ runId: 'run-2', callId: 'call-2', ctx: master })
  await adapted.mastraTool.beforeApproval({ text: 'old' }, ctx)
  const rec = await approval.getForCall('run-2', 'call-2')
  await approval.approve(rec.id, { actor: 'master', argsHash: hashArgs({ text: 'old' }) })
  state.calls = 0
  const out = await adapted.mastraTool.execute({ text: 'new' }, ctx)
  eq(state.calls, 0, '参数变化不执行')
  ok(String(out).includes('参数已变化') || String(out).includes('rejected_by_confirm'), 'args mismatch 拒绝')
}

console.log('\n[只读集合仍拒绝写工具]')
{
  const set = adaptReadonlyTools(registry)
  eq(Object.keys(set.tools).length, 0, '写工具不进入只读集合')
  eq(set.skipped[0]?.code, 'tool_not_readonly', '记录 tool_not_readonly')
}

approval.close()

console.log(`\n========================================`)
console.log(`通过 ${passed}，失败 ${failed}`)
console.log(`========================================`)
if (failed > 0) process.exitCode = 1
