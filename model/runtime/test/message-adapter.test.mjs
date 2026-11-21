/**
 * S6 MessageAdapter：legacy ↔ AI SDK/Mastra 消息。
 *
 * 运行：node model/runtime/test/message-adapter.test.mjs
 */
import {
  legacyToMastraMessages, mastraMessagesToLegacy, legacyContentToParts,
  currentUserContent, hasUnsupportedLegacyShape,
} from '../message-adapter.js'

let passed = 0
let failed = 0
const ok = (c, m) => { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }
const eq = (a, b, m) => { const s = JSON.stringify(a) === JSON.stringify(b); ok(s, `${m}${s ? '' : `（实际 ${JSON.stringify(a)}）`}`) }

console.log('\n[用户多模态]')
{
  const parts = legacyContentToParts([
    { type: 'text', text: '看图' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
    { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'BBB' } },
    { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'CCC' } },
    { type: 'input_audio', input_audio: { data: 'DDD', format: 'wav' } },
  ])
  eq(parts[0], { type: 'text', text: '看图' }, 'text')
  eq(parts[1], { type: 'image', image: 'data:image/png;base64,AAA' }, 'OpenAI image_url')
  eq(parts[2], { type: 'image', image: 'BBB', mediaType: 'image/jpeg' }, 'Anthropic image')
  eq(parts[3], { type: 'file', data: 'CCC', mediaType: 'application/pdf', filename: undefined }, 'Anthropic document')
  eq(parts[4], { type: 'file', data: 'DDD', mediaType: 'audio/wav' }, 'input_audio')
  const cur = currentUserContent({ content: [{ type: 'text', text: '旧' }, { type: 'image_url', image_url: { url: 'u' } }] }, '新文本')
  eq(cur[0], { type: 'text', text: '新文本' }, '当前轮文本替换注入文本')
  eq(cur[1].type, 'image', '当前轮图片保留')
}

console.log('\n[历史 ↔ Mastra]')
{
  const legacy = [
    { role: 'user', content: '你好' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'weather', arguments: '{"city":"北京"}' } }] },
    { role: 'tool', tool_call_id: 'c1', name: 'weather', content: '{"temp":22}' },
    { role: 'assistant', content: '晴 22', reasoning: '思考一下' },
  ]
  const msgs = legacyToMastraMessages(legacy)
  eq(msgs[0], { role: 'user', content: [{ type: 'text', text: '你好' }] }, 'user')
  eq(msgs[1].content[0].type, 'tool-call', 'assistant tool-call')
  eq(msgs[1].content[0].input, { city: '北京' }, 'tool-call input 对象')
  eq(msgs[2].content[0].type, 'tool-result', 'tool-result')
  eq(msgs[3].content[0], { type: 'reasoning', text: '思考一下' }, 'reasoning 保留')
}

console.log('\n[Anthropic provider_native]')
{
  const legacy = [{
    role: 'assistant', content: '答案',
    reasoning: 'thinking text',
    provider_native: {
      type: 'anthropic',
      content: [
        { type: 'thinking', thinking: 'thinking text', signature: 'sig-1' },
        { type: 'text', text: '答案' },
        { type: 'tool_use', id: 'c1', name: 'weather', input: { city: '北京' } },
      ],
    },
  }]
  const msgs = legacyToMastraMessages(legacy)
  const parts = msgs[0].content
  eq(parts[0].type, 'reasoning', 'thinking → reasoning')
  eq(parts[0].providerOptions.anthropic.signature, 'sig-1', 'signature 保留')
  eq(parts[1], { type: 'text', text: '答案' }, 'text')
  eq(parts[2].type, 'tool-call', 'tool_use → tool-call')
}

console.log('\n[Mastra → legacy]')
{
  const msgs = [{
    role: 'assistant',
    content: {
      parts: [
        { type: 'reasoning', text: '想', providerOptions: { anthropic: { signature: 's' } } },
        { type: 'tool-invocation', toolInvocation: { state: 'result', toolCallId: 'c1', toolName: 'weather', args: { city: '北京' }, result: '{"temp":22}' } },
        { type: 'text', text: '晴 22' },
      ],
    },
  }]
  const out = mastraMessagesToLegacy(msgs)
  eq(out[0].tool_calls[0].function.name, 'weather', 'tool_calls')
  eq(out[0].tool_calls[0].function.arguments, '{"city":"北京"}', 'arguments JSON')
  eq(out[1].role, 'tool', 'tool 结果')
  eq(out[2].content, '晴 22', '最终文本')
  eq(out[0].reasoning, '想', 'reasoning')
  eq(out[0].provider_native.content[0].signature, 's', 'provider_native 重建')
}

console.log('\n[未知块不丢]')
{
  const parts = legacyContentToParts([{ type: 'weird', foo: 1 }])
  eq(parts[0].type, 'text', '未知块转文本')
  ok(parts[0].text.includes('weird'), '包含原块 JSON')
  eq(hasUnsupportedLegacyShape([{ role: 'assistant', reasoning: 'x' }]), null, 'S6 不再拒绝 reasoning')
}

console.log(`\n========================================`)
console.log(`通过 ${passed}，失败 ${failed}`)
console.log(`========================================`)
if (failed > 0) process.exitCode = 1
