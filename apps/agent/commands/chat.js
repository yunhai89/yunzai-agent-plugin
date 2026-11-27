/**
 * AI 对话主循环与会话管理（原 apps/agent.js）。
 */
import { randomUUID } from 'node:crypto'
import Config from '../../../utils/Config.js'
import Log from '../../../utils/Log.js'
import devLog from '../../../utils/DevLog.js'
import { STOP_REASON_CN, buildChatListHtml, parseCron } from '../../../model/agent/index.js'
import { normalizeUsage } from '../../../model/agent/messages.js'
import { redactSecrets } from '../../../model/agent/redact.js'
import { ReplySender, createRunQueues, makeProgressGate } from '../../../model/agent/reply-sender.js'
import { stripInlineToolCalls } from '../../../model/openai/helpers.js'
import { detectAdapter as detectQQAdapter, buildMarkdownMessage, splitMarkdown, markdownToPlain, hasMarkdownSegment } from '../../../model/qqofficial/index.js'
import { flushPendingCards } from '../../../model/qqofficial/tool.js'
import { isStickerOnly, stripMarkers } from '../../../model/sticker/parser.js'
import { createMediaService, fetchQuotedContext } from '../../../model/media/index.js'
import { describeImages } from '../../../model/vision/index.js'
import { detectCapabilities } from '../../../model/llm/capabilities.js'
import { buildSituationalContext } from '../../../model/perception.js'
import { makeDiagramDeliverer } from '../../../model/diagram/deliver.js'
import { REPLY_CSS } from '../../../model/render/theme.js'
import { screenshot, renderReplyImage } from '../../render.js'
import { getRuntime, maybeRedact, apiRejected, wasInitFailureNotified, markInitFailureNotified } from '../runtime.js'
import { ctxOf, attachToolRuntime, ownsScheduleRecord, resolvePersonaGrounding, thinkingLogFields, fireReminder, makeFireDispatch } from '../context.js'
import { makeReplyStream, makeDeltaStreamer } from '../streaming.js'

// 每会话运行队列（长任务稳定性审计 P1）：同 conversation 串行（防读改写互覆历史/过期回复乱序），
// 跨 conversation 并发。队列本身框架无关（model/agent/reply-sender.js），可离线测试。
const convRunQueues = createRunQueues()

export const chatCommands = {

  async _handleAgent(text) {
    // traceId 先于一切可能失败的异步操作生成（长任务稳定性审计 P0-5：曾生成于 getActiveConversation
    // 之后，该 await 裸露抛出时既无 trace 也无回复）。终态守卫保证每个 trigger 最终、且只落到
    // reply_sent / reply_failed / cancelled / run_error 之一（离线一致性检查可复核）。
    const traceId = randomUUID()
    let devScope = null
    let terminalFired = false
    const terminal = (event, data = {}) => {
      if (terminalFired) { Log.warn('[trace] 终态重复触发（已忽略）', event, traceId); return false }
      terminalFired = true
      devLog(event, data, traceId, devScope)
      return true
    }
    // 正常路径的 trigger 事件在拿到会话后才发（带 conv/devScope）；装配或会话读取失败时它发不出来，
    // 只发终态就成了"孤儿终态"（离线一致性检查判为不合法 trace）。失败路径补发最小 trigger，
    // scope=null → 落 dev-fallback.log（此时确实还没有会话归属）。
    const triggerOnFailure = (at) => {
      const c = ctxOf(this.e)
      devLog('trigger', {
        user: c.userId, gid: c.groupId, isGroup: c.isGroup, scopeUserId: c.scopeUserId, scopeId: c.scopeId,
        conv: null, text: text || '', inputLen: (text || '').length, at,
      }, traceId, null)
    }
    let rt
    try {
      rt = await getRuntime()
    } catch (e) {
      const msg = e?.message || '插件初始化失败'
      // 终态守卫：装配失败也必须有终态，否则该 traceId 永久悬挂（离线一致性检查视为回复静默丢失），
      // 且 Replying false 会让消息下沉给其它插件——用户看到的是"命令没人认领"而非失败原因（审计 A）。
      triggerOnFailure('getRuntime')
      terminal('run_error', { error: msg, at: 'getRuntime' })
      // 每个用户仅提示一次（避免群里刷屏），修复 config（热加载）后自动恢复
      const _uid = String(this.e.user_id || '')
      if (_uid && !wasInitFailureNotified(_uid)) {
        markInitFailureNotified(_uid)
        try { await this.e.reply(`⚠️ ${msg}。修复后保存 config 即自动恢复。`) } catch { /* noop */ }
      }
      return true // 已受理并给出失败提示（去重期除外），不再下沉给其它插件
    }
    const cfg = Config.get().agent || {}
    const ctx = ctxOf(this.e)
    // QQ 官方机器人：send_keyboard 工具排队卡片，由本轮最终回复后统一投递
    ctx.pendingCards = []
    // 会话指针读取须有错误边界（此前裸 await 抛出 → 整条消息无响应、控制台无 trace）
    try {
      ctx.conversationId = await rt.session.getActiveConversation(ctx.scopeUserId, ctx.groupId)
    } catch (e) {
      Log.error('[chat] 读取活跃会话失败', e?.message || e)
      triggerOnFailure('getActiveConversation')
      terminal('run_error', { error: e?.message || String(e), at: 'getActiveConversation' })
      try { await this.e.reply('⚠️ 读取会话信息失败，请稍后重试。') } catch { /* best effort */ }
      return false
    }
    // per-会话日志文件名所需信息；uid 用 scopeUserId 保证"同会话同文件"（群共享时为 __group__）
    let __convMeta = null
    try { __convMeta = await rt.session.getConversationMeta(ctx.scopeUserId, ctx.groupId, ctx.conversationId) } catch { /* noop */ }
    ctx.conversationShortId = __convMeta?.shortId || null
    ctx.devScope = { gid: ctx.groupId || 'private', uid: ctx.scopeUserId, convId: ctx.conversationId, createdAt: __convMeta?.createdAt || Date.now() }
    devScope = ctx.devScope
    devLog('trigger', {
      user: ctx.userId, gid: ctx.groupId, isGroup: ctx.isGroup, scopeUserId: ctx.scopeUserId, scopeId: ctx.scopeId, conv: ctx.conversationId,
      text: text || '',              // 用户提问原文（意图来源；trace 不截断，全文记录）
      inputLen: (text || '').length,
      hasReply: !!(this.e?.reply_id || (Array.isArray(this.e?.message) && this.e.message.some((s) => s && s.type === 'reply'))), // 是否引用了消息提问
    }, traceId, ctx.devScope)

    // —— 多模态：主动收集消息中的图片/文件，按模型能力转为协议原生内容 ——
    const protocol = cfg.protocol || 'openai'
    const caps = detectCapabilities({ protocol, model: cfg.model, caps: cfg.media?.caps })
    const mediaCfg = cfg.media || {}
    ctx.miyoushe = { cookie: cfg.miyoushe?.cookie || '', defaultGid: cfg.miyoushe?.defaultGid || 2, maxImages: cfg.miyoushe?.maxImages ?? 9 }
    // 供工具按回复模式分流发图：image=渲染进回复图 / text=合并转发 / markdown=QQ 官方机器人直发
    ctx.replyMode = cfg.reply?.mode || 'text'
    try {
      const __qq = detectQQAdapter(this.e)
      if (__qq.official && cfg.qqOfficial?.markdown?.enable !== false && hasMarkdownSegment()) ctx.replyMode = 'markdown'
      ctx.official = __qq.official
    } catch { /* noop */ }
    // 提醒服务：reminder_set 工具经此调 rt.schedule.add（绑定 fireReminder + selfId），到时间 fireReminder 主动发消息
    ctx.selfId = String(this.e.self_id || this.e.selfId || '')
    ctx.reminder = {
      // 有 prompt → 一次性任务链（type=task 跑 Agent + 发结果，走 fireDispatch）；否则静态提醒（fireReminder）
      add: (info) => {
        const isTask = !!info.prompt
        return rt.schedule.add(
          { selfId: ctx.selfId, type: isTask ? 'task' : 'reminder', ...info },
          isTask ? makeFireDispatch(rt) : fireReminder,
        )
      },
      list: (userId, opts) => rt.schedule.listByUser(userId, opts),
      // 取消前校验归属：直接按 id 取消曾是越权路径（任意用户枚举 5 位顺序号即可删他人提醒/任务链）
      cancel: async (id) => {
        const all = await rt.schedule.listAll()
        const rec = all.find((r) => String(r.id) === String(id))
        if (!rec) return false
        if (!ownsScheduleRecord(rec, ctx)) throw new Error('无权取消该提醒/任务（仅创建者或主人可取消）')
        await rt.schedule.cancel(id)
        return true
      },
    }
    // 定时任务链：schedule_task 工具经此调 rt.schedule.add（type=task + cron + makeFireDispatch，到点跑 Agent + 发结果）
    ctx.cronTask = {
      add: (info) => {
        const cron = info.cron || parseCron(info.when)
        if (!cron) {
          return { error: `无法识别时间「${info.when || ''}」，支持：每天8点/每2小时/工作日9点/每周一8点30/每30分钟。若写了多个时间点且分钟不同（如 8:30和20:15），请分多条任务创建。` }
        }
        return rt.schedule.add({ type: 'task', cron, prompt: info.prompt, userId: ctx.scopeUserId, groupId: ctx.groupId || null, selfId: ctx.selfId }, makeFireDispatch(rt))
      },
      list: async () => {
        const all = await rt.schedule.listAll()
        // 只回本会话（或主人）拥有的任务链：曾返回全部 type='task'（含他人私聊任务），
        // 普通成员据此可枚举并读取/取消他人任务
        return all.filter((r) => r.type === 'task' && ownsScheduleRecord(r, ctx))
      },
      cancel: async (id) => {
        const all = await rt.schedule.listAll()
        const rec = all.find((r) => String(r.id) === String(id))
        if (!rec) return false
        if (!ownsScheduleRecord(rec, ctx)) throw new Error('无权取消该任务（仅创建者或主人可取消）')
        await rt.schedule.cancel(id)
        return true
      },
    }
    // 工具运行时能力（沙箱执行面 + 视觉子模型）：沙箱给 terminal/沙箱化工具（全员可用，无审批无黑名单，只有成本闸）；
    // 视觉给媒体类工具（bilibili__analyze 看视频等）
    attachToolRuntime(ctx, rt, cfg)
    // web_download 工具运行时配置（yt-dlp 下载；目录/大小/超时上限，单位 MB→字节）
    ctx.download = {
      dir: cfg.download?.dir || undefined,
      maxBytes: cfg.download?.maxMB ? cfg.download.maxMB * 1024 * 1024 : undefined,
      sendLimitBytes: cfg.download?.sendLimitMB ? cfg.download.sendLimitMB * 1024 * 1024 : undefined,
      maxTimeoutSec: cfg.download?.maxTimeoutSec || undefined,
      ytDlpBin: cfg.download?.bin || undefined,
      allowPrivateHosts: cfg.download?.allowPrivateHosts === true,
    }
    // media.enable=false：关闭多模态（不收集/不注入附件/不转视觉），纯文本处理
    const mediaEnabled = cfg.media?.enable !== false
    const media = mediaEnabled ? createMediaService({
      bot: ctx.bot, e: this.e, caps, protocol, config: mediaCfg, fetcher: ctx.fetcher,
      log: (m) => (/失败|未能|异常/.test(m) ? Log.warn('[media]', m) : Log.debug('[media]', m)),
    }) : null
    // —— 引用消息：拉取被引用内容（文本/文件/聊天记录卡片）并入本轮输入 ——
    // 此前只对引用里的媒体做了收集，引用文本/转发卡片从未进模型上下文 → 机器人"看不到引用"。
    let quotedBlock = ''
    try {
      const hasReply = this.e?.reply_id != null || (Array.isArray(this.e?.message) && this.e.message.some((s) => s && s.type === 'reply'))
      if (hasReply) {
        const q = await fetchQuotedContext(this.e, { bot: ctx.bot, fetcher: ctx.fetcher, log: (m) => Log.debug('[reply]', m) })
        if (q) {
          ctx.quoted = q // 供 analyze_chat_record 自动定位被引用的聊天记录卡片
          const parts = []
          if (q.nick || q.text) parts.push(`${q.nick ? q.nick + ': ' : ''}${q.text || '(无文本)'}`)
          if (q.forwardResid) parts.push('[这是一条合并聊天记录卡片，可用 analyze_chat_record 工具分析其内容]')
          // 结束标记供 Agent._stripInjectedFromUserText 精确剥离（第 10 轮审计 high：
          // 引用块在用户真话之前，没有结束标记就只能靠空行猜，引用内容里含空行时会切错）
          if (parts.length) quotedBlock = `【引用消息】\n${parts.join('\n')}\n【引用消息结束】`
        } else {
          Log.debug('[reply] 未能取到被引用消息（getReply/get_msg/历史均失败）')
        }
      }
    } catch (e) { Log.warn('[reply] 引用消息获取失败', e?.message || e) }
    // 模型可见文本 = 引用块 + 用户本轮文字（引用只进模型输入，不改原始 text，避免影响 skill 匹配/日志）
    const modelText = quotedBlock ? (text ? `${quotedBlock}\n\n${text}` : quotedBlock) : text

    let input = modelText
    let blindMedia = '' // 收集到但无法识别的媒体种类（如"图片/视频"）——主模型无对应能力且未被 vision 子模型转文本，用于防臆测提示
    let effText = modelText
    if (mediaEnabled) {
      try {
        let files = await media.collectActive()
        const nImg = files.filter((f) => f.kind === 'image' || (f.mime || '').startsWith('image/')).length
        const nVid = files.filter((f) => f.kind === 'video' || (f.mime || '').startsWith('video/')).length
        // A 方案：主模型看不到的图片、以及**所有视频**，交视觉子模型转文本描述再喂主模型。
        //  - 图片仅在主模型无视觉时转（主模型自带视觉则保留原生块，不丢细节）；
        //  - 视频无主模型原生块路径（convert 不发 video），无论主模型是否有视觉都走子模型。
        const needVision = rt.vision && ((!caps.vision && nImg > 0) || nVid > 0)
        if (needVision) {
          Log.mark('[chat]', `vision 子模型识别 ${nImg} 图/${nVid} 视频（主模型 ${cfg.model} 视觉=${caps.vision ? 'on' : 'off'}）`)
          try {
            files = await describeImages(rt.vision, files, modelText, { images: !caps.vision, video: true })
            media.replaceActive(files)
          } catch (e) {
            Log.warn('[vision] 媒体识别失败，按原能力降级', e?.message || e)
          }
        }
        ctx.media = files // 供 read_attachment 等被动工具读取
        devLog('media', { files: (files || []).map((f) => ({
          // source: message=消息附带 reply=引用 forward=合并转发 group_file=群文件
          source: f.source, kind: f.kind, name: f.name, ext: f.ext || null, mime: f.mime || null,
          size: f.size ?? null,            // 协议/消息段报告大小（与 bytes 对比判断下载是否完整）
          bytes: f.bytes ?? null,          // 实际下载字节（null/0=未拿到字节=下载未成功）
          hasUrl: !!f.url,                 // 是否拿到直链
          status: f.resolveError || 'ok',  // ok / no_url / download_failed / limit_images / limit_size
          skipReason: f.__skipReason || null,
          visionDescribed: !!f.__visionDescribed, // 图片是否已被 vision 子模型转成文本描述
          visionError: f.__visionError || null,   // 视觉子模型失败原因（null=成功/未走识别）；用于事后定位"识别失败/为空"
        })) }, traceId, ctx.devScope)
        // 盲媒体判定（问题1）：有图片/视频，主模型无对应能力，且未被 vision 子模型转成文本（__visionDescribed）
        const stillBlind = (pred) => files.some((f) => pred(f) && f.buffer && !f.__visionDescribed)
        const blindKinds = []
        if (nImg > 0 && !caps.vision && stillBlind((f) => f.kind === 'image' || (f.mime || '').startsWith('image/'))) blindKinds.push('图片')
        if (nVid > 0 && stillBlind((f) => f.kind === 'video' || (f.mime || '').startsWith('video/'))) blindKinds.push('视频')
        if (blindKinds.length) {
          blindMedia = blindKinds.join('/')
          Log.warn(`[vision] 用户发送了${blindMedia}但当前无法识别（主模型无对应能力，未配可用视觉子模型 agent.vision.model）；将提示用户而非臆测`)
        }
        // 纯媒体无文字：注入默认指令（问题4）
        effText = modelText || (files.length ? '（我发了一张图片/文件给你，请查看并告诉我内容，或按需处理）' : '')
        if (effText) {
          const content = media.buildContent(effText)
          if (Array.isArray(content)) input = { role: 'user', content, _media: true }
          else input = effText
          if (files.length) Log.debug('[chat]', `media files=${files.length} images=${nImg} videos=${nVid} vision=${!!caps.vision} blind=${blindMedia || '-'} multimodal=${Array.isArray(content)}`)
        }
      } catch (e) {
        Log.warn('[media] 主动收集失败，回退纯文本', e?.message || e)
        ctx.media = []
      }
    } else {
      ctx.media = []
    }
    // 既无文字又无媒体（或媒体已关闭）：提示而非空跑
    if (!effText) {
      try {
        await this.e.reply('未识别到文字或图片/文件内容（引用的图片可能获取失败），请重新发送或补充说明。')
        terminal('reply_sent', { mode: 'text', stopReason: 'no_input', earlyReturn: true })
      } catch (re) {
        terminal('reply_failed', { mode: 'text', stopReason: 'no_input', earlyReturn: true, error: re?.message || String(re) })
      }
      return true
    }

    // —— 人设：解析当前用户激活的人设 + 已采纳资料接地（静态核心事实 + 长尾检索）——
    let systemPrompt
    let personaId = null
    let personaGroundingContext = null
    try {
      const pg = await resolvePersonaGrounding(rt, ctx, text)
      personaId = pg.personaId
      systemPrompt = pg.systemPrompt || undefined
      personaGroundingContext = pg.context || null
    } catch (e) {
      Log.warn('[persona] 解析失败，用默认', e?.message || e)
    }

    // —— 情境感知：perception（数据：时间/角色/运行能力盘点/近期对话）+ skill（说明书，按输入匹配）——
    let context
    try {
      // 会话历史条数：供 perception 判断"上下文稀薄 → 主动补全近期群聊"（复用 session 缓存，零额外读盘）
      let sessionLen
      try { sessionLen = await rt.session.historyLength(ctx) } catch { sessionLen = undefined }
      const perception = await buildSituationalContext({
        ctx, runtime: rt, e: this.e, kv: rt.kv, cfg, bot: ctx.bot,
        historyCount: cfg.skill?.historyCount ?? 15,
        sessionLen,
      })
      const matched = rt.skills.match({ input: text, ctx })
      const skillText = rt.skills.assemble(matched)
      if (matched.length) Log.mark('[skill]', '命中说明书：', matched.map((s) => s.name).join(','))
      devLog('skill', { matched: matched.map((s) => s.name), input: (text || '').slice(0, 100) }, traceId, ctx.devScope)
      context = [perception, skillText].filter(Boolean).join('\n\n') || undefined
      // B方案：附件清单注入 context——让 AI 明确知道本轮有哪些附件、可用
      // read_attachment/file_to_pdf(name:"<文件名>") 直接处理。根治"附件正文进了上下文
      // 却丢了文件名、AI 不知该对哪个文件动手"（如"把这个转pdf"→AI 去列群文件找不到）
      const __atts = Array.isArray(ctx.media) ? ctx.media : []
      if (__atts.length) {
        const __srcCn = { message: '消息附带', reply: '引用消息', forward: '合并转发', group_file: '群文件' }
        const __lines = __atts.map((f, i) => {
          const sz = f.bytes ? `${(f.bytes / 1024).toFixed(1)}KB` : '大小未知'
          const st = f.resolveError ? `（获取失败:${f.resolveError}）` : ''
          return `${i + 1}. ${f.name} (${sz}, ${__srcCn[f.source] || f.source}${f.mime ? ', ' + f.mime : ''})${st}`
        })
        const __attHint = `【本次附件】用户本轮有以下附件（已自动收集；你可用 read_attachment(name:"<文件名>") 读内容、file_to_pdf(name:"<文件名>") 转PDF，无需知道路径）：\n${__lines.join('\n')}\n若用户指令针对某附件（如"转成pdf"/"总结这个文件"），请直接用其文件名作 name 参数调用对应工具。`
        context = context ? `${context}\n\n${__attHint}` : __attHint
      }
    } catch (e) {
      Log.warn('[perception/skill] 注入失败', e?.message || e)
    }
    // —— 人设长尾资料：按本轮问题检索 per-persona 知识库，动态注入本轮上下文（核心事实已在身份层静态接地）——
    if (personaGroundingContext) {
      context = context ? `${context}\n\n${personaGroundingContext}` : personaGroundingContext
    }
    // 盲媒体防臆测（问题1）：模型看不到图/视频时，明确告知"无法识别"，杜绝从历史/上下文臆测内容
    if (blindMedia) {
      const warn = `【系统提示】用户发送了${blindMedia}，但当前无法识别（未配置可用的视觉模型 agent.vision.model，或主模型不支持）。请如实告知用户暂时无法识别${blindMedia}内容、建议配置视觉模型；切勿根据历史对话或上下文臆测内容。`
      context = context ? `${context}\n\n${warn}` : warn
    }

    // [chat] 汇总行移到 run 之后打印：需带上本轮"思考自动决策"结果（档位/预算/判档来源）
    // 官方机器人：主动推送有频控/需权限，默认不发进度（qqOfficial.progress=true 可开）
    let wantProgress = cfg.progress !== false
    try {
      if (detectQQAdapter(this.e).official && cfg.qqOfficial?.progress !== true) wantProgress = false
    } catch { /* noop */ }
    // 逐字流式固定关闭（适配器差异大，稳定性优先）；进度反馈仍由 cfg.progress 控制。
    // 仅离线 e2e 用环境变量开启（不是用户配置）。
    const wantStream = process.env.AGENTS_STREAM_TEST === '1'

    // —— 受控串行发送队列（P0-5）：思考中/进度/旁白/最终回复全部经它发送 ——
    // 取代 `try { e.reply(...) } catch {}`（同步 catch 捕获不了适配器 Promise 的 rejection，
    // 会变 unhandledRejection 静默消失）；enqueue 永不 reject，失败归一为 outcome 记日志。
    const replyQueue = new ReplySender({
      send: (p) => {
        const args = [p.msg]
        if (p.quote !== undefined) args.push(p.quote)
        if (p.opts !== undefined) args.push(p.opts)
        return this.e.reply(...args)
      },
      onSendError: (err, _p, tag) => Log.warn(`[reply:${tag}] 消息发送失败`, err?.message || err),
      // 发送超时保护：进度/旁白一条卡住时快速失败，不再把串行队列堵到适配器超时（默认 60s）。
      // final 不设超时（finalTimeoutMs=0）——宁可多等，也不把可能已送达的最终回复误判为失败。
      timeoutMs: 15000,
    })
    const safeReply = (msg, quote, opts) => replyQueue.enqueue({ msg, quote, opts })
    if (wantProgress) safeReply('思考中…') // best effort：发送失败只记日志，绝不阻塞 Agent 执行
    // 同一 run 内进度与旁白共享节流闸：总条数与频率受限，降低短时间连发撞 QQ 限流概率。
    const progressGate = makeProgressGate({ minIntervalMs: 1800, maxMsgs: 6 })
    const rs = makeReplyStream(this.e, { progress: wantProgress, recall: cfg.progressRecall ?? 3, shortCircuitTools: ['clarify'], replyQueue, gate: progressGate })
    // —— QQ 官方机器人（QQBot）能力：markdown 直发（无需渲染成图片）+ inline keyboard ——
    // 触发条件：官方适配器 && agent.qqOfficial.markdown.enable（默认开）&& 当前框架支持 markdown 段（TRSS）。
    const qqInfo = detectQQAdapter(this.e)
    const mdCfg = cfg.qqOfficial?.markdown || {}
    const mdMode = !!(qqInfo.official && mdCfg.enable !== false && hasMarkdownSegment())
    // 流式：仅文本回复模式下逐字发增量（图片/markdown 模式需整段，不流式）；onDelta 始终用于观测计数
    const replyModeEarly = mdMode ? 'markdown' : (cfg.reply?.mode || 'text')
    const streamer = makeDeltaStreamer(safeReply, {
      enabled: wantStream && replyModeEarly === 'text',
      // 与最终整段发送同一口径（第 2248 行）：关闭脱敏时不必做尾部暂存，流式节奏不受影响
      redact: cfg.redactSecrets === false ? null : redactSecrets,
    })
    let __deltaEvents = 0, __deltaChars = 0, __reasonChars = 0

    // —— diagram 示意图交付（应用层发送，工具绝不直接 e.reply）——
    // diagram_render 的成功结果在工具完成回调里收集（未截断的 content），最终回复送达后经队列发送：
    //   天然满足 取消(aborted)后不发送迟到图片 / 同路径只发一次 / 发送失败记 send_failed 而不影响主回复终态。
    const diagramDeliverer = makeDiagramDeliverer({ safeReply, devLog, traceId, devScope: ctx.devScope, logger: Log })
    const onDiagramToolEnd = (tc, content) => diagramDeliverer.onToolEnd(tc, content)
    const sendPendingDiagrams = () => diagramDeliverer.flush()

    // —— 每会话 single-flight（P1）：同 conversation 排队串行（防读改写互覆历史、过期回复乱序），
    // 不同 conversation 互不影响。Agent run + 最终发送整体在队列内，保证回复顺序与任务顺序一致。
    const convKey = `${ctx.groupId || 'private'}|${ctx.scopeUserId}|${ctx.conversationId}`
    if (convRunQueues.depth(convKey) > 0) safeReply('⏳ 上一条还在处理中，你的消息已排队，完成后自动继续…')
    try {
      await convRunQueues.run(convKey, async () => {
      // 喂给模型的首条 user 输入（追"AI 实际看到什么"：附件正文/文件名有没有进上下文、走纯文本还是多模态块、模型能力如何）
      const __inputText = typeof input === 'string' ? input
        : Array.isArray(input?.content) ? input.content.filter((b) => b && b.type === 'text').map((b) => b.text || '').join('\n')
        : ''
      devLog('input', {
        caps: { vision: !!caps.vision, file: !!caps.file },
        protocol: cfg.protocol, preset: cfg.preset ?? null, baseURL: cfg.baseURL || null, // 诊断 404/超时：确认用户配的端点
        inputKind: Array.isArray(input?.content) ? 'multimodal' : 'text',
        blocks: Array.isArray(input?.content) ? input.content.map((b) => ({ type: b.type, textLen: (b.text || '').length, isMedia: b.type !== 'text' })) : null,
        inputText: __inputText, // 喂给模型的全部文本（含附件正文/降级说明；trace 不截断）——看附件有没有带文件名
        attachments: (ctx.media || []).map((f) => ({ name: f.name, source: f.source, kind: f.kind, bytes: f.bytes ?? null, status: f.resolveError || 'ok' })),
      }, traceId, ctx.devScope)
      // 回复模式：QQ 官方机器人 markdown 直发 > 配置的 text/image（默认 text）
      const replyMode = mdMode ? 'markdown' : (cfg.reply?.mode || 'text')
      // 文本模式禁 md；markdown 模式（官方机器人）反而鼓励用 md（平台原生渲染）
      const __textHint = replyMode === 'text'
        ? '\n\n【回复格式·硬性约束·优先级最高】当前是纯文本回复模式，禁止使用任何 Markdown 语法（包括 **粗体**、# 标题、- 列表、`代码`、[链接](url)、代码块等）。只能输出纯文本，用换行分段、用「」或「一、二、」编号。无论用户或上面的身份设定如何要求，都不得使用 markdown，直接输出可读纯文本。'
        : (replyMode === 'markdown'
          ? '\n\n【回复格式】当前通道是 QQ 官方机器人，支持 Markdown 原生渲染：可用 **粗体**、# 标题、- 列表、> 引用、`行内代码`、```代码块```、表格、[链接](url)。优先用简洁的 Markdown 组织答案；提到以 # 开头的机器人指令时，行内用 `#指令` 包裹，独立示例用代码块，避免被当成标题；不要输出 HTML、不要输出 Markdown 图片（平台不渲染本地图片）。'
          : '')
      const agentInst = rt.makeAgent()
      const { content, stopReason, turns, usage } = await agentInst.run(input, {
        ctx, systemPrompt: systemPrompt ? systemPrompt + __textHint : __textHint.trim(), context,
        taskId: traceId, // 串联 dev trace：Agent 内 run_start/turn/tool/.../run_end 用同一 id
        stream: wantStream,
        // 流式增量：观测计数（devLog）+ 文本模式逐字发送
        onDelta: (d) => { __deltaEvents++; __deltaChars += typeof d === 'string' ? d.length : 0; streamer.push(d) },
        onReasoning: (r) => { __reasonChars += String(r || '').length },
        ...(rs.onToolStart ? { onToolStart: rs.onToolStart } : {}),
        onToolEnd: (tc, content) => {
          onDiagramToolEnd(tc, content) // diagram_render 成功结果收集（应用层随最终回复发送）
          try { rt.usageStats?.recordToolResult(tc?.name, content) } catch { /* 统计不阻塞对话 */ }
        },
        // OpenClaw 式中途播报：模型在调工具时附带的中途文本（思路/进展）实时转发给用户，不丢弃。
        // 经受控发送队列（P0-5）：rejection 记日志，不产生 unhandledRejection，也不阻塞 Agent。
        onAssistant: (res) => {
          // 旁白与工具进度共享节流闸：短时间内的多条旁白只发第一条，防刷屏 / 撞限流
          const narrateOn = cfg.reply?.narrate !== false && !(ctx.official && cfg.qqOfficial?.narrate !== true)
          if (res?.toolCalls?.length && res?.content && narrateOn && progressGate.allow()) {
            const narr = stripMarkers(maybeRedact(res.content)).replace(/\s+$/, '')
            if (narr) safeReply(narr)
          }
        },
        // 主人免确认直执行（masterSkipConfirm）时的高危提示——否则该开关静默绕过审批
        onMasterAutoApprove: (tc) => {
          const args = typeof tc?.arguments === 'string' ? tc.arguments : JSON.stringify(tc?.arguments ?? {})
          safeReply(maybeRedact(`⚠️ 主人任务免确认自动执行（高危）：${tc?.name || '?'} ${String(args).slice(0, 200)}`))
        },
      })
      // [chat] 汇总行：thinkingAuto 为 on 时显示自动判定的档位/预算/判档来源；off 时显示静态 thinking 与上限
      Log.mark('[chat]', `user=${ctx.userId} gid=${ctx.groupId || '-'} conv=${ctx.conversationId} model=${cfg.model} persona=${personaId || 'default'} vision=${caps.vision ? 'on' : 'off'} ${thinkingLogFields(agentInst, cfg)}${context ? ` ctx=${String(context).length}字` : ''}`)
      // —— 在线自进化：采迹（数据闭环）+ 后台自评审触发（全异步、兜底，绝不阻塞回复）——
      try { rt.traceStore?.record({ scope: ctx.scopeUserId, scopeId: ctx.scopeId, input: __inputText, output: content, turns, usage, stopReason, taskId: traceId }) } catch (e) { Log.warn('[evolution] 采迹失败', e?.message || e) }
      // 自评审的 memory 建议要过来源闸门：必须带**真实用户发言**才能写「用户要求」类条目
      // （2026-10-17 审计 S2：此前 ctx 里没有 userTexts，带 evidence 的正当建议反而全被拒）。
      try { rt.selfReview?.tick({ ...ctx, userTexts: agentInst?._userTexts || [] }, { input: __inputText, output: content, turns, usage, stopReason }) } catch (e) { Log.warn('[evolution] 自评审触发失败', e?.message || e) }
      const u = usage ? `in:${usage.prompt_tokens ?? usage.input_tokens ?? usage.input ?? '-'}/out:${usage.completion_tokens ?? usage.output_tokens ?? usage.output ?? '-'}` : '-'
      Log.mark('[chat]', `reply turns=${turns} stop=${stopReason} usage=${u} replyLen=${(content || '').length}`)
      // 发送前脱敏：屏蔽 API Key / token 等敏感信息（agent.redactSecrets 默认开；异常不阻塞回复）
      // 安全网：无论 provider 是否已剥离，最终外发前再剥一次内联工具调用标记（<tool_calls><invoke…>），
      // 杜绝任何模型/通道把控制文本当正文发出（provider 层已解析，这里防 fallback/自定义 provider 漏网）
      const body = stripInlineToolCalls(cfg.redactSecrets === false ? (content || '') : maybeRedact(content || '')).replace(/\s+$/, '')
      // 收尾流式：发完剩余增量并等待发送队列结算（完成屏障）。只有全部分片确认送达、且流式全文
      // 与最终正文一致，才算"已投递"从而跳过整段最终回复；存在失败/未决/缺片一律不算成功。
      const streamState = await streamer.finish()
      const streamedFinal = streamer.enabled && streamState.sentAny && streamer.rawFull === (content || '')
      // 缺片恢复：部分分片已送达且流式全文等于正文 → 只补发未送达的尾部（避免成功部分重复）；
      // 全部失败或正文与流式不一致 → 走下方整段发送。超时等未知状态按失败处理（不冒充成功），
      // 也不无条件重发全部（已有确认送达的前缀不重发）。
      let streamRecovery = null
      if (streamer.enabled && !streamedFinal && streamState.deliveredEnd > 0 && streamer.rawFull === (content || '')) {
        const rest = String(content || '').slice(streamState.deliveredEnd)
        if (rest.trim()) streamRecovery = rest
      }
      devLog('stream', { enabled: streamer.enabled, deltaEvents: __deltaEvents, deltaChars: __deltaChars, reasoningChars: __reasonChars, streamedFinal, deliveredEnd: streamState.deliveredEnd, recovery: !!streamRecovery }, traceId, ctx.devScope)
      // 异常停止必须以可见标记落到回复上：否则预算耗尽 / 空转 / 连续失败与普通回复外形完全一致
      // （用户以为任务正常完成）。文案复用 Agent 的确定性兜底表，保持单一真源。
      const suffix = STOP_REASON_CN[stopReason] ? `（${STOP_REASON_CN[stopReason]}）` : ''
      // 表情包：本轮一次性门控（决定带哪些图 + 记冷却/防连发/usage），图片/文本模式共用结果，避免双计。
      // force 场景：① 用户明确索要表情包；② 整条回复只有表情标记（剥除后为空）——否则被频率闸
      // 挡下会变成一条空白消息（曾把 [sticker:x] 剥掉后什么都不剩）。这两种都必须真的发出表情。
      const explicitSticker = /表情包|表情|斗图|贴个表情|发个表情|来个表情|sticker/i.test(text || '')
      const forceSticker = explicitSticker || isStickerOnly(body)
      const acceptMap = (rt.sticker && body) ? rt.sticker.decide(body, ctx, { force: forceSticker }) : null
      // 群聊回复引用触发消息（agent.reply.quote，默认开；私聊不引用）：人多时靠引用定位回复对象，
      // @ 仍由 atSender 独立控制，二者可同时生效。只作用于最终正文/图片，不引用进度与旁白。
      const quoteReply = ctx.isGroup && cfg.reply?.quote !== false
      // 群聊回复艾特发言人（agent.reply.atSender，默认开；私聊不艾特）
      // 频道（guild）不支持普通 at 段，跳过；官方群聊把 at 折进 markdown 内容（适配器转换）
      const atSender = (ctx.isGroup && cfg.reply?.atSender !== false && ctx.userId && qqInfo.kind !== 'guild' && typeof segment !== 'undefined' && typeof segment.at === 'function') ? segment.at(ctx.userId) : null
      // 回复渲染：默认文本；可选图片（markdown→图片，失败退文本）；replyMode 已在上方 run 前计算
      // 发送经受控队列；delivered 依据队列 outcome（适配器返回值/retcode/rejection），不再"执行过 await 即成功"。
      let delivered = streamedFinal // 流式已逐字送达 → 不再重复发整段正文
      let finalOutcome = null
      let mdHandled = false // markdown 分支已自行处理（成功或已降级），不再走下方通用文本兜底
      devLog('send_start', { mode: replyMode, replyLen: (body || '').length, stopReason, turns, streamed: streamedFinal }, traceId, ctx.devScope)
      if (replyMode === 'markdown' && body) {
        // QQ 官方机器人 markdown 直发：按上限分片（长回答不留半截），首片带 @/引用。
        // 失败兜底：适配器返回 error 且无 message_id（平台拒绝 markdown / 模板未申请）→ 转纯文本重发一次。
        mdHandled = true
        try {
          // 剥表情包标记（与文本模式同源）；否则 [sticker:x] 字面量会进 markdown 正文
          let mdBody = body
          try { mdBody = stripMarkers(rt.sticker ? rt.sticker.applyText(body, new Map()) : body) } catch { mdBody = stripMarkers(body) }
          const chunks = splitMarkdown(mdBody, Number(mdCfg.maxChars) || undefined)
          // 异常停止原因并入最后一片（markdown 模式不单独补发，避免多一条消息）
          if (suffix && chunks.length) chunks[chunks.length - 1] = `${chunks[chunks.length - 1]}\n\n${suffix}`
          let mdOk = chunks.length > 0
          for (let i = 0; i < chunks.length && mdOk; i++) {
            const msg = buildMarkdownMessage(this.e, chunks[i], {
              atSender: i === 0 ? atSender : null,
              ownerId: ctx.userId,
            })
            if (!msg) { mdOk = false; break }
            const out = await replyQueue.enqueue({ msg, quote: i === 0 ? quoteReply : false }, { tag: 'final' })
            if (!out.ok || apiRejected(out.ret)) { mdOk = false; break }
            // 分片间让适配器串行队列自然排队；最终 outcome 取最后一片（失败时整体按失败处理）
            finalOutcome = { ok: true, markdown: true, chunks: chunks.length, ret: out.ret }
          }
          if (mdOk) {
            delivered = true
          } else {
            // markdown 被拒 → 纯文本降级（保留可读性：剥掉 md 标记）
            Log.warn('[qqofficial] markdown 发送失败，降级纯文本', JSON.stringify(finalOutcome?.ret || {}).slice(0, 300))
            const plain = `${markdownToPlain(body)}${suffix ? `\n${suffix}` : ''}`
            finalOutcome = await replyQueue.enqueue({ msg: atSender ? [atSender, plain] : plain, quote: quoteReply }, { tag: 'final' })
            delivered = !!finalOutcome.ok && !apiRejected(finalOutcome.ret)
          }
          // 表情包：官方 markdown 模式下作为独立图片消息追加（适配器会转 markdown 图片；失败忽略）
          if (delivered && acceptMap && acceptMap.size && typeof segment !== 'undefined' && typeof segment.image === 'function') {
            for (const abs of acceptMap.values()) {
              const st = await safeReply(segment.image(abs))
              if (!st.ok) Log.warn('[qqofficial] 表情包发送失败（已忽略）', st.error)
            }
            try { rt.sticker?.noteSent?.([...acceptMap.keys()]) } catch { /* noop */ }
          }
          if (delivered && suffix) { /* 已并入最后分片/降级文本，无需另发 */ }
        } catch (e) {
          Log.warn('[qqofficial] markdown 回复失败，回退文本', e?.message || e)
          mdHandled = false // 让下方通用文本兜底接管
        }
      } else if (replyMode === 'image' && body) {
        try {
          // 拆 sticker：正文始终剥除标记（未通过的也剥，防 [sticker:x] 字面量漏进图片——
          // 文本模式本就如此；此前图片模式仅在 acceptMap 非空时才剥，被频率闸挡下时标记会漏进图里）；
          // 通过门控的图独立成气泡（stickerImgs）
          let stickerImgs = []
          let cleanBody = stripMarkers(body)
          if (rt.sticker) {
            try {
              cleanBody = stripMarkers(rt.sticker.applyImage(body, new Map())).replace(/[\s\n]+$/, '')
              if (acceptMap && acceptMap.size) {
                // acceptMap 的 value 是图片绝对路径字符串；_imgDataUri 读文件转 data URI
                stickerImgs = [...acceptMap.values()].map((abs) => rt.sticker._imgDataUri(abs)).filter(Boolean)
              }
            } catch { cleanBody = stripMarkers(body) }
          }
          const img = await renderReplyImage(cleanBody, {
          footer: `会话 ${ctx.conversationShortId || `#${ctx.conversationId}`} · 对话 ${traceId.slice(0, 8)}`,
          extraCss: REPLY_CSS,
          chat: {
            userText: text,
            userName: this.e.sender?.card || this.e.sender?.nickname || ctx.userId,
            userAvatar: `https://q1.qlogo.cn/g?b=qq&nk=${ctx.userId}&s=100`,
            aiName: (typeof Bot !== 'undefined' && (Bot.nickname || Bot.name)) || 'AI',
            aiAvatar: `https://q1.qlogo.cn/g?b=qq&nk=${(typeof Bot !== 'undefined' && (Bot.uin || Bot.uins?.[0])) || this.e.self_id || ''}&s=100`,
            groupName: ctx.isGroup ? (this.e.group_name || this.e.groupInfo?.group_name || '') : '',
            groupId: ctx.groupId || '',
            model: cfg.model || '',
            inputTokens: usage?.input ?? usage?.raw?.prompt_tokens ?? usage?.prompt_tokens ?? 0,
            outputTokens: usage?.output ?? usage?.raw?.completion_tokens ?? usage?.completion_tokens ?? 0,
            tokens: usage?.total_tokens ?? usage?.total ?? (usage ? ((usage.prompt_tokens ?? usage.input_tokens ?? usage.input ?? 0) + (usage.completion_tokens ?? usage.output_tokens ?? usage.output ?? 0)) : null),
            reasoningTokens: usage?.completion_tokens_details?.reasoning_tokens ?? usage?.reasoning_tokens ?? usage?.raw?.completion_tokens_details?.reasoning_tokens ?? usage?.raw?.reasoning_tokens ?? 0,
            stickerImgs,
          },
        })
          if (img) {
            finalOutcome = await replyQueue.enqueue({ msg: atSender ? [atSender, img] : img, quote: quoteReply }, { tag: 'final' })
            delivered = !!finalOutcome.ok
            // 多样性硬闸在图片模式同样要推进（曾只在文本模式 noteSent → recent-3 去重在图片模式回复下永不更新，防线失效）
            try { if (delivered && acceptMap?.size) rt.sticker?.noteSent?.([...acceptMap.keys()]) } catch { /* noop */ }
            // 图片模式下链接单独发（图内无法复制）：单链接文本直发；多链接打包一条合并转发防刷屏
            const __links = [...new Set((body.match(/https?:\/\/[^\s<>"')]+/g) || []).map((s) => s.replace(/[.,;:!?)]+$/, '')))]
            if (__links.length === 1) {
              await safeReply(__links[0])
            } else if (__links.length > 1) {
              // 多链接 → 合并转发卡片（Yunzai makeForwardMsg：e.group/friend/Bot.makeForwardMsg([{message},...]) → forward segment → reply）
              try {
                const fwdMsg = __links.map((u) => ({ message: u }))
                let fwd = null
                if (this.e.isGroup && this.e.group?.makeForwardMsg) fwd = await this.e.group.makeForwardMsg(fwdMsg)
                else if (this.e.friend?.makeForwardMsg) fwd = await this.e.friend.makeForwardMsg(fwdMsg)
                else if (typeof Bot !== 'undefined' && Bot.makeForwardMsg) fwd = await Bot.makeForwardMsg(fwdMsg)
                if (fwd) await safeReply(fwd)
                else throw new Error('forward unavailable')
              } catch {
                // 适配器不支持合并转发 → 降级一条文本
                await safeReply(__links.join('\n'))
              }
            }
          }
        } catch (e) { Log.warn('[render] 回复图片渲染失败，回退文本', e?.message || e) }
      }
      if (!delivered && !mdHandled) {
        // 文本模式（或图片渲染失败）：正文先发（剥除所有表情包标记，不在正文内联）；
        // 表情包作为主内容之后的【独立消息】依次发送（不与文字混排在同一条）。
        // 安全网：无论 acceptMap 是否存在，都再 stripMarkers 一次（半/全角变体、超长名、门控异常），
        // 保证任何情况下都不把字面 [sticker:x] 漏给用户。
        // 缺片恢复：仅补发未确认送达的尾部（正文身份与流式一致时）；否则按整段正文发送
        const strippedRaw = streamRecovery != null
          ? stripMarkers(maybeRedact(streamRecovery))
          : (acceptMap ? rt.sticker.applyText(body, new Map()) : (body || ''))
        let cleanBody = stripMarkers(String(strippedRaw)).replace(/[\s\n]+$/, '')
        if (!cleanBody && !(acceptMap && acceptMap.size)) cleanBody = '(无回复)'
        const txt = `${cleanBody}${suffix ? `\n${suffix}` : ''}`
        finalOutcome = await replyQueue.enqueue({ msg: atSender ? [atSender, txt] : txt, quote: quoteReply }, { tag: 'final' })
        delivered = !!finalOutcome.ok
        if (!delivered) Log.warn('[render] 文本回复发送失败', finalOutcome.error)
        // 表情包：主内容发完后，作为独立消息依次发送
        if (delivered && acceptMap && acceptMap.size && typeof segment !== 'undefined') {
          for (const abs of acceptMap.values()) {
            const st = await safeReply(segment.image(abs))
            if (!st.ok) Log.warn('[render] 表情包单独发送失败', st.error)
          }
          rt.sticker?.noteSent?.([...acceptMap.keys()])
        }
      } else if (suffix && !mdHandled) {
        await safeReply(suffix) // 图片已发，异常停止提示另发一条附注
      }
      // diagram 示意图：最终回复送达后发送（文本/图片两种回复模式都覆盖；取消路径不会执行到此处）
      await sendPendingDiagrams()
      // QQ 官方机器人 keyboard 卡片：send_keyboard 工具排队的卡片在最终回复后投递（顺序稳定）
      if (Array.isArray(ctx.pendingCards) && ctx.pendingCards.length) {
        try {
          await flushPendingCards({ ctx, send: (msg, quote) => safeReply(msg, quote), logger: Log.tag('qqofficial') })
        } catch (e) { Log.warn('[qqofficial] 卡片投递失败', e?.message || e) }
      }
      // —— 用量统计（KV 日聚合，Web 端 overview 趋势主数据源）：对话完成即记（含 reply_failed；
      //    run_error/cancelled 在外层 catch 记 errors）。normalizeUsage 跨协议归一 ——
      try {
        const nu = normalizeUsage(usage) || {}
        rt.usageStats?.recordRun({
          inputTokens: nu.input || 0, outputTokens: nu.output || 0,
          cacheRead: nu.cacheRead || 0, cacheWrite: nu.cacheWrite || 0, cacheObserved: !!nu.cacheObserved,
          // 观测口径（只含报告了缓存字段的轮）：Web 端命中率的分母与成本口径都基于它，
          // 不能退回全量 input——未观测轮会被当 0 命中稀释命中率
          observedInput: nu.observedInput || 0, observedOutput: nu.observedOutput || 0, observedUncached: nu.observedUncached || 0,
          turns, model: cfg.model || '',
        })
      } catch { /* 统计失败不阻塞回复 */ }
      // —— 终态（P1）：reply_sent / reply_failed 必居其一；失败不伪装为正常结束 ——
      if (delivered) {
        const ret = finalOutcome?.ret
        terminal('reply_sent', {
          mode: replyMode, stopReason, turns, replyLen: (body || '').length,
          msgRet: ret == null ? null : (typeof ret === 'object' ? { retcode: ret.retcode ?? null } : String(ret).slice(0, 40)),
        })
      } else {
        Log.error('[chat] 最终回复发送失败', finalOutcome?.error || 'unknown')
        terminal('reply_failed', { mode: replyMode, stopReason, turns, replyLen: (body || '').length, error: finalOutcome?.error || 'send rejected' })
        await safeReply('⚠️ 回复已生成但发送失败，请稍后重发消息触发重试。') // best-effort 降级提示（不改变 reply_failed 终态）
      }
      // F07：投递结果入账（execution 完成 ≠ 已送达）；QQ 超时等未知状态记 unknown
      try {
        if (rt.taskStore && traceId) {
          const status = delivered ? 'sent' : (finalOutcome?.unknown ? 'unknown' : 'failed')
          await rt.taskStore.recordDelivery(traceId, { status, mode: replyMode, detail: delivered ? null : (finalOutcome?.error || 'send rejected') })
        }
      } catch { /* 投递记录失败不影响回复 */ }
      // 记录群内最近活跃时间，供 perception 判断"久未发言补课"
      if (ctx.isGroup && ctx.groupId && rt.kv) {
        rt.kv.set(`perception:last_active:${ctx.groupId}`, { at: Date.now() }).catch(() => {})
      }
      devLog('reply', { mode: replyMode, delivered, replyLen: (body || '').length, body: body || '', turns, stopReason }, traceId, ctx.devScope)
      // ── 自动 TTS（agent.tts.autoReply，默认开）：最终回复送达后追加语音 ——
      // 内容 = LLM 最终回复经 TTS 服务合成入口统一清洗（md/代码/链接/emoji/破折号；maxChars 按句截断）；
      // 文字/图片照常发送，语音是补充，用户选定的形式。
      // fire-and-forget：合成 7~15s，不占用会话 single-flight 队列（否则下一条消息会排队等待）；
      // 多个语音交给 TTS 服务内部串行队列按序生成。跳过：未送达 / 本轮已用 tts_speak 点播（防重复语音）/
      // 清洗后无内容。任何失败只记日志（warn + devLog），不影响已完成的投递终态。
      if (delivered && rt.tts && cfg.tts?.autoReply !== false && String(body || '').trim() && !agentInst?._ranTools?.has('tts_speak')) {
        const messages = Array.isArray(agentInst?.messages) ? agentInst.messages.slice(-8) : []
        void (async () => {
          const started = Date.now()
          try {
            const vr = await rt.tts.synthesize({ text: body, maxChars: Number(cfg.tts?.replyMaxChars ?? 300), context: { messages } })
            const ms = Date.now() - started
            if (!vr.ok) {
              Log.warn('[tts] 回复语音合成失败：', vr.error)
              devLog('tts_reply', { ok: false, error: String(vr.error || '').slice(0, 200), chars: String(body || '').length, ms }, traceId, ctx.devScope)
              return
            }
            if (typeof segment === 'undefined' || typeof segment.record !== 'function') {
              Log.warn('[tts] 语音已生成但当前适配器不支持语音消息（segment.record 不可用）')
              return
            }
            const vout = await safeReply(segment.record(vr.file))
            devLog('tts_reply', {
              ok: !!vout.ok, sent: !!vout.ok, voice: vr.voice, mode: vr.mode, tier: vr.tier,
              chars: vr.chars || 0, ms, error: vout.ok ? null : (vout.error || 'send rejected'),
            }, traceId, ctx.devScope)
            if (!vout.ok) Log.warn('[tts] 回复语音发送失败：', vout.error)
          } catch (e) {
            Log.warn('[tts] 自动语音异常（不影响回复）', e?.message || e)
          }
        })()
      }
      })
      // run 正常结束：标记本轮结束，未被 check_subagent 消费的子代理终态结果异步回推
      try { rt.multiagent?.endRun?.(ctx) } catch { /* noop */ }
    } catch (e) {
      // 用量统计：错误终态（cancelled/run_error）也计数（errors 维度；无 usage 可记）
      try { rt.usageStats?.recordRun({ error: true }) } catch { /* noop */ }
      if (/aborted/i.test(String(e?.message || e))) {
        // 用户主动取消：不再发送过期结果（P0-4）
        Log.warn('[chat] 任务已取消', traceId)
        terminal('cancelled', { error: String(e?.message || e) })
        return true
      }
      Log.error('[chat] agent 失败', e?.message || e)
      terminal('run_error', { error: e?.message || String(e), stack: e?.stack || null, input: (text || '').slice(0, 200), model: cfg.model, turns: 'unknown' })
      // run 已结束（异常路径）：标记子代理任务结算，未消费结果稍后异步回推
      try { rt.multiagent?.endRun?.(ctx) } catch { /* noop */ }
      await safeReply(maybeRedact([
        `⚠️ 处理时出错：${e?.message || e}`,
        '如反复出错，请发送 #上报错误 <问题描述> 上报（自动打包会话日志给开发者）；',
        '或加入官方 QQ 群 960179589 @群主 并附上日志反馈。',
      ].join('\n')))
    }
    return true
  }
,


  // —— 多对话 ——
  async chatList() {
    const rt = await getRuntime()
    const ctx = ctxOf(this.e)
    const list = await rt.session.listConversations(ctx.scopeUserId, ctx.groupId)
    const activeId = await rt.session.getActiveConversation(ctx.scopeUserId, ctx.groupId)
    const activeShortId = list.find((c) => String(c.id) === String(activeId))?.shortId || activeId
    const html = buildChatListHtml({ user: ctx.userId, conversations: list, activeId: activeShortId })
    // render.card=false：弱服务器直接走文本回退（此前只有 #帮助 尊重该开关，列表仍会截图，配置互搏审计 F26）
    const img = Config.get().agent?.render?.card === false ? null : await screenshot('agents-plugin/chat-list', html)
    if (img) return this.e.reply(img), true
    const isActive = (c) => String(c.id) === String(activeId) || String(c.shortId || c.id) === String(activeId)
    const lines = list.map((c) => `#${c.shortId || c.id} ${c.title}（${c.count}条）${isActive(c) ? ' [当前]' : ''}`)
    await this.e.reply(['聊天列表', ...lines].join('\n'))
    return true
  }
,


  async enterChat() {
    const input = this.e.msg.match(/^#进入聊天\s*([0-9a-zA-Z]+)/)?.[1]
    const rt = await getRuntime()
    const ctx = ctxOf(this.e)
    const ref = input
      ? await rt.session.resolveConversationRef(input, { userId: ctx.scopeUserId, groupId: ctx.groupId }).catch(() => null)
      : null
    const id = ref?.id || input
    const ok = id ? await rt.session.setActiveConversation(ctx.scopeUserId, ctx.groupId, id) : false
    const label = ref?.shortId || input || ''
    await this.e.reply(ok ? `已切换到会话 #${label}` : `未找到会话 #${label || ''}，发送 #聊天列表 查看`)
    return true
  }
,


  async newChat() {
    const rt = await getRuntime()
    const ctx = ctxOf(this.e)
    const conv = await rt.session.createConversation(ctx.scopeUserId, ctx.groupId)
    await this.e.reply(`已新建会话 #${conv.shortId || conv.id}（${conv.title}），后续消息在此会话中继续`)
    return true
  }

}
