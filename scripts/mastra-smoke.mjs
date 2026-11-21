#!/usr/bin/env node
/**
 * Mastra-only 冒烟（S11）：不启动 Yunzai、不联网。
 *  1) 默认 engine=mastra；
 *  2) 创建 LibSQL + Memory + MemoryBridge + chat runner；
 *  3) health、关闭、重复关闭。
 * 运行：node scripts/mastra-smoke.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRuntimeFacade } from '../model/runtime/factory.js'
import { SessionStore } from '../model/agent/session.js'
import { memoryKv } from '../model/agent/store/kv.js'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'yz-mastra-smoke-'))
let failed = 0
const ok = (c, m) => { console.log(c ? '  ✓' : '  ✗ FAIL', m); if (!c) failed++ }

const cfg = {
  apiKey: 'legacy-provider', model: 'smoke', protocol: 'legacy',
  runtime: { engine: 'mastra' },
  mastra: { storage: { driver: 'libsql', libsqlFile: 'smoke.db' }, closeTimeoutMs: 5_000 },
}

const t0 = Date.now()
const f = await createRuntimeFacade({
  cfg, dataDir: TMP,
  chat: { tools: null, session: new SessionStore({ kv: memoryKv() }), makeAgent: () => ({}) },
})
ok(f.engine === 'mastra' && f.mastraReady === true, 'engine=mastra / Mastra 已创建')
ok(f.chatEngine === 'mastra', 'chatRunner 就绪')
ok(!!f.history, 'MemoryBridge 已创建')
ok(fs.existsSync(path.join(TMP, 'smoke.db')), 'LibSQL 文件存在')
const h = await f.health()
ok(h.ok === true && h.history === 'mastra', `health ok / history=${h.history}`)
const t1 = Date.now()
await f.close()
await f.close()
ok(f.closed === true, '关闭幂等')
console.log(`  · 创建 ${t1 - t0}ms，关闭 ${Date.now() - t1}ms`)

fs.rmSync(TMP, { recursive: true, force: true })
console.log(`\n${failed ? `失败 ${failed}` : '通过'}`)
if (failed) process.exitCode = 1
