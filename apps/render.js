/**
 * 渲染封装 —— 统一走 Yunzai 渲染器（lib/puppeteer/puppeteer.js，按 Yunzai 配置的
 * puppeteer / shotium 后端），插件不再启动自己的 Chromium。
 *
 * 图片：把自包含 HTML 写入唯一 tplFile，交给 Yunzai 渲染器截图。
 * PDF：仅在 Yunzai 当前后端为 Puppeteer 时复用它的浏览器页导出；shotium 等纯图片
 *      后端返回 null，调用方按 PDF → 图片 → 文本降级。
 * 所有方法失败返回 null / false，调用方据此降级。
 */

import fs from 'node:fs'
import path from 'node:path'
import Log from '../utils/Log.js'
import Config from '../utils/Config.js'
import { buildHtml, mdToHtml } from '../model/render/index.js'
import { buildChatHtml } from '../model/render/theme.js'
import { inlineImages } from '../model/render/inline-images.js'

/** 同一 name 的临时模板保留窗口：只清理早于该时长的旧文件。
 *  （修 2026-10-17 审计：原先无条件删除同名模板，并发同名截图会互删对方刚写入的 tplFile
 *   → 一方 puppeteer.screenshot 取不到模板、失败降级为文本。） */
const SHOT_KEEP_MS = 10 * 60 * 1000
/** PDF / 高清长图的总超时下限（毫秒）：排版比卡片截图慢，低于 puppeteer 默认 30s 会误杀。 */
const HEAVY_TIMEOUT_FLOOR_MS = 30000

const YUNZAI_RENDERER = '../../../lib/puppeteer/puppeteer.js'

/** 渲染总超时（毫秒）：防弱服务器上渲染器卡死导致指令永不返回（超时→调用方降级文本）。 */
function renderTimeoutMs() {
  const t = Number(Config.get()?.agent?.render?.timeoutMs)
  return t > 0 ? t : 15000
}

/** 帮助图渲染默认总超时（毫秒）：帮助卡片是最长的一张图（全量指令/区块），
 *  弱机器/冷缓存下首次渲染可能远超普通卡片图，默认给足 5 分钟，避免「首次打开帮助永远是文本」。 */
export const HELP_RENDER_TIMEOUT_DEFAULT_MS = 300000

/**
 * 帮助图渲染总超时（毫秒）：`agent.render.helpTimeoutMs`（默认 300000；<=0 视为未配置）。
 * 与 `render.timeoutMs`（普通卡片图，默认 15s）分开：帮助图更重，不能用同一预算，
 * 否则弱服务器上要么帮助超时、要么为了帮助把所有列表卡片都拖到 5 分钟。
 * @param {object} [render] agent.render 配置块
 * @returns {number}
 */
export function helpRenderTimeoutMs(render = {}) {
  const t = Number(render?.helpTimeoutMs)
  return t > 0 ? t : HELP_RENDER_TIMEOUT_DEFAULT_MS
}

/** 给任意 Promise 加总超时：超时 resolve(null)，不阻塞调用方（底层 Promise 仍会自行收尾）。 */
function withTimeout(promise, ms, tag) {
  if (!(ms > 0)) return promise
  let timer = null
  return Promise.race([
    Promise.resolve(promise).finally(() => { if (timer) clearTimeout(timer) }),
    new Promise((resolve) => {
      timer = setTimeout(() => { try { Log.warn(`[render] ${tag} 超时(${ms}ms)，降级`) } catch { /* noop */ } ; resolve(null) }, ms)
      timer.unref?.()
    }),
  ])
}

// ─── Yunzai 渲染器（进程内单例；失败只缓存一次本次调用，不永久禁用）───
let _renderer = null
let _rendererLoading = null

async function getYunzaiRenderer() {
  if (_renderer) return _renderer
  if (_rendererLoading) return _rendererLoading
  _rendererLoading = (async () => {
    try {
      const mod = await import(YUNZAI_RENDERER)
      _renderer = mod.default || mod
      return _renderer
    } catch (e) {
      Log.warn('[render] 加载 Yunzai 渲染器失败', e?.message || e)
      return null
    } finally {
      _rendererLoading = null
    }
  })()
  return _rendererLoading
}

/** 写唯一 tplFile（Yunzai 渲染器的模板入口），并清理同前缀过期文件。 */
async function writeTplFile(name, html) {
  const safe = String(name || 'agents').replace(/[\\/]/g, '_')
  const dir = Config.path.temp
  await fs.promises.mkdir(dir, { recursive: true }).catch(() => {})
  const tplFile = path.join(dir, `${safe}__${Date.now()}_${Math.random().toString(36).slice(2, 8)}.html`)
  try {
    const now = Date.now()
    for (const f of fs.readdirSync(dir)) {
      if (!f.startsWith(`${safe}__`)) continue
      const fp = path.join(dir, f)
      if (fp === tplFile) continue
      try { if (now - fs.statSync(fp).mtimeMs > SHOT_KEEP_MS) fs.unlinkSync(fp) } catch { /* noop */ }
    }
  } catch { /* noop */ }
  await fs.promises.writeFile(tplFile, String(html ?? ''))
  return { tplFile, safe }
}

/** 从 Yunzai 渲染器/后端列表里找 Puppeteer 后端（auto 模式可能默认选 shotium，但 PDF 仍需浏览器）。 */
function findPuppeteerRenderer(renderer) {
  if (typeof renderer?.browserInit === 'function') return renderer
  const map = renderer?.renderers
  if (map && typeof map.values === 'function') {
    for (const r of map.values()) if (typeof r?.browserInit === 'function') return r
  }
  return null
}

/** 归一化渲染器返回值：Buffer / base64 / 临时文件路径。 */
async function toBuffer(out) {
  if (!out) return null
  if (Buffer.isBuffer(out)) return out
  if (Array.isArray(out)) return toBuffer(out[0])
  if (typeof out === 'string') {
    const s = out.trim()
    if (!s) return null
    if (s.startsWith('base64://')) return Buffer.from(s.slice('base64://'.length), 'base64')
    if (/^data:image\//.test(s)) {
      const comma = s.indexOf(',')
      if (comma > 0) return Buffer.from(s.slice(comma + 1), 'base64')
    }
    try { if (fs.existsSync(s)) return await fs.promises.readFile(s) } catch { /* noop */ }
    try {
      const b = Buffer.from(s, 'base64')
      return b.length ? b : null
    } catch { return null }
  }
  if (out?.data?.file) return toBuffer(out.data.file)
  if (out?.file) return toBuffer(out.file)
  return null
}

/**
 * 用 Yunzai 渲染器把自包含 HTML 截图成 Buffer。
 * @param {string} html
 * @param {object} [opts] { name, imgType='jpeg', quality=95, timeoutMs, pageGotoParams, multiPage, multiPageHeight }
 * @returns {Promise<Buffer|null>}
 */
export const renderCardBuffer = async (html, {
  name = 'agents-plugin/card', imgType = 'jpeg', quality = 95, timeoutMs,
  pageGotoParams, multiPage = false, multiPageHeight,
} = {}) => {
  const ms = Number(timeoutMs) > 0 ? Number(timeoutMs) : renderTimeoutMs()
  return withTimeout((async () => {
    const renderer = await getYunzaiRenderer()
    if (!renderer?.render) {
      Log.warn('[render] Yunzai 渲染器不可用（检查 Yunzai renderers 配置）')
      return null
    }
    try {
      const { tplFile, safe } = await writeTplFile(name, html)
      const out = await renderer.render(name, {
        tplFile,
        saveId: safe,
        imgType,
        quality,
        ...(multiPage ? { multiPage: true } : {}),
        ...(multiPageHeight ? { multiPageHeight } : {}),
        ...(pageGotoParams ? { pageGotoParams } : {}),
      })
      return toBuffer(out)
    } catch (e) {
      Log.warn('[render] Yunzai 渲染器截图失败', e?.message || e)
      return null
    }
  })(), ms, 'card')
}

/**
 * 经 Yunzai 渲染器截图，返回 segment.image。失败返回 null，调用方降级文本。
 * @param {string} name
 * @param {string} html
 * @param {object} [opts] 透传 renderCardBuffer 的 imgType/quality/timeoutMs/pageGotoParams
 */
export const screenshot = async (name, html, opts = {}) => {
  const buf = await renderCardBuffer(html, { ...opts, name })
  if (!buf) return null
  const seg = (typeof segment !== 'undefined' && segment) || null
  return seg?.image ? seg.image(`base64://${buf.toString('base64')}`) : null
}

/**
 * 把一段文本（markdown）渲染成回复图片（segment.image），失败返回 null。
 * markdown→HTML 用 marked+highlight.js（依赖缺失时自动降级为简易渲染）；截图统一经 Yunzai 渲染器。
 */
export const renderReplyImage = async (content, opts = {}) => {
  const ms = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : (Number(Config.get()?.agent?.render?.replyTimeoutMs) || 30000)
  return withTimeout(_renderReplyImage(content, { ...opts, timeoutMs: ms }), ms, 'reply-image')
}

const _renderReplyImage = async (content, { timeoutMs, footer, extraCss, chat } = {}) => {
  try {
    const bodyHtml = await inlineImages(await mdToHtml(content)) // 远程图片下载转 base64 内联（防盗链+可靠），见 model/render/inline-images.js
    // 聊天模式：头像 base64 内联（防渲染器加载远程失败/防盗链）
    let chatResolved = chat
    if (chat) {
      const fa = async (u) => { if (!u) return ''; try { const r = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0' } }); const b = Buffer.from(await r.arrayBuffer()); return `data:image/jpeg;base64,${b.toString('base64')}` } catch { return String(u) } }
      const userAvatar = await fa(chat.userAvatar)
      const aiAvatar = await fa(chat.aiAvatar)
      // 多气泡：用户问 + AI 正文 + 每个表情包独立一条（类似微信多消息）
      // 正文为空（如"只有表情包"的回复）时不渲染空气泡，避免出现空白气泡
      const messages = [
        { role: 'user', text: chat.userText, avatar: userAvatar },
        ...(String(bodyHtml || '').trim() ? [{ role: 'ai', html: bodyHtml, avatar: aiAvatar, name: chat.aiName }] : []),
        // stickerImgs 的元素已是完整 <img class="sticker" src="data:..."> 标签（manager._imgDataUri 产物，
        // .sticker 样式在 theme.js）——不能再当 URL 包一层 src。
        ...((chat.stickerImgs || []).map((tag) => ({ role: 'ai', html: String(tag), avatar: aiAvatar, name: chat.aiName }))),
      ]
      chatResolved = { messages, head: chat.groupName ? `${chat.groupName}（${chat.groupId}）` : '私聊', tokens: chat.tokens, reasoningTokens: chat.reasoningTokens, model: chat.model, inputTokens: chat.inputTokens, outputTokens: chat.outputTokens }
    }
    const html = chatResolved
      ? buildChatHtml(chatResolved)
      : buildHtml({ bodyHtml, ...(footer ? { footer } : {}), ...(extraCss ? { extraCss } : {}) })
    const buf = await renderCardBuffer(html, {
      name: 'agents-plugin/reply', imgType: 'jpeg', quality: 95, timeoutMs,
    })
    if (!buf) {
      Log.warn('[render] 回复图渲染失败，回退文本')
      return null
    }
    const seg = (typeof segment !== 'undefined' && segment) || null
    return seg?.image ? seg.image(`base64://${buf.toString('base64')}`) : null
  } catch (e) {
    Log.warn('[render] renderReplyImage 异常', e?.message || e)
    return null
  }
}

/**
 * 把自包含 HTML 渲染为「卡片图」：统一经 Yunzai 渲染器（截 #container，JPEG q95）。
 * 返回 segment.image；失败返回 null（调用方降级文本）。
 */
export const renderCardImage = async (html, { name = 'agents-plugin/card', timeoutMs } = {}) => {
  return screenshot(name, html, { ...(Number(timeoutMs) > 0 ? { timeoutMs: Number(timeoutMs) } : {}) })
}

/**
 * 渲染 HTML 为 PDF 文件。
 * 仅在 Yunzai 当前渲染后端是 Puppeteer 时复用其浏览器（不再单独 launch Chromium）；
 * shotium 等纯图片后端返回 null，调用方降级为图片/文本。
 * @param {string} html
 * @param {object} opts { path, format='A4' }
 * @returns {Promise<string|null>} 成功返回写入路径，失败 null
 */
export const renderPdf = async (html, { path: outPath, format = 'A4' } = {}) => {
  if (!outPath) return null
  try {
    await fs.promises.mkdir(path.dirname(outPath), { recursive: true })
  } catch { /* noop */ }
  const pdfMs = Math.max(renderTimeoutMs(), HEAVY_TIMEOUT_FLOOR_MS)
  const buff = await withTimeout((async () => {
    const renderer = await getYunzaiRenderer()
    const puppeteer = findPuppeteerRenderer(renderer)
    if (!puppeteer) {
      Log.warn('[render] 当前 Yunzai 渲染后端不支持 PDF（仅图片），跳过 PDF 导出')
      return null
    }
    let page = null
    try {
      const browser = await puppeteer.browserInit()
      const target = browser?.newPage ? browser : puppeteer.browser
      if (!target?.newPage) return null
      page = await target.newPage()
      await page.setJavaScriptEnabled?.(false)
      await page.setContent(String(html ?? ''), { waitUntil: 'load', timeout: pdfMs })
      return await page.pdf({
        format,
        printBackground: true,
        margin: { top: '16mm', bottom: '16mm', left: '14mm', right: '14mm' },
        preferCSSPageSize: false,
        timeout: pdfMs,
      })
    } catch (e) {
      Log.warn('[render] PDF 渲染失败', e?.message || e)
      return null
    } finally {
      if (page) page.close().catch(() => {})
    }
  })(), pdfMs + 5000, 'pdf')
  if (!buff) return null
  try {
    await fs.promises.writeFile(outPath, Buffer.isBuffer(buff) ? buff : Buffer.from(buff))
    return outPath
  } catch {
    return null
  }
}

/**
 * 渲染 HTML 为高清长图（PNG；由 Yunzai 渲染器截 #container）。
 * @param {string} name 缓存名
 * @param {string} html
 * @param {object} opts { imgType='png', timeoutMs }（旧 scale/width 参数保留但忽略）
 * @returns {Promise<Buffer|null>}
 */
export const renderHd = async (name, html, { imgType = 'png', timeoutMs } = {}) => {
  const ms = Number(timeoutMs) > 0 ? Number(timeoutMs) : Math.max(renderTimeoutMs(), HEAVY_TIMEOUT_FLOOR_MS)
  return renderCardBuffer(html, { name, imgType, quality: 100, timeoutMs: ms })
}
