/**
 * 工具结果「软失败」判定 —— 全仓唯一实现。
 *
 * 历史教训：这里曾有两份口径不同的实现，且互相漂移：
 *  - `Agent.isToolError`（账本/恢复/澄清短路用它）：结构化判定，但不认 MCP 的纯文本错误；
 *  - `ToolRegistry.isErrorShape`（AOP 日志/usage-stats 用它）：无锚点子串 `/"error"\s*:/`，
 *    工具返回的**正文**里只要出现字面量 `"error":`（API 文档、Issue 页、JSON 代码示例、用户笔记）
 *    就被判成失败 —— 注入「这是失败原因，请如实回复」提示、账本记 toolFailed、写操作 effectState
 *    从 applied 变 unknown（恢复计划要求人工核对）。
 * 两处判定不一致还会让 AOP/统计与账本对同一次调用得出相反结论。
 *
 * 统一规则（保守但不误判）：
 *  - 对象：`error != null` / `ok === false` / `isError === true`；数组：任一元素满足；
 *  - 字符串：JSON 形态按上述结构判定（截断/非法 JSON 只认规范前缀 `{"error"`，不匹配正文）；
 *  - 非 JSON 纯文本：只认 MCP 文本错误约定（`Error:` / `error:` 开头），不扩大到正文子串匹配。
 */

function shape(o) {
  return !!o && typeof o === 'object' && !Array.isArray(o)
    && (o.error != null || o.ok === false || o.isError === true)
}

/**
 * @param {*} content 工具返回值（字符串或对象）
 * @returns {boolean} 是否为「软失败」（工具没抛异常，但以错误对象/串报错）
 */
export function isToolErrorContent(content) {
  if (content == null) return false
  if (typeof content === 'object') return Array.isArray(content) ? content.some(shape) : shape(content)
  if (typeof content !== 'string') return false
  const s = content.trim()
  if (!s) return false
  if (s.startsWith('{') || s.startsWith('[')) {
    try {
      const o = JSON.parse(s)
      return Array.isArray(o) ? o.some(shape) : shape(o)
    } catch { return /^\{\s*"error"\s*:/.test(s) } // 截断/非法 JSON：只认规范前缀，不误判正文
  }
  return /^error\b/i.test(s) // MCP 文本错误约定（如 "Error: ENOENT ..."）
}

export function truncateJson(value, max) {
  const limit = Math.max(128, Number(max) || 0)
  const size = (v) => { try { const t = JSON.stringify(v); return t == null ? 0 : t.length } catch { return Infinity } }
  if (size(value) <= limit) return value

  const MARK = 56 // _truncated/omitted/total 等标注字段的余量
  /** 截断字符串到「JSON 序列化后不超过 cap」——必须计入引号与反斜杠的转义开销。
   *  曾按裸长度计（`str.length <= cap`），含引号/反斜杠的值会撑破预算：轻则整字段被丢弃
   *  （`{text:'y'.repeat(200000)}` 直接退化成 only _truncated），重则整体超限。 */
  const sliceStr = (str, cap) => {
    if (size(str) <= cap) return str
    const suffix = `…(截断 ${str.length} 字符)`
    const cut = (n) => str.slice(0, n) + suffix
    if (size(cut(0)) > cap) return cut(Math.max(0, Math.min(str.length, cap - suffix.length - 2)))
    let lo = 0
    let hi = str.length
    while (lo < hi) { // 单调 → 二分定切点，保证 size(cut(n)) <= cap
      const mid = Math.ceil((lo + hi) / 2)
      if (size(cut(mid)) <= cap) lo = mid
      else hi = mid - 1
    }
    return cut(lo)
  }

  /** 递归按预算裁剪任意 JSON 值；返回值的序列化长度不超过 cap（含标注） */
  const shrink = (v, cap, depth) => {
    if (v === null || typeof v !== 'object') return typeof v === 'string' ? sliceStr(v, cap) : v
    const budget = Math.max(24, cap - MARK)
    if (Array.isArray(v)) {
      if (depth >= 8) return { items: [], _truncated: true, omitted: v.length, total: v.length }
      const items = []
      let used = 0
      for (const it of v) {
        const room = budget - used - 1
        if (room <= 24) break
        const shrunk = shrink(it, room, depth + 1)
        const len = size(shrunk) + 1
        if (used + len > budget) break
        items.push(shrunk); used += len
      }
      if (items.length === v.length) return items
      return { items, _truncated: true, omitted: v.length - items.length, total: v.length }
    }
    if (depth >= 8) return { _truncated: true, omitted: Object.keys(v).length }
    const out = {}
    const droppedKeys = []
    let used = 0
    for (const k of Object.keys(v)) {
      const keyLen = k.length + 3 // "k":
      const room = budget - used - keyLen
      if (room <= 24) { droppedKeys.push(k); continue }
      const shrunk = shrink(v[k], room, depth + 1)
      const len = size(shrunk) + keyLen
      if (used + len > budget) { droppedKeys.push(k); continue }
      out[k] = shrunk; used += len
    }
    if (!droppedKeys.length) return out
    return { ...out, _truncated: true, omitted_fields: droppedKeys.slice(0, 12), ...(droppedKeys.length > 12 ? { omittedCount: droppedKeys.length } : {}) }
  }

  const shrunk = shrink(value, limit, 0)
  if (size(shrunk) <= limit) return shrunk
  // 兜底：极端形态（超深嵌套/单字段巨大）仍超限 → 字面量截断，保证结果仍可 JSON.parse。
  // 该字面量是作为**字符串值**嵌入的，每个 `"` / `\` 都会转义膨胀（万键对象约 +190 字符），
  // 故切点按「实际序列化长度」二分确定——曾用 `limit - suffix.length - 32` 估算，实测 2000 上限下输出 2189。
  let flat
  try { flat = typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value)) } catch { flat = String(value) }
  const suffix = `…(截断 ${flat.length} 字符)`
  const wrap = (n) => ({ _truncated: true, value: flat.slice(0, n) + suffix })
  let lo = 0
  let hi = flat.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (size(wrap(mid)) <= limit) lo = mid
    else hi = mid - 1
  }
  return wrap(lo)
}

/** 失败回灌提示：注入错误 tool 结果的 _hint 字段，引导模型据实回复、勿臆测编造。
 *  注：以 JSON 字段注入（而非追加文本），保证 tool 结果仍可被 JSON.parse。 */
export const TOOL_FAIL_HINT = '这是工具返回的真实失败原因——请据此如实回复用户（勿臆测/编造其它原因）；若给出可重试方向（缺参数/权限不足/网络不可达/需先查 id）则换方式重试或指导用户；若结果含 _alternatives，优先改用其中能力相近的备选工具，不要对同一工具同参数反复空转；若反复失败无法解决，引导用户发送 #上报错误 <问题描述> 上报（命令会自动打包本次会话日志给开发者）。'
