/**
 * S6 Memory Phase 1：多对话 / active / 删除 / 群共享 / 私聊 / 跨群隔离。
 * 历史唯一真源仍是 SessionStore；Mastra 只接收显式 messages。
 *
 * 运行：node model/runtime/test/chat-runner-isolation.test.mjs
 */
import { createMastraChatRunner } from '../chat-runner.js'
import { ToolRegistry } from '../../agent/tools/registry.js'
import { createPolicy } from '../../agent/policy.js'
import { SessionStore } from '../../agent/session.js'
import { memoryKv } from '../../agent/store/kv.js'

let passed = 0
let failed = 0
const ok = (c, m) => { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }
const eq = (a, b, m) => { const s = JSON.stringify(a) === JSON.stringify(b); ok(s, `${m}${s ? '' : `（实际 ${JSON.stringify(a)}）`}`) }

const cfg = {
  apiKey: 'k', model: 'm', protocol: 'openai', preset: 'openai', baseURL: 'https://example.test/v1',
  llmProviders: [{ id: 'p', protocol: 'openai', preset: 'openai', baseURL: 'https://example.test/v1', apiKey: 'k' }],
  llmModels: [{ id: 'm', providerId: 'p', model: 'm' }], providerId: 'p', modelId: 'm',
}
const requests = []
const fetchImpl = async (url, opts = {}) => {
  requests.push(JSON.parse(opts.body))
  return new Response(JSON.stringify({
    choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }), { status: 200, headers: { 'content-type': 'application/json' } })
}
const store = new SessionStore({ kv: memoryKv() })
const tools = new ToolRegistry()
const agentInst = {
  _inputText: (i) => String(i), _assembleSystem: () => ({ system: 'SYS' }), _memorySnapshot: () => '',
  _screenUntrusted: (t) => t, session: store, tools, maxTurns: 4, temperature: 0, maxTokens: 100,
  thinking: null, policy: createPolicy(), confirm: null, taskStore: null, guard: null,
  untrustedGuard: true, masterSkipConfirm: false,
}
const runner = createMastraChatRunner({ cfg, deps: { tools, confirm: null }, fetchImpl })

async function seed(userId, groupId, marker) {
  const c = await store.createConversation(userId, groupId)
  await store.appendConversation(userId, groupId, c.id, [
    { role: 'user', content: marker },
    { role: 'assistant', content: `${marker}-reply` },
  ])
  return c.id
}

console.log('\n[多 conversation / 隔离]')
{
  const c1 = await seed('u1', 'g1', 'G1U1C1')
  const c2 = await seed('u1', 'g1', 'G1U1C2')
  const c3 = await seed('u2', 'g1', 'G1U2C1')
  const c4 = await seed('u1', 'g2', 'G2U1C1')
  const c5 = await seed('u1', null, 'PRIVATEU1')
  eq((await store.listConversations('u1', 'g1')).length, 2, 'u1/g1 两个对话')

  const cases = [
    { uid: 'u1', gid: 'g1', cid: c1, marker: 'G1U1C1', absent: ['G1U1C2', 'G1U2C1', 'G2U1C1', 'PRIVATEU1'] },
    { uid: 'u1', gid: 'g1', cid: c2, marker: 'G1U1C2', absent: ['G1U1C1', 'G1U2C1', 'G2U1C1', 'PRIVATEU1'] },
    { uid: 'u2', gid: 'g1', cid: c3, marker: 'G1U2C1', absent: ['G1U1C1', 'G1U1C2', 'G2U1C1', 'PRIVATEU1'] },
    { uid: 'u1', gid: 'g2', cid: c4, marker: 'G2U1C1', absent: ['G1U1C1', 'G1U1C2', 'G1U2C1', 'PRIVATEU1'] },
    { uid: 'u1', gid: null, cid: c5, marker: 'PRIVATEU1', absent: ['G1U1C1', 'G1U1C2', 'G1U2C1', 'G2U1C1'] },
  ]
  for (const c of cases) {
    requests.length = 0
    const r = await runner.runChat('新问题', {
      agentInst, ctx: { userId: c.uid, scopeUserId: c.uid, groupId: c.gid, conversationId: c.cid },
    })
    const text = JSON.stringify(requests[0]?.messages || [])
    ok(text.includes(c.marker), `${c.marker} 进入本轮请求`)
    for (const a of c.absent) ok(!text.includes(a), `${c.marker} 不串入 ${a}`)
    const saved = await store.getConversation(c.uid, c.gid, c.cid)
    ok(JSON.stringify(saved).includes('新问题'), `${c.marker} 用户消息写回本对话`)
  }
}

console.log('\n[active / 切换 / 删除]')
{
  const u = 'u3'; const g = 'g1'
  const a = await seed(u, g, 'ACTIVE-A')
  const b = await seed(u, g, 'ACTIVE-B')
  eq(await store.getActiveConversation(u, g), b, '后创建的对话为 active')
  await store.setActiveConversation(u, g, a)
  eq(await store.getActiveConversation(u, g), a, '切换 active')
  await store.deleteConversation(u, g, a)
  eq(await store.getActiveConversation(u, g), b, '删除 active 后回退到剩余对话')
  eq((await store.listConversations(u, g)).length, 1, '删除后只剩 1 条')
}

console.log('\n[群共享]')
{
  const sharedId = '__group__:g1'
  const c = await store.createConversation(sharedId, 'g1', '共享')
  await store.appendConversation(sharedId, 'g1', c.id, [{ role: 'user', content: 'SHARED-MARK' }])
  requests.length = 0
  await runner.runChat('共享问题', {
    agentInst, ctx: { userId: 'someone', scopeUserId: sharedId, groupId: 'g1', conversationId: c.id },
  })
  const text = JSON.stringify(requests[0]?.messages || [])
  ok(text.includes('SHARED-MARK'), '群共享历史进入请求')
  for (const a of ['G1U1C1', 'G1U1C2', 'PRIVATEU1']) ok(!text.includes(a), `群共享不串入 ${a}`)
  const saved = await store.getConversation(sharedId, 'g1', c.id)
  ok(JSON.stringify(saved).includes('共享问题'), '群共享写回自己的对话')
}

console.log('\n[无 Mastra Memory 双写]')
{
  // Runner 只写 SessionStore；未创建 Mastra Memory/Thread
  ok(!tools.list().some((t) => /memory/i.test(t.name)), '工具集未被注入 Memory 工具')
}

console.log(`\n========================================`)
console.log(`通过 ${passed}，失败 ${failed}`)
console.log(`========================================`)
if (failed > 0) process.exitCode = 1
