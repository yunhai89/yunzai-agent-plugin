/**
 * PR1 接线回归：真实 `apps/agent.js` 构建运行时 → Facade →（engine=mastra）创建骨架。
 *
 * 覆盖：
 *  - 默认 legacy：rt.runtime 存在、未创建 Mastra/DB；
 *  - 热加载切 mastra：重建运行时，创建 LibSQL 骨架（临时目录），health ok；
 *  - 再切回 legacy：Facade 重建，旧 Mastra 关闭；
 *  - scope.close 后 facade.closed=true。
 *
 * 运行：node --import ./stress/e2e/hooks.mjs stress/e2e/runtime-facade-wiring.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), `e2e-runtime-facade-${process.pid}-`))
process.env.E2E_TMP = TMP
process.env.E2E_REAL_AGENT = '1'
await import(pathToFileURL(path.join(import.meta.dirname, 'hooks.mjs')).href)

const cfgMod = await import('./stubs/Config.js')
const base = {
  apiKey: 'sk-offline-fixture', model: 'offline-fixture',
  devLog: { dir: path.join(TMP, 'devlog') },
  multiagent: { enable: false }, sandbox: { mode: 'off' },
  toolEvo: { enable: false }, sticker: { enable: false },
  tools: { builtin: false }, schedule: { taskEnabled: false },
  webApi: { enable: false }, skill: { dir: path.join(TMP, 'skills') },
  qqBot: { enable: false },
  runtime: { engine: 'legacy' },
  mastra: { storage: { driver: 'libsql', libsqlFile: 'mastra/e2e.db' }, closeTimeoutMs: 5_000 },
}
cfgMod.__setConfig({ agent: base })

let passed = 0
let failed = 0
const ok = (c, m) => { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }

const { getRuntime } = await import('../../apps/agent.js')

console.log('\n[legacy：不加载 Mastra]')
{
  const rt = await getRuntime()
  ok(!!rt.runtime, 'rt.runtime 已装配')
  ok(rt.runtime.engine === 'legacy', 'engine=legacy')
  ok(rt.runtime.mastraReady === false, '未创建 Mastra')
  ok(!fs.existsSync(path.join(TMP, 'mastra/e2e.db')), '未创建 LibSQL 文件')
  const h = await rt.runtime.health()
  ok(h.ok === true, 'health ok')
}

console.log('\n[热加载切 mastra：创建骨架]')
{
  cfgMod.__setConfig({ agent: { ...base, runtime: { engine: 'mastra' } } })
  cfgMod.__emitChange()
  const rt = await getRuntime()
  ok(rt.runtime.engine === 'mastra', 'engine=mastra')
  ok(rt.runtime.mastraReady === true, 'Mastra 骨架已创建')
  ok(rt.runtime.chatEngine === 'mastra', 'Mastra 非流式 Runner 已就绪')
  ok(rt.runtime.shouldUseMastra({ userId: 'not-gray' }) === false, '未配置灰度不切聊天流量')
  ok(fs.existsSync(path.join(TMP, 'mastra/e2e.db')), 'LibSQL 文件已创建（临时目录）')
  const h = await rt.runtime.health()
  ok(h.ok === true, 'health ok')
  ok(h.storage.driver === 'libsql', 'storage=libsql')
}

console.log('\n[切回 legacy：旧 Mastra 关闭]')
{
  cfgMod.__setConfig({ agent: { ...base, runtime: { engine: 'legacy' } } })
  cfgMod.__emitChange()
  const rt = await getRuntime()
  ok(rt.runtime.engine === 'legacy', 'engine=legacy')
  ok(rt.runtime.mastraReady === false, '新 Facade 无 Mastra')
  ok(fs.existsSync(path.join(TMP, 'mastra/e2e.db')), '旧库文件保留（不删数据）')
}

console.log('\n[scope.close：Facade 关闭]')
{
  const rt = await getRuntime()
  await rt.scope.close('e2e')
  ok(rt.runtime.closed === true, 'scope.close 关闭 Facade')
}

console.log(`\n========================================`)
console.log(`通过 ${passed}，失败 ${failed}`)
console.log(`========================================`)
if (failed > 0) process.exitCode = 1
