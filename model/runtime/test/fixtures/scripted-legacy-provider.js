/**
 * 脚本化 legacy Provider（PR0 fixture）。
 *
 * 与 `model/agent/test.mjs` 的内联 mockProvider 等价，但独立成文件供 parity harness 复用：
 * 同一组 `steps` 同时驱动 legacy Provider 与脚本化 AI SDK model，避免两边场景漂移。
 *
 * 运行：仅离线测试使用；不联网、不读写配置。
 */
import { toOpenAIUsage } from './usage.js'

function normalizeCall(c, i) {
  return {
    id: c.id || `call_${i + 1}`,
    name: c.name,
    arguments: c.arguments ?? c.args ?? {},
  }
}

/**
 * @param {Array<{text?:string, toolCalls?:Array<{id?:string,name:string,arguments?:object}>, reasoning?:string, finishReason?:string, usage?:object, delayMs?:number, hook?:Function, throw?:string}>} steps
 * @returns {{ calls: object[], chat: Function }}
 */
export function scriptedLegacyProvider(steps = []) {
  const list = Array.isArray(steps) && steps.length ? steps : [{ text: '' }]
  const calls = []
  let i = 0
  return {
    calls,
    async chat(opts = {}) {
      calls.push(opts)
      const step = list[Math.min(i, list.length - 1)]
      i += 1
      if (step.hook) await step.hook(opts)
      if (step.delayMs) await new Promise((r) => setTimeout(r, step.delayMs))
      if (step.throw) throw new Error(step.throw)
      const toolCalls = (step.toolCalls || []).map(normalizeCall)
      return {
        role: 'assistant',
        content: step.text ?? '',
        toolCalls,
        reasoning: step.reasoning ?? null,
        finishReason: step.finishReason ?? (toolCalls.length ? 'tool_calls' : 'stop'),
        usage: toOpenAIUsage(step.usage),
        rawMessage: {},
      }
    },
  }
}
