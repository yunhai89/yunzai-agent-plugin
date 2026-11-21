/**
 * S7 / Memory Phase 2 迁移核心（KV/SessionStore → Mastra Memory）。
 *
 * 设计原则（对应 04-data-migration-and-runbook.md）：
 *  - dry-run 只读：不写 Mastra，不写 legacy；
 *  - 稳定 message id：threadId+seq+role+content hash，断点/重跑幂等；
 *  - 一条 conversation 一个 thread，owner=identity.resourceId；
 *  - 保留压缩状态（cacheEpoch/compactLedger/activeTools）与 archive_refs 校验；
 *  - 不双写：apply 只写 Mastra，legacy 原样保留；
 *  - 回滚只删除本次新建的 thread（或本次导入的 message id），绝不动 legacy。
 */
import fs from 'node:fs'
import path from 'node:path'
import { contentHash } from '../agent/compact/index.js'
import { mastraDbMessagesToLegacy } from './message-adapter.js'
import { resolveMemoryIdentity } from './memory-bridge.js'

const MIGRATION_VERSION = 1
const VALID_ROLES = new Set(['user', 'assistant', 'tool', 'system'])

function str(v) {
  return v == null ? '' : String(v)
}

function parseArgs(v) {
  if (typeof v !== 'string') return v ?? {}
  try { return JSON.parse(v) } catch { return { _raw: v } }
}

function normalizeBlock(b) {
  if (b == null) return null
  if (typeof b === 'string') return { type: 'text', text: b }
  return b
}

export function normalizeContent(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const blocks = content.map(normalizeBlock).filter(Boolean)
    if (blocks.length === 1 && blocks[0].type === 'text') return blocks[0].text || ''
    return blocks
  }
  if (content == null) return ''
  return String(content)
}

function normalizeToolContent(content) {
  if (typeof content !== 'string') return content
  try { return JSON.parse(content) } catch { return content }
}

/** 稳定的消息投影：用于源/目标 hash 与抽样对比 */
export function normalizeLegacyMessage(m) {
  if (!m || typeof m !== 'object') return null
  const role = str(m.role)
  const out = {
    role,
    content: role === 'tool' ? normalizeToolContent(normalizeContent(m.content)) : normalizeContent(m.content),
  }
  if (m.reasoning) out.reasoning = str(m.reasoning)
  if (Array.isArray(m.tool_calls) && m.tool_calls.length) {
    out.tool_calls = m.tool_calls.map((tc) => ({
      id: str(tc?.id),
      name: str(tc?.function?.name || tc?.name),
      args: parseArgs(tc?.function?.arguments ?? tc?.arguments),
    }))
  }
  if (m.tool_call_id || m.toolCallId) out.tool_call_id = str(m.tool_call_id || m.toolCallId)
  if (m.name) out.name = str(m.name)
  if (m.provider_native) out.provider_native = m.provider_native
  return out
}

export function normalizeState(state = {}) {
  const out = { cacheEpoch: Number(state?.cacheEpoch) || 0 }
  if (state?.compactLedger && typeof state.compactLedger === 'object') out.compactLedger = state.compactLedger
  if (Array.isArray(state?.activeTools) && state.activeTools.length) out.activeTools = state.activeTools
  return out
}

export function stableMessageId(threadId, seq, message) {
  return `yz_${contentHash({ threadId, seq, message: normalizeLegacyMessage(message) }).slice(0, 32)}`
}

function addError(errors, scope, message, extra = {}) {
  errors.push({ scope, message, ...extra })
}

function addWarning(warnings, scope, message, extra = {}) {
  warnings.push({ scope, message, ...extra })
}

function conversationList(input) {
  if (Array.isArray(input)) return input
  if (Array.isArray(input?.conversations)) return input.conversations
  throw new Error('迁移源格式错误：需要 conversation 数组或 { conversations: [] }')
}

/**
 * 校验并生成迁移计划（dry-run）。
 * @param {object} opts
 * @param {Array|object} opts.input 源 conversation 数组
 * @param {string} [opts.botId]
 * @param {string} [opts.adapter]
 * @param {object} [opts.archive] CompactionArchive
 * @returns {{ok:boolean,errors:Array,warnings:Array,stats:object,threads:Array}}
 */
export function planMigration({ input, botId = '', adapter = 'onebot', archive = null } = {}) {
  const errors = []
  const warnings = []
  const threads = []
  const scopes = new Map()
  let totalMessages = 0
  let rawConversations = []
  try { rawConversations = conversationList(input) } catch (e) {
    return { ok: false, errors: [{ message: e.message }], warnings, stats: { conversations: 0, threads: 0, messages: 0, scopes: 0 }, threads: [] }
  }

  for (const [idx, conv] of rawConversations.entries()) {
    const scope = `conversation[${idx}]`
    if (!conv || typeof conv !== 'object') { addError(errors, scope, '不是对象'); continue }
    const userId = conv.scopeUserId ?? conv.userId ?? conv.user_id ?? ''
    const groupId = conv.scopeGroupId ?? conv.groupId ?? conv.group_id ?? null
    const convId = conv.conversationId ?? conv.convId ?? conv.id ?? ''
    if (!str(userId)) { addError(errors, scope, '缺少 scopeUserId/userId'); continue }
    if (!str(convId)) { addError(errors, scope, '缺少 conversationId'); continue }

    let identity
    try {
      identity = resolveMemoryIdentity({
        userId, groupId: groupId === 'private' ? null : groupId, conversationId: convId,
        ctx: {
          scopeUserId: conv.scopeUserId ?? userId,
          groupId: groupId === 'private' ? null : groupId,
          scopeId: conv.scopeId,
          selfId: conv.selfId || conv.self_id,
          adapterKind: conv.adapterKind || conv.adapter,
          official: conv.official,
        },
        defaultBotId: botId, defaultAdapter: adapter,
      })
    } catch (e) {
      addError(errors, scope, `identity 非法：${e?.message || e}`, { userId, groupId, convId })
      continue
    }

    const messages = Array.isArray(conv.messages) ? conv.messages : null
    if (!messages) { addError(errors, scope, 'messages 不是数组', { threadId: identity.threadId }); continue }

    const cleaned = []
    const openCalls = new Map()
    let index = 0
    for (const m of messages) {
      const mscope = `${scope}.messages[${index}]`
      index++
      if (!m || typeof m !== 'object') { addError(errors, mscope, '消息不是对象'); continue }
      const role = str(m.role)
      if (!VALID_ROLES.has(role)) { addError(errors, mscope, `未知 role：${role}`); continue }
      if (role === 'system') {
        addWarning(warnings, mscope, 'system 消息不导入（每轮由 Agent 重建）')
        continue
      }
      if (m.content == null || (typeof m.content !== 'string' && !Array.isArray(m.content))) {
        addError(errors, mscope, 'content 不是 string/array', { role })
        continue
      }
      if (role === 'assistant' && Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) {
          const id = str(tc?.id)
          if (!id) addError(errors, mscope, 'tool_calls 缺少 id')
          else openCalls.set(id, str(tc?.function?.name || tc?.name))
        }
      }
      if (role === 'tool') {
        const id = str(m.tool_call_id || m.toolCallId)
        if (!id) addError(errors, mscope, 'tool 消息缺少 tool_call_id')
        else if (!openCalls.has(id)) addError(errors, mscope, `孤立 tool 结果：${id}`)
        else openCalls.delete(id)
      }
      cleaned.push(m)
    }
    for (const [id, name] of openCalls) addWarning(warnings, scope, `工具调用没有结果（保留原样）：${name || 'unknown'} ${id}`)

    const state = normalizeState({
      cacheEpoch: conv.cacheEpoch ?? conv.state?.cacheEpoch,
      compactLedger: conv.compactLedger ?? conv.state?.compactLedger,
      activeTools: conv.activeTools ?? conv.state?.activeTools,
    })
    const normalized = cleaned.map(normalizeLegacyMessage).filter(Boolean)
    const sourceHash = contentHash({ messages: normalized, state })
    const messageHashes = normalized.map((m, i) => contentHash({ seq: i, message: m }))

    // archive_refs 校验（只读）
    const convKey = `${identity.scopeUserId}:${identity.scopeGroupId || 'p'}:${identity.conversationId}`
    const refs = Array.isArray(state.compactLedger?.archive_refs) ? state.compactLedger.archive_refs : []
    for (const r of refs) {
      if (!r?.ref) { addError(errors, scope, 'archive_ref 缺少 ref'); continue }
      if (!archive) { addWarning(warnings, scope, `未提供 archive，跳过 ref 校验：${r.ref}`); continue }
      const got = archive.get(r.ref, { convKey })
      if (!got?.ok) addError(errors, scope, `archive_ref 无法读取：${r.ref}（${got?.code || 'unknown'}）`)
      else if (r.hash && got.hash && r.hash !== got.hash) addError(errors, scope, `archive_ref hash 不一致：${r.ref}`)
    }

    const thread = {
      key: identity.threadId,
      threadId: identity.threadId,
      resourceId: identity.resourceId,
      adapter: identity.adapter,
      botId: identity.botId,
      scopeId: identity.scopeId,
      scopeUserId: identity.scopeUserId,
      scopeGroupId: identity.scopeGroupId,
      conversationId: identity.conversationId,
      title: str(conv.title) || `对话 ${identity.conversationId}`,
      createdAt: Number(conv.createdAt) || Date.now(),
      updatedAt: Number(conv.updatedAt) || Number(conv.createdAt) || Date.now(),
      messages: cleaned,
      normalized,
      messageHashes,
      messageCount: cleaned.length,
      state,
      sourceHash,
      archiveRefs: refs,
      sourceKey: str(conv.key),
    }
    threads.push(thread)
    totalMessages += cleaned.length

    const skey = `${identity.adapter}|${identity.botId}|${identity.scopeId}`
    const s = scopes.get(skey) || { adapter: identity.adapter, botId: identity.botId, scopeId: identity.scopeId, resourceId: identity.resourceId, conversations: 0, messages: 0 }
    s.conversations++
    s.messages += cleaned.length
    scopes.set(skey, s)
  }

  // 跨 scope / bot 隔离：同一 threadId 只能对应一个 resourceId
  const byThread = new Map()
  for (const t of threads) {
    const prev = byThread.get(t.threadId)
    if (prev && prev.resourceId !== t.resourceId) addError(errors, t.threadId, `thread 冲突：${prev.resourceId} vs ${t.resourceId}`)
    else byThread.set(t.threadId, t)
  }

  return {
    version: MIGRATION_VERSION,
    generatedAt: Date.now(),
    ok: errors.length === 0,
    errors,
    warnings,
    stats: {
      conversations: rawConversations.length,
      threads: threads.length,
      messages: totalMessages,
      scopes: scopes.size,
      warnings: warnings.length,
      errors: errors.length,
    },
    scopes: [...scopes.values()].sort((a, b) => a.scopeId.localeCompare(b.scopeId)),
    threads,
  }
}

function ensureDir(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
}

export function readCheckpoint(file) {
  if (!file || !fs.existsSync(file)) return { version: MIGRATION_VERSION, threads: {}, updatedAt: 0 }
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'))
    return { version: MIGRATION_VERSION, threads: {}, updatedAt: 0, ...data }
  } catch {
    return { version: MIGRATION_VERSION, threads: {}, updatedAt: 0 }
  }
}

export function writeCheckpoint(file, checkpoint) {
  if (!file) return
  ensureDir(file)
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, JSON.stringify({ ...checkpoint, updatedAt: Date.now() }, null, 2))
  fs.renameSync(tmp, file)
}

/**
 * 应用迁移。默认拒绝覆盖已有非空 thread（除非 checkpoint 显示同一 sourceHash 已完成）。
 * @returns {Promise<object>} 报告
 */
export async function applyMigration({ plan, bridge, checkpointFile = '', backupDir = '', batchSize = 50, logger = null } = {}) {
  if (!plan?.ok) return { ok: false, phase: 'apply', errors: plan?.errors || [], warnings: plan?.warnings || [], applied: 0, skipped: 0 }
  if (!bridge) throw new Error('applyMigration 需要 bridge')
  const checkpoint = readCheckpoint(checkpointFile)
  if (backupDir) {
    fs.mkdirSync(backupDir, { recursive: true })
    const src = path.join(backupDir, 'migration-source.json')
    if (!fs.existsSync(src)) {
      fs.writeFileSync(src, JSON.stringify({
        version: MIGRATION_VERSION, generatedAt: plan.generatedAt,
        threads: plan.threads.map((t) => ({
          threadId: t.threadId, resourceId: t.resourceId, conversationId: t.conversationId,
          scopeUserId: t.scopeUserId, scopeGroupId: t.scopeGroupId, title: t.title,
          createdAt: t.createdAt, updatedAt: t.updatedAt, state: t.state, messages: t.messages,
        })),
      }, null, 2))
    }
  }
  const report = { ok: true, phase: 'apply', applied: 0, skipped: 0, errors: [], warnings: [...(plan.warnings || [])], threads: [] }
  const batch = Math.max(1, Number(batchSize) || 50)

  for (const t of plan.threads) {
    const prev = checkpoint.threads[t.threadId]
    if (prev && prev.sourceHash === t.sourceHash && prev.status === 'done') {
      report.skipped++
      report.threads.push({ threadId: t.threadId, status: 'skipped', reason: 'already-done' })
      continue
    }
    try {
      const ensured = await bridge.ensureThreadForMigration({
        userId: t.scopeUserId, groupId: t.scopeGroupId || null, conversationId: t.conversationId,
        title: t.title, createdAt: t.createdAt, updatedAt: t.updatedAt,
        state: t.state, sourceHash: t.sourceHash,
        migration: { mode: 'script', version: MIGRATION_VERSION, at: Date.now(), sourceHash: t.sourceHash, messageCount: t.messageCount },
      })
      const existing = await bridge.getThreadMessages(t.threadId, t.resourceId).catch(() => ({ messages: [] }))
      const existingCount = (existing?.messages || []).length
      if (!ensured.created && existingCount > 0 && prev?.sourceHash !== t.sourceHash) {
        report.errors.push({ threadId: t.threadId, message: `目标 thread 已有 ${existingCount} 条消息，拒绝覆盖` })
        report.ok = false
        report.threads.push({ threadId: t.threadId, status: 'conflict' })
        continue
      }
      const r = await bridge.replaceConversationForMigration({
        userId: t.scopeUserId, groupId: t.scopeGroupId || null, conversationId: t.conversationId,
        messages: t.messages, state: t.state, sourceHash: t.sourceHash,
        migration: { mode: 'script', version: MIGRATION_VERSION, at: Date.now(), sourceHash: t.sourceHash, messageCount: t.messageCount },
      })
      const ids = await bridge.listThreadMessageIds(t.threadId)
      checkpoint.threads[t.threadId] = {
        status: 'done', sourceHash: t.sourceHash, count: r.count, messageIds: ids,
        createdThread: ensured.created, appliedAt: Date.now(),
      }
      writeCheckpoint(checkpointFile, checkpoint)
      report.applied++
      report.threads.push({ threadId: t.threadId, status: 'applied', count: r.count, createdThread: ensured.created })
      if (logger) logger('debug', `[migrate] ${t.threadId} ${r.count} 条`)
      // 批次之间让出事件循环，避免长迁移阻塞进程
      if (report.applied % batch === 0) await new Promise((r2) => setImmediate(r2))
    } catch (e) {
      report.ok = false
      report.errors.push({ threadId: t.threadId, message: e?.message || String(e), code: e?.code })
      report.threads.push({ threadId: t.threadId, status: 'failed', message: e?.message || String(e) })
    }
  }
  writeCheckpoint(checkpointFile, checkpoint)
  return report
}

/** 校验迁移结果：数量/顺序/hash/工具配对/owner/state/归档 ref。 */
export async function verifyMigration({ plan, bridge, sample = 0, archive = null } = {}) {
  const report = { ok: true, phase: 'verify', checkedThreads: 0, checkedMessages: 0, errors: [], warnings: [...(plan?.warnings || [])], threads: [] }
  if (!plan?.ok) {
    report.ok = false
    report.errors.push(...(plan?.errors || []))
    return report
  }
  if (!bridge) throw new Error('verifyMigration 需要 bridge')
  const sampleEvery = Math.max(0, Number(sample) || 0)
  for (const t of plan.threads) {
    try {
      const thread = await bridge.getThreadRaw(t.threadId)
      if (!thread) { report.errors.push({ threadId: t.threadId, message: '目标 thread 不存在' }); report.ok = false; continue }
      if (thread.resourceId !== t.resourceId) {
        report.errors.push({ threadId: t.threadId, message: `owner 不一致：${thread.resourceId} != ${t.resourceId}` })
        report.ok = false
        continue
      }
      const md = thread.metadata || {}
      if (str(md.scopeUserId) !== t.scopeUserId || str(md.scopeGroupId) !== str(t.scopeGroupId)) {
        report.errors.push({ threadId: t.threadId, message: 'scope 元数据不一致' })
        report.ok = false
      }
      const db = await bridge.getThreadMessages(t.threadId, t.resourceId)
      const target = mastraDbMessagesToLegacy(db?.messages || [])
      const targetNorm = target.map(normalizeLegacyMessage).filter(Boolean)
      const targetState = normalizeState({
        cacheEpoch: md.cacheEpoch,
        compactLedger: md.compactLedger,
        activeTools: md.activeTools,
      })
      if (targetNorm.length !== t.normalized.length) {
        report.errors.push({ threadId: t.threadId, message: `消息数不一致：${targetNorm.length} != ${t.normalized.length}` })
        report.ok = false
      }
      const targetHash = contentHash({ messages: targetNorm, state: targetState })
      if (targetHash !== t.sourceHash) {
        report.errors.push({ threadId: t.threadId, message: `内容 hash 不一致：${targetHash.slice(0, 12)} != ${t.sourceHash.slice(0, 12)}` })
        report.ok = false
      }
      for (let i = 0; i < Math.min(targetNorm.length, t.normalized.length); i++) {
        if (sampleEvery && i % sampleEvery !== 0) continue
        const h1 = contentHash({ seq: i, message: t.normalized[i] })
        const h2 = contentHash({ seq: i, message: targetNorm[i] })
        if (h1 !== h2) {
          report.errors.push({ threadId: t.threadId, message: `顺序/内容不一致 @${i}` })
          report.ok = false
          break
        }
      }
      // 目标孤儿 tool 结果
      const calls = new Set()
      for (const m of targetNorm) {
        for (const tc of m.tool_calls || []) calls.add(tc.id)
        if (m.role === 'tool' && m.tool_call_id && !calls.has(m.tool_call_id)) {
          report.errors.push({ threadId: t.threadId, message: `目标孤立 tool 结果：${m.tool_call_id}` })
          report.ok = false
        }
      }
      for (const r of t.archiveRefs || []) {
        if (!archive) continue
        const convKey = `${t.scopeUserId}:${t.scopeGroupId || 'p'}:${t.conversationId}`
        const got = archive.get(r.ref, { convKey })
        if (!got?.ok) { report.errors.push({ threadId: t.threadId, message: `归档 ref 不可读：${r.ref}` }); report.ok = false }
      }
      report.checkedThreads++
      report.checkedMessages += targetNorm.length
      report.threads.push({ threadId: t.threadId, status: 'ok', count: targetNorm.length })
    } catch (e) {
      report.ok = false
      report.errors.push({ threadId: t.threadId, message: e?.message || String(e), code: e?.code })
    }
  }
  return report
}

/**
 * 回滚：只删除本次迁移创建的 thread（或本次导入的 message id），legacy 原样保留。
 */
export async function rollbackMigration({ checkpointFile, bridge, dryRun = false, logger = null } = {}) {
  if (!bridge) throw new Error('rollbackMigration 需要 bridge')
  const checkpoint = readCheckpoint(checkpointFile)
  const report = { ok: true, phase: 'rollback', dryRun, deletedThreads: 0, deletedMessages: 0, errors: [], threads: [] }
  for (const [threadId, rec] of Object.entries(checkpoint.threads || {})) {
    if (!rec || rec.status !== 'done') continue
    try {
      if (rec.createdThread) {
        if (!dryRun) await bridge.deleteThreadById(threadId)
        report.deletedThreads++
        report.threads.push({ threadId, action: 'delete-thread' })
      } else {
        const ids = Array.isArray(rec.messageIds) ? rec.messageIds : []
        if (!dryRun && ids.length) {
          const store = await bridge._memoryStore()
          await store.deleteMessages(ids)
        }
        report.deletedMessages += ids.length
        report.threads.push({ threadId, action: 'delete-messages', count: ids.length })
      }
      if (!dryRun) checkpoint.threads[threadId] = { ...rec, status: 'rolled-back', rolledBackAt: Date.now() }
      if (logger) logger('debug', `[migrate] rollback ${threadId}`)
    } catch (e) {
      report.ok = false
      report.errors.push({ threadId, message: e?.message || String(e) })
    }
  }
  if (!dryRun) writeCheckpoint(checkpointFile, checkpoint)
  return report
}

/** 把迁移计划/报告写成人类可读摘要 */
export function summarizeMigration(plan) {
  return [
    `conversations=${plan.stats?.conversations || 0}`,
    `threads=${plan.stats?.threads || 0}`,
    `messages=${plan.stats?.messages || 0}`,
    `scopes=${plan.stats?.scopes || 0}`,
    `errors=${plan.errors?.length || 0}`,
    `warnings=${plan.warnings?.length || 0}`,
  ].join(' ')
}

export { MIGRATION_VERSION }
