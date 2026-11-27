/**
 * 深度研究报告 → HTML（用于 PDF 导出与高清长图渲染，同一份 HTML 两用）。
 *
 * 零依赖 markdown→HTML（覆盖研究报告常用语法），浅色排版、打印友好：
 *  - PDF：A4 宽度、衬线正文、分页避让
 *  - 长图：Yunzai 渲染器截图，CSS 控制最大宽度居中
 */

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** 行内格式：加粗 / 斜体 / 行内代码 / 链接 / 删除线 */
function inline(s) {
  let t = esc(s)
  // 行内代码先处理（避免内部被其它规则破坏）
  const codes = []
  t = t.replace(/`([^`]+)`/g, (_, c) => (codes.push(c), `\u0000${codes.length - 1}\u0000`))
  t = t
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>')
  // 还原行内代码
  t = t.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[+i]}</code>`)
  return t
}

/** markdown → HTML 块结构（研究报告常用子集） */
export function markdownToHtml(md) {
  const lines = String(md || '').replace(/\r\n/g, '\n').split('\n')
  const out = []
  let i = 0
  let listType = null // 'ul' | 'ol'
  const closeList = () => { if (listType) { out.push(`</${listType}>`); listType = null } }
  let inCode = false
  let codeBuf = []

  const flushCode = () => {
    if (inCode) {
      out.push(`<pre><code>${esc(codeBuf.join('\n'))}</code></pre>`)
      codeBuf = []
      inCode = false
    }
  }

  while (i < lines.length) {
    const line = lines[i]

    // 代码围栏
    if (/^```/.test(line)) {
      if (inCode) flushCode()
      else { closeList(); inCode = true }
      i++
      continue
    }
    if (inCode) { codeBuf.push(line); i++; continue }

    // 空行
    if (!line.trim()) { closeList(); i++; continue }

    // 水平线
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) { closeList(); out.push('<hr/>'); i++; continue }

    // 标题
    const h = line.match(/^(#{1,6})\s+(.*)$/)
    if (h) {
      closeList()
      const lvl = h[1].length
      out.push(`<h${lvl}>${inline(h[2])}</h${lvl}>`)
      i++
      continue
    }

    // 引用
    if (/^>\s?/.test(line)) {
      closeList()
      const buf = [line.replace(/^>\s?/, '')]
      while (i + 1 < lines.length && /^>\s?/.test(lines[i + 1])) { i++; buf.push(lines[i].replace(/^>\s?/, '')) }
      out.push(`<blockquote>${inline(buf.join(' '))}</blockquote>`)
      i++
      continue
    }

    // 无序列表
    if (/^\s*[-*+]\s+/.test(line)) {
      if (listType !== 'ul') { closeList(); out.push('<ul>'); listType = 'ul' }
      out.push(`<li>${inline(line.replace(/^\s*[-*+]\s+/, ''))}</li>`)
      i++
      continue
    }

    // 有序列表
    if (/^\s*\d+\.\s+/.test(line)) {
      if (listType !== 'ol') { closeList(); out.push('<ol>'); listType = 'ol' }
      out.push(`<li>${inline(line.replace(/^\s*\d+\.\s+/, ''))}</li>`)
      i++
      continue
    }

    // 段落（连续非空非块行合并）
    closeList()
    const buf = [line]
    while (
      i + 1 < lines.length &&
      lines[i + 1].trim() &&
      !/^(#{1,6}\s|>\s?|\s*[-*+]\s|\s*\d+\.\s|```)/.test(lines[i + 1]) &&
      !/^\s*([-*_])\1{2,}\s*$/.test(lines[i + 1])
    ) { i++; buf.push(lines[i]) }
    out.push(`<p>${inline(buf.join(' '))}</p>`)
    i++
  }
  closeList()
  flushCode()
  return out.join('\n')
}

const CSS = `
* { margin:0; padding:0; box-sizing:border-box; }
body { font-family: "PingFang SC","Noto Serif SC","Source Han Serif SC",Georgia,"Times New Roman",serif;
  background:#fff; color:#1f2937; line-height:1.75; }
#container { width:780px; margin:0 auto; padding:40px 48px; }
.cover { border-bottom:3px solid #3b82f6; padding-bottom:18px; margin-bottom:26px; }
.cover h1 { font-size:26px; color:#111827; line-height:1.35; }
.cover .meta { color:#6b7280; font-size:13px; margin-top:10px; font-family:-apple-system,"PingFang SC",sans-serif; }
h1,h2,h3,h4 { color:#111827; line-height:1.4; margin:26px 0 12px; font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif; }
h2 { font-size:20px; border-left:4px solid #3b82f6; padding-left:10px; }
h3 { font-size:16px; }
p { margin:10px 0; font-size:15px; }
ul,ol { margin:10px 0 10px 22px; }
li { margin:5px 0; font-size:15px; }
strong { color:#111827; }
a { color:#2563eb; text-decoration:none; word-break:break-all; }
code { background:#f3f4f6; padding:1px 6px; border-radius:4px; font-size:13px; font-family:ui-monospace,Menlo,Consolas,monospace; }
pre { background:#f9fafb; border:1px solid #e5e7eb; border-radius:8px; padding:14px 16px; overflow:auto; margin:12px 0; }
pre code { background:none; padding:0; font-size:13px; }
blockquote { border-left:3px solid #93c5fd; background:#eff6ff; padding:10px 14px; margin:12px 0; color:#374151; border-radius:0 6px 6px 0; }
hr { border:none; border-top:1px solid #e5e7eb; margin:20px 0; }
.sources { background:#f8fafc; border:1px solid #e2e8f0; border-radius:10px; padding:16px 20px; margin-top:28px; }
.sources h2 { border:none; padding:0; margin-top:0; }
.sources ol { margin-left:20px; }
.sources li { font-size:13px; color:#475569; word-break:break-all; margin:6px 0; }
.eval { display:inline-block; font-size:12px; color:#fff; background:#10b981; padding:2px 10px; border-radius:10px; margin-left:8px; }
.eval.warn { background:#f59e0b; }
.eval.fail { background:#ef4444; }
.foot { margin-top:30px; padding-top:14px; border-top:1px solid #e5e7eb; color:#9ca3af; font-size:11px; text-align:center; font-family:-apple-system,sans-serif; }
@media print { #container { width:auto; padding:0; } body { font-size:12pt; } }
`

function doc(inner) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>${CSS}</style></head><body><div id="container">${inner}</div></body></html>`
}

function safeFilename(topic) {
  return String(topic || 'research').replace(/[\\/:*?"<>|\n]+/g, '_').trim().slice(0, 40) || 'research'
}

/** 五维分数均值（0-1 → 0-100 整数）；无有效维度返回 null */
function avgScore(dims) {
  const nums = dims ? Object.values(dims).filter((n) => typeof n === 'number' && Number.isFinite(n)) : []
  return nums.length ? Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 100) : null
}

/**
 * 组装研究报告 HTML。
 * @param {object} o { topic, report(markdown), citations?: string[], evaluation?: {pass,score,dimensions}, rounds?, createdAt? }
 */
export function buildResearchHtml({ topic, report = '', citations = [], evaluation = null, rounds = 0, createdAt } = {}) {
  const when = createdAt ? new Date(createdAt).toLocaleString('zh-CN') : ''
  // 兼容两种口径：扁平 {pass,score}（deep-research 现行输出）与嵌套 {llm:{pass,scores}}（旧结构）
  const evalPass = evaluation ? (evaluation.pass ?? evaluation.llm?.pass ?? evaluation.quick?.passed) : undefined
  const evalScore = evaluation ? (evaluation.score ?? avgScore(evaluation.llm?.scores ?? evaluation.dimensions)) : null
  const evalBadge = evaluation
    ? `<span class="eval ${evalPass === false ? 'fail' : ''}">${evalPass === false ? '评估未通过' : '评估通过'}${evalScore != null ? ` · ${evalScore}` : ''}</span>`
    : ''
  const cover = `
    <div class="cover">
      <h1>${esc(topic || '深度研究报告')}</h1>
      <div class="meta">深度研究 · ${rounds ? `${rounds} 轮迭代 · ` : ''}${when}${evalBadge}</div>
    </div>`

  const sources = citations?.length
    ? `<div class="sources"><h2>参考来源</h2><ol>${citations.map((c) => `<li>${inline(c)}</li>`).join('')}</ol></div>`
    : ''

  const foot = `<div class="foot">由 agents-plugin · Deep Research 生成 · 请核对来源后使用</div>`

  return doc(`${cover}${markdownToHtml(report)}${sources}${foot}`)
}

export { safeFilename }

/**
 * 按段落/行边界把长文本切成不超过 max 字符的段；超长单行按字硬切。
 * 用于文本下发兜底，避免单条消息超过 QQ 发送上限。
 */
export function splitMessage(text, max = 1800) {
  const t = String(text || '')
  if (!t) return []
  if (t.length <= max) return [t]
  const out = []
  let buf = ''
  const flush = () => { if (buf) { out.push(buf); buf = '' } }

  for (const para of t.split(/\n{2,}/)) {
    if (para.length > max) {
      flush()
      for (const line of para.split('\n')) {
        if (line.length > max) {
          flush()
          for (let i = 0; i < line.length; i += max) out.push(line.slice(i, i + max))
        } else if ((buf ? buf + '\n' + line : line).length > max) {
          flush()
          buf = line
        } else {
          buf = buf ? buf + '\n' + line : line
        }
      }
      flush()
    } else if ((buf ? buf + '\n\n' + para : para).length > max) {
      flush()
      buf = para
    } else {
      buf = buf ? buf + '\n\n' + para : para
    }
  }
  flush()
  return out
}
