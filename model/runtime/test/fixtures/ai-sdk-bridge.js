/**
 * AI SDK 模型 → legacy AssistantResult 的桥（PR0 fixture，不接生产）。
 *
 * 作用：让 parity harness 在 PR0 就能用同一组 steps 驱动
 *   legacy Provider  → 真实 Agent
 *   AI SDK model     → 本桥 → 真实 Agent
 * 从而先锁定「chunk/字段映射」契约。PR2 的 ModelFactory / PR4 的 Mastra Runner 必须保持
 * 同一组断言；届时本文件可替换为真实实现，测试名与场景不变。
 */
import { toOpenAIUsage } from './usage.js'

function parseInput(input) {
  if (input == null) return {}
  if (typeof input === 'string') {
    try { return JSON.parse(input) } catch { return {} }
  }
  return input
}

function legacyFinish(reason) {
  const r = reason && typeof reason === 'object' ? (reason.unified || reason.raw) : reason
  if (r === 'tool-calls') return 'tool_calls'
  return r || 'stop'
}

/** 把 AI SDK doGenerate 的结果转成 AssistantResult */
export function generateResultToAssistant(result) {
  let text = ''
  let reasoning = ''
  const toolCalls = []
  for (const part of result?.content || []) {
    if (part?.type === 'text') text += part.text || ''
    else if (part?.type === 'reasoning') reasoning += part.text || ''
    else if (part?.type === 'tool-call') {
      toolCalls.push({
        id: part.toolCallId || `call_${toolCalls.length + 1}`,
        name: part.toolName,
        arguments: parseInput(part.input),
      })
    }
  }
  return {
    role: 'assistant',
    content: text,
    toolCalls,
    reasoning: reasoning || null,
    finishReason: legacyFinish(result?.finishReason),
    usage: toOpenAIUsage(result?.usage),
    rawMessage: result,
  }
}

/** 聚合 AI SDK 流式 chunk → AssistantResult（PR4 流式桥的预演；当前仅测试） */
export async function aggregateStream(stream) {
  let text = ''
  let reasoning = ''
  const calls = new Map()
  let finishReason = 'stop'
  let usage = null
  const reader = stream.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      const c = value
      if (c?.type === 'text-delta') text += c.delta || ''
      else if (c?.type === 'reasoning-delta') reasoning += c.delta || ''
      else if (c?.type === 'tool-input-start') {
        calls.set(c.id, { id: c.id, name: c.toolName, json: '' })
      } else if (c?.type === 'tool-input-delta') {
        const t = calls.get(c.id)
        if (t) t.json += c.delta || ''
      } else if (c?.type === 'tool-call') {
        calls.set(c.toolCallId, { id: c.toolCallId, name: c.toolName, input: c.input })
      } else if (c?.type === 'finish') {
        finishReason = legacyFinish(c.finishReason)
        usage = toOpenAIUsage(c.usage)
      }
    }
  } finally {
    reader.releaseLock()
  }
  const toolCalls = [...calls.values()].map((t) => ({
    id: t.id,
    name: t.name,
    arguments: t.input !== undefined ? parseInput(t.input) : parseInput(t.json),
  }))
  return {
    role: 'assistant',
    content: text,
    toolCalls,
    reasoning: reasoning || null,
    finishReason,
    usage,
    rawMessage: null,
  }
}

/** 让脚本化 AI SDK model 可直接放进 Agent 的 provider 槽位 */
export function aiSdkModelToLegacyProvider(model) {
  const calls = []
  return {
    calls,
    async chat(opts = {}) {
      calls.push(opts)
      const result = await model.doGenerate(opts)
      return generateResultToAssistant(result)
    },
  }
}
