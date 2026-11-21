/**
 * PR3a 接线回归：真实 `apps/agent.js` 装配出的 ToolRegistry → 只读 Mastra 工具集。
 *
 * 验证：
 *  - 真实内置工具（web_search/memory_search/kb_search/context_recall/calculate/reminder_list）被适配；
 *  - 写工具被过滤；
 *  - 名称映射全部合法（≤63、可反向）；
 *  - 真实工具 execute 经 RequestContext 读到 ctx（reminder_list 空结果）。
 *
 * 运行：node --import ./stress/e2e/hooks.mjs stress/e2e/tool-adapter-wiring.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { RequestContext } from '@mastra/core/request-context'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), `e2e-tool-adapter-${process.pid}-`))
process.env.E2E_TMP = TMP
process.env.E2E_REAL_AGENT = '1'
await import(pathToFileURL(path.join(import.meta.dirname, 'hooks.mjs')).href)

const cfgMod = await import('./stubs/Config.js')
cfgMod.__setConfig({ agent: {
  apiKey: 'sk-offline-fixture', model: 'offline-fixture',
  devLog: { dir: path.join(TMP, 'devlog') },
  multiagent: { enable: false }, sandbox: { mode: 'off' },
  toolEvo: { enable: false }, sticker: { enable: false },
  tools: { builtin: true }, schedule: { taskEnabled: false },
  webApi: { enable: false }, skill: { dir: path.join(TMP, 'skills') },
  qqBot: { enable: false },
} })

let passed = 0
let failed = 0
const ok = (c, m) => { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m}${JSON.stringify(a) === JSON.stringify(b) ? '' : `（实际 ${JSON.stringify(a)}）`}`)

const { getRuntime } = await import('../../apps/agent.js')
const guard = await import('../../model/agent/guard.js')
const { adaptReadonlyTools } = await import('../../model/runtime/tool-adapter.js')

const rt = await getRuntime()
const adapted = adaptReadonlyTools(rt.tools, { maxToolResultChars: 8000, guard, untrustedGuard: true })
const names = Object.keys(adapted.tools)

console.log('\n[真实内置只读工具]')
{
  for (const name of ['web_search', 'memory_search', 'kb_search', 'context_recall', 'calculate', 'reminder_list']) {
    ok(!!adapted.tools[name], `${name} 已适配`)
  }
  ok(adapted.entries.length > 20, `只读工具数量 ${adapted.entries.length}`)
  ok(adapted.skipped.length > 0, `写工具被过滤 ${adapted.skipped.length} 个`)
  ok(adapted.entries.every((e) => e.effect === 'read'), '全部为 effect=read')
  eq(adapted.names.mastraName('web_search'), 'web_search', 'ASCII 名称不变')
  ok(names.every((n) => n.length <= 63 && /^[A-Za-z0-9_-]+$/.test(n)), '所有 Mastra 名合法')
  ok(names.every((n) => adapted.names.legacyName(n)), '所有 Mastra 名可反向')
}

console.log('\n[真实工具 execute + ctx]')
{
  const rc = new RequestContext()
  rc.set('yz.ctx', { userId: 'e2e-user', scopeUserId: 'e2e-user', groupId: 'e2e-group', isGroup: true })
  const t = adapted.tools.reminder_list
  const out = await t.execute({}, { requestContext: rc })
  const o = JSON.parse(out)
  eq(o.count, 0, 'reminder_list 读取当前用户（空）')
  ok(typeof o.note === 'string', '返回可读结果')
}

await rt.scope.close('e2e')
fs.rmSync(TMP, { recursive: true, force: true })

console.log(`\n========================================`)
console.log(`通过 ${passed}，失败 ${failed}`)
console.log(`========================================`)
if (failed > 0) process.exitCode = 1
