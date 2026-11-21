/**
 * MastraAgent —— 旧 `Agent` 公共 API 的 Mastra 兼容层（S11）。
 *
 * 旧 ReAct 主循环已删除；本类只负责：
 *  - 保留 research/multiagent/prompt 等模块使用的构造参数与 `run()` 形状；
 *  - 把上下文装配、工具、会话/记忆/审批等交给 `chat-runner` + Mastra；
 *  - 提供旧代码依赖的少量纯工具函数（输入归一、token 估算、system 组装）。
 *
 * 主聊天路径不经过本类：Facade 直接持有 `chat-runner`。
 */
import { randomUUID } from 'node:crypto'
import { estimateTokensApprox } from '../agent/token-estimate.js'
import { tagUntrusted } from '../agent/guard.js'
import { tokenBreakdown } from '../agent/trace/events.js'
import { resolveModelContext } from '../llm/model-context.js'
import {
  TEMPLATES, SERVICE_DIRECTIVE, SEARCH_VERIFICATION,
  buildToolCatalogSection, buildToolDiscoverySection, buildSkillsPromptSection,
  buildStickerPromptSection, buildAgentSystemPrompt,
} from '../prompt/index.js'
import { createMastraChatRunner } from './chat-runner.js'

const DEFAULT_IDENTITY = TEMPLATES.agent.system
const DEFAULT_ALWAYS_ON = ['tool_search', 'clarify', 'memory_search', 'web_search', 'kb_search', 'skill', 'get_chat_history', 'reminder_set', 'schedule_task', 'context_recall', 'diagram_render', 'get_group_file', 'list_group_files']
const QUOTE_PREFIX = '【引用消息】'
const QUOTE_SUFFIX = '【引用消息结束】'

export const GOVERNOR_STOP = new Set(['max_turns', 'duplicate_action', 'consecutive_failures', 'no_progress', 'time_budget', 'token_budget', 'provider_incomplete'])
export const STOP_REASON_CN = {
  max_turns: '已达到本轮工具调用次数上限',
  token_budget: '本轮的 token 预算已用完',
  time_budget: '本轮的时间预算已用完',
  duplicate_action: '检测到工具在重复执行相同操作，已停止以避免空转',
  no_progress: '连续多步工具调用没有产生新结果，已停止',
  consecutive_failures: '工具连续失败多次，已停止重试',
  provider_incomplete: '模型未产出可用正文（可能达到输出上限或被截断），已停止',
}

const _activeRuns = new Map()
export function abortActiveRun(taskId) {
  const h = _activeRuns.get(taskId)
  if (!h) return false
  try { h.ctl.abort() } catch { /* noop */ }
  return true
}
export function isAgentRunActive(taskId) { return _activeRuns.has(taskId) }
export async function abortAllActiveRuns() {
  const handles = [..._activeRuns.values()]
  for (const h of handles) { try { h.ctl.abort() } catch { /* noop */ } }
  await Promise.allSettled(handles.map((h) => h.done))
  return handles.length
}

function shortHash(str) {
  let h1 = 0x811c9dc5, h2 = 0x01000193
  const s = String(str || '')
  for (let i = 0; i < s.length; i++) { h1 = ((h1 ^ s.charCodeAt(i)) * 16777619) >>> 0; h2 = ((h2 + s.charCodeAt(i) * 31) >>> 0) }
  return (h1.toString(36) + h2.toString(36)).slice(0, 12)
}

/** 从旧 provider/client 推导 ModelFactory 所需的最小 cfg（研究/多代理/评测兼容路径）。 */
export function deriveCfgFromProvider(provider, model = '', extra = {}) {
  return {
    protocol: 'legacy',
    preset: '',
    apiKey: 'legacy-provider',
    model: model || provider?.defaultModel || 'legacy-model',
    legacyProvider: provider,
    temperature: extra.temperature,
    maxTokens: extra.maxTokens ?? extra.max_tokens,
    ...extra,
  }
}

export class MastraAgent {
  constructor(config = {}) {
    this.provider = config.provider || null
    this.cfg = config.cfg || config.agentConfig?.cfg || null
    this.model = config.model || null
    this.tools = config.tools || null
    this.memory = config.memory || null
    this.skills = config.skills || null
    this.stickers = config.stickers || null
    this.systemPrompt = config.systemPrompt || DEFAULT_IDENTITY
    this.maxTurns = config.maxTurns ?? 200
    this.temperature = config.temperature
    this.maxTokens = config.max_tokens ?? config.maxTokens ?? null
    this.thinking = config.thinking || null
    this.thinkingAuto = config.thinkingAuto || null
    this.thinkingCapableOverride = typeof config.thinkingCapable === 'boolean' ? config.thinkingCapable : null
    this.mediaCaps = config.mediaCaps || null
    this.thinkingClassifierLlm = config.thinkingClassifierLlm || null
    this.jev = config.jev || null
    this.shellIntercept = Array.isArray(config.shellIntercept) ? config.shellIntercept : []
    this.providerProtocol = config.protocol || (this.cfg?.protocol) || 'openai'
    this.providerPreset = config.preset || (this.cfg?.preset) || ''
    this.toolChoice = config.tool_choice ?? config.toolChoice ?? null
    this.estimateTokens = config.estimateTokens || null
    this.contextWindowOverride = Number.isFinite(Number(config.contextWindow)) && Number(config.contextWindow) > 0 ? Number(config.contextWindow) : null
    this.contextWindow = this.contextWindowOverride
    this.contextWindowTotal = this.contextWindowOverride
    this.contextMaxOutput = null
    this._contextMeta = null
    this._contextWindowIsInput = false
    this.contextResolver = typeof config.contextResolver === 'function' ? config.contextResolver : null
    const ratio = (v, dflt, min, max) => { const n = Number(v); return Number.isFinite(n) && n >= min && n <= max ? n : dflt }
    this.contextHighRatio = ratio(config.contextHighRatio, 0.8, 0.3, 0.95)
    const lowCap = Math.max(0.05, this.contextHighRatio - 0.05)
    this.contextLowRatio = Math.min(ratio(config.contextLowRatio, 0.45, 0.05, lowCap), lowCap)
    this.cacheEpoch = 0
    this.compactArchive = config.compactArchive || null
    this._compactLedger = null
    this.maxToolResultChars = config.maxToolResultChars ?? 8000
    this.keepReasoning = config.keepReasoning === true
    this.contextKeepRecent = config.contextKeepRecent ?? 8
    this.logger = config.logger || (() => {})
    this.devLog = config.devLog || null
    this.guard = config.guard || null
    this.guardSensitivity = config.guardSensitivity || 'medium'
    this.guardAction = config.guardAction || 'flag'
    this.untrustedGuard = config.untrustedGuard !== false
    this.blockedMessage = config.blockedMessage || '检测到潜在的指令注入，已拒绝处理。'
    this.policy = config.policy || null
    this.confirm = config.confirm || null
    this.masterSkipConfirm = config.masterSkipConfirm === true
    this.session = config.session || null
    this.recall = config.recall || null
    this.recallTopK = config.recallTopK ?? 5
    this.recallLlm = config.recallLlm || null
    this.profile = config.profile || null
    this.promptRegistry = config.promptRegistry || null
    this.reflect = config.reflect ?? 'auto'
    this.reflectMaxIterations = config.reflectMaxIterations ?? 1
    this.finalizeMaxTokens = Math.max(256, Number(config.finalizeMaxTokens) || 2048)
    this.fallbackProviders = Array.isArray(config.fallbackProviders) ? config.fallbackProviders : []
    this.taskStore = config.taskStore || null
    this.toolDiscovery = config.toolDiscovery || null
    this.stableToolList = config.toolDiscovery?.stableList !== false
    this.activeTools = null
    this._metaTools = {}
    this.messages = []
    this._userTexts = []
    this._runnerPromise = null
    this._budget = { limit: Number(config.rootTokenBudget) > 0 ? Number(config.rootTokenBudget) : null, consumed: 0, reserved: 0 }
    this._journalDegraded = false
    this._lastPrefixFp = null
  }

  setHistory(messages) { this.messages = messages ? messages.map((m) => ({ ...m })) : [] }
  getHistory() { return this.messages }
  reset() { this.messages = [] }
  reserveBudget() { return true }
  releaseBudget() {}
  noteExternalUsage() {}
  async continueFrom(_checkpoint, _opts = {}) { throw new Error('MastraAgent 不支持 continueFrom：请使用 chat-runner 的 resume') }

  _inputText(input) {
    if (input == null) return ''
    if (typeof input === 'string') return input
    if (typeof input.content === 'string') return input.content
    if (Array.isArray(input.content)) return input.content.filter((b) => b && b.type === 'text').map((b) => b.text || '').join('\n').trim()
    try { return JSON.stringify(input) } catch { return '' }
  }

  _screenUntrusted(text, source, { always = true } = {}) {
    const raw = String(text ?? '')
    if (!raw || !this.untrustedGuard) return raw
    let body = raw
    if (this.guard && typeof this.guard.screenUntrusted === 'function') {
      try {
        const r = this.guard.screenUntrusted(raw, { source, sensitivity: this.guardSensitivity, action: 'label' })
        if (r.flagged) this.logger('warn', `外部内容疑似注入：source=${source} score=${r.score}`)
        body = r.text
      } catch { body = raw }
    }
    return always ? tagUntrusted(body, source) : body
  }

  _memorySnapshot(scopeId) {
    if (!this.memory) return ''
    try { return this._screenUntrusted(this.memory.snapshotAll(scopeId) || '', 'declarative_memory') } catch (e) {
      this.logger('warn', `[memory] 声明式记忆快照读取失败：${e?.message || e}`)
      return ''
    }
  }

  _stickerCatalog() {
    if (!this.stickers) return ''
    try { return this._screenUntrusted(buildStickerPromptSection(this.stickers.catalog()), 'sticker_catalog') } catch { return '' }
  }

  _buildUserMessage(input, text) {
    if (input && typeof input === 'object' && !Array.isArray(input)) {
      if (input._media && Array.isArray(input.content)) {
        const nonText = input.content.filter((b) => !b || b.type !== 'text')
        return { role: input.role || 'user', content: (text ? [{ type: 'text', text }] : []).concat(nonText) }
      }
      return { role: input.role || 'user', ...input, content: text }
    }
    return { role: 'user', content: text }
  }

  _stripInjectedFromUserText(content) {
    let text = typeof content === 'string' ? content : (Array.isArray(content) ? content.filter((b) => b && b.type === 'text').map((b) => b.text || '').join('\n') : '')
    if (!text) return ''
    const marker = '【用户消息】'
    const i = text.lastIndexOf(marker)
    let body = (i >= 0 ? text.slice(i + marker.length) : text).trim()
    if (body.startsWith(QUOTE_PREFIX)) {
      const end = body.indexOf(QUOTE_SUFFIX)
      if (end >= 0) body = body.slice(end + QUOTE_SUFFIX.length)
      else { const sep = body.indexOf('\n\n'); body = sep >= 0 ? body.slice(sep + 2) : '' }
    }
    return body.trim()
  }

  _assembleSystem(memories, systemPromptOverride, _context, _scopeId) {
    const regIdentity = this.promptRegistry?.get('agent')?.system
    const evolvedIdentity = regIdentity && regIdentity !== TEMPLATES?.agent?.system ? regIdentity : ''
    const identity = systemPromptOverride || evolvedIdentity || this.systemPrompt
    let toolCatalog = ''
    if (this.toolDiscovery?.enable && this.tools) {
      const staticNames = this.toolDiscovery.alwaysOn?.length ? this.toolDiscovery.alwaysOn : DEFAULT_ALWAYS_ON
      const names = [...staticNames]
      if (this.jev?.client?.configured && this.jev.decisions?.llmTool && this.tools.has?.('jev')) names.push('jev')
      const alwaysOnTools = [...Object.values(this._metaTools), ...names.map((n) => this.tools.get(n)).filter(Boolean)]
      toolCatalog = buildToolDiscoverySection({ alwaysOnTools, categories: ['query', 'personal', 'message', 'group_manage', 'system'] })
    } else if (this.tools && this.tools.list().length) {
      toolCatalog = buildToolCatalogSection(this.tools.list())
    }
    const skillsSection = this.skills ? this._screenUntrusted(buildSkillsPromptSection(this.skills.catalog()), 'skills_catalog') : ''
    const guardHardening = this.guard ? (this.guard.systemHardening() || '') : ''
    const system = buildAgentSystemPrompt({
      identity, serviceDirective: SERVICE_DIRECTIVE, toolCatalog,
      skillsSection, stickerSection: '', memorySnapshot: '', guardHardening,
    })
    const breakdown = tokenBreakdown({
      identity, service: SERVICE_DIRECTIVE + '\n\n' + SEARCH_VERIFICATION, context: '', guard: guardHardening,
      toolCatalog, toolListTokens: 0, recalledMemory: '', memorySnapshot: '',
      skills: skillsSection, sticker: '', conversationTokens: this._estimateMessagesTokens(),
    }, this.estimateTokens)
    const fp = {
      systemHash: shortHash(identity + SERVICE_DIRECTIVE + SEARCH_VERIFICATION),
      toolListHash: shortHash(this._buildToolList().map((t) => t?.name).filter(Boolean).join(',')),
      toolHash: shortHash(toolCatalog), stickerVersion: '', guardHash: shortHash(guardHardening),
      skillsHash: shortHash(skillsSection),
    }
    let cacheBreakReason = null
    if (this._lastPrefixFp) {
      if (fp.systemHash !== this._lastPrefixFp.systemHash) cacheBreakReason = 'system_identity'
      else if (fp.toolListHash !== this._lastPrefixFp.toolListHash) cacheBreakReason = 'tool_list'
      else if (fp.toolHash !== this._lastPrefixFp.toolHash) cacheBreakReason = 'tool_schema'
      else if (fp.guardHash !== this._lastPrefixFp.guardHash) cacheBreakReason = 'guard_rules'
      else if (fp.skillsHash !== this._lastPrefixFp.skillsHash) cacheBreakReason = 'skills_catalog'
    }
    this._lastPrefixFp = fp
    return { system, breakdown, prefixFp: fp, cacheBreakReason }
  }

  _buildToolList() {
    if (!this.tools) return []
    if (this.stableToolList) return [...Object.values(this._metaTools), ...this.tools.list()]
    if (!this.activeTools) return this.tools.list()
    const out = []
    const seen = new Set()
    for (const t of Object.values(this._metaTools || {})) if (t && !seen.has(t.name)) { out.push(t); seen.add(t.name) }
    for (const name of this.activeTools) { if (seen.has(name)) continue; const t = this.tools.get(name); if (t) { out.push(t); seen.add(name) } }
    return out
  }

  _contentText(content) {
    if (content == null) return ''
    if (typeof content === 'string') return content
    if (Array.isArray(content)) return content.map((b) => {
      if (b == null) return ''
      if (typeof b === 'string') return b
      if (typeof b.text === 'string') return b.text
      if (typeof b.type === 'string') return `[${b.type}]`
      try { return JSON.stringify(b) } catch { return '' }
    }).filter(Boolean).join('\n')
    try { return JSON.stringify(content) } catch { return '' }
  }

  _estimateToolsTokens() {
    const list = this._buildToolList()
    if (!list.length) return 0
    return estimateTokensApprox(JSON.stringify(list.map((t) => ({ n: t.name, d: t.description, p: t.parameters }))))
  }

  _estimateHistory(system, { toolTokens = null } = {}) {
    const fn = this.estimateTokens || estimateTokensApprox
    return fn(String(system ?? '')) + this._estimateMessagesTokens({ includeReasoning: true }) + (toolTokens == null ? this._estimateToolsTokens() : toolTokens)
  }

  _estimateMessagesTokens({ includeReasoning = this.keepReasoning } = {}) {
    const fn = this.estimateTokens || estimateTokensApprox
    let n = 0
    for (const m of this.messages || []) {
      n += 4 + fn(this._contentText(m.content))
      if ((includeReasoning || m.tool_calls) && m.reasoning) n += fn(m.reasoning)
      if (m.provider_native) n += fn(JSON.stringify(m.provider_native))
      if (m.tool_calls) n += fn(JSON.stringify(m.tool_calls))
    }
    return n
  }

  _thinkingActive() {
    const t = this.thinking
    if (!t || t === 'off' || t === false) return false
    if (typeof t === 'object' && (t.type === 'disabled' || t.enabled === false)) return false
    return true
  }

  _resolveContextForRun() {
    if (this.contextWindowOverride) { this.contextWindow = this.contextWindowOverride; return }
    let meta = null
    try {
      const resolver = this.contextResolver || resolveModelContext
      meta = resolver({ model: this.model, protocol: this.providerProtocol, preset: this.providerPreset, thinking: this._thinkingActive() })
    } catch { meta = null }
    const inputBudget = Math.max(1024, Number(meta?.inputBudget) || 128000)
    this._contextMeta = meta
    this.contextWindow = inputBudget
    this.contextWindowTotal = Number(meta?.contextWindow) || inputBudget
    const mo = Number(meta?.maxOutputTokens)
    this.contextMaxOutput = Number.isFinite(mo) && mo > 0 ? mo : null
    this._contextWindowIsInput = true
  }

  async _runner() {
    if (!this._runnerPromise) {
      this._runnerPromise = (async () => {
        const cfg = this.cfg || deriveCfgFromProvider(this.provider, this.model, {
          temperature: this.temperature, maxTokens: this.maxTokens,
        })
        this.cfg = cfg
        this.providerProtocol = cfg.protocol || this.providerProtocol
        this.providerPreset = cfg.preset || this.providerPreset
        if (!this.model) this.model = cfg.model
        return createMastraChatRunner({
          cfg,
          deps: {
            tools: this.tools, confirm: this.confirm, taskStore: this.taskStore,
            policy: this.policy, guard: this.guard, makeAgent: () => this,
          },
          logger: this.logger,
        })
      })()
    }
    return this._runnerPromise
  }

  async run(input, opts = {}) {
    const taskId = opts.taskId || `mastra_${randomUUID()}`
    const ctl = new AbortController()
    if (opts.signal) {
      if (opts.signal.aborted) ctl.abort()
      else opts.signal.addEventListener('abort', () => { try { ctl.abort() } catch { /* noop */ } }, { once: true })
    }
    const h = { ctl, done: Promise.resolve() }
    _activeRuns.set(taskId, h)
    try {
      const runner = await this._runner()
      const r = await runner.runChat(input, { ...opts, agentInst: this, taskId, signal: ctl.signal })
      if (r?.unsupported) {
        throw Object.assign(new Error(`Mastra 不支持当前请求：${r.unsupported}`), { code: r.unsupported })
      }
      this._userTexts = [this._inputText(input)]
      return r
    } finally {
      _activeRuns.delete(taskId)
    }
  }
}

export default MastraAgent
