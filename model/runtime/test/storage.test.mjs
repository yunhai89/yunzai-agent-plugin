/**
 * Storage / Vector Factory 契约（PR1）。
 *
 * 覆盖：LibSQL 绝对路径、:memory:、相对 file: 拒绝、重启持久化、关闭幂等、
 * Vector 创建/关闭、Postgres 缺 DSN fail-closed（有 MASTRA_TEST_DATABASE_URL 时可选跑）。
 *
 * 运行：node model/runtime/test/storage.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  createStorage, createVector, createStorageBundle, resolveLibsqlUrl,
} from '../storage-factory.js'

let passed = 0
let failed = 0
function ok(c, m) {
  if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) }
}
function eq(a, b, m) {
  const same = JSON.stringify(a) === JSON.stringify(b)
  ok(same, `${m}${same ? '' : `  (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`}`)
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'yz-mastra-storage-'))

console.log('\n[LibSQL 路径解析]')
{
  const t = resolveLibsqlUrl({ libsqlFile: 'mastra/test.db' }, { dataDir: TMP })
  eq(t.url, `file:${path.join(TMP, 'mastra/test.db')}`, '相对 dataDir → 绝对 file:')
  ok(path.isAbsolute(t.path), 'path 为绝对路径')
  eq(resolveLibsqlUrl({ libsqlUrl: ':memory:' }, {}).url, 'file::memory:', ':memory: 支持')
  eq(resolveLibsqlUrl({ libsqlUrl: `file:${path.join(TMP, 'x.db')}` }, {}).url, `file:${path.join(TMP, 'x.db')}`, '绝对 file: 保留')
  let e = null
  try { resolveLibsqlUrl({ libsqlUrl: 'file:relative.db' }, {}) } catch (err) { e = err }
  eq(e?.code, 'runtime_config_invalid', '相对 file: 拒绝（防 cwd 打开不同库）')
}

console.log('\n[LibSQL 初始化 / 关闭 / 重开持久化]')
{
  const cfg = { driver: 'libsql', libsqlFile: 'persist/test.db' }
  const s1 = await createStorage(cfg, { dataDir: TMP })
  eq(s1.driver, 'libsql', 'driver=libsql')
  eq(s1.describe().path, path.join(TMP, 'persist/test.db'), 'describe 路径绝对')
  eq(await s1.ping(), true, 'ping 成功')
  const mem1 = await s1.store.getStore('memory')
  const now = new Date()
  await mem1.saveThread({ thread: { id: 't1', resourceId: 'r1', title: 'persist', createdAt: now, updatedAt: now } })
  await s1.close()
  await s1.close() // 幂等
  ok(fs.existsSync(path.join(TMP, 'persist/test.db')), '数据库文件已落盘')

  const s2 = await createStorage(cfg, { dataDir: TMP })
  const mem2 = await s2.store.getStore('memory')
  const got = await mem2.getThreadById({ threadId: 't1', resourceId: 'r1' })
  eq(got?.title, 'persist', '重启后 thread 仍可读')
  await s2.close()
}

console.log('\n[:memory: 单测]')
{
  const s = await createStorage({ driver: 'libsql', libsqlUrl: ':memory:' }, {})
  eq(s.describe().memory, true, 'memory 标记')
  eq(await s.ping(), true, 'ping 成功')
  await s.close()
}

console.log('\n[Vector 创建/关闭]')
{
  const s = await createStorage({ driver: 'libsql', libsqlFile: 'vector/base.db' }, { dataDir: TMP })
  const v = await createVector({ enable: true, driver: 'libsql', indexName: 'yz_test', dimensions: 8 }, { storage: s, dataDir: TMP })
  ok(!!v, 'vector 已创建')
  eq(v.describe().indexName, 'yz_test', 'indexName 保留')
  await v.store.createIndex({ indexName: 'yz_test', dimension: 8, metric: 'cosine' })
  eq((await v.store.listIndexes()).includes('yz_test'), true, '索引可创建/列出')
  await v.close()
  await s.close()
}

console.log('\n[Bundle：vector 关闭失败不阻断 storage]')
{
  const b = await createStorageBundle({ storage: { driver: 'libsql', libsqlFile: 'bundle/b.db' }, vector: { enable: false } }, { dataDir: TMP })
  eq(await b.ping(), true, 'bundle ping')
  await b.close()
  const again = await b.ping().catch(() => false)
  eq(again, false, '关闭后 ping=false')
}

console.log('\n[Postgres：缺 DSN fail-closed]')
{
  const old = process.env.MASTRA_TEST_DATABASE_URL
  delete process.env.MASTRA_TEST_DATABASE_URL
  let e = null
  try {
    await createStorage({ driver: 'postgres', connectionStringEnv: 'MASTRA_TEST_DATABASE_URL' }, { dataDir: TMP })
  } catch (err) { e = err }
  eq(e?.code, 'storage_init_failed', '缺少 DSN → storage_init_failed')
  ok(!String(e?.message || '').includes('postgres://'), '错误消息不含 DSN')
  if (old) process.env.MASTRA_TEST_DATABASE_URL = old
}

console.log('\n[Postgres：可选真实测试]')
{
  if (!process.env.MASTRA_TEST_DATABASE_URL) {
    console.log('  ⊘ SKIP 未设置 MASTRA_TEST_DATABASE_URL')
  } else {
    const s = await createStorage({ driver: 'postgres', connectionStringEnv: 'MASTRA_TEST_DATABASE_URL', schemaName: 'mastra' }, {})
    eq(await s.ping(), true, 'Postgres ping')
    await s.close()
  }
}

fs.rmSync(TMP, { recursive: true, force: true })

console.log(`\n========================================`)
console.log(`通过 ${passed}，失败 ${failed}`)
console.log(`========================================`)
if (failed > 0) process.exitCode = 1
