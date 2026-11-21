/**
 * Provider parity（PR2）：同一上游 JSON 下，legacy Provider 与 AI SDK 的 content/finish/usage 归一一致。
 *
 * 运行：node model/runtime/test/provider-parity.test.mjs
 */
import { createProvider } from '../../agent/provider/index.js'
import { createLanguageModel } from '../model-factory.js'
import { normalizeUsage } from '../../agent/messages.js'
import { normalizeAiSdkUsage, aiSdkFinishReason } from '../observability.js'

let passed = 0
let failed = 0
function ok(c, m) {
  if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) }
}
function eq(a, b, m) {
  const same = JSON.stringify(a) === JSON.stringify(b)
  ok(same, `${m}${same ? '' : `  (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`}`)
}

function fakeFetch(bodyFactory) {
  const calls = []
  return {
    calls,
    fetch: async (url, opts = {}) => {
      calls.push({ url: String(url), body: opts.body ? JSON.parse(opts.body) : null, headers: opts.headers })
      return new Response(JSON.stringify(bodyFactory()), { status: 200, headers: { 'content-type': 'application/json' } })
    },
  }
}

const PROMPT = [{ role: 'user', content: 'hi' }]

console.log('\n[OpenAI：content / finish / usage]')
{
  const usage = {
    prompt_tokens: 120, completion_tokens: 30, total_tokens: 150,
    prompt_tokens_details: { cached_tokens: 100 },
    completion_tokens_details: { reasoning_tokens: 10 },
  }
  const response = () => ({
    id: 'chatcmpl-x', object: 'chat.completion', created: 1, model: 'gpt-test',
    choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
    usage,
  })
  const cap1 = fakeFetch(response)
  const legacy = createProvider({
    protocol: 'openai', baseURL: 'https://example.test/v1', apiKey: 'k', model: 'gpt-test',
    fetch: cap1.fetch,
  })
  const lr = await legacy.chat({ model: 'gpt-test', messages: PROMPT })

  const cap2 = fakeFetch(response)
  const model = createLanguageModel({
    protocol: 'openai', preset: 'openai', baseURL: 'https://example.test/v1', apiKey: 'k', model: 'gpt-test',
  }, { fetchImpl: cap2.fetch })
  const ar = await model.doGenerate({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })

  eq(lr.content, ar.content.find((p) => p.type === 'text')?.text, 'content 一致')
  eq(lr.finishReason, aiSdkFinishReason(ar.finishReason), 'finishReason 一致')
  eq(normalizeUsage(lr.usage), normalizeAiSdkUsage(ar.usage), '归一 usage 一致（含 cache/reasoning）')
  eq(normalizeAiSdkUsage(ar.usage)?.cacheObserved, true, 'cacheObserved=true')
  eq(normalizeAiSdkUsage(ar.usage)?.uncached, 20, 'uncached=20')
  eq(cap1.calls[0].body.model, cap2.calls[0].body.model, '同一 model')
}

console.log('\n[Anthropic：content / finish / usage]')
{
  const usage = {
    input_tokens: 100,
    output_tokens: 20,
    cache_read_input_tokens: 50,
    cache_creation_input_tokens: 10,
  }
  const response = () => ({
    id: 'msg_x', type: 'message', role: 'assistant', model: 'claude-test',
    content: [{ type: 'text', text: 'hello' }], stop_reason: 'end_turn',
    usage,
  })
  const cap1 = fakeFetch(response)
  const legacy = createProvider({
    protocol: 'anthropic', baseURL: 'https://example.test', apiKey: 'k', model: 'claude-test',
    fetch: cap1.fetch,
  })
  const lr = await legacy.chat({ model: 'claude-test', messages: PROMPT, max_tokens: 64 })

  const cap2 = fakeFetch(response)
  const model = createLanguageModel({
    protocol: 'anthropic', preset: 'anthropic', baseURL: 'https://example.test', apiKey: 'k', model: 'claude-test',
  }, { fetchImpl: cap2.fetch })
  const ar = await model.doGenerate({ prompt: PROMPT, maxOutputTokens: 64 })

  eq(lr.content, ar.content.find((p) => p.type === 'text')?.text, 'content 一致')
  eq(lr.finishReason, aiSdkFinishReason(ar.finishReason, { protocol: 'anthropic' }), 'finishReason 一致')
  eq(normalizeUsage(lr.usage), normalizeAiSdkUsage(ar.usage, { protocol: 'anthropic' }), '归一 usage 一致（input 含 cache）')
  const u = normalizeAiSdkUsage(ar.usage, { protocol: 'anthropic' })
  eq([u.input, u.cacheRead, u.cacheWrite, u.uncached], [160, 50, 10, 100], 'Anthropic 输入拆分一致')
}

console.log('\n[未上报 usage：null，不伪造成 0]')
{
  // OpenAI provider 的响应可以没有 usage；legacy/AI SDK 都应保持 null/空
  const response = () => ({
    id: 'x', object: 'chat.completion', created: 1, model: 'm',
    choices: [{ index: 0, message: { role: 'assistant', content: 'x' }, finish_reason: 'stop' }],
  })
  const cap = fakeFetch(response)
  const model = createLanguageModel({ protocol: 'openai', preset: 'openai', baseURL: 'https://x/v1', apiKey: 'k', model: 'm' }, { fetchImpl: cap.fetch })
  const ar = await model.doGenerate({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })
  eq(normalizeAiSdkUsage(ar.usage), null, '无 usage → null')
}

console.log(`\n========================================`)
console.log(`通过 ${passed}，失败 ${failed}`)
console.log(`========================================`)
if (failed > 0) process.exitCode = 1
