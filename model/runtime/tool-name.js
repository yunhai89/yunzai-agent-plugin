/**
 * 工具名映射（PR3）。
 *
 * Mastra `formatTools` 会静默把工具名 sanitize 到 `[A-Za-z0-9_-]`、首字符补 `_`、截断 63。
 * Adapter 必须先做同样映射并保留 legacy 原名，否则历史 tool_call / 审批 / 统计会错位。
 *
 * 规则与 PR0 fixture 一致；PR0 测试继续复用本模块。
 */
export const TOOL_NAME_MAX = 63

/** 单名 sanitize（与 Mastra formatTools 一致） */
export function sanitizeToolName(name, { maxLength = TOOL_NAME_MAX } = {}) {
  let n = String(name ?? '').replace(/[^a-zA-Z0-9_-]/g, '_')
  if (!/^[a-zA-Z_]/.test(n)) n = '_' + n
  if (n.length > maxLength) n = n.slice(0, maxLength)
  return n || '_'
}

/**
 * 增量映射：注册顺序决定谁拿原名；sanitize 冲突用 `_2`、`_3`… 后缀（保 63）。
 * 同一 legacy 名称重复 add 返回已有 mastra 名（幂等）；不同原名映射到已占用名时加后缀。
 */
export class ToolNameMap {
  constructor() {
    this.toMastra = new Map()
    this.toLegacy = new Map()
    this.collisions = []
  }

  add(legacyName) {
    const legacy = String(legacyName ?? '')
    if (this.toMastra.has(legacy)) return this.toMastra.get(legacy)
    const base = sanitizeToolName(legacy)
    let candidate = base
    let n = 1
    while (this.toLegacy.has(candidate)) {
      n += 1
      const suffix = `_${n}`
      candidate = base.slice(0, TOOL_NAME_MAX - suffix.length) + suffix
      if (n > 9999) throw new Error(`工具名冲突无法消解：${legacy}`)
    }
    if (candidate !== base) this.collisions.push({ legacy, mapped: candidate, collidedWith: this.toLegacy.get(base) || base })
    this.toMastra.set(legacy, candidate)
    this.toLegacy.set(candidate, legacy)
    return candidate
  }

  mastraName(legacy) { return this.toMastra.get(String(legacy)) || null }
  legacyName(mastra) { return this.toLegacy.get(String(mastra)) || null }
  entries() { return [...this.toMastra.entries()] }
  get size() { return this.toMastra.size }
}

/** 一次性从名称数组建映射（测试/批量注册用） */
export function buildToolNameMap(names = []) {
  const map = new ToolNameMap()
  const seen = new Set()
  for (const name of names) {
    const key = String(name ?? '')
    if (seen.has(key)) throw new Error(`重复工具名：${key}`)
    seen.add(key)
    map.add(key)
  }
  return map
}
