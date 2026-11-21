/**
 * 嵌入式 Mastra 骨架契约（PR1）：只创建/关闭，不注册 Agent、不接流量。
 *
 * 运行：node model/runtime/test/mastra-runtime.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveRuntimeConfig } from '../schemas/config.js'
import { createEmbeddedMastra } from '../mastra-runtime.js'

let passed = 0
let failed = 0
function ok(c, m) {
  if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) }
}
function eq(a, b, m) {
  const same = JSON.stringify(a) === JSON.stringify(b)
  ok(same, `${m}${same ? '' : `  (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`}`)
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'yz-mastra-runtime-'))
const config = resolveRuntimeConfig({
  runtime: { engine: 'mastra' },
  mastra: {
    storage: { driver: 'libsql', libsqlFile: 'mastra.db' },
    vector: { enable: false },
    closeTimeoutMs: 5_000,
  },
})

console.log('\n[创建 / health]')
const rt = await createEmbeddedMastra({ config, dataDir: TMP })
{
  ok(!!rt.mastra, 'Mastra 实例已创建')
  eq(rt.storage.driver, 'libsql', 'storage=libsql')
  eq(rt.vector, null, 'vector 默认关闭')
  eq(rt.memory, null, 'Phase 1 不创建 Memory')
  ok(rt.initMs >= 0, '记录初始化耗时')
  const h = await rt.health()
  eq(h.ok, true, 'health ok')
  eq(h.storage.driver, 'libsql', 'health 含 storage driver')
  ok(path.isAbsolute(h.storage.path), 'health 路径绝对')
  ok(!JSON.stringify(h).includes('MASTRA_DATABASE_URL'), 'health 不含 DSN/env')
}

console.log('\n[Memory Phase 2：创建 Memory]')
{
  const memCfg = resolveRuntimeConfig({
    runtime: { engine: 'mastra' },
    mastra: {
      storage: { driver: 'libsql', libsqlFile: 'memory.db' },
      memory: { mode: 'mastra' },
      closeTimeoutMs: 5_000,
    },
  })
  const rtm = await createEmbeddedMastra({ config: memCfg, dataDir: TMP })
  ok(!!rtm.memory, 'Memory 已创建')
  eq(rtm.describe().memory.mode, 'mastra', 'describe mode=mastra')
  eq(rtm.describe().memory.ready, true, 'describe memory ready')
  const hm = await rtm.health()
  eq(hm.memory.ready, true, 'health memory ready')
  const now = new Date()
  await rtm.memory.saveThread({ thread: { id: 'm1', resourceId: 'r1', title: 'M', createdAt: now, updatedAt: now } })
  const got = await rtm.memory.getThreadById({ threadId: 'm1', resourceId: 'r1' })
  eq(got?.title, 'M', 'Memory thread 可写读')
  await rtm.close('memory')
}

console.log('\n[重复 close 幂等]')
{
  const a = await rt.close('test')
  const b = await rt.close('second')
  eq(a.ok, true, '首次 close ok')
  eq(b.ok, true, '重复 close ok')
  eq(rt.closed, true, 'closed 标记')
}

console.log('\n[重开同一库：thread 持久化]')
{
  const rt2 = await createEmbeddedMastra({ config, dataDir: TMP })
  const mem = await rt2.storage.store.getStore('memory')
  const now = new Date()
  await mem.saveThread({ thread: { id: 'thread-1', resourceId: 'resource-1', title: 'mastra', createdAt: now, updatedAt: now } })
  await rt2.close('reopen')
  const rt3 = await createEmbeddedMastra({ config, dataDir: TMP })
  const mem3 = await rt3.storage.store.getStore('memory')
  const got = await mem3.getThreadById({ threadId: 'thread-1', resourceId: 'resource-1' })
  eq(got?.title, 'mastra', '重启后 thread 可读')
  await rt3.close('done')
}

console.log('\n[初始化失败不留半成品]')
{
  const bad = resolveRuntimeConfig({
    runtime: { engine: 'mastra' },
    mastra: { storage: { driver: 'postgres', connectionStringEnv: 'NO_SUCH_DSN_FOR_TEST' } },
  })
  let e = null
  try { await createEmbeddedMastra({ config: bad, dataDir: TMP }) } catch (err) { e = err }
  eq(e?.code, 'storage_init_failed', '缺 DSN 抛出 storage_init_failed')
}

fs.rmSync(TMP, { recursive: true, force: true })

console.log(`\n========================================`)
console.log(`通过 ${passed}，失败 ${failed}`)
console.log(`========================================`)
if (failed > 0) process.exitCode = 1
