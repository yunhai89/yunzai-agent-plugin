/**
 * Mastra Chat Runner 契约（PR4a）。
 *
 * 运行：node model/runtime/test/chat-runner.test.mjs
 */
import { createMastraChatRunner } from '../chat-runner.js'
import { ToolRegistry } from '../../agent/tools/registry.js'
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

const cfg = {
  providerId: 'p', modelId: 'm', apiKey: 'k', model: 'm', protocol: 'openai', preset: 'openai', baseURL: 'https://example.test/v1',
  llmProviders: [{ id: 'p', protocol: 'openai', preset: 'openai', baseURL: 'https://example.test/v1', apiKey: 'k' }],
  llmModels: [{ id: 'm', providerId: 'p', model: 'm' }],
}

function openaiBody(text, extra = {}) {
  return {
    id: 'x', object: 'chat.completion', created: 1, model: 'm',
    choices: [{ index: 0, message: { role: 'assistant', content: text, ...extra }, finish_reason: extra.tool_calls ? 'tool_calls' : 'stop' }],
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
function makeAgentInst({ tools, history = [], confirm = { request: async () => true } } = {}) {
  const saved = []
  const session = {
    key: (g, u) => `k:${g || 'p'}:${u}`,
    async get() { return history },
    async getConversation() { return history },
    async append(k, msgs) { saved.push(msgs) },
    async appendConversation(u, g, c, msgs) { saved.push(msgs) },
  }
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
    confirm,
    taskStore: null,
    guard: null,
    untrustedGuard: true,
    masterSkipConfirm: false,
    _userTexts: [],
  }
  return { inst, saved }
}

console.log('\n[纯文本]')
{
  const cap = fetchQueue([openaiBody('hello')])
  const tools = new ToolRegistry()
  const { inst, saved } = makeAgentInst({ tools })
  const runner = createMastraChatRunner({ cfg, deps: { tools, confirm: inst.confirm }, fetchImpl: cap.fetch })
  const r = await runner.runChat('hi', { agentInst: inst, ctx: { userId: 'u', groupId: 'g', conversationId: 1, scopeUserId: 'u' } })
  eq(r.content, 'hello', 'content')
  eq([r.stopReason, r.turns, r.engine], ['stop', 1, 'mastra'], 'stop/turns/engine')
  eq(r.usage.input, 10, 'usage')
  eq(cap.calls[0].messages.some((m) => m.role === 'system'), true, 'system 传给模型')
  eq(saved[0].map((m) => m.role), ['user', 'assistant'], '持久化 user+assistant')
}

console.log('\n[历史 + 工具循环 + 持久化]')
{
  const tools = new ToolRegistry().register({
    name: 'weather', description: 'w', category: 'query', meta: { effect: 'read' },
    parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
    async execute(p) { return { city: p.city, temp: 22 } },
  })
  const history = [{ role: 'user', content: '旧问题' }, { role: 'assistant', content: '旧回答' }]
  const cap = fetchQueue([
    openaiBody(null, { tool_calls: [{ id: 'c1', type: 'function', function: { name: 'weather', arguments: '{"city":"北京"}' } }] }),
    openaiBody('晴 22'),
  ])
  const { inst, saved } = makeAgentInst({ tools, history })
  const runner = createMastraChatRunner({ cfg, deps: { tools, confirm: inst.confirm }, fetchImpl: cap.fetch })
  const r = await runner.runChat('北京天气', { agentInst: inst, ctx: { userId: 'u', groupId: 'g', conversationId: 1, scopeUserId: 'u' } })
  eq(r.content, '晴 22', '工具后最终文本')
  eq(r.turns, 2, '两轮')
  const roles = cap.calls[0].messages.map((m) => m.role)
  const noSys = roles.filter((r) => r !== 'system')
  eq(noSys.slice(0, 2), ['user', 'assistant'], '历史进入请求')
  eq(roles.at(-1), 'user', '本轮 user 在末尾')
  eq(saved[0].map((m) => m.role), ['user', 'assistant', 'tool', 'assistant'], '工具消息持久化')
  eq(saved[0][1].tool_calls[0].function.name, 'weather', 'assistant tool_calls')
  eq(saved[0][2].tool_call_id, 'c1', 'tool_call_id 配对')
}

console.log('\n[写工具：旧 ConfirmStore 阻塞审批]')
{
  let asks = 0, execs = 0
  const tools = new ToolRegistry().register({
    name: 'save_note', description: 'save', category: 'system', meta: { alwaysConfirm: true, effect: 'write', replay: 'never' },
    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    async execute() { execs++; return { ok: true } },
  })
  const cap = fetchQueue([
    openaiBody(null, { tool_calls: [{ id: 'c1', type: 'function', function: { name: 'save_note', arguments: '{"text":"x"}' } }] }),
    openaiBody('saved'),
  ])
  const { inst } = makeAgentInst({ tools, confirm: { request: async () => { asks++; return true } } })
  const runner = createMastraChatRunner({ cfg, deps: { tools, confirm: inst.confirm }, fetchImpl: cap.fetch })
  const r = await runner.runChat('save', { agentInst: inst, ctx: { userId: 'u', groupId: 'g', conversationId: 1, scopeUserId: 'u', isMaster: true, role: 'master' } })
  eq([asks, execs], [1, 1], '审批一次、执行一次')
  eq(r.content, 'saved', '审批后回复')
}

console.log('\n[不支持 → 回退信号]')
{
  const tools = new ToolRegistry()
  const { inst } = makeAgentInst({ tools })
  const runner = createMastraChatRunner({ cfg, deps: { tools, confirm: inst.confirm }, fetchImpl: async () => { throw new Error('should not call') } })
  const gem = createMastraChatRunner({
    cfg: { apiKey: 'k', model: 'gemini-2.5', protocol: 'gemini', preset: 'gemini' },
    deps: { tools, confirm: inst.confirm }, fetchImpl: async () => { throw new Error('no') },
  })
  const g = await gem.runChat('hi', { agentInst: inst, ctx: { userId: 'u' } })
  eq(g.unsupported, 'model_gemini_legacy_only', 'Gemini 回退')
}


console.log('\n[流式：text-delta → onDelta + 最终内容]')
{
  const sse = [
    'data: {"id":"x","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":"hel"},"finish_reason":null}]}',
    'data: {"id":"x","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":"lo"},"finish_reason":null}]}',
    'data: {"id":"x","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12}}',
    'data: [DONE]',
    '',
  ].join('\n\n')
  const fetchImpl = async () => new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  const tools = new ToolRegistry()
  const { inst, saved } = makeAgentInst({ tools })
  const deltas = []
  const runner = createMastraChatRunner({ cfg, deps: { tools, confirm: inst.confirm }, fetchImpl })
  const r = await runner.runChat('hi', { agentInst: inst, ctx: { userId: 'u' }, stream: true, onDelta: (d) => deltas.push(d) })
  eq(deltas.join(''), 'hello', 'onDelta 收到文本')
  eq(r.content, 'hello', '最终内容')
  eq(saved[0].map((m) => m.role), ['user', 'assistant'], '流式后持久化')
}

console.log('\n[空输出]')
{
  const tools = new ToolRegistry()
  const cap = fetchQueue([openaiBody('')])
  const { inst } = makeAgentInst({ tools })
  const runner = createMastraChatRunner({ cfg, deps: { tools, confirm: inst.confirm }, fetchImpl: cap.fetch })
  const r = await runner.runChat('hi', { agentInst: inst, ctx: { userId: 'u' } })
  eq(r.unsupported, 'empty_output', '空输出回退')
}

console.log(`\n========================================`)
console.log(`通过 ${passed}，失败 ${failed}`)
console.log(`========================================`)
if (failed > 0) process.exitCode = 1
