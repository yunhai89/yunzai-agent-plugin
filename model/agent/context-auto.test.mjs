/**
 * 自动上下文预算的 Agent 集成回归（离线）。
 *
 * 验证：
 *  - 每轮 run 都会重新解析上下文预算（不是构造期固化）；
 *  - thinkingAuto 的判档结果会传给解析器，思考/非思考模式可使用不同窗口；
 *  - 实时解析结果只影响压缩水位，不写回用户配置；
 *  - 显式 contextWindow（测试/高级调用）仍作为覆盖值优先。
 * 运行：node model/agent/context-auto.test.mjs
 */
import { Agent, ToolRegistry, SessionStore, memoryKv } from './index.js'
import { clearModelContextCache } from '../llm/model-context.js'

let passed = 0
let failed = 0
const ok = (c, m) => { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }
const eq = (a, b, m) => { const s = JSON.stringify(a) === JSON.stringify(b); ok(s, `${m}${s ? '' : ` (got ${JSON.stringify(a)})`}`) }
async function test(name, fn) { console.log(`\n[${name}]`); try { await fn() } catch (e) { failed++; console.error('  ✗ THROW', e?.message || e); console.error(e?.stack?.split('\n').slice(0, 4).join('\n')) } }

function makeSession() {
  const impl = {
    key: () => 'k',
    async getConversation() { return [] },
    async appendConversation() {},
    async setConversation() {},
    async get() { return [] },
    async set() {},
    async getConversationState() { return null },
    async setConversationState() {},
    async historyLength() { return 0 },
  }
  return new Proxy(impl, { get(t, p) { return p in t ? t[p] : async () => undefined } })
}

const provider = {
  async chat() {
    return { role: 'assistant', content: 'ok', toolCalls: [], finishReason: 'stop', usage: { prompt_tokens: 120, completion_tokens: 2 } }
  },
}
const ctx = { userId: 'u1', scopeUserId: 'u1', groupId: null, conversationId: 'c1' }

function stubResolver(seen) {
  return ({ model, thinking }) => {
    seen.push({ model, thinking })
    return {
      model,
      contextWindow: thinking ? 210000 : 110000,
      maxInputTokens: thinking ? 200000 : 100000,
      maxOutputTokens: 10000,
      inputBudget: thinking ? 200000 : 100000,
      contextWindowKind: 'total',
      thinkingMode: thinking ? 'on' : 'off',
      source: 'test-resolver',
      sourceId: thinking ? 'thinking-on' : 'thinking-off',
    }
  }
}

await test('同一 Agent 每轮按 thinkingAuto 档位切换上下文预算', async () => {
  clearModelContextCache()
  const seen = []
  const events = []
  const agent = new Agent({
    provider, tools: new ToolRegistry(), session: makeSession(),
    model: 'stub-model', reflect: 'off', governor: false,
    thinkingCapable: true,
    thinkingAuto: { enable: true, classifier: 'off' },
    contextResolver: stubResolver(seen),
    devLog: (event, payload) => events.push({ event, payload }),
  })

  await agent.run('你好', { ctx })
  eq(seen[0]?.thinking, false, '寒暄 → 解析器收到 thinking=false')
  eq(agent.contextWindow, 100000, '非思考预算生效')
  eq(agent.contextWindowTotal, 110000, '总窗口来自同一解析结果')

  await agent.run('请深入分析并证明这个算法的时间复杂度，给出多步推导、代码实现和边界条件。', { ctx })
  eq(seen[1]?.thinking, true, '复杂问题 → 解析器收到 thinking=true')
  eq(agent.contextWindow, 200000, '思考预算生效（每轮重新解析）')

  const resolved = events.filter((e) => e.event === 'context_resolved')
  eq(resolved.length, 2, '每轮都记录 context_resolved')
  eq(resolved[1]?.payload?.thinking, 'on', '日志记录本轮思考模式')
  eq(resolved[1]?.payload?.source, 'test-resolver', '日志记录来源')
})

await test('显式 contextWindow 覆盖自动解析', async () => {
  const seen = []
  const agent = new Agent({
    provider, tools: new ToolRegistry(), session: makeSession(),
    model: 'stub-model', reflect: 'off', governor: false,
    contextWindow: 32000, contextResolver: stubResolver(seen),
  })
  await agent.run('你好', { ctx })
  eq(seen.length, 0, '显式覆盖时不调用自动解析器')
  eq(agent.contextWindow, 32000, '覆盖值保持')
})

await test('真实解析器：目录模型自动得到窗口/输出预算', async () => {
  const agent = new Agent({
    provider, tools: new ToolRegistry(), session: makeSession(),
    model: 'gpt-6.1-sol', reflect: 'off', governor: false, thinkingCapable: false,
  })
  await agent.run('你好', { ctx })
  eq(agent.contextWindow, 922000, '自动解析 GPT-6.1 输入预算')
  eq(agent.contextWindowTotal, 1050000, '自动解析 GPT-6.1 总窗口')
  eq(agent.contextMaxOutput, 128000, '自动解析输出上限')
})

await test('厂商报上下文超限：学习真实上限、压缩并同模型重试一次', async () => {
  const kv = memoryKv()
  const session = new SessionStore({ kv })
  await session.createConversation('u1', null, 'c1')
  const history = []
  for (let i = 0; i < 10; i++) {
    history.push({ role: 'user', content: '历史问题' + i + '：' + '长内容'.repeat(60) })
    history.push({ role: 'assistant', content: '历史回答' + i + '：' + '说明'.repeat(40) })
  }
  await session.appendConversation('u1', null, 'c1', history)

  let calls = 0
  const events = []
  const provider = {
    async chat() {
      calls++
      if (calls === 1) throw new Error("This model's maximum context length is 8000 tokens. However you requested 12000 tokens.")
      return { role: 'assistant', content: '压缩后成功', toolCalls: [], finishReason: 'stop', usage: { prompt_tokens: 900, completion_tokens: 4 } }
    },
  }
  const agent = new Agent({
    provider, tools: new ToolRegistry(), session,
    model: 'overflow-stub', reflect: 'off', governor: false,
    contextResolver: () => ({ inputBudget: 128000, contextWindow: 128000, maxOutputTokens: 8192, thinkingMode: 'off', source: 'test' }),
    contextKeepRecent: 4,
    devLog: (event, payload) => events.push({ event, payload }),
  })
  const r = await agent.run('继续', { ctx })
  eq(calls, 2, '超限后同模型重试一次')
  eq(r.content, '压缩后成功', '重试成功交付')
  eq(agent.contextWindow, 7600, '学习上限（8000×95%）立即生效')
  const compact = events.find((e) => e.event === 'cache_compact' && e.payload?.reason === 'provider_overflow')
  ok(!!compact, '压缩事件标记 provider_overflow')
  ok(compact.payload.dropped > 0, '确实丢弃了旧 turn-block')
})

console.log('\n========================================')
console.log(`通过 ${passed}，失败 ${failed}`)
console.log('========================================')
if (failed > 0) process.exitCode = 1
