/**
 * 统一日志封装，兼容 TRSS-Yunzai 与 Miao-Yunzai。
 * 优先使用 TRSS 的 Bot.makeLog，其次使用全局 logger，最后回退 console。
 * 等级：trace / debug / info / mark / warn / error / fatal
 */

const TAG = 'agents-plugin'
let FORCE_DEBUG = false

/** ANSI 颜色（控制台彩色日志用；非终端或被 logger 转义时原样显示，无害） */
export const ANSI = Object.freeze({
  R: '\x1b[0m', r: '\x1b[31m', g: '\x1b[32m', y: '\x1b[33m', b: '\x1b[34m', m: '\x1b[35m', c: '\x1b[36m', gry: '\x1b[90m', B: '\x1b[1m',
})

/** 单值 → 单行可读文本：对象 JSON 化，Error 保留 message + 栈首行。 */
function formatArg(v) {
  if (v instanceof Error) {
    return `${v.name || 'Error'}: ${v.message}${v.stack ? `\n${v.stack.split('\n').slice(0, 4).join('\n')}` : ''}`
  }
  if (typeof v === 'string') return v
  if (v == null) return String(v)
  if (typeof v === 'object') {
    try { return JSON.stringify(v) } catch { return String(v) }
  }
  return String(v)
}

/**
 * 多参数 → 单个可读字符串。
 * 直接把数组交给 Bot.makeLog 会被框架按 Node 数组格式打印（带 `[length]: N`、逐项引号/换行），
 * 多行工具日志几乎无法阅读；统一拼成一行（Error 栈除外），并做长度保护。
 */
export function formatLogArgs(args = [], { max = 4000 } = {}) {
  const list = Array.isArray(args) ? args : [args]
  // 单字符串（面板/多行正文）原样保留：盒式面板依赖连续空格对齐，不能压成单空格。
  const singleText = list.length === 1 && typeof list[0] === 'string'
  let text = singleText ? list[0] : list.map(formatArg).join(' ')
  if (!singleText) text = text.replace(/[ \t]+/g, ' ')
  text = text.trim()
  return text.length > max ? `${text.slice(0, max)}…(+${text.length - max})` : text
}

function log(level, ...args) {
  const msg = formatLogArgs(args)
  // Web「调试日志」开启时，Yunzai 的 logger level 仍可能是 info，Bot.makeLog('debug')
  // 会被框架过滤。这里把 debug/trace 强制走 info 通道并加 [DEBUG] 前缀，
  // 保证后台确实能看到调试输出；关闭后恢复原级别过滤。
  if (FORCE_DEBUG && (level === 'debug' || level === 'trace')) {
    try {
      if (typeof Bot !== 'undefined' && typeof Bot.makeLog === 'function') {
        return Bot.makeLog('info', `[DEBUG] ${msg}`, TAG, true)
      }
    } catch (e) { /* fall through */ }
    const lg = typeof logger !== 'undefined' ? logger : console
    const fn = lg?.info || console.log
    return fn.call(lg, `[${TAG}][DEBUG]`, msg)
  }
  try {
    if (typeof Bot !== 'undefined' && typeof Bot.makeLog === 'function') {
      return Bot.makeLog(level, msg, TAG)
    }
  } catch (e) {
    // ignore and fall through
  }

  const lg = typeof logger !== 'undefined' ? logger : console
  const fn = typeof lg[level] === 'function' ? lg[level] : lg.info
  if (typeof fn === 'function') fn.call(lg, `[${TAG}]`, msg)
}

const Log = {
  /** Web 调试日志：true 时 debug/trace 强制输出（info 通道 + [DEBUG] 前缀）。 */
  setDebug: (on) => { FORCE_DEBUG = on === true },
  isDebug: () => FORCE_DEBUG,
  trace: (...a) => log('trace', ...a),
  debug: (...a) => log('debug', ...a),
  info: (...a) => log('info', ...a),
  mark: (...a) => log('mark', ...a),
  warn: (...a) => log('warn', ...a),
  error: (...a) => log('error', ...a),
  fatal: (...a) => log('fatal', ...a),
}

/**
 * 创建带 tag 的分级 logger：(level='debug', ...args) → log(level, '[tag]', ...args)
 * 这样库内 `logger('warn', msg)` 会真正按 warn 级别输出（而非被吞成 debug）。
 */
Log.tag = function tag(tag) {
  return (level = 'debug', ...args) => log(level, `[${tag}]`, ...args)
}

/** 把任意值截断为单行日志字符串（对象先 JSON 化），避免日志被超大内容撑爆 */
Log.brief = function brief(v, n = 160) {
  let s
  if (v == null) s = String(v)
  else if (typeof v === 'string') s = v
  else {
    try { s = JSON.stringify(v) } catch { s = String(v) }
  }
  s = String(s).replace(/\s+/g, ' ').trim()
  return s.length > n ? s.slice(0, n) + `…(+${s.length - n})` : s
}

// ─── 启动横幅 / 对齐面板 ───
// 终端里 CJK / 全角 / emoji 占 2 列，按显示宽度对齐才能排整齐。
const WIDE_RANGES = [
  [0x1100, 0x115f], [0x2e80, 0xa4cf], [0xac00, 0xd7a3], [0xf900, 0xfaff],
  [0xfe30, 0xfe6f], [0xff00, 0xff60], [0xffe0, 0xffe6], [0x1f300, 0x1faff], [0x20000, 0x3fffd],
]
function charWidth(cp) {
  if (cp === 0x2329 || cp === 0x232a) return 2
  for (const [a, b] of WIDE_RANGES) if (cp >= a && cp <= b) return 2
  return 1
}

/** 字符串显示宽度（CJK/全角/emoji 记 2 列） */
export function strWidth(s) {
  let w = 0
  for (const ch of String(s)) w += charWidth(ch.codePointAt(0))
  return w
}

/** 收集有效行（过滤 null/undefined/空串） */
function panelRows(rows) {
  return (rows || []).filter((r) => Array.isArray(r) && r.length >= 2 && r[1] != null && String(r[1]) !== '')
}

/** 盒式面板（依赖等宽字体与 CJK 宽度对齐；窄屏/比例字体下会错位，仅作可选 style） */
function renderBox(title, pairs, { minWidth = 44 } = {}) {
  const labelW = pairs.reduce((m, [k]) => Math.max(m, strWidth(k)), 0)
  const valueW = pairs.reduce((m, [, v]) => Math.max(m, strWidth(v)), 0)
  const head = `─ ${title} `
  const width = Math.max(minWidth, 4 + labelW + valueW, 1 + strWidth(head))
  const lines = ['┌' + head + '─'.repeat(Math.max(0, width - 1 - strWidth(head)))]
  for (const [k, v] of pairs) {
    lines.push(`│ ${k}${' '.repeat(Math.max(0, labelW - strWidth(k)))}  ${v}`)
  }
  lines.push('└' + '─'.repeat(width - 1))
  return lines.join('\n')
}

/**
 * 渲染面板（纯函数，便于离线测试）。
 * 默认 flat 样式：每行自包含 `· 标签：值`，**不依赖等宽字体与跨行对齐**——手机比例字体 / 窄屏换行也不会乱。
 * 如需桌面盒式排版可传 { style: 'box' }（依赖等宽字体）。
 * @param {string} title
 * @param {Array<[string, any]>} rows
 * @param {object} [opts] { style:'flat'|'box', rule:标题下划线长度, minWidth:盒式最小宽度 }
 */
export function renderPanel(title, rows = [], { style = 'flat', rule = 20, minWidth = 44 } = {}) {
  const pairs = panelRows(rows)
  if (style === 'box') return renderBox(title, pairs, { minWidth })
  return [`${'─'.repeat(rule)} ${title}`, ...pairs.map(([k, v]) => `· ${k}：${v}`)].join('\n')
}

/** 输出面板（整块单次日志，避免逐行 logger 前缀打断排版） */
Log.panel = function panel(title, rows, opts) {
  return log('info', renderPanel(title, rows, opts))
}

export default Log
