console.log('SKIP_FILE: legacy handwritten Agent kernel removed (S11)')
process.exit(0)

/**
 * Parity harness 门禁（PR0）：P1–P14。
 *
 * 当前 bridge 侧 = 脚本化 AI SDK model → ai-sdk-bridge → 真实 Agent；
 * legacy 侧 = 脚本化 legacy Provider → 真实 Agent。
 * 两侧 trace 必须逐字段一致（错误场景比 error；成功场景比 content/stopReason/turns/usage/
 * toolCalls/toolResults/state），并逐项检查场景预期。
 *
 * PR4 后把 runBridgeScenario 替换为真实 Mastra Runner；本文件的场景与断言不变。
 *
 * 运行：node model/runtime/test/parity.test.mjs
 */
import { SCENARIOS } from './fixtures/scenarios.js'
import { runLegacyScenario, runBridgeScenario, diffTraces } from './fixtures/parity-harness.js'

let passed = 0
let failed = 0
function ok(c, m) {
  if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) }
}

for (const scenario of SCENARIOS) {
  console.log(`\n[${scenario.id} · ${scenario.name}]`)
  const legacy = await runLegacyScenario(scenario)
  const bridge = await runBridgeScenario(scenario)

  const diff = diffTraces(legacy, bridge)
  ok(diff.length === 0, `legacy/bridge trace 一致${diff.length ? `：${diff.slice(0, 6).join('；')}` : ''}`)

  for (const [cond, label] of scenario.expect(legacy)) ok(!!cond, label)
  for (const [cond, label] of scenario.expect(bridge)) ok(!!cond, `${label}（bridge）`)
}

console.log(`\n========================================`)
console.log(`通过 ${passed}，失败 ${failed}`)
console.log(`========================================`)
if (failed > 0) process.exitCode = 1
