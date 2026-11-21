/**
 * AgentRuntimeFacade（PR1 骨架）。
 *
 * 边界：apps 只依赖本 Facade 的稳定方法，不直接 import Mastra 类型/实例。
 * PR1 的 `runChat` 仍走 legacy Agent；即使配置 engine=mastra，只要 Mastra runner 还没有
 * `runChat`（PR4 才接），也安全回退 legacy，并记录 `mastra_chat_not_wired`。
 *
 * 因此 PR1 不改变任何聊天行为；Facade 只负责 engine 选择、health 与生命周期。
 */
import { normalizeRuntimeError } from './errors.js'


export class AgentRuntimeFacade {
  /**
   * @param {object} opts
   * @param {string} opts.engine legacy | mastra（请求引擎）
   * @param {{makeAgent?:Function, runChat?:Function}} [opts.legacy]
   * @param {object|null} [opts.mastra] createEmbeddedMastra 返回值
   * @param {object} [opts.config] 归一后的 {runtime,mastra}
   * @param {object|null} [opts.initError] Mastra 初始化失败时的归一错误
   * @param {Function} [opts.logger] (level,...args) 兼容现有 Log.tag
   * @param {number} [opts.generation]
   */
  constructor({ engine = 'legacy', legacy = null, mastra = null, chatRunner = null, gray = null, config = null, initError = null, logger = null, generation = 0, history = null } = {}) {
    if (engine !== 'legacy' && engine !== 'mastra') throw new Error(`未知 runtime engine：${engine}`)
    this.requestedEngine = engine
    this.engine = engine
    this.legacy = legacy
    this.mastra = mastra
    this.chatRunner = chatRunner
    this.history = history || null
    this.session = history || null
    this.gray = gray || null
    this.config = config
    this.initError = initError
    this.generation = generation
    this.logger = logger || null
    this.closed = false
    this.closing = null
    this._warnedNotWired = false
    this._runs = new Map()
  }

  get mastraReady() {
    return !!this.mastra
  }

  /** 实际可用的聊天引擎（是否命中灰度由 shouldUseMastra 决定） */
  get chatEngine() {
    return this.requestedEngine === 'mastra' && typeof this.chatRunner?.runChat === 'function' ? 'mastra' : 'legacy'
  }

  /** 灰度：显式用户/群，或稳定哈希百分比；空范围=mastra 引擎也不切流量 */
  shouldUseMastra(ctx = null) {
    if (this.chatEngine !== 'mastra' || !ctx) return false
    const g = this.gray || {}
    const uid = String(ctx.userId ?? ctx.scopeUserId ?? '')
    const gid = String(ctx.groupId ?? '')
    const users = Array.isArray(g.users) ? g.users.map(String) : []
    const groups = Array.isArray(g.groups) ? g.groups.map(String) : []
    if (uid && users.includes(uid)) return true
    if (gid && groups.includes(gid)) return true
    const pct = Math.max(0, Math.min(100, Number(g.percent) || 0))
    if (pct > 0) {
      let h = 2166136261
      const key = `${uid}|${gid}`
      for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0 }
      return (h % 100) < pct
    }
    return false
  }

  forRequest({ ctx = null, taskId = null, overrides = null } = {}) {
    return {
      runChat: (input, opts = {}) => this.runChat(input, { ...opts, ctx, taskId: opts.taskId || taskId, overrides: opts.overrides || overrides }),
      streamChat: (input, opts = {}) => this.streamChat(input, { ...opts, ctx, taskId: opts.taskId || taskId, overrides: opts.overrides || overrides }),
      abort: () => this.abort(taskId),
    }
  }

  /**
   * 非流式。返回与 Agent.run 兼容：{content,messages,usage,turns,taskId,stopReason,...}
   */
  async runChat(input, opts = {}) {
    if (this.closed) throw new Error('runtime facade 已关闭')
    const taskId = opts.taskId ? String(opts.taskId) : null
    let ctl = null
    if (taskId) {
      ctl = new AbortController()
      this._runs.set(taskId, ctl)
      if (opts.signal) {
        if (opts.signal.aborted) ctl.abort()
        else opts.signal.addEventListener('abort', () => { try { ctl.abort() } catch { /* noop */ } }, { once: true })
      }
      opts = { ...opts, signal: ctl.signal }
    }
    try {
      return await this._runChatInner(input, opts)
    } finally {
      if (taskId) this._runs.delete(taskId)
    }
  }

  async _runChatInner(input, opts = {}) {
    if (opts.agentInst) {
      try {
        this.logger?.('mark', '[runtime] runChat', `engine=${this.requestedEngine}`, `chat=${this.chatEngine}`, `user=${opts.ctx?.userId || '-'}`, `gray=${this.shouldUseMastra(opts.ctx) ? 'yes' : 'no'}`)
      } catch { /* noop */ }
    }
    if (this.shouldUseMastra(opts.ctx)) {
      const result = await this.chatRunner.runChat(input, { ...opts, callbacks: opts.callbacks || { onToolStart: opts.onToolStart, onToolEnd: opts.onToolEnd, onMasterAutoApprove: opts.onMasterAutoApprove } })
      if (result && !result.unsupported) return result
      try { this.logger?.('warn', '[runtime] Mastra 灰度回退 legacy', result?.unsupported || 'unknown') } catch { /* noop */ }
    }
    if (opts.agentInst && typeof opts.agentInst.run === 'function') {
      return opts.agentInst.run(input, opts)
    }
    if (this.requestedEngine === 'mastra' && !this._warnedNotWired) {
      this._warnedNotWired = true
      try { this.logger?.('warn', 'engine=mastra 但 chat runner 尚未接线/未命中灰度，走 legacy') } catch { /* noop */ }
    }
    if (typeof this.legacy?.runChat === 'function') return this.legacy.runChat(input, opts)
    if (typeof this.legacy?.makeAgent === 'function') {
      const agent = this.legacy.makeAgent(opts.overrides)
      return agent.run(input, opts)
    }
    throw new Error('runtime facade 未配置 legacy runner')
  }

  /**
   * 流式兼容入口。PR1 的 legacy `Agent.run` 已通过 onDelta 回调支持流式，
   * 因此这里先返回同形 result；PR4 再改为事件流。
   */
  async streamChat(input, opts = {}) {
    const result = await this.runChat(input, { ...opts, stream: true })
    return { runId: result?.taskId || opts.taskId || null, events: [], result }
  }

  async abort(taskId) {
    let hit = false
    const ctl = taskId != null ? this._runs.get(String(taskId)) : null
    if (ctl) { try { ctl.abort(); hit = true } catch { /* noop */ } }
    if (typeof this.mastra?.abort === 'function') {
      try { const r = await this.mastra.abort(taskId); hit = hit || !!r } catch { /* noop */ }
    }
    return hit
  }

  async abortAll() {
    let n = 0
    for (const ctl of this._runs.values()) { try { ctl.abort(); n++ } catch { /* noop */ } }
    this._runs.clear()
    return n
  }

  async approve(id, decision = true, actor = 'master') {
    if (typeof this.chatRunner?.approve === 'function') {
      try { return await this.chatRunner.approve(id, decision, actor) } catch (e) { return { ok: false, code: 'approve_failed', error: e?.message || String(e) } }
    }
    return { ok: false, code: 'native_approval_disabled' }
  }

  async pendingApprovals() {
    const out = []
    if (typeof this.chatRunner?.pendingApprovals === 'function') {
      try { out.push(...await this.chatRunner.pendingApprovals()) } catch { /* noop */ }
    }
    if (typeof this.mastra?.pendingApprovals === 'function') {
      try { out.push(...await this.mastra.pendingApprovals()) } catch { /* noop */ }
    }
    return out
  }

  async health() {
    const base = {
      engine: this.requestedEngine,
      chatEngine: this.chatEngine,
      gray: this.gray ? { users: this.gray.users?.length || 0, groups: this.gray.groups?.length || 0, percent: this.gray.percent || 0 } : null,
      mastraBuilt: this.mastraReady,
      history: this.history ? 'mastra' : 'sessionstore',
      closed: this.closed,
      generation: this.generation,
      initError: this.initError ? { code: this.initError.code, phase: this.initError.phase } : null,
    }
    if (!this.mastra) {
      return { ...base, ok: !this.closed, storage: null, vector: null, memory: null }
    }
    let mh = null
    try {
      mh = await this.mastra.health()
    } catch (e) {
      mh = { ok: false, error: normalizeRuntimeError(e, { phase: 'health' }).code }
    }
    return {
      ...base,
      ok: !this.closed && mh?.ok === true,
      storage: mh?.storage || null,
      vector: mh?.vector || null,
      memory: mh?.memory || null,
    }
  }

  close(reason = 'close') {
    if (this.closing) return this.closing
    this.closing = (async () => {
      try { await this.abortAll() } catch { /* noop */ }
      let result = { ok: true, reason, errors: [] }
      if (typeof this.mastra?.close === 'function') {
        try { result = await this.mastra.close(reason) } catch (e) {
          result = { ok: false, reason, errors: [{ step: 'mastra.close', code: normalizeRuntimeError(e).code }] }
        }
      }
      this.closed = true
      try { this.logger?.('info', `Facade 已关闭（${reason}）`) } catch { /* noop */ }
      return result
    })()
    return this.closing
  }
}

/** 兼容工厂：旧调用方只需要一个 no-op 门面 */
export function createLegacyFacade(opts = {}) {
  return new AgentRuntimeFacade({ ...opts, engine: 'legacy', mastra: null })
}

