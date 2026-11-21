/**
 * AI SDK 流式/非流式桥契约（PR0 fixture）。
 *
 * 锁定：
 *   - `doStream` 的 text-delta / tool-input-start|delta|end / tool-call / finish 能聚合出与
 *     `doGenerate` 等价的 AssistantResult；
 *   - finishReason `tool-calls → tool_calls`；
 *   - usage 只在 Provider 上报时非 null（未观测 ≠ 0）。
 *
 * PR2 接入真实 `ai` 包后，用官方类型复核 chunk 名称；本测试继续作为映射回归。
 *
 * 运行：node model/runtime/test/contracts/ai-sdk-bridge.test.mjs
 */
import { scriptedAiSdkModel } from '../fixtures/scripted-model.js'
import { aggregateStream, generateResultToAssistant } from '../fixtures/ai-sdk-bridge.js'
import { SCENARIOS } from '../fixtures/scenarios.js'

let passed = 0
let failed = 0
function ok(c, m) {
  if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) }
}
function eq(a, b, m) {
  const same = JSON.stringify(a) === JSON.stringify(b)
  ok(same, `${m}${same ? '' : `  (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`}`)
}

console.log('\n[流式聚合：纯文本]')
{
  const steps = [{ text: '流式纯文本回复', usage: { inputTokens: 12, outputTokens: 6, totalTokens: 18 } }]
  const model = scriptedAiSdkModel(steps)
  const gen = generateResultToAssistant(await model.doGenerate({}))
  const { stream } = await model.doStream({})
  const agg = await aggregateStream(stream)
  eq(agg.content, gen.content, 'text 聚合一致')
  eq(agg.finishReason, gen.finishReason, 'finishReason 一致')
  eq(agg.usage, gen.usage, 'usage 一致')
  eq(agg.toolCalls, [], '无工具调用')
}

console.log('\n[流式聚合：工具调用]')
{
  const steps = [{
    text: '先查天气',
    toolCalls: [
      { id: 'c1', name: 'weather', arguments: { city: '北京' } },
      { id: 'c2', name: 'weather', arguments: { city: '上海' } },
    ],
    finishReason: 'tool_calls',
  }]
  const model = scriptedAiSdkModel(steps)
  const gen = generateResultToAssistant(await model.doGenerate({}))
  const { stream } = await model.doStream({})
  const agg = await aggregateStream(stream)
  eq(agg.content, gen.content, '文本 + 工具调用文本一致')
  eq(agg.toolCalls.length, 2, '两个工具调用')
  eq(agg.toolCalls[0].arguments, { city: '北京' }, '工具入参由 input delta 还原（1）')
  eq(agg.toolCalls[1].arguments, { city: '上海' }, '工具入参由 input delta 还原（2）')
  eq(agg.finishReason, 'tool_calls', 'finishReason tool-calls → tool_calls')
  eq(agg.usage, null, '未上报 usage 时为 null，不是 0')
}

console.log('\n[场景 P2：流式与场景 step 对齐]')
{
  const scenario = SCENARIOS.find((s) => s.id === 'P2')
  const model = scriptedAiSdkModel(scenario.steps)
  const { stream } = await model.doStream({})
  const agg = await aggregateStream(stream)
  eq(agg.toolCalls[0].name, 'weather', '场景工具名一致')
  eq(agg.toolCalls[0].arguments, { city: '北京' }, '场景工具入参一致')
}

console.log(`\n========================================`)
console.log(`通过 ${passed}，失败 ${failed}`)
console.log(`========================================`)
if (failed > 0) process.exitCode = 1
