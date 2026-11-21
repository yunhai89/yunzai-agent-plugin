/**
 * 脚本化 AI SDK LanguageModel（PR0 fixture）。
 *
 * 形状按 AI SDK 7 / LanguageModelV4 的公开契约：
 *   - `specificationVersion: 'v4'`
 *   - `doGenerate()` → `{ content, finishReason, usage, warnings }`
 *   - `doStream()`   → `{ stream: ReadableStream<LanguageModelV4StreamPart> }`
 *
 * 说明：PR0 不安装 `ai` 依赖，因此这里只锁定**本仓库 fixture 需要的子集**；
 * PR2 接入真实 `ai` 包时，必须用官方类型校对 chunk 名称/字段，并让 parity 测试继续通过。
 * 不联网；所有输出由 steps 决定。
 */

const TEXT_CHUNK = 4

function unifiedFinish(finishReason) {
  if (finishReason === 'tool_calls') return 'tool-calls'
  return finishReason || 'stop'
}

function makeContent(step) {
  const content = []
  if (step.reasoning) content.push({ type: 'reasoning', text: step.reasoning })
  if (step.text != null && step.text !== '') content.push({ type: 'text', text: step.text })
  for (const [i, c] of (step.toolCalls || []).entries()) {
    content.push({
      type: 'tool-call',
      toolCallId: c.id || `call_${i + 1}`,
      toolName: c.name,
      input: JSON.stringify(c.arguments ?? c.args ?? {}),
    })
  }
  return content
}

function makeChunks(step) {
  const chunks = [{ type: 'stream-start', warnings: [] }]
  if (step.reasoning) {
    chunks.push({ type: 'reasoning-start', id: 'r1' })
    for (let i = 0; i < step.reasoning.length; i += TEXT_CHUNK) {
      chunks.push({ type: 'reasoning-delta', id: 'r1', delta: step.reasoning.slice(i, i + TEXT_CHUNK) })
    }
    chunks.push({ type: 'reasoning-end', id: 'r1' })
  }
  if (step.text) {
    chunks.push({ type: 'text-start', id: 't1' })
    for (let i = 0; i < step.text.length; i += TEXT_CHUNK) {
      chunks.push({ type: 'text-delta', id: 't1', delta: step.text.slice(i, i + TEXT_CHUNK) })
    }
    chunks.push({ type: 'text-end', id: 't1' })
  }
  for (const [i, c] of (step.toolCalls || []).entries()) {
    const id = c.id || `call_${i + 1}`
    const input = c.arguments ?? c.args ?? {}
    chunks.push({ type: 'tool-input-start', id, toolName: c.name })
    const json = JSON.stringify(input)
    for (let p = 0; p < json.length; p += 16) {
      chunks.push({ type: 'tool-input-delta', id, delta: json.slice(p, p + 16) })
    }
    chunks.push({ type: 'tool-input-end', id })
    // Mastra/AI SDK stream 的 tool-call.input 是 JSON 字符串（不是对象）；doGenerate 才是对象
    chunks.push({ type: 'tool-call', toolCallId: id, toolName: c.name, input: json })
  }
  chunks.push({
    type: 'finish',
    finishReason: { unified: unifiedFinish(step.finishReason), raw: step.finishReason },
    usage: step.usage || {},
  })
  return chunks
}

/**
 * @param {Array<object>} steps 与 scripted-legacy-provider 相同的 step 结构
 */
export function scriptedAiSdkModel(steps = [], { provider = 'scripted', modelId = 'scripted-v4' } = {}) {
  const list = Array.isArray(steps) && steps.length ? steps : [{ text: '' }]
  const calls = { generate: 0, stream: 0, history: [] }
  let i = 0
  const next = () => {
    const step = list[Math.min(i, list.length - 1)]
    i += 1
    return step
  }
  return {
    specificationVersion: 'v4',
    provider,
    modelId,
    supportedUrls: {},
    calls,
    async doGenerate(options = {}) {
      calls.generate += 1
      calls.history.push(options)
      const step = next()
      if (step.hook) await step.hook(options)
      if (step.delayMs) await new Promise((r) => setTimeout(r, step.delayMs))
      if (step.throw) throw new Error(step.throw)
      const usage = step.usage || {}
      return {
        content: makeContent(step),
        finishReason: unifiedFinish(step.finishReason),
        // AI SDK 7 LanguageModelV4 的 usage 是细粒度对象（inputTokens.total/cacheRead…）；
        // 同时保留 raw，方便桥接层映射回 legacy。
        usage: {

            inputTokens: {
              total: Number(usage.inputTokens) || 0,
              noCache: Math.max(0, (Number(usage.inputTokens) || 0) - (Number(usage.cachedInputTokens) || 0)),
              cacheRead: usage.cachedInputTokens == null ? undefined : Number(usage.cachedInputTokens) || 0,
              cacheWrite: undefined,
            },
            outputTokens: {
              total: Number(usage.outputTokens) || 0,
              text: Number(usage.outputTokens) || 0,
              reasoning: usage.reasoningTokens == null ? undefined : Number(usage.reasoningTokens) || 0,
            },
            raw: { prompt_tokens: Number(usage.inputTokens) || 0, completion_tokens: Number(usage.outputTokens) || 0 },
          },
        warnings: [],
        response: { id: `resp_${calls.generate}`, timestamp: new Date(0), modelId },
      }
    },
    async doStream(options = {}) {
      calls.stream += 1
      calls.history.push(options)
      const step = next()
      if (step.hook) await step.hook(options)
      const chunks = step.chunks || makeChunks(step)
      const stream = new ReadableStream({
        start(controller) {
          for (const c of chunks) controller.enqueue(c)
          controller.close()
        },
      })
      return { stream, response: { id: `stream_${calls.stream}`, timestamp: new Date(0), modelId } }
    },
  }
}
