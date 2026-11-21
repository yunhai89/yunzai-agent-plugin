/**
 * Parity harness（PR0 骨架）。
 *
 * 目的：把「同一 fixture、同一脚本化模型输出」下的行为差异变成可重复断言。
 * 当前 mastra 侧尚未接线，因此 bridge 侧用 `scriptedAiSdkModel → ai-sdk-bridge → 真实 Agent`
 * 预演 AI SDK → legacy 结果映射；PR2/PR4 接线后，把 bridge runner 换成真实 ModelFactory /
 * Mastra Runner 即可，场景与比较器不变。
 *
 * 只读：不联网、不写配置/数据库。
 */
import { Agent } from '../../../agent/Agent.js'
import { ToolRegistry } from '../../../agent/tools/registry.js'
import { createPolicy } from '../../../agent/policy.js'
import * as guard from '../../../agent/guard.js'
import { normalizeUsage } from '../../../agent/messages.js'
import { scriptedLegacyProvider } from './scripted-legacy-provider.js'
import { scriptedAiSdkModel } from './scripted-model.js'
import { aiSdkModelToLegacyProvider } from './ai-sdk-bridge.js'
import { SCENARIOS, createScenarioState, scenarioSnapshot } from './scenarios.js'

const CTX = Object.freeze({
  userId: 'fixture-user',
  scopeUserId: 'fixture-user',
  groupId: 'fixture-group',
  isGroup: true,
  role: 'member',
  isMaster: false,
  adapterKind: 'onebot',
  adapterId: 'OneBot11',
})

function parseContent(text) {
  if (typeof text !== 'string') return text
  try { return JSON.parse(text) } catch { return text }
}

function traceOfResult(res, scenario, state) {
  const toolCalls = []
  const toolResults = []
  for (const m of res.messages || []) {
    if (m?.role === 'assistant' && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        toolCalls.push({
          name: tc?.function?.name || tc?.name || '',
          args: (() => {
            const a = tc?.function?.arguments ?? tc?.arguments
            if (typeof a === 'string') { try { return JSON.parse(a) } catch { return a } }
            return a
          })(),
        })
      }
    } else if (m?.role === 'tool') {
      toolResults.push({ name: m.name, raw: m.content, content: parseContent(m.content) })
    }
  }
  return {
    finalContent: res.content,
    stopReason: res.stopReason,
    turns: res.turns,
    usage: normalizeUsage(res.usage),
    toolCalls,
    toolResults,
    state: scenarioSnapshot(state),
  }
}

function traceOfError(e, scenario, state) {
  return { error: e?.message || String(e), state: scenarioSnapshot(state) }
}

function makeAgent(provider, scenario, state, controller) {
  const tools = scenario.tools(state, controller)
  return new Agent({
    provider,
    tools: new ToolRegistry().register(tools),
    maxTurns: scenario.maxTurns ?? 20,
    reflect: 'off',
    loop: scenario.loop || false,
    policy: createPolicy(),
    confirm: scenario.confirm
      ? { request: async () => scenario.confirm === 'approve' }
      : null,
    maxToolResultChars: scenario.maxToolResultChars ?? 8000,
    untrustedGuard: true,
    guard: scenario.injection ? guard : null,
    contextWindow: 200000,
    logger: () => {},
  })
}

async function execute(scenario, providerFactory) {
  const state = createScenarioState()
  const controller = new AbortController()
  const provider = providerFactory(scenario, state, controller)
  const agent = makeAgent(provider, scenario, state, controller)
  try {
    const res = await agent.run(`fixture:${scenario.id}`, { signal: controller.signal, ctx: { ...CTX, ...(scenario.ctx || {}) } })
    return traceOfResult(res, scenario, state)
  } catch (e) {
    return traceOfError(e, scenario, state)
  }
}

/** legacy 侧：脚本化 legacy Provider → 真实 Agent */
export function runLegacyScenario(scenario) {
  return execute(scenario, (sc) => scriptedLegacyProvider(sc.steps))
}

/** bridge 侧：脚本化 AI SDK model → ai-sdk-bridge → 真实 Agent（PR4 换真实 Runner） */
export function runBridgeScenario(scenario) {
  return execute(scenario, (sc) => {
    const model = scriptedAiSdkModel(sc.steps)
    return aiSdkModelToLegacyProvider(model)
  })
}

/** 结构化 diff，失败信息直接指出字段 */
export function diffTraces(a, b) {
  const out = []
  const walk = (x, y, path) => {
    if (x === y) return
    if (typeof x !== typeof y) { out.push(`${path}: ${JSON.stringify(x)} !== ${JSON.stringify(y)}`); return }
    if (x == null || y == null) { out.push(`${path}: ${JSON.stringify(x)} !== ${JSON.stringify(y)}`); return }
    if (typeof x !== 'object') { out.push(`${path}: ${JSON.stringify(x)} !== ${JSON.stringify(y)}`); return }
    if (Array.isArray(x) !== Array.isArray(y)) { out.push(`${path}: array mismatch`); return }
    if (Array.isArray(x)) {
      if (x.length !== y.length) out.push(`${path}.length: ${x.length} !== ${y.length}`)
      for (let i = 0; i < Math.min(x.length, y.length); i++) walk(x[i], y[i], `${path}[${i}]`)
      return
    }
    const keys = new Set([...Object.keys(x), ...Object.keys(y)])
    for (const k of keys) walk(x[k], y[k], `${path}.${k}`)
  }
  walk(a, b, '$')
  return out
}

export async function runAllScenarios() {
  const results = []
  for (const scenario of SCENARIOS) {
    const legacy = await runLegacyScenario(scenario)
    const bridge = await runBridgeScenario(scenario)
    results.push({ scenario, legacy, bridge, diff: diffTraces(legacy, bridge) })
  }
  return results
}
