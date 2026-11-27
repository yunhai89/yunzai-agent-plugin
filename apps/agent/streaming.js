/**
 * 回复流 / 进度流 / 逐字增量（原 apps/agent.js）。
 * 只做发送节流与分片安全，不依赖运行时装配。
 */
import { PROGRESS_LABELS, extractArgHint } from './constants.js'
import { makeProgressGate } from '../../model/agent/reply-sender.js'
import { stripMarkers } from '../../model/sticker/parser.js'
import { redactSecrets, redactSafeCut } from '../../model/agent/redact.js'

/**
 * 构造进度反馈回调集合。
 * @param {object} e Yunzai 事件
 * @param {object} opts { progress, recall, shortCircuitTools, replyQueue, gate }
 *   replyQueue：受控串行发送队列（长任务稳定性审计 P0-5）——进度消息经它发送，
 *   rejection 归一为 outcome 记日志，绝不产生 unhandledRejection。
 *   gate：与旁白共享的节流闸（同一 run 内进度+旁白总条数/频率受限，降低撞 QQ 限流概率）。
 */
export function makeReplyStream(e, {
  progress = true, recall = 3, shortCircuitTools = ['clarify'], replyQueue = null, gate = null,
} = {}) {
  if (!progress) return {}
  let lastTool = null
  let lastAt = 0
  const g = gate || makeProgressGate()

  return {
    onToolStart(tc) {
      const name = tc?.name
      if (!name) return
      // 短路工具（如 clarify）：参数本身就是最终回复，发进度=与最终回复重复，跳过
      if (shortCircuitTools.includes(name)) return
      const now = Date.now()
      if (name === lastTool && now - lastAt < 5000) return
      if (!g.allow(now)) return
      lastTool = name
      lastAt = now
      const label = PROGRESS_LABELS[name] || `🔧 调用 ${name}`
      const hint = extractArgHint(tc?.arguments, name)
      const msg = hint ? `${label}：${hint}` : `${label}…`
      replyQueue?.enqueue({ msg, quote: false, opts: { recallMsg: recall } }, { tag: 'progress' })
    },
  }
}

/**
 * 逐字流式发射器（仅 stream=true + 文本回复模式启用）：
 * 累积 provider 的 onDelta 增量，按时间/字数节流，只发送【新增】文本（多条气泡=打字机效果）。
 * rawFull 供调用方在 run 结束后与最终正文比对：一致则跳过重复的整段最终回复。
 */
// 注意：必须是箭头函数（无 prototype）。Yunzai 加载器会把带 prototype 的导出当插件类 new，
// 函数声明会因此被误当插件并触发 collectTask(undefined).cron 报错（index.js 也做了 class 过滤兜底）。
/**
 * 判断从 start（'['/'【'）起是否可能是 sticker 标记的【前缀】（未闭合）：
 *  - 已闭合（出现 ']'/'】'）→ false（完整标记交给 stripMarkers 剥除，不暂存）；
 *  - 命中非法字符（'['/'【'/换行）→ false（不可能再长成标记）；
 *  - 到达结尾仍未闭合 → true（必须暂存，等后续分片补齐，避免 `[sti` 先发出去后无法整体剥除）。
 * 覆盖半/全角、大小写、可选冒号与空白。
 */
function isStickerMarkerPrefix(s, start) {
  let i = start + 1
  while (i < s.length && /\s/.test(s[i])) i++
  const word = 'sticker'
  for (let t = 0; t < word.length; t++) {
    if (i >= s.length) return true // 词尚未输完：可能是前缀
    if (s[i].toLowerCase() !== word[t]) return false
    i++
  }
  while (i < s.length && /\s/.test(s[i])) i++
  if (i < s.length && (s[i] === ':' || s[i] === '：')) {
    i++
    while (i < s.length && /\s/.test(s[i])) i++
  }
  for (; i < s.length; i++) {
    const ch = s[i]
    if (ch === ']' || ch === '】') return false // 完整标记
    if (ch === '[' || ch === '【' || ch === '\n') return false // 断链，不再是标记
  }
  return true
}

/** 返回 s 中最长可疑 sticker 标记前缀的起始下标；无则 -1。用于跨分片暂存，绝不半截外发。 */
function pendingStickerStart(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c !== '[' && c !== '【') continue
    if (isStickerMarkerPrefix(s, i)) return i
  }
  return -1
}

export const makeDeltaStreamer = (safeReply, { enabled = false, minIntervalMs = 1200, minChars = 24, redact = redactSecrets } = {}) => {
  const doRedact = typeof redact === 'function' ? redact : (s) => s
  let raw = ''
  let sentLen = 0 // 已发出的脱敏文本对应的 raw 前缀长度（deliveredEnd 也用它：调用方按 raw 坐标取剩余正文）
  let sentSafeLen = 0 // 已发出脱敏文本的长度（差分在脱敏后的坐标系里做）
  let lastAt = 0
  let queuedAny = false
  let failed = false
  let complete = false
  let deliveredEnd = 0 // 已确认送达的 raw 前缀长度（分片按序发送）
  const inflight = [] // { end, p } 已入队发送的 Promise（永不 reject，归一为 {ok}）

  const enqueueChunk = (chunk, end) => {
    queuedAny = true
    let ret
    try {
      ret = safeReply(chunk)
    } catch {
      failed = true
      inflight.push({ end, p: Promise.resolve({ ok: false }), _ok: false })
      return
    }
    // 同步发送（返回非 thenable，如 `(m)=>sent.push(m)`）：立即视为已确认，保持旧同步语义
    if (!ret || typeof ret.then !== 'function') {
      inflight.push({ end, p: Promise.resolve({ ok: true }), _ok: true })
      return
    }
    const q = Promise.resolve(ret).then(
      (outcome) => {
        const ok = !(outcome && outcome.ok === false)
        if (!ok) failed = true
        return { ok }
      },
      () => { failed = true; return { ok: false } },
    )
    inflight.push({ end, p: q })
  }

  const flush = (force = false) => {
    if (!enabled) return
    if (!force && !(raw.length - sentLen >= minChars && Date.now() - lastAt >= minIntervalMs)) return
    // 可发送的 raw 边界：尾部若「可能是不完整密钥」先扣住不发（收尾时无此顾虑）。
    // 逐片调用 redactSecrets 必然漏掉跨片断裂的密钥（分片边界由 minChars/minIntervalMs 决定），
    // 故这里改成：先定安全切点 → 对【完整前缀】脱敏 → 与上次的脱敏结果差分出新片段。
    // redactSecrets 对前缀单调（同一处替换恒为 ***），因此差分不会错位、已发内容不会被推翻。
    let cut = force ? raw.length : Math.min(raw.length, doRedact === redactSecrets ? redactSafeCut(raw) : raw.length)
    // 跨分片防泄漏：结尾若可能是 sticker 标记的【未闭合前缀】（含 `[`、`[s`、`[sti` 等），
    // 暂缓发送等后续增量补齐；force（收尾）时丢弃悬空前缀，绝不把 [sticker:x] 流给用户。
    // 判定在 raw 坐标上做（标记字符不受脱敏影响），且不推进 sentLen → 收尾后仍可由调用方补发。
    const hold = pendingStickerStart(raw.slice(sentLen, cut))
    if (hold !== -1) cut = sentLen + hold
    if (cut <= sentLen) return
    const safe = doRedact(raw.slice(0, cut))
    const part = safe.slice(sentSafeLen)
    sentSafeLen = safe.length
    sentLen = cut
    lastAt = Date.now()
    const chunk = stripMarkers(part)
    if (chunk.trim()) enqueueChunk(chunk, sentLen)
  }

  const finalize = () => {
    let end = 0
    for (const c of inflight) {
      if (c._ok === false) break
      end = c.end
    }
    deliveredEnd = end
    complete = queuedAny && !failed
    return complete
  }

  return {
    enabled,
    push(d) { if (typeof d === 'string') raw += d; flush(false) },
    /**
     * 收尾：发完剩余增量并等待全部入队分片结算（发送队列完成屏障）。
     * 返回 { ok, sentAny, deliveredEnd, rawLen }；只要存在失败/未决/缺片即 ok=false，
     * 调用方据此不得标记"完整送达"（避免失败被当成功、正文被跳过）。
     */
    finish() {
      flush(true)
      const unsettled = inflight.filter((c) => c._ok === undefined)
      const result = () => ({ ok: complete, sentAny: complete, deliveredEnd, rawLen: raw.length })
      if (!unsettled.length) { finalize(); return Promise.resolve(result()) }
      return Promise.all(unsettled.map((c) => c.p)).then((results) => {
        unsettled.forEach((c, i) => { c._ok = results[i].ok })
        finalize()
        return result()
      })
    },
    get rawFull() { return raw },
    get sentAny() { return complete },
    get deliveredEnd() { return deliveredEnd },
  }
}
