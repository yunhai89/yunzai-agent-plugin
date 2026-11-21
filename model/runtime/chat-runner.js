/**
 * PR4a：Mastra Agent 非流式聊天 Runner（灰度）。
 *
 * 只对纯文本、非思考自定义字段、非 Gemini/Azure 的灰度请求启用；不支持时返回
 * `{unsupported:reason}`，Facade 自动回退 legacy（不静默减功能）。
 *
 * 复用 legacy Agent 的上下文装配：
 *  - `agentInst._assembleSystem()`（身份/服务准则/工具目录/技能/guard）；
 *  - recall/profile/MEMORY 快照/情境仍按 legacy 方式拼到本轮 user 消息尾部；
 *  - 历史由 SessionStore 读取，显式传给 Mastra（Phase 1 不让 Memory 接管）。
 *
 * 审批：PR4a 使用旧 ConfirmStore 在工具 execute 内阻塞（#确认/#拒绝 原样可用），
 * 不进入 Mastra suspend；原生 ApprovalBridge 已在 PR3b 就绪，PR4c 再接。
 */
import { Agent } from '@mastra/core/agent'
import { RequestContext } from '@mastra/core/request-context'
import { createModelFactory, resolveThinkingOptions, resolveModelSettings } from './model-factory.js'
import { adaptTools } from './tool-adapter.js'
import { ToolNameMap } from './tool-name.js'
import { legacyToMastraMessages, mastraMessagesToLegacy, hasUnsupportedLegacyShape, currentUserContent } from './message-adapter.js'
import { normalizeAiSdkUsage, aiSdkFinishReason } from './observability.js'
import { resolveProxyFetch } from './proxy-fetch.js'
import { compactMessages } from '../agent/compact/index.js'
import { getPromptCalibration } from '../llm/model-context.js'

export function createMastraChatRunner({ cfg = {}, deps = {}, logger = null, fetchImpl = null } = {}) {
  let factoryPromise = null
  const pending = new Map()
  const nativeApproval = deps.nativeApproval === true
  // 单实例 + 动态 instructions/model/tools（从 RequestContext 取），native approval 需要 Agent 注册到 Mastra storage 才能 resume
  const agent = new Agent({
    id: 'yz-chat',
    name: 'yz-chat',
    instructions: ({ requestContext }) => requestContext?.get?.('yz.system') || '',
    model: ({ requestContext }) => requestContext?.get?.('yz.model'),
    tools: ({ requestContext }) => requestContext?.get?.('yz.tools') || {},
  })
  try { deps.mastra?.addAgent?.(agent, 'yz-chat') } catch { /* 已注册/无 Mastra 时忽略 */ }
  const factory = async () => {
    if (!factoryPromise) {
      factoryPromise = (async () => {
        const f = fetchImpl || await resolveProxyFetch(cfg.proxy, { logger })
        return createModelFactory({ cfg, fetchImpl: f, sessionId: 'yz-mastra-chat' })
      })()
    }
    return factoryPromise
  }

  /**
   * @returns {Promise<object|null>} null/unsupported → Facade 回退 legacy
   */
  async function runChat(input, opts = {}) {
    const agentInst = opts.agentInst
    if (!agentInst) return { unsupported: 'no_agent_instance' }

    const f = await factory()
    const main = f.main()
    if (!main || main.legacyOnly) return { unsupported: `model_${main?.reason || 'unconfigured'}` }
    const th = resolveThinkingOptions({ ref: main.ref, thinking: agentInst.thinking })
    if (th.legacyOnly) return { unsupported: `thinking_${th.style}` }
    const { modelSettings } = resolveModelSettings(main.ref, {
      thinkingOptions: th, temperature: agentInst.temperature, maxTokens: agentInst.maxTokens,
    })

    const ctx = opts.ctx || {}
    const rawText = agentInst._inputText(input)
    const scopeUserId = ctx.scopeUserId || ctx.userId || ''
    const groupId = ctx.groupId || null
    const convId = ctx.conversationId
    let history = await loadHistory(agentInst, { scopeUserId, groupId, convId })
    const badShape = hasUnsupportedLegacyShape(history)
    if (badShape) return { unsupported: badShape }
    let convState = {}
    if (convId != null && typeof agentInst.session?.getConversationState === 'function') {
      try { convState = await agentInst.session.getConversationState(scopeUserId, groupId, convId) || {} } catch { convState = {} }
    }
    agentInst.cacheEpoch = Number(convState.cacheEpoch) || 0
    agentInst._compactLedger = convState.compactLedger && typeof convState.compactLedger === 'object' ? convState.compactLedger : null
    agentInst.messages = history.map((m) => ({ ...m }))

    let memories = null
    if (agentInst.recall && ctx && !opts.ephemeral) {
      try {
        memories = await agentInst.recall.retrieve(rawText, scopeUserId, agentInst.recallTopK)
      } catch { memories = null }
    }
    let recalled = ''
    if (memories?.length) recalled = agentInst.recall.formatForPrompt(memories) || ''
    let profile = ''
    if (agentInst.profile && scopeUserId && !opts.ephemeral) {
      try { profile = await agentInst.profile.build(scopeUserId) } catch { profile = '' }
    }
    const dynParts = []
    if (opts.context) dynParts.push(agentInst._screenUntrusted(opts.context, 'context'))
    if (!opts.ephemeral) {
      const snap = agentInst._memorySnapshot(ctx.scopeId)
      if (snap) dynParts.push(snap)
    }
    if (recalled) dynParts.push(agentInst._screenUntrusted(recalled, 'memory'))
    if (profile) dynParts.push(agentInst._screenUntrusted(profile, 'profile'))
    let userText = rawText
    if (dynParts.length) userText = `【本轮情境参考（系统注入，非用户发言）】\n${dynParts.join('\n\n')}\n\n【用户消息】\n${userText}`
    const { system } = agentInst._assembleSystem(memories, opts.systemPrompt, opts.context, ctx.scopeId)
    const compactedState = await maybeCompactHistory(agentInst, history, { system, scopeUserId, groupId, convId, taskId: opts.taskId || '', ctx })
    history = compactedState.history
    const messages = legacyToMastraMessages([...history])
    const active = Array.isArray(input) ? { role: 'user', content: input } : input
    messages.push({ role: 'user', content: currentUserContent(active, userText) })

    const taskId = opts.taskId || ''
    const runId = taskId || `run-${Date.now().toString(36)}`
    const callbacks = opts.callbacks || {}
    const onDelta = opts.onDelta || callbacks.onDelta
    const onReasoning = opts.onReasoning || callbacks.onReasoning
    const onAssistant = opts.onAssistant || callbacks.onAssistant
    const adapted = adaptTools(deps.tools, {
      allowWrite: true,
      names: new ToolNameMap(),
      approval: nativeApproval ? deps.approval || null : null,
      confirmStore: nativeApproval ? null : (deps.confirm || agentInst.confirm || null),
      policy: agentInst.policy || deps.policy || null,
      masterSkipConfirm: agentInst.masterSkipConfirm === true,
      taskStore: deps.taskStore || agentInst.taskStore || null,
      guard: deps.guard || agentInst.guard || null,
      untrustedGuard: agentInst.untrustedGuard !== false,
      onMasterAutoApprove: opts.callbacks?.onMasterAutoApprove,
      onToolStart: callbacks.onToolStart,
      onToolEnd: callbacks.onToolEnd,
    })
    const rc = new RequestContext()
    rc.set('yz.system', system)
    rc.set('yz.model', main.model)
    rc.set('yz.tools', adapted.tools)
    rc.set('yz.conversationId', convId)
    rc.set('yz.ctx', ctx)
    rc.set('yz.taskId', taskId)
    rc.set('yz.runId', runId)
    rc.set('yz.toolCallId', null)
    rc.set('yz.threadId', opts.threadId || null)
    rc.set('yz.resourceId', opts.resourceId || null)
    rc.set('yz.scopeKey', opts.scopeKey || null)

    const taskStore = deps.taskStore || agentInst.taskStore || null
    const resumeEntry = { agent, rc, agentInst, history, scopeUserId, groupId, convId, taskStore, taskId, rawText, main, protocol: main.ref.protocol, runId, ...compactedState }
    if (nativeApproval) pending.set(runId, resumeEntry)
    if (taskStore && taskId) {
      try { await taskStore.begin({ taskId, ctx, phase: 'running', input: rawText }) } catch { /* 旧路径/已存在不阻断 */ }
    }
    let out
    try {
      const genOpts = {
        runId,
        requestContext: rc,
        maxSteps: Math.max(1, Number(agentInst.maxTurns) || 200),
        abortSignal: opts.signal || undefined,
        modelSettings,
        providerOptions: th.providerOptions,
      }
      if (opts.stream) {
        const stream = await agent.stream(messages, genOpts)
        let stepText = ''
        let stepHasTool = false
        for await (const chunk of stream.fullStream) {
          const type = chunk?.type
          const p = chunk?.payload || {}
          if (type === 'step-start') { stepText = ''; stepHasTool = false; continue }
          if (type === 'text-delta') { stepText += p.text || ''; continue }
          if (type === 'reasoning-delta') {
            if (onReasoning) { try { onReasoning(p.text || '') } catch { /* noop */ } }
            continue
          }
          if (type === 'tool-call') { stepHasTool = true; continue }
          if (type === 'step-finish') {
            if (stepText) {
              if (stepHasTool) {
                if (onAssistant) { try { onAssistant({ content: stepText, toolCalls: [{ name: p?.toolName || '' }] }) } catch { /* noop */ } }
              } else if (onDelta) {
                try { onDelta(stepText) } catch { /* noop */ }
              }
            }
            stepText = ''
            stepHasTool = false
          }
        }
        out = await stream.getFullOutput()
      } else {
        out = await agent.generate(messages, genOpts)
      }
    } catch (e) {
      if (taskStore && taskId) await taskStore.finish({ taskId, phase: 'failed', stopReason: 'run_error', completion: 'none' }).catch(() => {})
      throw e
    }
    if (out.error) {
      if (taskStore && taskId) await taskStore.finish({ taskId, phase: 'failed', stopReason: 'run_error', completion: 'none' }).catch(() => {})
      throw out.error
    }
    const lastStepText = Array.isArray(out.steps) && out.steps.length ? String(out.steps[out.steps.length - 1]?.text || '').trim() : ''
    const content = lastStepText || String(out.text || '').trim()
    if (out.finishReason === 'suspended') {
      if (!nativeApproval) {
        if (taskStore && taskId) await taskStore.finish({ taskId, phase: 'waiting_input', stopReason: 'approval', completion: 'partial' }).catch(() => {})
        throw Object.assign(new Error('Mastra 审批 suspend 未接入 Facade'), { code: 'mastra_suspended' })
      }
      const sp = out.suspendPayload || {}
      const rec = await deps.approval?.getForCall(runId, sp.toolCallId).catch(() => null)
      return {
        content: `⏳ 需要审批：${sp.toolName || '工具'} #${rec?.id || '?'}
主人发送 #确认 ${rec?.id || ''} 或 #拒绝 ${rec?.id || ''}。`,
        stopReason: 'waiting_input',
        turns: 0, usage: null, taskId: runId, engine: 'mastra',
        suspended: true, approvalId: rec?.id || null, toolCallId: sp.toolCallId || null, runId,
      }
    }
    if (!content) {
      const used = (out.toolCalls || []).length || (out.steps || []).some((st) => st?.toolResults?.length || st?.toolCalls?.length)
      if (taskStore && taskId) await taskStore.finish({ taskId, phase: 'failed', stopReason: 'provider_incomplete', completion: 'none' }).catch(() => {})
      if (used) throw Object.assign(new Error('Mastra 空输出'), { code: 'provider_incomplete' })
      return { unsupported: 'empty_output' }
    }
    const protocol = main.ref.protocol
    const stopReason = aiSdkFinishReason(out.finishReason, { protocol })
    const usage = normalizeAiSdkUsage(out.totalUsage || out.usage, { protocol })
    const turns = Array.isArray(out.steps) ? out.steps.length : 0
    if (taskStore && taskId) await taskStore.finish({ taskId, phase: 'completed', stopReason, completion: 'complete', usage }).catch(() => {})
    const converted = mastraMessagesToLegacy(out.messages || [])
    const newMsgs = stripHistoryPrefix(converted, history)
    const finalMsgs = compactedState.compacted ? [...history, ...newMsgs] : newMsgs
    if (finalMsgs.length) {
      try {
        await saveHistory(agentInst, {
          scopeUserId, groupId, convId, msgs: finalMsgs, replace: compactedState.compacted,
          extra: { cacheEpoch: compactedState.cacheEpoch, compactLedger: compactedState.ledger || undefined },
        })
      } catch (e) {
        logger?.('warn', '[runtime] Mastra 历史持久化失败', e?.message || e)
      }
    }
    if (nativeApproval) pending.delete(runId)
    agentInst._userTexts = [rawText]
    try { logger?.('mark', '[runtime] Mastra 灰度回复', `model=${main.ref.model}`, `turns=${turns}`, `tools=${(out.toolCalls || []).length}`) } catch { /* noop */ }
    return {
      content,
      messages: agentInst.messages,
      usage,
      turns,
      taskId: runId,
      stopReason,
      engine: 'mastra',
      toolCalls: (out.toolCalls || []).length,
    }
  }

  async function rebuildEntry(rec) {
    const inst = deps.makeAgent ? deps.makeAgent() : null
    if (!inst) return null
    const f = await factory()
    const main = f.main()
    if (!main || main.legacyOnly) return null
    const adapted = adaptTools(deps.tools, {
      allowWrite: true, names: new ToolNameMap(),
      approval: deps.approval || null,
      confirmStore: null,
      policy: inst.policy || deps.policy || null,
      masterSkipConfirm: inst.masterSkipConfirm === true,
      taskStore: deps.taskStore || inst.taskStore || null,
      guard: deps.guard || inst.guard || null,
      untrustedGuard: inst.untrustedGuard !== false,
    })
    const rc = new RequestContext()
    const c = rec.ctx || {}
    rc.set('yz.ctx', {
      userId: c.userId, groupId: c.groupId, scopeUserId: c.scopeUserId,
      isGroup: !!c.groupId, role: c.role || 'member', isMaster: c.isMaster === true,
      conversationId: c.conversationId,
    })
    rc.set('yz.system', rec.meta?.system || '')
    rc.set('yz.model', main.model)
    rc.set('yz.tools', adapted.tools)
    rc.set('yz.conversationId', rec.ctx?.conversationId || null)
    rc.set('yz.taskId', rec.runId)
    rc.set('yz.runId', rec.runId)
    return {
      agent, rc, agentInst: inst, history: [],
      scopeUserId: c.scopeUserId || c.userId || '', groupId: c.groupId || null,
      convId: c.conversationId || null, taskStore: deps.taskStore || inst.taskStore || null,
      taskId: rec.runId, rawText: '', main, protocol: main.ref.protocol, runId: rec.runId,
    }
  }

  async function approve(id, approved, actor = 'master') {
    if (!nativeApproval || !deps.approval) return { ok: false, code: 'native_approval_disabled' }
    const rec = await deps.approval.get(id)
    if (!rec) return { ok: false, code: 'not_found' }
    const r = await deps.approval.resolve(id, approved === true, { actor })
    if (!r.ok) return r
    let entry = pending.get(rec.runId)
    if (!entry) entry = await rebuildEntry(rec)
    if (!entry) return { ok: true, resumed: false, record: r.record }
    let out
    try {
      out = approved
        ? await entry.agent.approveToolCallGenerate({ runId: rec.runId, toolCallId: rec.toolCallId, requestContext: entry.rc })
        : await entry.agent.declineToolCallGenerate({ runId: rec.runId, toolCallId: rec.toolCallId, requestContext: entry.rc })
    } catch (e) {
      return { ok: true, resumed: false, code: 'resume_failed', error: e?.message || String(e), record: r.record }
    }
    pending.delete(rec.runId)
    const result = await finalizeResume(out, entry)
    return { ok: true, resumed: true, content: result.content, result, record: r.record }
  }

  async function pendingApprovals() {
    if (!nativeApproval || !deps.approval) return []
    return deps.approval.list({ status: 'pending' })
  }

  return { runChat, approve, pendingApprovals }
}

async function finalizeResume(out, e) {
  if (out.error) throw out.error
  const last = Array.isArray(out.steps) && out.steps.length ? String(out.steps[out.steps.length - 1]?.text || '').trim() : ''
  const content = last || String(out.text || '').trim()
  const stopReason = aiSdkFinishReason(out.finishReason, { protocol: e.protocol })
  const usage = normalizeAiSdkUsage(out.totalUsage || out.usage, { protocol: e.protocol })
  const turns = Array.isArray(out.steps) ? out.steps.length : 0
  const converted = mastraMessagesToLegacy(out.messages || [])
  const newMsgs = stripHistoryPrefix(converted, e.history)
  const finalMsgs = e.compacted ? [...(e.history || []), ...newMsgs] : newMsgs
  if (finalMsgs.length) {
    try {
      await saveHistory(e.agentInst, {
        scopeUserId: e.scopeUserId, groupId: e.groupId, convId: e.convId, msgs: finalMsgs, replace: e.compacted === true,
        extra: { cacheEpoch: e.cacheEpoch, compactLedger: e.ledger || undefined },
      })
    } catch { /* noop */ }
  }
  if (e.taskStore && e.taskId) await e.taskStore.finish({ taskId: e.taskId, phase: 'completed', stopReason, completion: 'complete', usage }).catch(() => {})
  return { content, stopReason, usage, turns, taskId: e.runId, engine: 'mastra' }
}

async function loadHistory(agentInst, { scopeUserId, groupId, convId }) {
  const s = agentInst.session
  if (!s) return []
  try {
    if (convId != null && typeof s.getConversation === 'function') {
      const arr = await s.getConversation(scopeUserId, groupId, convId)
      if (Array.isArray(arr)) return arr
    }
    const key = typeof s.key === 'function' ? s.key(groupId, scopeUserId) : null
    if (key) {
      const arr = await s.get(key)
      if (Array.isArray(arr)) return arr
    }
  } catch { /* noop */ }
  return []
}

async function saveHistory(agentInst, { scopeUserId, groupId, convId, msgs, replace = false, extra = {} }) {
  const s = agentInst.session
  if (!s || !msgs?.length) return
  if (convId != null && typeof s.appendConversation === 'function') {
    if (replace && typeof s.setConversation === 'function') await s.setConversation(scopeUserId, groupId, convId, msgs, extra)
    else await s.appendConversation(scopeUserId, groupId, convId, msgs, extra)
    return
  }
  const key = typeof s.key === 'function' ? s.key(groupId, scopeUserId) : null
  if (key) {
    if (replace && typeof s.set === 'function') await s.set(key, msgs)
    else await s.append(key, msgs)
  }
}

async function maybeCompactHistory(agentInst, history, { system, scopeUserId, groupId, convId, taskId, ctx }) {
  const out = { history, compacted: false, cacheEpoch: Number(agentInst.cacheEpoch) || 0, ledger: agentInst._compactLedger || null }
  if (!history.length || !agentInst.compactArchive || typeof agentInst._estimateHistory !== 'function') return out
  try {
    if (typeof agentInst._resolveContextForRun === 'function') agentInst._resolveContextForRun(taskId, ctx)
    const window = Number(agentInst.contextWindow) || 0
    if (!window) return out
    const high = Math.max(1, Math.floor(window * (Number(agentInst.contextHighRatio) || 0.8)))
    const est = agentInst._estimateHistory(system)
    if (est <= high) return out
    const cal = getPromptCalibration(agentInst.model)
    const fn = agentInst.estimateTokens || (() => 0)
    const low = Number(agentInst.contextLowRatio) || 0.45
    const target = Math.max(128, Math.floor((window * low) / cal) - fn(String(system ?? '')) - (agentInst._estimateToolsTokens?.() || 0) - 16)
    const convKey = `${scopeUserId || 'u'}:${groupId || 'p'}:${convId || 'unknown'}`
    const rr = await compactMessages(history, {
      kind: 'token', value: target, archive: agentInst.compactArchive, convKey, epoch: out.cacheEpoch + 1,
      estimateTokens: agentInst.estimateTokens, minKeep: Math.max(Number(agentInst.contextKeepRecent) || 8, 2),
      prevLedger: out.ledger,
    })
    if (rr.dropped || rr.pruned) {
      out.history = rr.messages
      out.ledger = rr.ledger || out.ledger
      out.cacheEpoch += 1
      out.compacted = true
    }
  } catch { /* 压缩失败保留原历史，不让聊天失败 */ }
  return out
}

/** 输出 messages 可能包含输入历史；按 role/content 前缀剥离，避免 SessionStore 重复追加 */
function stripHistoryPrefix(converted, history) {
  if (!history?.length || !converted?.length) return converted
  const text = (content) => {
    if (typeof content === 'string') return content
    if (Array.isArray(content)) return content.filter((p) => p && p.type === 'text').map((p) => p.text || '').join('\n')
    return content == null ? '' : String(content)
  }
  const norm = (m) => {
    const calls = Array.isArray(m?.tool_calls) ? m.tool_calls.map((c) => `${c.id || ''}:${c.function?.name || c.name || ''}`).join(',') : ''
    return `${m?.role || ''}:${text(m?.content)}:${m?.tool_call_id || m?.toolCallId || ''}:${calls}`
  }
  const h = history.map(norm)
  const c = converted.map(norm)
  let n = 0
  while (n < h.length && n < c.length && h[n] === c[n]) n++
  return n === h.length ? converted.slice(n) : converted
}
