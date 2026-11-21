#!/usr/bin/env node
/**
 * Mastra 骨架冒烟（离线，PR1）。
 *
 * 用途：不启动 Yunzai、不联网，验证：
 *   1) 默认 legacy Facade 可创建/关闭，且不加载 Mastra；
 *   2) engine=mastra 可创建 LibSQL 骨架、health、关闭；
 *   3) 记录冷启动耗时（只记录，不承诺阈值）。
 *
 * 运行：node scripts/mastra-smoke.mjs
 * 退出码：0=通过，1=失败。临时库在系统临时目录，结束即删。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRuntimeFacade } from '../model/runtime/factory.js'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'yz-mastra-smoke-'))
let failed = 0
const ok = (c, m) => { console.log(c ? '  ✓' : '  ✗ FAIL', m); if (!c) failed++ }
const ms = (t0) => Number((process.hrtime.bigint() - t0) / 1_000_000n)

console.log('\n[1] legacy（默认）')
{
  const t0 = process.hrtime.bigint()
  const f = await createRuntimeFacade({ cfg: {}, dataDir: TMP, legacy: { runChat: async () => ({ content: 'ok', stopReason: 'stop' }) } })
  ok(f.engine === 'legacy' && f.mastraReady === false, 'engine=legacy，未创建 Mastra')
  ok((await f.runChat('hi')).content === 'ok', 'runChat 走 legacy')
  await f.close()
  console.log(`  · 创建+关闭 ${ms(t0)}ms`)
}

console.log('\n[2] mastra 骨架')
{
  const dir = path.join(TMP, 'mastra')
  fs.mkdirSync(dir, { recursive: true })
  const t0 = process.hrtime.bigint()
  const f = await createRuntimeFacade({
    cfg: {
      runtime: { engine: 'mastra' },
      mastra: { storage: { driver: 'libsql', libsqlFile: 'smoke.db' }, closeTimeoutMs: 5_000 },
    },
    dataDir: dir,
    legacy: { runChat: async () => ({ content: 'legacy-fallback', stopReason: 'stop' }) },
  })
  const created = ms(t0)
  ok(f.engine === 'mastra' && f.mastraReady === true, 'Mastra 骨架已创建')
  ok(f.chatEngine === 'legacy', 'PR1 聊天仍 legacy')
  const h = await f.health()
  ok(h.ok === true && h.storage.driver === 'libsql', 'health ok / storage=libsql')
  ok(fs.existsSync(path.join(dir, 'smoke.db')), 'LibSQL 文件存在')
  const t1 = process.hrtime.bigint()
  await f.close()
  console.log(`  · 创建 ${created}ms，关闭 ${ms(t1)}ms`)
}

fs.rmSync(TMP, { recursive: true, force: true })

console.log(`\n${failed ? `失败 ${failed}` : '通过'}`)
if (failed) process.exitCode = 1
