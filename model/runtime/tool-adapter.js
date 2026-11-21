/**
 * LegacyTool → Mastra Tool Adapter（PR3a 只读 + PR3b 写工具/审批/账本）。
 *
 * 目标：让 Mastra 看到与 legacy 等价的工具名/参数/结果，同时不接主链路、不改工具实现。
 *
 * 关键点：
 *  - `id` 用 sanitize 后的 Mastra 名，并保留 legacy 名双向映射；
 *  - `inputSchema` 用 AI SDK `jsonSchema()` + 现有 AJV `validateToolArgs()`，不转 Zod；
 *  - `ctx` 只从 `context.requestContext.get('yz.ctx')` 读取，绝不放全局；
 *  - 结果复用 legacy 的失败富化/截断/注入标注（model/agent/tool-result.js 共用）；
 *  - 写工具：requireApproval/beforeApproval + 执行前审批复核 + TaskStore 账本；
 *  - 无 `outputSchema`，避免输出校验改变既有语义。
 */
import { createTool } from '@mastra/core/tools'
import { jsonSchema } from 'ai'
import { validateToolArgs } from '../agent/tool-schema.js'
import { resolveExecutionMeta } from '../agent/tool-effects.js'
import { ToolNameMap } from './tool-name.js'
import { prepareToolResult } from './tool-result.js'
import { decideExecution, executeWithTaskStore } from './tool-hooks.js'
import { hashArgs } from './approval-bridge.js'

export class ToolAdapterError extends Error {
  constructor(code, message, extra = {}) {
    super(message)
    this.name = 'ToolAdapterError'
    this.code = code
    Object.assign(this, extra)
  }
}

function readRequestValue(context, key) {
  const rc = context?.requestContext
  if (!rc) return null
  if (typeof rc.get === 'function') {
    try { return rc.get(key) ?? null } catch { return null }
  }
  return rc[key] ?? null
}

/** Mastra 的 requestContext 在 requireApproval 是普通对象、execute 是 RequestContext；两种都兼容 */
export function readLegacyCtx(context = null) {
  return readRequestValue(context, 'yz.ctx')
}

function readTaskId(context = null) { return readRequestValue(context, 'yz.taskId') }
function readRunId(context = null) { return readRequestValue(context, 'yz.runId') }
function readToolCallId(context = null) { return context?.toolCallId || readRequestValue(context, 'yz.toolCallId') }

function validationError(res) {
  const e = new Error(`工具参数校验失败：${(res.fields || []).map((f) => `${f.path} ${f.keyword} ${f.message}`).join('；') || res.code || 'invalid'}`)
  e.name = 'ToolInputValidationError'
  e.code = res.code || 'invalid_arguments'
  e.fields = res.fields || []
  return e
}

function makeInputSchema(tool) {
  const schema = tool?.parameters && typeof tool.parameters === 'object'
    ? tool.parameters
    : { type: 'object', properties: {}, additionalProperties: true }
  return jsonSchema(schema, {
    validate: (value) => {
      const res = validateToolArgs(tool, value)
      return res.ok ? { success: true, value } : { success: false, error: validationError(res) }
    },
  })
}

function rejected(raw) {
  return raw
}

/**
 * 适配单个工具。
 * @param {object} legacy
 * @param {object} deps
 * @param {ToolNameMap} deps.names
 * @param {boolean} [deps.allowWrite=false] PR3a 默认拒绝写；PR3b/PR4 传 true
 * @param {object|null} [deps.approval] ApprovalBridge
 * @param {object|null} [deps.policy] RBAC policy
 * @param {boolean} [deps.masterSkipConfirm]
 * @param {object|null} [deps.taskStore]
 * @param {Function} [deps.onMasterAutoApprove]
 */
export function adaptTool(legacy, {
  names,
  allowWrite = false,
  maxToolResultChars = 8000,
  registry = null,
  guard = null,
  untrustedGuard = true,
  approval = null,
  confirmStore = null,
  policy = null,
  masterSkipConfirm = false,
  approvalTimeoutMs = null,
  taskStore = null,
  onMasterAutoApprove = null,
  onToolStart = null,
  onToolEnd = null,
} = {}) {
  if (!legacy?.name || typeof legacy.execute !== 'function') {
    throw new ToolAdapterError('invalid_tool', '工具必须有 name 与 execute')
  }
  const effectMeta = resolveExecutionMeta(legacy)
  if (effectMeta.effect !== 'read' && !allowWrite) {
    throw new ToolAdapterError('tool_not_readonly', `工具 ${legacy.name} 不是只读（effect=${effectMeta.effect}）；PR3a 只适配只读工具`, {
      tool: legacy.name,
      effect: effectMeta.effect,
    })
  }
  const map = names || new ToolNameMap()
  const mastraName = map.mastraName(legacy.name) || map.add(legacy.name)
  const isWrite = effectMeta.effect !== 'read'

  const decide = (input, ctx) => decideExecution({ tool: legacy, args: input, ctx, policy, masterSkipConfirm })

  const opts = {
    id: mastraName,
    description: String(legacy.description || legacy.name),
    inputSchema: makeInputSchema(legacy),
    requireApproval: async (input, ctx) => {
      if (!isWrite) return false
      // PR4a gray：用旧 ConfirmStore 在 execute 内阻塞审批（#确认 命令原样可用），不进入 Mastra suspend。
      if (confirmStore && !approval) return false
      const legacyCtx = readLegacyCtx(ctx)
      const dec = await decide(input, legacyCtx)
      if (dec.autoApproved) {
        try { await onMasterAutoApprove?.({ name: legacy.name, arguments: input }) } catch { /* noop */ }
      }
      return dec.decision === 'confirm' || dec.decision === 'deny'
    },
    beforeApproval: async (input, ctx) => {
      if (!isWrite) return
      const legacyCtx = readLegacyCtx(ctx)
      const dec = await decide(input, legacyCtx)
      if (dec.decision === 'deny') {
        return { proceed: false, output: { error: 'rejected_by_policy', reason: dec.reason } }
      }
      if (dec.decision !== 'confirm') return
      const runId = readRunId(ctx)
      const toolCallId = ctx?.toolCallId || readToolCallId(ctx)
      if (!approval || !runId || !toolCallId) {
        return { proceed: false, output: { error: 'rejected_by_confirm', reason: '无审批上下文或 ApprovalBridge 未启用' } }
      }
      // 同一 run+call 只建一条；Mastra beforeApproval 不应重复，但 resume/重试时兜底
      const old = await approval.getForCall(runId, toolCallId).catch(() => null)
      if (old) return
      const rec = await approval.create({
        runId,
        toolCallId,
        toolName: legacy.name,
        args: input,
        ctx: legacyCtx,
        threadId: readRequestValue(ctx, 'yz.threadId'),
        resourceId: readRequestValue(ctx, 'yz.resourceId'),
        scopeKey: readRequestValue(ctx, 'yz.scopeKey'),
        timeoutMs: approvalTimeoutMs,
        reason: dec.reason,
        meta: {
          system: readRequestValue(ctx, 'yz.system') || '',
          conversationId: readRequestValue(ctx, 'yz.conversationId'),
        },
      })
      try { legacyCtx?.notify?.(rec.id, { tool: legacy.name, args: input, ctx: legacyCtx }) } catch { /* noop */ }
      return
    },
    execute: async (input, context) => {
      const legacyCtx = readLegacyCtx(context)
      const signal = context?.abortSignal || legacyCtx?.signal || null
      if (signal?.aborted) {
        return prepareToolResult({
          raw: { error: 'cancelled', reason: '工具执行前任务已取消' },
          tool: legacy, registry, ctx: legacyCtx, guard, untrustedGuard, maxToolResultChars,
        })
      }
      const v = validateToolArgs(legacy, input)
      if (!v.ok) {
        return prepareToolResult({
          raw: { error: v.code || 'invalid_arguments', fields: v.fields || [] },
          tool: legacy, registry, ctx: legacyCtx, guard, untrustedGuard, maxToolResultChars,
        })
      }

      if (isWrite) {
        const dec = await decide(input, legacyCtx)
        if (dec.decision === 'deny') {
          return prepareToolResult({ raw: rejected({ error: 'rejected_by_policy', reason: dec.reason }), tool: legacy, registry, ctx: legacyCtx, guard, untrustedGuard, maxToolResultChars })
        }
        if (dec.decision === 'confirm' && !dec.autoApproved) {
          let okByApproval = false
          if (approval) {
            const runId = readRunId(context)
            const toolCallId = readToolCallId(context)
            let rec = runId && toolCallId ? await approval.getForCall(runId, toolCallId).catch(() => null) : null
            if (!rec && runId) rec = await approval.findApproved({ runId, toolName: legacy.name, argsHash: hashArgs(input) }).catch(() => null)
            if (!rec || rec.status !== 'approved') {
              return prepareToolResult({ raw: { error: 'rejected_by_confirm', reason: '审批未通过或已失效' }, tool: legacy, registry, ctx: legacyCtx, guard, untrustedGuard, maxToolResultChars })
            }
            if (rec.argsHash !== hashArgs(input)) {
              return prepareToolResult({ raw: { error: 'rejected_by_confirm', reason: '审批后参数已变化' }, tool: legacy, registry, ctx: legacyCtx, guard, untrustedGuard, maxToolResultChars })
            }
            okByApproval = true
          }
          if (!okByApproval && confirmStore) {
            let ok = false
            try {
              ok = await confirmStore.request({
                tool: legacy.name, args: input, ctx: legacyCtx,
                notify: legacyCtx?.notify, signal,
              })
            } catch { ok = false }
            if (!ok) {
              return prepareToolResult({ raw: { error: 'rejected_by_confirm', reason: '未获批准或超时' }, tool: legacy, registry, ctx: legacyCtx, guard, untrustedGuard, maxToolResultChars })
            }
          } else if (!okByApproval) {
            return prepareToolResult({ raw: { error: 'rejected_by_confirm', reason: '无审批器' }, tool: legacy, registry, ctx: legacyCtx, guard, untrustedGuard, maxToolResultChars })
          }
        }
      }

      const toolCtx = Object.assign({}, legacyCtx || {}, {
        ...(signal ? { signal } : {}),
        ...((readTaskId(context) || legacyCtx?.taskId) ? { taskId: readTaskId(context) || legacyCtx.taskId } : {}),
      })
      let raw
      try {
        try { await onToolStart?.({ name: legacy.name, arguments: input, toolCallId: readToolCallId(context) }) } catch { /* noop */ }
        const run = () => legacy.execute(input, toolCtx)
        const idem = typeof legacy.meta?.idempotencyKey === 'function'
          ? (() => { try { return String(legacy.meta.idempotencyKey(input, legacyCtx) ?? '') || null } catch { return null } })()
          : null
        const runId = readRunId(context)
        const callId = readToolCallId(context) || (runId ? `${runId}:${legacy.name}:${hashArgs(input).slice(0, 16)}` : null)
        const guarded = await executeWithTaskStore({
          taskStore,
          taskId: readTaskId(context) || legacyCtx?.taskId || null,
          callId,
          ctx: legacyCtx,
          tool: legacy,
          args: input,
          effect: effectMeta.effect,
          replay: effectMeta.replay,
          idempotencyKey: idem,
          execute: run,
        })
        raw = guarded.value
        try { await onToolEnd?.({ name: legacy.name, arguments: input, toolCallId: readToolCallId(context) }, raw) } catch { /* noop */ }
      } catch (e) {
        raw = { error: e?.code === 'journal_unavailable' ? 'journal_unavailable' : (e?.message || String(e)), ...(e?.code ? { code: e.code } : {}) }
      }
      return prepareToolResult({
        raw, tool: legacy, registry, ctx: legacyCtx, guard, untrustedGuard, maxToolResultChars,
        source: `tool:${legacy.name}`,
      })
    },
    toModelOutput: (output) => ({
      type: 'content',
      value: [{ type: 'text', text: typeof output === 'string' ? output : JSON.stringify(output ?? {}) }],
    }),
  }

  const mastraTool = createTool(opts)

  return {
    mastraTool,
    mastraName,
    legacyName: legacy.name,
    tool: legacy,
    meta: legacy.meta || {},
    category: legacy.category || '',
    effect: effectMeta.effect,
    replay: effectMeta.replay,
  }
}

function adaptSet(registry, deps = {}) {
  const list = typeof registry?.list === 'function' ? registry.list() : []
  const map = deps.names || new ToolNameMap()
  const tools = {}
  const entries = []
  const skipped = []
  for (const legacy of list) {
    let adapted
    try {
      adapted = adaptTool(legacy, { ...deps, names: map })
    } catch (e) {
      skipped.push({ name: legacy?.name || '', code: e?.code || 'adapt_failed', reason: e?.message || String(e) })
      continue
    }
    tools[adapted.mastraName] = adapted.mastraTool
    entries.push(adapted)
  }
  return { tools, names: map, entries, skipped }
}

/**
 * 从 ToolRegistry 生成只读 Mastra 工具集（PR3a）。
 * @returns {{tools:Record<string,object>, names:ToolNameMap, entries:Array, skipped:Array}}
 */
export function adaptReadonlyTools(registry, deps = {}) {
  return adaptSet(registry, { ...deps, allowWrite: false })
}

/**
 * 从 ToolRegistry 生成全部工具（PR3b/PR4；写工具必须带 ApprovalBridge/TaskStore）。
 */
export function adaptTools(registry, deps = {}) {
  return adaptSet(registry, { ...deps, allowWrite: deps.allowWrite !== false })
}
