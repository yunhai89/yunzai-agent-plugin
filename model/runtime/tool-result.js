/**
 * Mastra Tool 结果管线（PR3）。
 *
 * 与 legacy `Agent._executeOne` 的工具结果尾部对齐：
 *   原始返回 → stringify → 失败富化 → resultCap 截断 → 注入标注。
 * 只处理结果；权限/审批/账本在 PR3b/PR4 接入，PR3a 不改变 legacy 执行。
 *
 * 注意：`truncateJson` / `TOOL_FAIL_HINT` 已抽到 `model/agent/tool-result.js` 作为唯一实现，
 * legacy Agent 与 Adapter 共用，避免两套截断/提示文案漂移。
 */
import { stringifyArgs } from '../agent/messages.js'
import { isToolErrorContent, truncateJson, TOOL_FAIL_HINT } from '../agent/tool-result.js'
import { enrichToolFailure } from '../agent/tool-fallback.js'
import { screenUntrusted } from '../agent/guard.js'

/** 与 Agent._capToolResult 同语义：JSON 可 parse 的结构化截断；纯文本按字符截断 */
export function capToolResult(content, max) {
  const limit = toolCap(content, max)
  if (!limit || typeof content !== 'string' || content.length <= limit) return content
  let parsed
  try { parsed = JSON.parse(content) } catch { parsed = undefined }
  if (parsed === undefined) {
    return content.slice(0, limit) + `\n…(已截断，原文 ${content.length} 字符；如需完整结果请缩小查询范围)`
  }
  return JSON.stringify(truncateJson(parsed, limit))
}

function toolCap(content, max) {
  const n = Number(max)
  return Number.isFinite(n) && n > 0 ? n : 0
}

/**
 * @param {object} opts
 * @param {*} opts.raw 工具 execute 返回值
 * @param {object} opts.tool legacy tool（读 meta.resultCap）
 * @param {number} [opts.maxToolResultChars]
 * @param {object|null} [opts.registry] 失败富化用
 * @param {object|null} [opts.ctx]
 * @param {object|null} [opts.policy]
 * @param {object|null} [opts.guard] `{ screenUntrusted }`；缺省用真实 guard
 * @param {boolean} [opts.untrustedGuard]
 * @param {string} [opts.source]
 * @returns {string}
 */
export function prepareToolResult({
  raw,
  tool = null,
  maxToolResultChars = 8000,
  registry = null,
  ctx = null,
  policy = null,
  guard = null,
  untrustedGuard = true,
  source = '',
} = {}) {
  let content = stringifyArgs(raw)
  if (isToolErrorContent(content)) {
    let enriched = null
    try {
      enriched = enrichToolFailure(content, {
        tool: tool || { name: source || 'unknown', description: '', parameters: {} },
        registry,
        ctx,
        policy,
        hint: TOOL_FAIL_HINT,
      })
    } catch { enriched = null }
    if (enriched) content = stringifyArgs(enriched)
    else {
      try { const o = JSON.parse(content); o._hint = TOOL_FAIL_HINT; content = JSON.stringify(o) }
      catch { content = content + '\n' + TOOL_FAIL_HINT }
    }
  }
  const cap = tool?.meta?.resultCap ?? maxToolResultChars
  content = capToolResult(content, cap)
  if (!untrustedGuard) return content
  try {
    const screener = typeof guard?.screenUntrusted === 'function' ? guard.screenUntrusted : screenUntrusted
    const r = screener(content, { source: source || `tool:${tool?.name || 'unknown'}`, sensitivity: 'medium', action: 'label' })
    return r?.text ?? content
  } catch {
    return content
  }
}
