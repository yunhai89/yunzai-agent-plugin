/**
 * ApprovalBridge（PR3b/PR4a）：持久化人工审批。
 *
 * 与旧 ConfirmStore 的区别：
 *  - pending 落 KV，进程重启后可恢复（不再纯内存丢失）；
 *  - 5 位短 id（避开 0），主人在 QQ 输入 `#确认 10001`；
 *  - 状态 CAS：pending → resolving → approved/denied/expired/cancelled；
 *  - argsHash 校验，防审批后参数被替换；
 *  - 超时/取消/按 run 取消；onResolve/onExpire 供 Facade 恢复或拒绝 Mastra run。
 *
 * 只存 argsPreview（≤500 字）与 ctx 摘要，不把完整写参数/隐私落盘。
 */
import { createHash } from 'node:crypto'
import { createKeyedLock } from '../agent/store/lock.js'

export const APPROVAL_PREFIX = 'Yz:agent:approval:'
const DEFAULT_TIMEOUT = 5 * 60 * 1000
const KEEP_RESOLVED_MS = 24 * 60 * 60 * 1000

/** 稳定 JSON（对象键排序） */
export function stableJson(v) {
  if (v == null) return String(v)
  if (Array.isArray(v)) return '[' + v.map(stableJson).join(',') + ']'
  if (typeof v === 'object') return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stableJson(v[k])).join(',') + '}'
  return JSON.stringify(v)
}

/** 参数哈希：审批记录只存 hash，执行前可复核 */
export function hashArgs(args) {
  return createHash('sha256').update(stableJson(args ?? {})).digest('hex')
}

function preview(v, n = 500) {
  let s
  try { s = typeof v === 'string' ? v : JSON.stringify(v) } catch { s = String(v) }
  s = String(s ?? '').replace(/\s+/g, ' ').trim()
  return s.length > n ? s.slice(0, n) + `…(+${s.length - n})` : s
}

function ctxSummary(ctx) {
  if (!ctx) return null
  return {
    userId: ctx.userId != null ? String(ctx.userId) : null,
    groupId: ctx.groupId != null ? String(ctx.groupId) : null,
    scopeUserId: ctx.scopeUserId != null ? String(ctx.scopeUserId) : null,
    role: ctx.role || null,
    isMaster: ctx.isMaster === true,
    official: ctx.official === true,
    conversationId: ctx.conversationId != null ? String(ctx.conversationId) : null,
  }
}

export class ApprovalBridge {
  constructor({
    kv,
    prefix = APPROVAL_PREFIX,
    timeoutMs = DEFAULT_TIMEOUT,
    now = Date.now,
    notify = null,
    onResolve = null,
    onExpire = null,
    logger = null,
  } = {}) {
    if (!kv) throw new Error('ApprovalBridge 需要 kv')
    this.kv = kv
    this.prefix = prefix
    this.timeoutMs = Math.max(1, Number(timeoutMs) || DEFAULT_TIMEOUT)
    this._now = now
    this.notify = typeof notify === 'function' ? notify : null
    this.onResolve = typeof onResolve === 'function' ? onResolve : null
    this.onExpire = typeof onExpire === 'function' ? onExpire : null
    this.logger = logger || null
    this._lock = createKeyedLock({ maxKeys: 1000 })
    this._timers = new Map()
    this._closed = false
  }

  _key(id) { return `${this.prefix}id:${id}` }
  _seqKey() { return `${this.prefix}seq` }

  async _nextId() {
    const cur = Number(await this.kv.get(this._seqKey())) || 10000
    const next = cur + 1
    await this.kv.set(this._seqKey(), next)
    return String(next).padStart(5, '0')
  }

  _ttl(rec) {
    const remain = Math.max(0, Number(rec.expiresAt) - this._now())
    return Math.ceil((remain + KEEP_RESOLVED_MS) / 1000)
  }

  async _persist(rec) {
    await this.kv.set(this._key(rec.id), rec, this._ttl(rec))
  }

  _schedule(rec) {
    if (this._closed || !rec || rec.status !== 'pending') return
    const old = this._timers.get(rec.id)
    if (old) clearTimeout(old)
    const ms = Math.max(0, Number(rec.expiresAt) - this._now())
    const timer = setTimeout(() => {
      this._timers.delete(rec.id)
      this.cancel(rec.id, 'timeout').catch((e) => this.logger?.warn?.('[approval] 超时结算失败', e?.message || e))
    }, ms)
    timer.unref?.()
    this._timers.set(rec.id, timer)
  }

  /**
   * 创建 pending 审批。
   * @returns {Promise<object>} record
   */
  async create({ runId, toolCallId, toolName, args = {}, ctx = null, threadId = null, resourceId = null, scopeKey = null, timeoutMs = null, reason = '', meta = null } = {}) {
    if (!runId || !toolCallId || !toolName) throw new Error('审批需要 runId/toolCallId/toolName')
    return this._lock.withLock('__create__', async () => {
    const id = await this._nextId()
    const now = this._now()
    const ttl = Math.max(1, Number(timeoutMs) || this.timeoutMs)
    const rec = {
      id,
      runId: String(runId),
      toolCallId: String(toolCallId),
      toolName: String(toolName),
      argsHash: hashArgs(args),
      argsPreview: preview(args),
      ctx: ctxSummary(ctx),
      scopeKey: scopeKey ? String(scopeKey) : null,
      threadId: threadId ? String(threadId) : null,
      resourceId: resourceId ? String(resourceId) : null,
      status: 'pending',
      reason: String(reason || ''),
      meta: meta && typeof meta === 'object' ? meta : null,
      createdAt: now,
      expiresAt: now + ttl,
      resolvedAt: null,
      actor: null,
      decision: null,
    }
    await this._persist(rec)
    this._schedule(rec)
    try { this.notify?.(id, rec) } catch (e) { this.logger?.warn?.('[approval] notify 失败', e?.message || e) }
    return rec
    })
  }

  async get(id) {
    const key = this._key(String(id ?? '').trim())
    const rec = await this.kv.get(key)
    return rec && typeof rec === 'object' ? rec : null
  }

  /** 按 runId+toolCallId 查审批（execute 前复核；最近一条优先） */
  async getForCall(runId, toolCallId) {
    const list = await this.list({ runId })
    return list.find((r) => String(r.toolCallId) === String(toolCallId)) || null
  }

  /** Mastra execute 上下文没有 toolCallId 时的兜底：runId+工具+argsHash 唯一匹配 */
  async findApproved({ runId, toolName, argsHash }) {
    const list = await this.list({ runId, status: 'approved' })
    return list.find((r) => String(r.toolName) === String(toolName) && String(r.argsHash) === String(argsHash)) || null
  }

  async list({ status = null, scopeKey = null, runId = null } = {}) {
    const keys = (await this.kv.scan(this.prefix)).filter((k) => k.includes(':id:'))
    const out = []
    for (const k of keys) {
      const rec = await this.kv.get(k).catch(() => null)
      if (!rec || typeof rec !== 'object' || !rec.id) continue
      if (status && rec.status !== status) continue
      if (scopeKey != null && rec.scopeKey !== scopeKey) continue
      if (runId != null && rec.runId !== String(runId)) continue
      out.push(rec)
    }
    return out.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
  }

  async pendingCount(scopeKey = null) {
    const list = await this.list({ status: 'pending', scopeKey })
    return list.length
  }

  /**
   * CAS 结算：只有 pending 能被结算；重复/迟到返回 not_pending。
   * @returns {Promise<{ok:boolean,code?:string,record?:object}>}
   */
  async resolve(id, decision, { actor = null, argsHash = null, reason = '' } = {}) {
    const key = String(id ?? '').trim()
    return this._lock.withLock(key, async () => {
      const rec = await this.get(key)
      if (!rec) return { ok: false, code: 'not_found' }
      if (rec.status !== 'pending') return { ok: false, code: 'not_pending', record: rec }
      if (argsHash != null && String(argsHash) !== rec.argsHash) return { ok: false, code: 'args_mismatch', record: rec }
      if (this._now() >= rec.expiresAt) {
        rec.status = 'expired'
        rec.resolvedAt = this._now()
        rec.decision = false
        rec.reason = 'timeout'
        await this._persist(rec)
        this._clearTimer(key)
        try { this.onExpire?.(rec) } catch { /* noop */ }
        return { ok: false, code: 'expired', record: rec }
      }
      rec.status = 'resolving'
      await this._persist(rec)
      rec.status = decision === true || decision === 'approve' ? 'approved' : 'denied'
      rec.decision = rec.status === 'approved'
      rec.resolvedAt = this._now()
      rec.actor = actor == null ? null : String(actor)
      if (reason) rec.reason = String(reason)
      await this._persist(rec)
      this._clearTimer(key)
      try { this.onResolve?.(rec) } catch (e) { this.logger?.warn?.('[approval] onResolve 失败', e?.message || e) }
      return { ok: true, record: rec }
    })
  }

  async approve(id, opts = {}) { return this.resolve(id, true, opts) }
  async deny(id, opts = {}) { return this.resolve(id, false, opts) }

  _clearTimer(id) {
    const t = this._timers.get(id)
    if (t) { clearTimeout(t); this._timers.delete(id) }
  }

  /** 取消单个 pending；reason=timeout → expired，其它 → cancelled */
  async cancel(id, reason = 'cancelled') {
    const key = String(id ?? '').trim()
    return this._lock.withLock(key, async () => {
      const rec = await this.get(key)
      if (!rec) return { ok: false, code: 'not_found' }
      if (rec.status !== 'pending') return { ok: false, code: 'not_pending', record: rec }
      rec.status = reason === 'timeout' ? 'expired' : 'cancelled'
      rec.resolvedAt = this._now()
      rec.decision = false
      rec.reason = String(reason)
      await this._persist(rec)
      this._clearTimer(key)
      if (reason === 'timeout') { try { this.onExpire?.(rec) } catch { /* noop */ } }
      return { ok: true, record: rec }
    })
  }

  /** 取消某次 run 的所有 pending（取消/回滚） */
  async cancelRun(runId, reason = 'run_cancelled') {
    const list = await this.list({ status: 'pending', runId })
    let n = 0
    for (const rec of list) {
      const r = await this.cancel(rec.id, reason)
      if (r.ok) n++
    }
    return n
  }

  /** 进程启动/重建后恢复 pending；过期的直接过期，未过期的重排定时器 */
  async restore() {
    const list = await this.list({ status: 'pending' })
    let restored = 0
    for (const rec of list) {
      if (this._now() >= rec.expiresAt) {
        await this.cancel(rec.id, 'timeout')
      } else {
        this._schedule(rec)
        restored++
      }
    }
    return restored
  }

  close() {
    this._closed = true
    for (const t of this._timers.values()) clearTimeout(t)
    this._timers.clear()
  }
}

export default ApprovalBridge
