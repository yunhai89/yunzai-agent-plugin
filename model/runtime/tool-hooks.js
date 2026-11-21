/**
 * Tool hooks（PR3b/PR4a）：RBAC/审批决策 + TaskStore 账本守卫。
 *
 * 与 legacy Agent._executeOne 的顺序对齐（见 01 §5.3/5.4）：
 *   alwaysConfirm → policy(deny/confirm/allow) → shouldConfirm → masterSkipConfirm → 审批。
 *
 * TaskStore 守卫：
 *   planned(含 argsHash/effect/replay) → started → execute → result(effectState/resultPreview)。
 *   同一 callId 已有 applied 写结果且 replay=never → 拒绝重放；
 *   started 但无 result 的写操作 → effect_unknown，要求人工核对。
 */
import { isToolErrorContent } from '../agent/tool-result.js'
import { scopeKeyOfCtx } from '../agent/task-store.js'
import { hashArgs } from './approval-bridge.js'

/**
 * @returns {Promise<{decision:'allow'|'deny'|'confirm', reason:string, autoApproved?:boolean}>}
 */
export async function decideExecution({ tool, args = {}, ctx = null, policy = null, masterSkipConfirm = false } = {}) {
  let needConfirm = tool?.meta?.alwaysConfirm === true
  let reason = needConfirm ? 'always_confirm' : ''
  // 无 ctx：legacy 不跑 policy，仅 meta.alwaysConfirm 生效（子 Agent/嵌入调用兼容）
  if (policy && ctx) {
    let dec = null
    try { dec = policy.decide(ctx, tool) } catch { dec = null }
    if (dec?.decision === 'deny') return { decision: 'deny', reason: dec.reason || 'policy_denied' }
    if (dec?.decision === 'confirm') { needConfirm = true; reason = dec.reason || 'policy_confirm' }
  }
  if (needConfirm && typeof tool?.meta?.shouldConfirm === 'function') {
    try {
      if (await tool.meta.shouldConfirm(args, ctx) === false) return { decision: 'allow', reason: 'should_confirm_veto' }
    } catch { /* shouldConfirm 出错保守起见仍审批 */ }
  }
  if (needConfirm && masterSkipConfirm && ctx?.isMaster) {
    return { decision: 'allow', reason: 'master_skip_confirm', autoApproved: true }
  }
  if (needConfirm) return { decision: 'confirm', reason: reason || 'confirm_required' }
  return { decision: 'allow', reason: 'allowed' }
}

function preview(v, n = 500) {
  let s
  try { s = typeof v === 'string' ? v : JSON.stringify(v) } catch { s = String(v) }
  s = String(s ?? '').replace(/\s+/g, ' ').trim()
  return s.length > n ? s.slice(0, n) + `…(+${s.length - n})` : s
}

/**
 * TaskStore 守卫包装。无 taskStore/ctx/taskId/callId 时直接执行（子 Agent/离线测试兼容）。
 * @param {object} opts
 * @param {Function} opts.execute 实际工具执行
 * @param {'read'|'write'|'external'} [opts.effect]
 * @param {'safe'|'idempotent'|'never'} [opts.replay]
 * @param {string|null} [opts.idempotencyKey]
 * @returns {Promise<{value:any,journaled:boolean,reused?:boolean,code?:string}>}
 */
export async function executeWithTaskStore({
  taskStore = null,
  taskId = null,
  callId = null,
  ctx = null,
  tool = null,
  args = {},
  effect = 'read',
  replay = null,
  idempotencyKey = null,
  attempt = 0,
  execute,
} = {}) {
  if (typeof execute !== 'function') throw new Error('executeWithTaskStore 需要 execute')
  if (!taskStore || !taskId || !callId || !ctx) {
    return { value: await execute(), journaled: false }
  }
  const scopeKey = scopeKeyOfCtx(ctx)
  const argsHash = hashArgs(args)
  const replayMode = replay || (effect === 'read' ? 'safe' : 'never')
  let cp
  try { cp = await taskStore.getCheckpoint(taskId, { scopeKey }) } catch (e) {
    throw Object.assign(new Error(`journal_unavailable：${e?.message || e}`), { code: 'journal_unavailable' })
  }
  if (cp?.ok) {
    const existing = (cp.steps || []).find((s) => String(s.callId) === String(callId))
    if (existing) {
      if (existing.ok === true && effect !== 'read' && replayMode === 'never') {
        return {
          journaled: true,
          reused: true,
          code: 'duplicate_suppressed',
          value: { error: 'duplicate_suppressed', reason: '该工具本次调用已执行，禁止重复副作用', resultPreview: existing.resultPreview || null },
        }
      }
      if (existing.ok == null && effect !== 'read') {
        return {
          journaled: true,
          reused: true,
          code: 'effect_unknown',
          value: { error: 'effect_unknown', reason: '上次写工具已开始但无结果，需人工核对后再执行' },
        }
      }
    }
  }

  const planned = await taskStore.event({
    taskId, kind: 'tool_planned', callId, attempt,
    payload: {
      name: tool?.name || '', argsHash, effect, replay: replayMode,
      ...(idempotencyKey ? { idempotencyKey } : {}),
      ...(effect === 'read' ? { args } : {}),
    },
  }).catch((e) => { throw Object.assign(new Error(`journal_unavailable：${e?.message || e}`), { code: 'journal_unavailable' }) })
  if (planned?.ok === false && planned.code === 'not_found') {
    // 没有 begin 的任务（旧路径/子 Agent）：不强行记孤账，直接执行
    return { value: await execute(), journaled: false }
  }
  const started = await taskStore.event({ taskId, kind: 'tool_started', callId, attempt, payload: { name: tool?.name || '', argsHash, effect } })
    .catch((e) => { throw Object.assign(new Error(`journal_unavailable：${e?.message || e}`), { code: 'journal_unavailable' }) })
  if (started?.ok === false) {
    throw Object.assign(new Error('journal_unavailable：tool_started 写入失败'), { code: 'journal_unavailable' })
  }

  let value
  let thrown = null
  try {
    value = await execute()
  } catch (e) {
    thrown = e
    value = { error: e?.message || String(e) }
  }
  const failed = !!thrown || isToolErrorContent(value)
  const effectState = effect === 'read' ? 'none' : (failed ? 'unknown' : 'applied')
  try {
    await taskStore.event({
      taskId, kind: 'tool_result', callId, attempt,
      payload: {
        name: tool?.name || '', ok: !failed, effectState, argsHash,
        ...(idempotencyKey ? { idempotencyKey } : {}),
        resultPreview: preview(value),
        ...(failed ? { errorCode: thrown ? 'tool_exception' : 'tool_error' } : {}),
      },
    })
  } catch { /* 结果写失败降级：不重放；上层 TaskStore.finish 仍能标记 journal_degraded */ }
  if (thrown) throw thrown
  return { value, journaled: true }
}

/** `#待确认` 单行文案（不含完整参数） */
export function formatApprovalLine(rec) {
  const who = rec?.ctx?.userId || '未知'
  const gid = rec?.ctx?.groupId ? `群 ${rec.ctx.groupId}` : '私聊'
  const exp = rec?.expiresAt ? new Date(rec.expiresAt).toLocaleTimeString('zh-CN') : '-'
  return `${rec.id} · ${rec.toolName} · ${who}（${gid}）· ${rec.argsPreview || ''} · 至 ${exp}`
}
