/**
 * 聊天原生审批 E2E（PR4c）：Mastra Agent suspend → ApprovalBridge → #确认 恢复并发送最终回复。
 *
 * 运行：node model/runtime/test/chat-runner-native-approval.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Mastra } from '@mastra/core'
import { LibSQLStore } from '@mastra/libsql'
import { createPolicy } from '../../agent/policy.js'
import { ToolRegistry } from '../../agent/tools/registry.js'
import { memoryKv } from '../../agent/store/kv.js'
import { ApprovalBridge } from '../approval-bridge.js'
import { createMastraChatRunner } from '../chat-runner.js'

let passed = 0
let failed = 0
function ok(c, m) { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }
function eq(a, b, m) { const s = JSON.stringify(a) === JSON.stringify(b); ok(s, `${m}${s ? '' : `  (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`}`) }

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'yz-chat-native-'))
const cfg = {
  apiKey: 'k', model: 'm', protocol: 'openai', preset: 'openai', baseURL: 'https://example.test/v1',
  llmProviders: [{ id: 'p', protocol: 'openai', preset: 'openai', baseURL: 'https://example.test/v1', apiKey: 'k' }],
  llmModels: [{ id: 'm', providerId: 'p', model: 'm' }], providerId: 'p', modelId: 'm',
}
function body(text, extra = {}) {
  return { id: 'x', object: 'chat.completion', created: 1, model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: text, ...extra }, finish_reason: extra.tool_calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }
}
function agentInst(tools, confirm = null) {
  return {
    _inputText: (i) => String(i), _assembleSystem: () => ({ system: 'sys' }), _memorySnapshot: () => '',
    _screenUntrusted: (t) => t,
    session: { key: (g, u) => `k:${u}`, async get() { return [] }, async append() {}, async getConversation() { return [] }, async appendConversation() {} },
    tools, maxTurns: 4, temperature: 0, maxTokens: 100, thinking: null,
    policy: createPolicy(), confirm, taskStore: null, guard: null, untrustedGuard: true, masterSkipConfirm: false,
  }
}

async function run({ approve = true } = {}) {
  const dir = path.join(TMP, approve ? 'a' : 'd'); fs.mkdirSync(dir, { recursive: true })
  let n = 0, execs = 0
  const fetchImpl = async () => {
    n++
    if (n === 1) return new Response(JSON.stringify(body(null, { tool_calls: [{ id: 'c1', type: 'function', function: { name: 'save_note', arguments: '{"text":"x"}' } }] })), { status: 200, headers: { 'content-type': 'application/json' } })
    return new Response(JSON.stringify(body('done')), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const tools = new ToolRegistry().register({
    name: 'save_note', description: 'save', category: 'system', meta: { alwaysConfirm: true, effect: 'write', replay: 'never' },
    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    async execute() { execs++; return { ok: true } },
  })
  const storage = new LibSQLStore({ id: 's', url: `file:${path.join(dir, 'm.db')}` }); await storage.init()
  const mastra = new Mastra({ storage, logger: false })
  const approval = new ApprovalBridge({ kv: memoryKv(), timeoutMs: 60_000 })
  const notices = []
  const inst = agentInst(tools)
  const runner = createMastraChatRunner({ cfg, deps: { tools, approval, nativeApproval: true, mastra }, fetchImpl })
  const ctx = { userId: 'u', groupId: 'g', conversationId: 1, scopeUserId: 'u', isMaster: true, role: 'master', notify: (id) => notices.push(id) }
  return { runner, approval, notices, ctx, inst, get execs() { return execs }, mastra, storage, tools, fetchImpl, dir }
}

console.log('\n[批准：suspend → approve → 执行一次]')
{
  const s = await run({ approve: true })
  const first = await s.runner.runChat('save', { agentInst: s.inst, ctx: s.ctx })
  eq(first.suspended, true, '返回 suspended')
  eq(first.stopReason, 'waiting_input', 'stopReason=waiting_input')
  eq(s.execs, 0, '审批前未执行')
  eq(s.notices.length, 1, '通知一次')
  const pending = await s.runner.pendingApprovals()
  eq(pending.length, 1, 'pending 可查')
  const res = await s.runner.approve(pending[0].id, true, 'master')
  eq([res.ok, res.resumed, res.content], [true, true, 'done'], '批准后恢复并返回最终内容')
  eq(s.execs, 1, '工具只执行一次')
  await s.mastra.shutdown(); await s.storage.close(); s.approval.close()
}

console.log('\n[拒绝：decline → 不执行]')
{
  const s = await run({ approve: false })
  const first = await s.runner.runChat('save', { agentInst: s.inst, ctx: s.ctx })
  eq(first.suspended, true, '返回 suspended')
  const pending = await s.runner.pendingApprovals()
  const res = await s.runner.approve(pending[0].id, false, 'master')
  eq([res.ok, res.resumed], [true, true], '拒绝后恢复')
  eq(s.execs, 0, '拒绝不执行')
  await s.mastra.shutdown(); await s.storage.close(); s.approval.close()
}


console.log('\n[重启后 resume：同一 storage + ApprovalBridge]')
{
  const s = await run({ approve: true })
  const first = await s.runner.runChat('save', { agentInst: s.inst, ctx: s.ctx })
  eq(first.suspended, true, '首次 suspend')
  const pending = await s.runner.pendingApprovals()
  const id = pending[0].id
  await s.mastra.shutdown(); await s.storage.close()
  const storage2 = new LibSQLStore({ id: 's2', url: `file:${path.join(s.dir, 'm.db')}` }); await storage2.init()
  const mastra2 = new Mastra({ storage: storage2, logger: false })
  const runner2 = createMastraChatRunner({
    cfg, deps: { tools: s.tools, approval: s.approval, nativeApproval: true, mastra: mastra2, makeAgent: () => s.inst },
    fetchImpl: s.fetchImpl,
  })
  const res = await runner2.approve(id, true, 'master')
  eq([res.ok, res.resumed, res.content], [true, true, 'done'], '重启后恢复并返回最终内容')
  eq(s.execs, 1, '重启后工具只执行一次')
  await mastra2.shutdown(); await storage2.close(); s.approval.close()
}

fs.rmSync(TMP, { recursive: true, force: true })

console.log(`\n========================================`)
console.log(`通过 ${passed}，失败 ${failed}`)
console.log(`========================================`)
if (failed > 0) process.exitCode = 1
