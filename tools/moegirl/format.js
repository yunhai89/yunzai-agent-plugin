/**
 * 萌娘百科工具包：纯格式化辅助。
 * 不依赖网络 / Config，便于离线单测。
 */

/** 任意值 → 可读文本（保留换行，去首尾空白） */
export function asText(v) {
  if (v == null) return ''
  if (typeof v === 'string') return v.trim()
  if (Buffer.isBuffer(v)) return v.toString('utf8').trim()
  return String(v).trim()
}

/** 截断长文本；返回 { text, truncated, originalLength } */
export function truncate(text, max) {
  const s = String(text ?? '')
  const n = clampInt(max, 100, 1_000_000, 8000)
  if (s.length <= n) return { text: s, truncated: false, originalLength: s.length }
  return { text: s.slice(0, n) + `\n…（已截断，原文 ${s.length} 字）`, truncated: true, originalLength: s.length }
}

/** HTML 片段 → 单行纯文本（MediaWiki 搜索 snippet 用） */
export function stripHtml(html) {
  const s = String(html ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]*>/g, '')
  return decodeEntities(s).replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
}

/** 常见 HTML 实体解码（含数字实体） */
export function decodeEntities(s) {
  return String(s ?? '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_m, h) => {
      try { return String.fromCodePoint(parseInt(h, 16)) } catch { return '' }
    })
    .replace(/&#(\d+);/g, (_m, d) => {
      try { return String.fromCodePoint(Number(d)) } catch { return '' }
    })
}

/**
 * Quill Delta（数组或 JSON 字符串）→ 纯文本。
 * 支持字符串 insert 以及视频 / 图片 / 提及等对象 insert。
 */
export function deltaToText(delta) {
  let ops = delta
  if (typeof ops === 'string') {
    try { ops = JSON.parse(ops) } catch { return ops.trim() }
  }
  if (!Array.isArray(ops)) return ''
  const out = []
  for (const op of ops) {
    if (!op || typeof op !== 'object') continue
    const ins = op.insert
    if (typeof ins === 'string') { out.push(ins); continue }
    if (!ins || typeof ins !== 'object') continue
    if (ins.video) out.push(`[视频] ${String(ins.video)}`)
    else if (ins.image) out.push(`[图片] ${String(ins.image)}`)
    else if (ins.audio) out.push(`[音频] ${String(ins.audio)}`)
    else if (ins.mention) out.push(`[提及] ${String(ins.mention)}`)
  }
  return out.join('').replace(/\n{3,}/g, '\n\n').trim()
}

/** 从 Quill Delta 提取媒体 URL */
export function deltaMedia(delta) {
  let ops = delta
  if (typeof ops === 'string') {
    try { ops = JSON.parse(ops) } catch { return [] }
  }
  if (!Array.isArray(ops)) return []
  const out = []
  const seen = new Set()
  for (const op of ops) {
    const ins = op && typeof op === 'object' ? op.insert : null
    if (!ins || typeof ins !== 'object') continue
    for (const k of ['video', 'image', 'audio']) {
      const url = ins[k] ? String(ins[k]) : ''
      if (url && !seen.has(url)) { seen.add(url); out.push({ type: k, url }) }
    }
  }
  return out
}

/** 毫秒时间戳 → ISO 字符串；无效返回 null */
export function isoTime(ms) {
  const n = Number(ms)
  if (!Number.isFinite(n) || n <= 0) return null
  try { return new Date(n).toISOString() } catch { return null }
}

/** 整数夹紧 */
export function clampInt(n, min, max, fallback) {
  const v = Number(n)
  if (!Number.isFinite(v)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(v)))
}

/** 词条 URL：base/title（空格按 MediaWiki 习惯转下划线） */
export function formatPageUrl(base, title) {
  const root = String(base || 'https://mobile.moegirl.org.cn').replace(/\/+$/, '')
  const t = String(title || '').trim()
  if (!t) return root
  return `${root}/${encodeURIComponent(t.replace(/ /g, '_'))}`
}

/** 对象数组去重（按 key 函数） */
export function uniqueBy(list, keyFn) {
  const seen = new Set()
  const out = []
  for (const item of Array.isArray(list) ? list : []) {
    const key = keyFn(item)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(item)
  }
  return out
}
