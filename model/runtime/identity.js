/**
 * Mastra Identity 规范（PR1）。
 *
 * resource/thread 是 Memory/Workflow 的数据归属键，必须同时包含：
 *   adapter（onebot/qqbot/qqguild）+ botId（self_id/appid）+ scopeId（现有 ctx.scopeId）。
 * 只带 scopeId 会让两个机器人账号共享 thread（00 §1.6/§7 的隔离缺口）。
 *
 * 官方 QQ ID 含 `:`，一律经 safeScopePart 净化，禁止 split(':') 解析。
 * 输出只允许 `[A-Za-z0-9_-]`，长度 ≤128（Mastra/store 的稳定键）。
 */
import { safeScopePart } from '../qqofficial/index.js'

export const IDENTITY_MAX_LEN = 128
export const IDENTITY_RE = /^[A-Za-z0-9_-]+$/

/** FNV-1a 32 位短哈希（与 safeScopePart 的防撞思路一致，稳定、无依赖） */
function shortHash(s) {
  let h = 0x811c9dc5
  for (let i = 0; i < String(s).length; i++) {
    h ^= String(s).charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

function str(v) {
  return v == null ? '' : String(v)
}

/** 适配器归一：只允许 onebot | qqbot | qqguild */
export function normalizeAdapter(ctx = {}) {
  if (!ctx.official) return 'onebot'
  const hint = `${str(ctx.adapterKind)} ${str(ctx.adapterId)} ${str(ctx.adapterName)}`
  return /guild|频道/i.test(hint) ? 'qqguild' : 'qqbot'
}

/** bot 身份：selfId / self_id / bot.uin；缺失用 'bot'（不能省，否则多账号串数据） */
export function normalizeBotId(ctx = {}) {
  const raw = str(ctx.selfId || ctx.self_id || ctx.bot?.uin || ctx.bot?.self_id || 'bot')
  return safeScopePart(raw) || 'bot'
}

/** scopeId 缺失时的保守推导（与 ctxOf 同口径，但不依赖 apps） */
export function deriveScopeId(ctx = {}) {
  const userId = str(ctx.userId || ctx.user_id || ctx.sender?.user_id || '')
  const groupId = str(ctx.groupId || ctx.group_id || '')
  const isGroup = ctx.isGroup === true || !!groupId
  if (isGroup && groupId) {
    if (ctx.isolation === false) return `g${safeScopePart(groupId)}`
    return `g${safeScopePart(groupId)}_u${safeScopePart(userId)}`
  }
  return `u_${safeScopePart(userId || 'unknown')}`
}

/** 长度封顶：超长时保留可读前缀 + 稳定短哈希，保证同一输入同一结果 */
function clip(id) {
  const s = str(id)
  if (s.length <= IDENTITY_MAX_LEN) return s
  const hash = shortHash(s)
  return `${s.slice(0, IDENTITY_MAX_LEN - hash.length - 1)}-${hash}`
}

export function assertIdentityPart(value, name = 'identity') {
  const s = str(value)
  if (!s) throw Object.assign(new Error(`${name} 为空`), { code: 'identity_invalid' })
  if (s.length > IDENTITY_MAX_LEN) throw Object.assign(new Error(`${name} 超过 ${IDENTITY_MAX_LEN} 字符`), { code: 'identity_invalid' })
  if (!IDENTITY_RE.test(s)) throw Object.assign(new Error(`${name} 含非法字符：${s}`), { code: 'identity_invalid' })
  return s
}

/**
 * @param {object} opts
 * @param {object} opts.ctx 现有 ctxOf() 产出
 * @param {string|number} [opts.conversationId] 对话 id；聊天默认 'default'
 * @param {'chat'|'scheduled'|'sub'} [opts.kind]
 * @param {string} [opts.agentName] 子 Agent 名
 * @param {string} [opts.childTaskId] 子任务 id
 * @returns {{adapter:string,botId:string,scopeId:string,ownerKey:string,resourceId:string,threadId:string,kind:string}}
 */
export function buildIdentity({ ctx = {}, conversationId = null, kind = 'chat', agentName = '', childTaskId = '' } = {}) {
  const adapter = normalizeAdapter(ctx)
  const botId = assertIdentityPart(clip(normalizeBotId(ctx)), 'botId')
  const scopeId = assertIdentityPart(clip(safeScopePart(ctx.scopeId || deriveScopeId(ctx)) || 'unknown'), 'scopeId')
  const ownerKey = `${botId}_${scopeId}`
  const resourceId = clip(`yz_${adapter}_${ownerKey}`)
  let threadId
  if (kind === 'scheduled') {
    threadId = clip(`yz_${adapter}_${ownerKey}_scheduled`)
  } else if (kind === 'sub') {
    const agent = safeScopePart(agentName) || 'worker'
    const child = safeScopePart(childTaskId) || 'task'
    threadId = clip(`yz_${adapter}_${ownerKey}_sub_${agent}_${child}`)
  } else {
    const conv = safeScopePart(conversationId == null || conversationId === '' ? 'default' : conversationId) || 'default'
    threadId = clip(`yz_${adapter}_${ownerKey}_c${conv}`)
  }
  return {
    adapter,
    botId,
    scopeId,
    ownerKey,
    resourceId: assertIdentityPart(resourceId, 'resourceId'),
    threadId: assertIdentityPart(threadId, 'threadId'),
    kind,
  }
}

/** 兼容别名：明确表达「从 ctx 生成」 */
export function identityForContext(ctx, opts = {}) {
  return buildIdentity({ ctx, ...opts })
}

export function isValidIdentity(value) {
  try {
    assertIdentityPart(value)
    return true
  } catch {
    return false
  }
}
