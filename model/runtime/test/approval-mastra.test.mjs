/**
 * Mastra + ApprovalBridge 端到端（PR3b/PR4a 基础）：
 * 写工具 → generate suspended → 审批通过 → approveToolCallGenerate → 工具只执行一次。
 * 另一路：拒绝 → declineToolCallGenerate → 工具不执行。
 *
 * 运行：node model/runtime/test/approval-mastra.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Agent } from '@mastra/core/agent'
import { Mastra } from '@mastra/core'
import { LibSQLStore } from '@mastra/libsql'
import { RequestContext } from '@mastra/core/request-context'
import { ToolRegistry } from '../../agent/tools/registry.js'
import { createPolicy } from '../../agent/policy.js'
import { memoryKv } from '../../agent/store/kv.js'
import { ApprovalBridge } from '../approval-bridge.js'
import { adaptTool } from '../tool-adapter.js'
import { ToolNameMap } from '../tool-name.js'
import { scriptedAiSdkModel } from './fixtures/scripted-model.js'

let passed = 0
let failed = 0
function ok(c, m) {
  if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) }
}
function eq(a, b, m) {
  const same = JSON.stringify(a) === JSON.stringify(b)
  ok(same, `${m}${same ? '' : `  (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`}`)
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'yz-approval-mastra-'))
let seq = 0
async function setup({ approve = true } = {}) {
  const dir = path.join(TMP, `run-${++seq}`)
  fs.mkdirSync(dir, { recursive: true })
  const calls = { execute: 0 }
  const registry = new ToolRegistry().register({
    name: 'save_note', description: 'save', category: 'system',
    meta: { alwaysConfirm: true, effect: 'write', replay: 'never' },
    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
    async execute(p) { calls.execute++; return { ok: true, text: p.text } },
  })
  const notices = []
  const approval = new ApprovalBridge({ kv: memoryKv(), timeoutMs: 60_000, notify: (id, r) => notices.push(r) })
  const adapted = adaptTool(registry.get('save_note'), {
    names: new ToolNameMap(), allowWrite: true, policy: createPolicy(), approval,
  })
  const model = scriptedAiSdkModel([
    { toolCalls: [{ id: 'c1', name: 'save_note', arguments: { text: 'hello' } }], finishReason: 'tool_calls' },
    { text: 'done' },
  ])
  const agent = new Agent({ id: 't', name: 't', instructions: 'test', model, tools: { [adapted.mastraName]: adapted.mastraTool } })
  const storage = new LibSQLStore({ id: 's', url: `file:${path.join(dir, 'm.db')}` })
  await storage.init()
  const mastra = new Mastra({ storage, agents: { t: agent }, logger: false })
  const rc = new RequestContext()
  rc.set('yz.runId', 'run-1')
  rc.set('yz.ctx', { userId: 'u', isMaster: true, role: 'master' })
  rc.set('yz.taskId', 'task-1')
  return { mastra, storage, agent: mastra.getAgent('t'), approval, notices, calls, rc, approve }
}

async function close(s) {
  await s.mastra.shutdown()
  await s.storage.close()
  s.approval.close()
}

console.log('\n[批准：suspend → approve → 执行一次]')
{
  const s = await setup()
  const out = await s.agent.generate('go', { runId: 'run-1', requestContext: s.rc, maxSteps: 4 })
  eq(out.finishReason, 'suspended', '暂停等待审批')
  eq(s.calls.execute, 0, '审批前未执行')
  eq(s.notices.length, 1, '审批通知一条')
  eq(s.notices[0].status, 'pending', 'pending')
  const runs = await s.agent.listSuspendedRuns()
  eq(runs.runs.length, 1, 'storage 可发现 suspended run')
  const res = await s.approval.approve(s.notices[0].id, { actor: 'master' })
  eq(res.ok, true, '审批通过')
  const out2 = await s.agent.approveToolCallGenerate({
    runId: 'run-1', toolCallId: out.suspendPayload.toolCallId, requestContext: s.rc,
  })
  eq(out2.finishReason, 'stop', '恢复后结束')
  eq(out2.text, 'done', '最终文本')
  eq(s.calls.execute, 1, '工具只执行一次')
  await close(s)
}

console.log('\n[拒绝：decline → 不执行]')
{
  const s = await setup()
  const out = await s.agent.generate('go', { runId: 'run-1', requestContext: s.rc, maxSteps: 4 })
  eq(out.finishReason, 'suspended', '暂停等待审批')
  const res = await s.approval.deny(s.notices[0].id, { actor: 'master', reason: 'no' })
  eq(res.ok, true, '拒绝成功')
  const out2 = await s.agent.declineToolCallGenerate({
    runId: 'run-1', toolCallId: out.suspendPayload.toolCallId, requestContext: s.rc,
  })
  eq(out2.finishReason, 'stop', '拒绝后继续')
  eq(s.calls.execute, 0, '拒绝不执行')
  await close(s)
}

fs.rmSync(TMP, { recursive: true, force: true })

console.log(`\n========================================`)
console.log(`通过 ${passed}，失败 ${failed}`)
console.log(`========================================`)
if (failed > 0) process.exitCode = 1
