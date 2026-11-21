/**
 * Mastra Memory Phase 2（S7）：thread/message 适配层。
 *
 * 目标：
 *  - 历史唯一写 = Mastra Memory；legacy SessionStore 只读/按需迁移源，绝不双写消息；
 *  - 保留项目既有 conversation API（create/list/active/delete/append/set/state），
 *    让 apps/Agent/Web 不需要知道底层是 KV 还是 Mastra；
 *  - thread 归属校验、跨用户/群/bot 隔离、稳定 message id、工具配对、压缩状态;
 *  - 迁移前双读：Mastra thread 优先，未迁移的 legacy 对话仍可列出/读取；首次写入时按需导入。
 *
 * 注意：本类继承 SessionStore 仅为复用 group:user 旧路径与 active/seq 键工具；
 * conversation 的消息读写全部走 Mastra Memory。
 */
import { SessionStore } from '../agent/session.js'
import { createKeyedLock } from '../agent/store/lock.js'
import { contentHash } from '../agent/compact/index.js'
import { safeScopePart } from '../qqofficial/index.js'
import { buildIdentity, deriveScopeId } from './identity.js'
import { legacyToMastraDbMessages, mastraDbMessagesToLegacy } from './message-adapter.js'
import { normalizeRuntimeError } from './errors.js'

const META_VERSION = 1

function str(v) {
  return v == null ? '' : String(v)
}

function inferBotId(...values) {
  for (const v of values) {
    const m = /^(\d{5,}):/.exec(str(v))
    if (m) return m[1]
  }
  return ''
}

function previewOf(messages = []) {
  const last = [...messages].reverse().find((m) => m && (m.role === 'user' || m.role === 'assistant'))
  if (!last) return ''
  const c = last.content
  if (typeof c === 'string') return c.slice(0, 80)
  if (Array.isArray(c)) {
    const t = c.filter((p) => p && p.type === 'text').map((p) => p.text || '').join(' ')
    if (t) return t.slice(0, 80)
  }
  return ''
}

function cleanExtra(extra = {}) {
  const out = {}
  for (const [k, v] of Object.entries(extra || {})) if (v !== undefined) out[k] = v
  return out
}

/**
 * 从 conversation API 参数 + 可选 ctx 解析 Mastra identity。
 * @returns {ReturnType<typeof buildIdentity> & {scopeUserId:string,scopeGroupId:string}}
 */
export function resolveMemoryIdentity({
  userId = '', groupId = null, conversationId = null, ctx = null,
  defaultBotId = '', defaultAdapter = 'onebot',
} = {}) {
  const c = ctx || {}
  const uid = str(c.scopeUserId ?? c.userId ?? userId)
  const gid = c.groupId !== undefined ? c.groupId : groupId
  const groupKey = gid == null || gid === '' || gid === 'private' ? null : str(gid)
  let scopeId = str(c.scopeId)
  if (!scopeId) {
    if (/^__group__:/.test(uid) && groupKey) scopeId = `g${safeScopePart(groupKey)}`
    else scopeId = deriveScopeId({ userId: uid, groupId: groupKey, isGroup: !!groupKey, isolation: !/^__group__:/.test(uid) })
  }
  const adapter = str(c.adapterKind || defaultAdapter || 'onebot') || 'onebot'
  const official = c.official === true || adapter === 'qqbot' || adapter === 'qqguild'
  const selfId = str(c.selfId || c.self_id || defaultBotId || inferBotId(uid, groupKey) || 'bot')
  const identity = buildIdentity({
    ctx: { ...c, selfId, scopeId, official, adapterKind: adapter },
    conversationId,
  })
  return {
    ...identity,
    conversationId: conversationId == null || conversationId === '' ? 'default' : String(conversationId),
    scopeUserId: uid,
    scopeGroupId: groupKey || '',
  }
}

export class MastraMemoryBridge extends SessionStore {
  /**
   * @param {object} opts
   * @param {object} opts.memory @mastra/memory Memory 实例
   * @param {object} opts.storage Mastra storage 实例（用于 listMessages/deleteMessages）
   * @param {SessionStore|null} [opts.legacySession] 迁移源/双读回退
   * @param {object} [opts.kv] 无 legacySession 时可注入 KV（仅迁移/测试）
   */
  constructor({
    memory, storage = null, legacySession = null, kv = null, prefix = 'Yz:agent:sess:',
    window = 400, ttl = 86400, cacheMax = 500,
    botId = '', adapter = 'onebot', onDemandMigration = true, logger = null,
  } = {}) {
    if (!memory) throw new Error('MastraMemoryBridge 需要 memory')
    const baseKv = legacySession?.kv || kv
    if (!baseKv) throw new Error('MastraMemoryBridge 需要 legacySession.kv 或 kv')
    super({
      kv: baseKv,
      prefix: legacySession?.prefix || prefix,
      window: legacySession?.window || window,
      ttl: legacySession?.ttl || ttl,
      cacheMax: legacySession?.cacheMax || cacheMax,
    })
    this.memory = memory
    this.storage = storage
    this.legacy = legacySession
    this.botId = str(botId)
    this.adapter = str(adapter) || 'onebot'
    this.onDemandMigration = onDemandMigration !== false
    this.logger = logger
    this._lock = createKeyedLock()
    this._storePromise = null
  }

  async _memoryStore() {
    if (!this.storage) throw new Error('MastraMemoryBridge 需要 storage 才能访问消息表')
    if (!this._storePromise) this._storePromise = this.storage.getStore('memory')
    const store = await this._storePromise
    if (!store) throw new Error('Mastra storage 没有 memory domain')
    return store
  }

  _identity(userId, groupId, conversationId, ctx = null) {
    return resolveMemoryIdentity({
      userId, groupId, conversationId, ctx,
      defaultBotId: this.botId, defaultAdapter: this.adapter,
    })
  }

  /** bot 级 active/seq 键：同进程多账号时不共享 active 指针。 */
  _activeKey(identity) {
    return `${this.prefix}conv:active:${identity.adapter}:${identity.botId}:${identity.scopeGroupId || 'private'}:${identity.scopeUserId}`
  }

  _seqKey(identity) {
    return `${this.prefix}conv:seq:${identity.adapter}:${identity.botId}:${identity.scopeGroupId || 'private'}:${identity.scopeUserId}`
  }

  async _readActive(identity) {
    const v = await this.kv.get(this._activeKey(identity))
    if (v != null && v !== '') return String(v)
    // 兼容 S6/legacy 的共享 active 键（只读回退，写仍写 bot 级键）
    const old = await this.kv.get(this.activeKey(identity.scopeUserId, identity.scopeGroupId || null))
    return old != null && old !== '' ? String(old) : null
  }

  _meta(identity, { title, createdAt, updatedAt, cacheEpoch = 0, compactLedger = null, activeTools = null, migration = null } = {}) {
    const now = Date.now()
    return {
      v: META_VERSION,
      kind: 'chat',
      adapter: identity.adapter,
      botId: identity.botId,
      scopeId: identity.scopeId,
      scopeUserId: identity.scopeUserId,
      scopeGroupId: identity.scopeGroupId,
      conversationId: str(identity.conversationId),
      title: title || '对话',
      createdAt: Number(createdAt) || now,
      updatedAt: Number(updatedAt) || now,
      messageCount: 0,
      messageSeq: 0,
      lastCreatedAt: 0,
      preview: '',
      cacheEpoch: Number(cacheEpoch) || 0,
      ...(compactLedger && typeof compactLedger === 'object' ? { compactLedger } : {}),
      ...(Array.isArray(activeTools) && activeTools.length ? { activeTools } : {}),
      ...(migration ? { migration } : {}),
    }
  }

  async _getThreadAny(threadId) {
    return this.memory.getThreadById({ threadId })
  }

  async _getThread(identity) {
    const t = await this.memory.getThreadById({ threadId: identity.threadId, resourceId: identity.resourceId })
    if (t) return t
    const any = await this._getThreadAny(identity.threadId)
    if (any && any.resourceId !== identity.resourceId) {
      throw Object.assign(new Error(`Mastra thread owner 冲突：${identity.threadId}`), {
        code: 'memory_thread_owner_conflict', threadId: identity.threadId,
        expected: identity.resourceId, actual: any.resourceId,
      })
    }
    return null
  }

  async _count(threadId) {
    const store = await this._memoryStore()
    const r = await store.listMessages({ threadId, perPage: 1, includeTotal: true })
    return Number(r?.total) || 0
  }

  async _readDb(identity) {
    return this.memory.recall({ threadId: identity.threadId, resourceId: identity.resourceId, perPage: false })
  }

  _makeId(threadId) {
    return (seq, m) => `yz_${contentHash({
      threadId, seq,
      role: m?.role,
      content: m?.content,
      tool_call_id: m?.tool_call_id || m?.toolCallId || '',
      tool_calls: m?.tool_calls || null,
    }).slice(0, 32)}`
  }

  async _writeMessagesLocked(identity, messages, {
    startSeq = 0, baseTime = Date.now(), replace = false, extra = {}, title = null, source = 'mastra',
  } = {}) {
    const thread = await this._getThread(identity)
    if (!thread) throw new Error(`Mastra thread 不存在：${identity.threadId}`)
    const meta = thread.metadata || {}
    const now = Date.now()
    const base = Number(baseTime) || now
    const db = legacyToMastraDbMessages(messages, {
      threadId: identity.threadId,
      resourceId: identity.resourceId,
      startSeq: Number(startSeq) || 0,
      baseTime: base,
      makeId: this._makeId(identity.threadId),
    })
    const old = replace ? await this._readDb(identity).catch(() => ({ messages: [] })) : null
    if (db.length) await this.memory.saveMessages({ messages: db })
    if (replace) {
      const keep = new Set(db.map((m) => m.id))
      const stale = (old?.messages || []).map((m) => m.id).filter((id) => id && !keep.has(id))
      if (stale.length) {
        const store = await this._memoryStore()
        await store.deleteMessages(stale)
      }
    }
    const nextMeta = {
      ...cleanExtra(extra),
      // metadata 是浅合并：显式写空值，保证 set/清空后不会残留旧 activeTools/ledger
      activeTools: Array.isArray(extra.activeTools) ? extra.activeTools : (replace ? [] : (Array.isArray(meta.activeTools) ? meta.activeTools : [])),
      compactLedger: extra.compactLedger !== undefined ? extra.compactLedger : (replace ? null : (meta.compactLedger || null)),
      cacheEpoch: extra.cacheEpoch !== undefined ? Number(extra.cacheEpoch) || 0 : Number(meta.cacheEpoch) || 0,
      messageSeq: db.length ? (Number(startSeq) || 0) + db.length : 0,
      messageCount: db.length,
      lastCreatedAt: db.length ? base + db.length - 1 : 0,
      preview: previewOf(messages),
      updatedAt: now,
      source,
      migratedAt: source === 'legacy' ? now : meta.migratedAt,
    }
    if (title) nextMeta.title = title
    await this.memory.updateThread({ id: identity.threadId, metadata: nextMeta })
    return { messages: db, count: db.length }
  }

  async _importLegacyLocked(identity) {
    if (!this.legacy) return null
    const [messages, legacyMeta, state] = await Promise.all([
      this.legacy.getConversation(identity.scopeUserId, identity.scopeGroupId || null, identity.conversationId).catch(() => []),
      this.legacy.getConversationMeta(identity.scopeUserId, identity.scopeGroupId || null, identity.conversationId).catch(() => null),
      this.legacy.getConversationState(identity.scopeUserId, identity.scopeGroupId || null, identity.conversationId).catch(() => ({})),
    ])
    if (!Array.isArray(messages) || !messages.length) return null
    const createdAt = Number(legacyMeta?.createdAt) || Date.now()
    const meta = this._meta(identity, {
      title: legacyMeta?.title || `对话 ${identity.conversationId}`,
      createdAt,
      updatedAt: legacyMeta?.updatedAt || Date.now(),
      cacheEpoch: state?.cacheEpoch,
      compactLedger: state?.compactLedger,
      activeTools: state?.activeTools,
      migration: { mode: 'on-demand', at: Date.now(), source: 'sessionstore', messageCount: messages.length },
    })
    await this.memory.saveThread({
      thread: {
        id: identity.threadId, resourceId: identity.resourceId, title: meta.title,
        createdAt: new Date(createdAt), updatedAt: new Date(meta.updatedAt), metadata: meta,
      },
    })
    await this._writeMessagesLocked(identity, messages, {
      startSeq: 0, baseTime: createdAt, extra: {
        cacheEpoch: meta.cacheEpoch,
        compactLedger: meta.compactLedger,
        activeTools: meta.activeTools,
      }, title: meta.title, source: 'legacy',
    })
    return messages
  }

  async _ensureThreadLocked(identity, { title = null, createdAt = null, legacy = true, createEmpty = true } = {}) {
    let thread = await this._getThread(identity)
    if (thread) return { thread, created: false, imported: false }
    if (legacy && this.onDemandMigration) {
      const imported = await this._importLegacyLocked(identity)
      if (imported?.length) {
        thread = await this._getThread(identity)
        return { thread, created: true, imported: true }
      }
    }
    if (!createEmpty) return { thread: null, created: false, imported: false }
    const meta = this._meta(identity, { title: title || `对话 ${identity.conversationId}`, createdAt: createdAt || Date.now() })
    thread = await this.memory.saveThread({
      thread: {
        id: identity.threadId, resourceId: identity.resourceId, title: meta.title,
        createdAt: new Date(meta.createdAt), updatedAt: new Date(meta.updatedAt), metadata: meta,
      },
    })
    return { thread, created: true, imported: false }
  }

  async _ensureThread(identity, opts = {}) {
    return this._lock.withLock(identity.threadId, () => this._ensureThreadLocked(identity, opts))
  }

  // —— 项目 conversation API ——

  async getConversation(userId, groupId, convId, ctx = null) {
    const identity = this._identity(userId, groupId, convId, ctx)
    const thread = await this._getThread(identity)
    if (!thread) {
      if (!this.onDemandMigration) return []
      const r = await this._ensureThread(identity, { ctx, createEmpty: false })
      if (!r?.thread) return []
    }
    const out = await this._readDb(identity)
    return mastraDbMessagesToLegacy(out?.messages || [])
  }

  async appendConversation(userId, groupId, convId, msgs, extra = {}, ctx = null) {
    if (!msgs?.length) return this.getConversation(userId, groupId, convId, ctx)
    const identity = this._identity(userId, groupId, convId, ctx)
    return this._lock.withLock(identity.threadId, async () => {
      const { thread } = await this._ensureThreadLocked(identity)
      const meta = thread.metadata || {}
      let seq = Number(meta.messageSeq)
      if (!Number.isFinite(seq)) seq = await this._count(identity.threadId)
      let count = Number(meta.messageCount)
      if (!Number.isFinite(count)) count = await this._count(identity.threadId)
      const baseTime = Math.max(Date.now(), (Number(meta.lastCreatedAt) || 0) + 1)
      const db = legacyToMastraDbMessages(msgs, {
        threadId: identity.threadId, resourceId: identity.resourceId,
        startSeq: seq, baseTime, makeId: this._makeId(identity.threadId),
      })
      if (db.length) await this.memory.saveMessages({ messages: db })
      await this.memory.updateThread({
        id: identity.threadId,
        metadata: {
          ...cleanExtra(extra),
          messageSeq: seq + db.length,
          messageCount: count + db.length,
          lastCreatedAt: db.length ? baseTime + db.length - 1 : Number(meta.lastCreatedAt) || 0,
          preview: previewOf(msgs),
          updatedAt: Date.now(),
        },
      })
      return msgs.map((m) => ({ ...m }))
    })
  }

  async setConversation(userId, groupId, convId, messages, extra = {}, ctx = null) {
    const identity = this._identity(userId, groupId, convId, ctx)
    return this._lock.withLock(identity.threadId, async () => {
      const { thread } = await this._ensureThreadLocked(identity)
      const meta = thread.metadata || {}
      const baseTime = Number(meta.createdAt) || Date.now()
      const r = await this._writeMessagesLocked(identity, Array.isArray(messages) ? messages : [], {
        startSeq: 0, baseTime, replace: true, extra, source: 'mastra',
      })
      return messages
    })
  }

  async getConversationState(userId, groupId, convId, ctx = null) {
    const identity = this._identity(userId, groupId, convId, ctx)
    const thread = await this._getThread(identity)
    if (thread) {
      const m = thread.metadata || {}
      return {
        activeTools: Array.isArray(m.activeTools) && m.activeTools.length ? m.activeTools : null,
        cacheEpoch: Number.isFinite(Number(m.cacheEpoch)) ? Number(m.cacheEpoch) : 0,
        ...(m.compactLedger && typeof m.compactLedger === 'object' ? { compactLedger: m.compactLedger } : {}),
      }
    }
    if (this.legacy) {
      try { return await this.legacy.getConversationState(identity.scopeUserId, identity.scopeGroupId || null, identity.conversationId) } catch { /* noop */ }
    }
    return { activeTools: null, cacheEpoch: 0 }
  }

  async getConversationMeta(userId, groupId, convId, ctx = null) {
    const identity = this._identity(userId, groupId, convId, ctx)
    const thread = await this._getThread(identity)
    if (thread) {
      const m = thread.metadata || {}
      return {
        id: identity.conversationId,
        title: thread.title || m.title || `对话 ${identity.conversationId}`,
        createdAt: Number(m.createdAt) || (thread.createdAt ? new Date(thread.createdAt).getTime() : 0),
        updatedAt: thread.updatedAt ? new Date(thread.updatedAt).getTime() : (Number(m.updatedAt) || 0),
      }
    }
    if (this.legacy) {
      try { return await this.legacy.getConversationMeta(identity.scopeUserId, identity.scopeGroupId || null, identity.conversationId) } catch { /* noop */ }
    }
    return null
  }

  _listItem(thread) {
    const m = thread.metadata || {}
    return {
      id: str(m.conversationId),
      title: thread.title || m.title || `对话 ${m.conversationId || ''}`,
      count: Number(m.messageCount) || 0,
      updatedAt: Number(m.updatedAt) || (thread.updatedAt ? new Date(thread.updatedAt).getTime() : 0),
      createdAt: Number(m.createdAt) || (thread.createdAt ? new Date(thread.createdAt).getTime() : 0),
      preview: m.preview || '',
      scopeUserId: str(m.scopeUserId),
      scopeGroupId: str(m.scopeGroupId),
      adapter: str(m.adapter || ''),
      botId: str(m.botId || ''),
      scopeId: str(m.scopeId || ''),
      source: 'mastra',
    }
  }

  async listConversations(userId, groupId, ctx = null) {
    const identity = this._identity(userId, groupId, null, ctx)
    const out = []
    const seen = new Set()
    const threads = await this.memory.listThreads({ filter: { resourceId: identity.resourceId }, perPage: false })
    for (const t of threads?.threads || []) {
      const m = t.metadata || {}
      if (m.kind && m.kind !== 'chat') continue
      if (m.conversationId == null) continue
      const item = this._listItem(t)
      seen.add(String(item.id))
      out.push(item)
    }
    if (this.legacy) {
      const legacyList = await this.legacy.listConversations(identity.scopeUserId, identity.scopeGroupId || null).catch(() => [])
      for (const c of legacyList) {
        if (seen.has(String(c.id))) continue
        seen.add(String(c.id))
        out.push({ ...c, scopeUserId: identity.scopeUserId, scopeGroupId: identity.scopeGroupId, source: 'legacy' })
      }
    }
    return out.sort((a, b) => Number(a.id) - Number(b.id))
  }

  async listAllConversations() {
    const out = []
    const seen = new Set()
    const seenScope = new Set()
    const threads = await this.memory.listThreads({ perPage: false })
    for (const t of threads?.threads || []) {
      const m = t.metadata || {}
      if (m.kind && m.kind !== 'chat') continue
      if (m.conversationId == null) continue
      const item = this._listItem(t)
      seen.add(`${item.adapter}|${item.botId}|${item.scopeId}|${item.id}`)
      seenScope.add(`${item.scopeUserId}|${item.scopeGroupId}|${item.id}`)
      out.push(item)
    }
    if (this.legacy) {
      const legacyList = await this.legacy.listAllConversations().catch(() => [])
      for (const c of legacyList) {
        const scopeKey = `${c.scopeUserId}|${c.scopeGroupId || ''}|${c.id}`
        if (seenScope.has(scopeKey)) continue
        const key = `legacy|||${scopeKey}`
        if (seen.has(key)) continue
        seen.add(key)
        seenScope.add(scopeKey)
        out.push({ ...c, scopeGroupId: c.scopeGroupId || '', source: 'legacy' })
      }
    }
    return out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
  }

  async historyLength(opts = {}) {
    const { userId, groupId, conversationId, scopeUserId } = opts
    const uid = scopeUserId != null && scopeUserId !== '' ? scopeUserId : userId
    const ctx = opts.ctx || opts
    return (await this.getConversation(uid, groupId, conversationId, ctx)).length
  }

  async _nextId(identity) {
    const seqKey = this._seqKey(identity)
    const cur = Number(await this.kv.get(seqKey)) || 0
    const threads = await this.memory.listThreads({ filter: { resourceId: identity.resourceId }, perPage: false })
    const ids = []
    for (const t of threads?.threads || []) {
      const cid = Number(t?.metadata?.conversationId)
      if (Number.isFinite(cid)) ids.push(cid)
    }
    if (this.legacy) {
      for (const c of await this.legacy.listConversations(identity.scopeUserId, identity.scopeGroupId || null).catch(() => [])) {
        const cid = Number(c.id)
        if (Number.isFinite(cid)) ids.push(cid)
      }
    }
    const max = Math.max(cur, ...ids)
    const id = String(max + 1)
    await this.kv.set(seqKey, max + 1)
    return id
  }

  async _createConversationLocked(identity, title, ctx = null) {
    const id = await this._nextId(identity)
    const convIdentity = this._identity(identity.scopeUserId, identity.scopeGroupId || null, id, ctx)
    const meta = this._meta(convIdentity, { title: title || `对话 ${id}`, createdAt: Date.now() })
    const now = Date.now()
    const thread = await this.memory.saveThread({
      thread: {
        id: convIdentity.threadId, resourceId: convIdentity.resourceId, title: meta.title,
        createdAt: new Date(now), updatedAt: new Date(now), metadata: meta,
      },
    })
    await this.kv.set(this._activeKey(identity), id)
    return { id, title: thread.title || meta.title, messages: [], createdAt: now, updatedAt: now }
  }

  async createConversation(userId, groupId, title, ctx = null) {
    const identity = this._identity(userId, groupId, null, ctx)
    return this._lock.withLock(this._activeKey(identity), () => this._createConversationLocked(identity, title, ctx))
  }

  async setActiveConversation(userId, groupId, convId, ctx = null) {
    const identity = this._identity(userId, groupId, convId, ctx)
    const exists = await this._getThread(identity).catch(() => null)
    let ok = !!exists
    if (!ok && this.legacy) {
      ok = !!(await this.legacy.getConversationMeta(identity.scopeUserId, identity.scopeGroupId || null, identity.conversationId).catch(() => null))
    }
    if (!ok) return false
    await this.kv.set(this._activeKey(identity), identity.conversationId)
    return true
  }

  async peekActiveConversation(userId, groupId, ctx = null) {
    const identity = this._identity(userId, groupId, null, ctx)
    try {
      return this._readActive(identity)
    } catch { return null }
  }

  async getActiveConversation(userId, groupId, ctx = null) {
    const identity = this._identity(userId, groupId, null, ctx)
    const activeKey = this._activeKey(identity)
    return this._lock.withLock(activeKey, async () => {
      const v = await this._readActive(identity)
      if (v) {
        const cid = String(v)
        const id2 = this._identity(userId, groupId, cid, ctx)
        let exists = !!(await this._getThread(id2).catch(() => null))
        if (!exists && this.legacy) {
          exists = !!(await this.legacy.getConversationMeta(id2.scopeUserId, id2.scopeGroupId || null, cid).catch(() => null))
        }
        if (exists) return cid
      }
      const list = await this.listConversations(userId, groupId, ctx)
      if (list.length) {
        const id = String(list[0].id)
        await this.kv.set(activeKey, id)
        return id
      }
      const c = await this._createConversationLocked(identity, null, ctx)
      return c.id
    })
  }

  async deleteConversation(userId, groupId, convId, ctx = null) {
    const identity = this._identity(userId, groupId, convId, ctx)
    const cid = identity.conversationId
    await this._lock.withLock(identity.threadId, async () => {
      const t = await this._getThread(identity).catch(() => null)
      if (t) await this.memory.deleteThread(identity.threadId)
      if (this.legacy) {
        try { await this.legacy.kv.del(this.legacy.convKey(identity.scopeUserId, identity.scopeGroupId || null, cid)) } catch { /* noop */ }
      }
    })
    const activeKey = this._activeKey(identity)
    await this._lock.withLock(activeKey, async () => {
      const active = await this._readActive(identity)
      if (active !== cid) return
      const list = await this.listConversations(userId, groupId, ctx)
      if (list.length) await this.kv.set(activeKey, String(list[0].id))
      else await this._createConversationLocked(identity, null, ctx)
    })
  }

  /** #清空所有记录：删除该 scope 下所有 Mastra thread 与 legacy 对话对象；不创建新对话。 */
  async clearAllConversations(userId, groupId, ctx = null) {
    const identity = this._identity(userId, groupId, null, ctx)
    let n = 0
    // 清空该用户在该群/私聊下的所有 bot（thread metadata 含完整 scope；群共享由调用方跳过）
    const threads = await this.memory.listThreads({ perPage: false })
    for (const t of threads?.threads || []) {
      const m = t.metadata || {}
      if (m.kind && m.kind !== 'chat') continue
      if (str(m.scopeUserId) !== identity.scopeUserId) continue
      if (str(m.scopeGroupId) !== identity.scopeGroupId) continue
      await this.memory.deleteThread(t.id)
      try {
        if (m.adapter && m.botId) {
          await this.kv.del(`${this.prefix}conv:active:${m.adapter}:${m.botId}:${str(m.scopeGroupId) || 'private'}:${str(m.scopeUserId)}`)
        }
      } catch { /* noop */ }
      n++
    }
    if (this.legacy) {
      const prefix = `${this.prefix}conv:${identity.scopeGroupId || 'private'}:${identity.scopeUserId}:`
      for (const k of await this.kv.scan(prefix).catch(() => [])) {
        if (k.includes(':active:') || k.includes(':seq:')) continue
        await this.kv.del(k)
        n++
      }
    }
    await this.kv.del(this.activeKey(identity.scopeUserId, identity.scopeGroupId || null)).catch(() => {})
    await this.kv.del(this._activeKey(identity)).catch(() => {})
    return n
  }

  // —— 迁移脚本/管理命令使用的显式接口 ——

  /** 创建或复用迁移 thread；owner 冲突直接抛错。 */
  async ensureThreadForMigration({
    userId, groupId, conversationId, ctx = null, title = null, createdAt = null, updatedAt = null,
    state = {}, migration = null, sourceHash = '',
  } = {}) {
    const identity = this._identity(userId, groupId, conversationId, ctx)
    return this._lock.withLock(identity.threadId, async () => {
      const existing = await this._getThread(identity)
      if (existing) return { identity, thread: existing, created: false }
      const meta = this._meta(identity, {
        title: title || `对话 ${identity.conversationId}`,
        createdAt, updatedAt,
        cacheEpoch: state?.cacheEpoch,
        compactLedger: state?.compactLedger,
        activeTools: state?.activeTools,
        migration,
      })
      if (sourceHash) meta.sourceHash = sourceHash
      const thread = await this.memory.saveThread({
        thread: {
          id: identity.threadId, resourceId: identity.resourceId, title: meta.title,
          createdAt: new Date(meta.createdAt), updatedAt: new Date(meta.updatedAt), metadata: meta,
        },
      })
      return { identity, thread, created: true }
    })
  }

  /** 全量替换迁移 thread 的消息（幂等：稳定 id + upsert + 清理旧 id）。 */
  async replaceConversationForMigration({
    userId, groupId, conversationId, ctx = null, messages = [], state = {}, migration = null, sourceHash = '',
  } = {}) {
    const identity = this._identity(userId, groupId, conversationId, ctx)
    return this._lock.withLock(identity.threadId, async () => {
      const thread = await this._getThread(identity)
      if (!thread) throw new Error(`迁移 thread 不存在：${identity.threadId}`)
      const meta = thread.metadata || {}
      const baseTime = Number(meta.createdAt) || Date.now()
      const r = await this._writeMessagesLocked(identity, messages, {
        startSeq: 0, baseTime, replace: true, source: 'legacy',
        extra: {
          cacheEpoch: Number(state?.cacheEpoch) || 0,
          compactLedger: state?.compactLedger && typeof state.compactLedger === 'object' ? state.compactLedger : undefined,
          activeTools: Array.isArray(state?.activeTools) && state.activeTools.length ? state.activeTools : undefined,
          sourceHash: sourceHash || undefined,
          migration: migration || undefined,
        },
      })
      return { identity, count: r.count }
    })
  }

  async getThreadRaw(threadId) {
    return this._getThreadAny(threadId)
  }

  async getThreadMessages(threadId, resourceId = '') {
    if (resourceId) return this.memory.recall({ threadId, resourceId, perPage: false })
    const store = await this._memoryStore()
    return store.listMessages({ threadId, perPage: false, includeTotal: true })
  }

  async listThreadMessageIds(threadId) {
    const r = await this.getThreadMessages(threadId)
    return (r?.messages || []).map((m) => m.id).filter(Boolean)
  }

  async deleteThreadById(threadId) {
    return this.memory.deleteThread(threadId)
  }

  async health() {
    try {
      const threads = await this.memory.listThreads({ perPage: 1 })
      return { ok: true, mode: 'mastra', threads: Number(threads?.total) || 0 }
    } catch (e) {
      return { ok: false, mode: 'mastra', error: normalizeRuntimeError(e, { phase: 'memory' }).code }
    }
  }
}

export default MastraMemoryBridge
