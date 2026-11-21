/**
 * Agent 结果/审批契约 —— PR0 基线。
 *
 * 锁定现有稳定契约（迁移后必须保持）：
 *   - Agent.run 结果字段与「content = 持久化历史末条 assistant」；
 *   - 需审批但未注入 ConfirmStore → fail-closed（rejected_by_confirm）；
 *   - policy 拒绝 → rejected_by_policy，工具不执行；
 *   - 审批通过 → 写工具只执行一次；
 *   - ConfirmStore 超时/拒绝/取消/迟到批准语义。
 *
 * 另记录两个 KNOWN-BUG（不修复，只标记）：
 *   - ConfirmStore 纯内存，进程重启后 pending 丢失；
 *   - 工具名可含中文/点号/超长（Mastra 侧会 sanitize，见 tool-name.test.mjs）。
 *
 * 运行：node model/runtime/test/contracts/agent-result.test.mjs
 */
import { Agent } from '../../../agent/Agent.js'
import { ToolRegistry } from '../../../agent/tools/registry.js'
import { createPolicy } from '../../../agent/policy.js'
import { ConfirmStore } from '../../../agent/confirm.js'

let passed = 0
let failed = 0
function ok(c, m) {
  if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) }
}
function eq(a, b, m) {
  const same = JSON.stringify(a) === JSON.stringify(b)
  ok(same, `${m}${same ? '' : `  (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`}`)
}
function knownBug(c, m) {
  if (c) { passed++; console.log('  ✓ KNOWN-BUG', m) } else { failed++; console.error('  ✗ KNOWN-BUG 已变化（请更新契约）', m) }
}

function provider(steps) {
  const list = steps.length ? steps : [{ text: '' }]
  let i = 0
  return {
    async chat() {
      const s = list[Math.min(i, list.length - 1)]
      i += 1
      return {
        role: 'assistant',
        content: s.text ?? '',
        toolCalls: s.toolCalls || [],
        reasoning: null,
        finishReason: s.finishReason || (s.toolCalls?.length ? 'tool_calls' : 'stop'),
        usage: s.usage || null,
        rawMessage: {},
      }
    },
  }
}

const CTX = { userId: 'u1', scopeUserId: 'u1', groupId: 'g1', isGroup: true, role: 'member', isMaster: false }

function writeTool(state) {
  return {
    name: 'save_note',
    description: '写操作',
    category: 'system',
    meta: {
      alwaysConfirm: true,
      effect: 'write',
      replay: 'never',
      idempotencyKey: 'text',
      resultCap: 500,
      concurrency: 'exclusive',
      requires: ['text'],
      interactive: false,
      groupAdminSkip: false,
      polling: false,
      mcp: false,
      shell: false,
      shouldConfirm: undefined,
    },
    parameters: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
      additionalProperties: false,
    },
    async execute(p) {
      state.executed += 1
      return { ok: true, text: p.text }
    },
  }
}

console.log('\n[Agent.run 结果字段]')
{
  const agent = new Agent({
    provider: provider([{ text: '最终回复', usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }]),
    tools: new ToolRegistry(),
    reflect: 'off',
    logger: () => {},
  })
  const res = await agent.run('hi')
  eq(Object.keys(res).sort(), ['content', 'messages', 'stopReason', 'taskId', 'turns', 'usage'], '结果字段集合稳定')
  eq(res.content, '最终回复', 'content 为最终回复')
  eq(res.stopReason, 'stop', 'stopReason=stop')
  eq(res.turns, 1, 'turns=1')
  const lastAssistant = [...res.messages].reverse().find((m) => m.role === 'assistant')
  eq(res.content, lastAssistant?.content, 'content 等于持久化历史末条 assistant')
  ok(typeof res.taskId === 'string' && res.taskId.length > 0, 'taskId 非空')
  eq(res.usage?.total, 15, 'usage 已归一')
}

console.log('\n[审批：无 ConfirmStore fail-closed]')
{
  const state = { executed: 0 }
  const agent = new Agent({
    provider: provider([
      { toolCalls: [{ id: 'c1', name: 'save_note', arguments: { text: 'x' } }] },
      { text: '未执行。' },
    ]),
    tools: new ToolRegistry().register(writeTool(state)),
    reflect: 'off',
    policy: createPolicy(),
    confirm: null,
    logger: () => {},
  })
  const res = await agent.run('save', { ctx: { ...CTX, isMaster: true, role: 'master' } })
  eq(state.executed, 0, '无审批器时工具不执行')
  const toolMsg = res.messages.find((m) => m.role === 'tool')
  eq(JSON.parse(toolMsg.content).error, 'rejected_by_confirm', '错误码 rejected_by_confirm')
}

console.log('\n[审批：policy 拒绝]')
{
  const state = { executed: 0 }
  const tool = writeTool(state)
  delete tool.meta.alwaysConfirm
  const agent = new Agent({
    provider: provider([
      { toolCalls: [{ id: 'c1', name: 'save_note', arguments: { text: 'x' } }] },
      { text: '被拒绝。' },
    ]),
    tools: new ToolRegistry().register(tool),
    reflect: 'off',
    policy: createPolicy(),
    confirm: { request: async () => true },
    logger: () => {},
  })
  const res = await agent.run('save', { ctx: { ...CTX } })
  eq(state.executed, 0, 'policy 拒绝时工具不执行')
  const toolMsg = res.messages.find((m) => m.role === 'tool')
  eq(JSON.parse(toolMsg.content).error, 'rejected_by_policy', '错误码 rejected_by_policy')
}

console.log('\n[审批：通过后只执行一次]')
{
  const state = { executed: 0 }
  const requests = []
  const agent = new Agent({
    provider: provider([
      { toolCalls: [{ id: 'c1', name: 'save_note', arguments: { text: 'x' } }] },
      { text: '已保存。' },
    ]),
    tools: new ToolRegistry().register(writeTool(state)),
    reflect: 'off',
    policy: createPolicy(),
    confirm: { request: async (req) => { requests.push(req); return true } },
    logger: () => {},
  })
  const res = await agent.run('save', { ctx: { ...CTX, isMaster: true, role: 'master' } })
  eq(state.executed, 1, '审批通过后只执行一次')
  eq(requests.length, 1, '只发起一次审批')
  eq(res.messages.find((m) => m.role === 'tool')?.name, 'save_note', '工具消息有配对名称')
}

console.log('\n[ConfirmStore：超时/拒绝/取消/迟到]')
{
  const store = new ConfirmStore({ timeout: 15 })
  const started = Date.now()
  const v = await store.request({ tool: 't', args: {}, ctx: {} })
  eq(v, false, '超时自动拒绝')
  ok(Date.now() - started >= 10, '确实等待到超时')
  eq(store.list().length, 0, '超时后 pending 清空')

  const store2 = new ConfirmStore({ timeout: 5000 })
  let id = null
  const p = store2.request({ tool: 't', args: {}, ctx: {}, notify: (x) => { id = x } })
  eq(store2.resolve(id, false), true, '拒绝命中 pending')
  eq(await p, false, '拒绝返回 false')
  eq(store2.resolve(id, true), false, '重复/迟到批准无效')

  const store3 = new ConfirmStore({ timeout: 5000 })
  let id3 = null
  const ctrl = new AbortController()
  const p3 = store3.request({ tool: 't', args: {}, ctx: {}, signal: ctrl.signal, notify: (x) => { id3 = x } })
  ctrl.abort()
  eq(await p3, false, '取消立即结算 false')
  eq(store3.list().length, 0, '取消后 pending 清空')
  eq(store3.resolve(id3, true), false, '取消后的迟到批准无效')
}

console.log('\n[ConfirmStore：进程重启丢失 pending]')
{
  const oldStore = new ConfirmStore({ timeout: 60_000 })
  let id = null
  const p = oldStore.request({ tool: 't', args: {}, ctx: {}, notify: (x) => { id = x } })
  const newStore = new ConfirmStore({ timeout: 60_000 }) // 模拟重启后的新实例
  eq(newStore.list().length, 0, '新实例看不到旧 pending')
  knownBug(newStore.resolve(id, true) === false, '重启后批准找不到旧审批（内存态丢失）')
  oldStore.resolve(id, false) // 清理旧实例，避免定时器悬挂
  eq(await p, false, '旧实例可自行结算（但生产进程已重启，回调不存在）')
}

console.log('\n[ToolRegistry：meta 全字段保留 + 同名拒绝]')
{
  const state = { executed: 0 }
  const tool = writeTool(state)
  const reg = new ToolRegistry().register(tool)
  const got = reg.get('save_note')
  for (const k of ['alwaysConfirm', 'effect', 'replay', 'idempotencyKey', 'resultCap', 'concurrency', 'requires', 'interactive', 'groupAdminSkip', 'polling', 'mcp', 'shell']) {
    eq(got.meta[k], tool.meta[k], `meta.${k} 保留`)
  }
  reg.register({ ...tool, description: 'overwrite' })
  eq(reg.get('save_note').description, '写操作', '同名不同对象注册被拒绝（保留原工具，不抛错）')
}

console.log(`\n========================================`)
console.log(`通过 ${passed}，失败 ${failed}`)
console.log(`========================================`)
if (failed > 0) process.exitCode = 1
