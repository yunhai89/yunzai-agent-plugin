#!/usr/bin/env node
/**
 * S7 / Memory Phase 2 迁移脚本。
 *
 * 用法（默认只读 inventory；--apply 需要 --yes）：
 *   node scripts/migrate-mastra.mjs --source-json dump.json --dry-run
 *   node scripts/migrate-mastra.mjs --redis-url redis://127.0.0.1:6379 --inventory --json
 *   node scripts/migrate-mastra.mjs --source-json dump.json --apply --yes \
 *     --checkpoint data/mastra/migration-checkpoint.json --backup-dir data/mastra/backup
 *   node scripts/migrate-mastra.mjs --source-json dump.json --verify --sample 50
 *   node scripts/migrate-mastra.mjs --rollback --checkpoint data/mastra/migration-checkpoint.json --yes
 *
 * 说明：
 *  - 源：SessionStore conversation（KV 导出或 Redis 实时扫描）；legacy 只读。
 *  - 目标：Mastra Memory（LibSQL/Postgres，由 agent.mastra.storage 决定）。
 *  - 不打印 API Key/DSN；不修改 config.yaml；不双写。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Config from '../utils/Config.js'
import { planMigration, applyMigration, verifyMigration, rollbackMigration, summarizeMigration, MIGRATION_VERSION } from '../model/runtime/memory-migrate.js'
import { MastraMemoryBridge } from '../model/runtime/memory-bridge.js'
import { createStorageBundle } from '../model/runtime/storage-factory.js'
import { CompactionArchive } from '../model/agent/compact/archive.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SESSION_PREFIX = 'Yz:agent:sess:'

function parseArgs(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) { out._.push(a); continue }
    const key = a.slice(2)
    if (key === 'yes' || key === 'json' || key === 'dry-run' || key === 'apply' || key === 'verify' || key === 'rollback' || key === 'inventory' || key === 'init-storage' || key === 'help') out[key] = true
    else { out[key] = argv[++i] }
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
if (args.help) {
  console.log(`用法：
  node scripts/migrate-mastra.mjs --source-json <file> [--inventory|--dry-run|--apply --yes|--verify|--rollback --yes]
  node scripts/migrate-mastra.mjs --redis-url <url> [--dump-source <file>]
选项：--bot-id --adapter --target libsql|postgres --checkpoint --backup-dir --report --archive-dir --sample --json`)
  process.exit(0)
}

const cfg = Config.get().agent || {}
const dataDir = Config.path?.data || path.join(ROOT, 'data')
const mastraCfg = JSON.parse(JSON.stringify(cfg.mastra || {}))
if (args.target) mastraCfg.storage = { ...(mastraCfg.storage || {}), driver: args.target }
if (args['libsql-url']) mastraCfg.storage = { ...(mastraCfg.storage || {}), driver: 'libsql', libsqlUrl: args['libsql-url'] }
const botId = String(args['bot-id'] || mastraCfg.identity?.botId || '')
const adapter = String(args.adapter || mastraCfg.identity?.adapter || 'onebot')
const checkpointFile = String(args.checkpoint || path.join(dataDir, 'mastra/migration-checkpoint.json'))
const backupDir = args['backup-dir'] ? path.resolve(args['backup-dir']) : path.join(dataDir, 'mastra/backup')
const reportFile = args.report ? path.resolve(args.report) : ''
const archiveDir = path.resolve(args['archive-dir'] || path.join(ROOT, cfg.compaction?.archiveDir || 'data/context-archive'))
const jsonMode = args.json === true

function log(...a) { if (!jsonMode) console.log(...a) }
function emit(obj) {
  const text = JSON.stringify(obj, null, 2)
  if (reportFile) {
    fs.mkdirSync(path.dirname(reportFile), { recursive: true })
    fs.writeFileSync(reportFile, text)
    log(`报告已写入 ${reportFile}`)
  }
  if (jsonMode) console.log(text)
}

function noopKv() {
  return { async get() { return null }, async set() {}, async del() {}, async scan() { return [] } }
}

function parseConversationKey(key) {
  const tail = String(key).slice(SESSION_PREFIX.length)
  if (!tail.startsWith('conv:')) return null
  if (tail.startsWith('conv:active:') || tail.startsWith('conv:seq:')) return null
  const rest = tail.slice('conv:'.length)
  const parts = rest.split(':')
  if (parts.length < 3) return null
  const convId = parts[parts.length - 1]
  const userId = parts[parts.length - 2]
  const groupId = parts.slice(0, -2).join(':') || 'private'
  return { convId, userId, groupId }
}

async function loadRedisSource(url, { dumpSource = '' } = {}) {
  let createClient
  try {
    ({ createClient } = await import('redis'))
  } catch (e) {
    throw new Error(`缺少 redis 客户端；请在 Yunzai 根目录运行或改用 --source-json（${e?.message || e}）`)
  }
  const client = createClient({ url })
  client.on?.('error', () => {})
  await client.connect()
  const conversations = []
  const warnings = []
  try {
    const keys = await client.keys(`${SESSION_PREFIX}conv:*`)
    for (const key of keys) {
      if (String(key).includes(':conv:active:') || String(key).includes(':conv:seq:')) continue
      const raw = await client.get(key)
      if (!raw) continue
      let rec
      try { rec = JSON.parse(raw) } catch { warnings.push({ key, message: 'value 不是 JSON，跳过' }); continue }
      if (!rec || !Array.isArray(rec.messages)) continue
      const parsed = parseConversationKey(key)
      if (!parsed) continue
      const hasMeta = rec.scopeUserId != null
      if (!hasMeta) warnings.push({ key, message: '缺少 scopeUserId 元数据，回退键名解析（官方 ID 可能不准确）' })
      conversations.push({
        key,
        scopeUserId: rec.scopeUserId != null ? String(rec.scopeUserId) : parsed.userId,
        scopeGroupId: rec.scopeGroupId != null ? String(rec.scopeGroupId) : (parsed.groupId === 'private' ? '' : parsed.groupId),
        conversationId: String(rec.id ?? parsed.convId),
        title: rec.title || '',
        createdAt: rec.createdAt,
        updatedAt: rec.updatedAt,
        messages: rec.messages,
        cacheEpoch: rec.cacheEpoch,
        compactLedger: rec.compactLedger,
        activeTools: rec.activeTools,
        parseWarning: hasMeta ? '' : 'key-parse',
      })
    }
  } finally {
    try { await client.quit() } catch { /* noop */ }
  }
  const out = { version: 1, generatedAt: Date.now(), botId, adapter, conversations, warnings }
  if (dumpSource) {
    fs.mkdirSync(path.dirname(path.resolve(dumpSource)), { recursive: true })
    fs.writeFileSync(path.resolve(dumpSource), JSON.stringify(out, null, 2))
    log(`源已导出 ${dumpSource}（${conversations.length} 个对话）`)
  }
  return out
}

function loadJsonSource(file) {
  const data = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'))
  if (Array.isArray(data)) return { version: 1, conversations: data, warnings: [] }
  return { version: 1, ...data, conversations: Array.isArray(data.conversations) ? data.conversations : [], warnings: data.warnings || [] }
}

async function openTarget() {
  const bundle = await createStorageBundle(mastraCfg, { dataDir })
  const { Memory } = await import('@mastra/memory')
  const memory = new Memory({
    id: 'yz-memory-migrate',
    storage: bundle.storage.store,
    vector: false,
    options: { lastMessages: false, semanticRecall: false, workingMemory: { enabled: false } },
  })
  const bridge = new MastraMemoryBridge({
    memory, storage: bundle.storage.store, kv: noopKv(),
    botId, adapter, onDemandMigration: false,
  })
  return { bundle, memory, bridge }
}

async function main() {
  if (args['init-storage']) {
    const { bundle } = await openTarget()
    const ok = await bundle.ping()
    await bundle.close()
    const out = { ok, phase: 'init-storage', target: mastraCfg.storage?.driver || 'libsql' }
    emit(out); log(ok ? 'storage 初始化通过' : 'storage 初始化失败')
    return ok ? 0 : 1
  }

  if (args.rollback) {
    if (args.yes !== true) { log('rollback 会删除本次导入的 Mastra 数据；确认请加 --yes'); return 2 }
    const target = await openTarget()
    try {
      const report = await rollbackMigration({ checkpointFile, bridge: target.bridge, dryRun: args['dry-run'] === true, logger: (...a) => log(' ', ...a) })
      emit({ phase: 'rollback', ...report })
      log(report.ok ? `rollback 完成：thread ${report.deletedThreads}，message ${report.deletedMessages}` : `rollback 有 ${report.errors.length} 个错误`)
      return report.ok ? 0 : 1
    } finally {
      await target.bundle.close()
    }
  }

  let source
  if (args['source-json']) source = loadJsonSource(args['source-json'])
  else if (args['redis-url'] || process.env.YZ_REDIS_URL || process.env.REDIS_URL) {
    source = await loadRedisSource(String(args['redis-url'] || process.env.YZ_REDIS_URL || process.env.REDIS_URL), { dumpSource: args['dump-source'] })
  } else if (args['dump-source']) {
    throw new Error('--dump-source 需要 --redis-url 或 --source-json')
  } else {
    throw new Error('缺少迁移源：--source-json <file> 或 --redis-url <url>')
  }

  const archive = (() => {
    try { return new CompactionArchive({ dir: archiveDir }) } catch { return null }
  })()
  const plan = planMigration({ input: source, botId: botId || source.botId || '', adapter: adapter || source.adapter || 'onebot', archive })
  if (source.warnings?.length) plan.warnings.push(...source.warnings.map((w) => ({ scope: 'source', ...w })))
  log(`[inventory] ${summarizeMigration(plan)}`)

  if (args.inventory || (!args['dry-run'] && !args.apply && !args.verify && !args.rollback)) {
    emit({ phase: 'inventory', ...plan })
    log(plan.ok ? 'dry-run 预检通过' : `发现 ${plan.errors.length} 个错误（见报告）`)
    return plan.ok ? 0 : 1
  }

  if (args['dry-run']) {
    emit({ phase: 'dry-run', ...plan })
    for (const e of plan.errors.slice(0, 20)) log(`  ✗ ${e.scope || e.threadId || ''} ${e.message}`)
    for (const w of plan.warnings.slice(0, 20)) log(`  ! ${w.scope || w.threadId || ''} ${w.message}`)
    log(plan.ok ? 'dry-run 通过（0 error，可进入 apply）' : `dry-run 失败：${plan.errors.length} error`)
    return plan.ok ? 0 : 1
  }

  if (args.apply) {
    if (!plan.ok) { emit({ phase: 'apply', ...plan, ok: false }); log('计划存在错误，拒绝 apply'); return 1 }
    if (args.yes !== true) { log('apply 会写 Mastra；确认请加 --yes'); return 2 }
    const target = await openTarget()
    try {
      const report = await applyMigration({ plan, bridge: target.bridge, checkpointFile, backupDir, logger: (...a) => log(' ', ...a) })
      emit({ phase: 'apply', ...report })
      log(report.ok ? `apply 完成：${report.applied} 个 thread，跳过 ${report.skipped}` : `apply 有 ${report.errors.length} 个错误`)
      return report.ok ? 0 : 1
    } finally {
      await target.bundle.close()
    }
  }

  if (args.verify) {
    const target = await openTarget()
    try {
      const report = await verifyMigration({ plan, bridge: target.bridge, sample: Number(args.sample) || 0, archive })
      emit({ phase: 'verify', ...report })
      log(report.ok ? `verify 通过：${report.checkedThreads} thread / ${report.checkedMessages} 条` : `verify 失败：${report.errors.length} 个错误`)
      return report.ok ? 0 : 1
    } finally {
      await target.bundle.close()
    }
  }

  return 0
}

main().then((code) => { process.exitCode = code }).catch((e) => {
  console.error(`迁移失败：${e?.message || e}`)
  process.exitCode = 1
})
