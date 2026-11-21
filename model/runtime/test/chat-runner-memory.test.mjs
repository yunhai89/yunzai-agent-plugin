/**
 * S7 / Memory Phase 2：Mastra Chat Runner 只写 Mastra Memory，legacy SessionStore 只读。
 *
 * 运行：node model/runtime/test/chat-runner-memory.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Memory } from '@mastra/memory'
import { createStorage } from '../storage-factory.js'
import { MastraMemoryBridge } from '../memory-bridge.js'
import { createMastraChatRunner } from '../chat-runner.js'
import { ToolRegistry } from '../../agent/tools/registry.js'
import { createPolicy } from '../../agent/policy.js'
import { SessionStore } from '../../agent/session.js'
import { memoryKv } from '../../agent/store/kv.js'
import { CompactionArchive } from '../../agent/compact/archive.js'
import { estimateTokensApprox } from '../../agent/token-estimate.js'

let passed = 0
let failed = 0
const ok = (c, m) => { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }
const eq = (a, b, m) => { const s = JSON.stringify(a) === JSON.stringify(b); ok(s, `${m}${s ? '' : `（实际 ${JSON.stringify(a)}）`}`) }

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'yz-memory-chat-'))
const cfg = {
  providerId: 'p', modelId: 'm', apiKey: 'k', model: 'm', protocol: 'openai', preset: 'openai', baseURL: 'https://example.test/v1',
  llmProviders: [{ id: 'p', protocol: 'openai', preset: 'openai', baseURL: 'https://example.test/v1', apiKey: 'k' }],
  llmModels: [{ id: 'm', providerId: 'p', model: 'm' }],
}
const storage = await createStorage({ driver: 'libsql', libsqlUrl: ':memory:' })
const memory = new Memory({
  storage: storage.store, vector: false,
  options: { lastMessages: false, semanticRecall: false, workingMemory: { enabled: false } },
})
const legacy = new SessionStore({ kv: memoryKv() })
const bridge = new MastraMemoryBridge({ memory, storage: storage.store, legacySession: legacy, botId: '123' })
const archive = new CompactionArchive({ dir: path.join(TMP, 'archive') })

function openaiBody(text) {
  return {
    id: 'x', object: 'chat.completion', created: 1, model: 'm',
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
  }
}
function fetchQueue(items) {
  let i = 0
  const calls = []
  return {
    calls,
    fetch: async (url, opts = {}) => {
      calls.push(JSON.parse(opts.body))
      const item = items[Math.min(i, items.length - 1)]
      i++
      return new Response(JSON.stringify(item), { status: 200, headers: { 'content-type': 'application/json' } })
    },
  }
}
function makeAgentInst({ tools, history = [], session = legacy, compact = false } = {}) {
  const inst = {
    _inputText: (i) => (typeof i === 'string' ? i : String(i?.content || '')),
    _assembleSystem: () => ({ system: 'SYS' }),
    _memorySnapshot: () => '',
    _screenUntrusted: (t) => t,
    session,
    tools,
    maxTurns: 4,
    temperature: 0,
    maxTokens: 100,
    thinking: null,
    policy: createPolicy(),
    confirm: { request: async () => true },
    taskStore: null,
    guard: null,
    untrustedGuard: true,
    masterSkipConfirm: false,
    _userTexts: [],
  }
  if (compact) {
    inst.contextWindow = 120
    inst.contextHighRatio = 0.5
    inst.contextLowRatio = 0.3
    inst.contextKeepRecent = 2
    inst.compactArchive = archive
    inst.estimateTokens = estimateTokensApprox
    inst.model = 'm'
    inst._resolveContextForRun = () => {}
    inst._estimateHistory = (system) => estimateTokensApprox(String(system || '')) + estimateTokensApprox(JSON.stringify(inst.messages || history))
    inst._estimateToolsTokens = () => 0
  }
  return inst
}

console.log('\n[第一轮：历史写 Mastra，不写 legacy]')
{
  const tools = new ToolRegistry()
  const inst = makeAgentInst({ tools })
  const cap = fetchQueue([openaiBody('S7-REPLY')])
  const runner = createMastraChatRunner({ cfg, deps: { tools, confirm: inst.confirm, memory: bridge }, fetchImpl: cap.fetch })
  const r = await runner.runChat('S7-INPUT', { agentInst: inst, ctx: { userId: 'u1', groupId: 'g1', conversationId: 1, scopeUserId: 'u1', selfId: '123' } })
  eq(r.content, 'S7-REPLY', '回复内容')
  const conv = await bridge.getConversation('u1', 'g1', 1, { selfId: '123' })
  eq(conv.map((m) => m.role), ['user', 'assistant'], 'Mastra 有 user+assistant')
  eq(conv[0].content, 'S7-INPUT', 'Mastra 用户消息')
  const old = await legacy.getConversation('u1', 'g1', 1).catch(() => [])
  eq(old, [], 'legacy 未被写入')
}

console.log('\n[第二轮：自动读取 Mastra 历史]')
{
  const tools = new ToolRegistry()
  const history = await bridge.getConversation('u1', 'g1', 1, { selfId: '123' })
  const inst = makeAgentInst({ tools, history })
  const cap = fetchQueue([openaiBody('S7-SECOND')])
  const runner = createMastraChatRunner({ cfg, deps: { tools, confirm: inst.confirm, memory: bridge }, fetchImpl: cap.fetch })
  await runner.runChat('S7-NEXT', { agentInst: inst, ctx: { userId: 'u1', groupId: 'g1', conversationId: 1, scopeUserId: 'u1', selfId: '123' } })
  const sent = JSON.stringify(cap.calls[0].messages)
  ok(sent.includes('S7-INPUT'), '历史 S7-INPUT 进入模型请求')
  const conv = await bridge.getConversation('u1', 'g1', 1, { selfId: '123' })
  eq(conv.map((m) => m.role), ['user', 'assistant', 'user', 'assistant'], '第二轮后 4 条')
}

console.log('\n[压缩：全量覆写 + cacheEpoch/ledger 写 thread metadata]')
{
  const tools = new ToolRegistry()
  const c = await bridge.createConversation('u2', 'g2', '压缩', { selfId: '123' })
  for (let i = 0; i < 10; i++) {
    await bridge.appendConversation('u2', 'g2', c.id, [
      { role: i % 2 ? 'assistant' : 'user', content: `历史 ${i} ` + 'x'.repeat(200) },
    ], {}, { selfId: '123' })
  }
  const inst = makeAgentInst({ tools, compact: true })
  const cap = fetchQueue([openaiBody('压缩后')])
  const runner = createMastraChatRunner({ cfg, deps: { tools, confirm: inst.confirm, memory: bridge }, fetchImpl: cap.fetch })
  const r = await runner.runChat('压缩问题', { agentInst: inst, ctx: { userId: 'u2', groupId: 'g2', conversationId: c.id, scopeUserId: 'u2', selfId: '123' }, taskId: 't1' })
  eq(r.content, '压缩后', '压缩后回复')
  const st = await bridge.getConversationState('u2', 'g2', c.id, { selfId: '123' })
  eq(st.cacheEpoch, 1, 'cacheEpoch=1')
  ok(!!st.compactLedger, 'compactLedger 存在')
  const conv = await bridge.getConversation('u2', 'g2', c.id, { selfId: '123' })
  ok(conv.length < 12, `压缩后消息减少（${conv.length}）`)
  ok(fs.readdirSync(path.join(TMP, 'archive')).length > 0, '归档落盘')
}

console.log('\n[工具 ctx 注入 userTexts]')
{
  let captured = null
  const tools = new ToolRegistry().register({
    name: 'ctx_probe', description: 'probe', category: 'query', meta: { effect: 'read' },
    parameters: { type: 'object', properties: {} },
    async execute(_p, ctx) { captured = ctx?.userTexts; return { ok: true } },
  })
  let turn = 0
  const fetchImpl = async () => {
    turn++
    const msg = turn === 1
      ? { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'ctx_probe', arguments: '{}' } }] }
      : { role: 'assistant', content: 'ok' }
    return new Response(JSON.stringify({
      choices: [{ index: 0, message: msg, finish_reason: turn === 1 ? 'tool_calls' : 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const inst = makeAgentInst({ tools })
  const runner = createMastraChatRunner({ cfg, deps: { tools, confirm: inst.confirm, memory: bridge }, fetchImpl })
  await runner.runChat('REMEMBER-ME', { agentInst: inst, ctx: { userId: 'u9', conversationId: 9, scopeUserId: 'u9', selfId: '123' } })
  eq(captured, ['REMEMBER-ME'], '工具 ctx.userTexts 为当前用户原话')
  const conv = await bridge.getConversation('u9', null, 9, { selfId: '123' })
  ok(conv.some((m) => m.role === 'tool' && String(m.content).includes('"ok":true')), '工具结果已持久化')
}

console.log('\n[隔离：不同 bot / 群 / 用户]')
{
  const c1 = await bridge.createConversation('u3', 'g3', 'A', { selfId: '111' })
  await bridge.appendConversation('u3', 'g3', c1.id, [{ role: 'user', content: 'BOT111' }], {}, { selfId: '111' })
  await bridge.createConversation('u3', 'g3', 'B1', { selfId: '222' })
  const c2 = await bridge.createConversation('u3', 'g3', 'B2', { selfId: '222' })
  await bridge.appendConversation('u3', 'g3', c2.id, [{ role: 'user', content: 'BOT222' }], {}, { selfId: '222' })
  const a = await bridge.getConversation('u3', 'g3', c1.id, { selfId: '111' })
  const b = await bridge.getConversation('u3', 'g3', c2.id, { selfId: '222' })
  eq(a[0].content, 'BOT111', 'bot111 历史')
  eq(b[0].content, 'BOT222', 'bot222 历史')
  const wrong = await bridge.getConversation('u3', 'g3', c2.id, { selfId: '111' })
  eq(wrong, [], 'bot111 看不到 bot222 thread')
}

await storage.close()
fs.rmSync(TMP, { recursive: true, force: true })
console.log(`\n========================================`)
console.log(`通过 ${passed}，失败 ${failed}`)
console.log(`========================================`)
if (failed > 0) process.exitCode = 1
