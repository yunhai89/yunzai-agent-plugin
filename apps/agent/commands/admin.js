/**
 * 管理/运维命令：模型切换、沙箱诊断、抓取环境、重载、官方 ID、错误上报、审批（原 apps/agent.js）。
 */
import fs from 'node:fs'
import path from 'node:path'
import Config from '../../../utils/Config.js'
import Log from '../../../utils/Log.js'
import { toFileSegment } from '../../../utils/SendFile.js'
import { describeContext as describeQQContext } from '../../../model/qqofficial/index.js'
import { isEventMaster } from '../../../model/qqofficial/guard.js'
import { diagnoseSandbox, egressPlan, formatPlan, formatReport } from '../../../model/sandbox/net-diag.js'
import { getCrawlSetupStatus, startCrawl4aiInstall, attachCrawlInstallFinish, formatCrawlSetupStatus, formatCrawlInstallResult } from '../../../model/crawl/setup.js'
import { getRuntime, invalidateRuntime } from '../runtime.js'
import { ctxOf, isCtxMaster, sendByInfo } from '../context.js'

export const adminCommands = {

  // #openrouter余额：查 OpenRouter key 额度/用量（master；需 agent.apiKey 为 OpenRouter key）
  async openrouterBalance() {
    const cfg = Config.get().agent || {}
    if (!cfg.apiKey) { await this.e.reply('未配置 agent.apiKey'); return true }
    await this.e.reply('🔄 查询 OpenRouter key 余额…')
    try {
      const r = await fetch('https://openrouter.ai/api/v1/key', { headers: { Authorization: `Bearer ${cfg.apiKey}` }, signal: AbortSignal.timeout(15000) })
      if (!r.ok) {
        const t = await r.text().catch(() => '')
        await this.e.reply(`❌ 查询失败（HTTP ${r.status}）${t ? '：' + t.slice(0, 100) : ''}\n（确认 agent.preset=openrouter 且 apiKey 为 OpenRouter key）`)
        return true
      }
      const d = (await r.json())?.data || {}
      const money = (v) => (v == null ? '∞（无限制）' : `$${Number(v).toFixed(4)}`)
      await this.e.reply([
        '🔑 OpenRouter Key 余额',
        `额度上限：${money(d.limit)}`,
        `剩余额度：${money(d.limit_remaining)}`,
        `已用（总计）：${money(d.usage)}`,
        `已用（今日）：${money(d.usage_daily)}`,
        `已用（本月）：${money(d.usage_monthly)}`,
        `免费层：${d.is_free_tier ? '是' : '否（付费层）'}`,
      ].join('\n'))
    } catch (e) { await this.e.reply('❌ 查询失败：' + (e?.message || e)) }
    return true
  }
,


  async reportBug() {
    const desc = this.e.msg?.match(/^#上报错误(?:\s+)?([\s\S]+)?$/)?.[1]?.trim() || ''
    let rt
    try { rt = await getRuntime() } catch (e) { await this.e.reply(String(e?.message || e)); return true }
    const ctx = ctxOf(this.e)
    const masters = Config.get().agent?.masters || []
    if (!masters.length) { await this.e.reply('⚠️ 未配置 agent.masters，无人接收上报。'); return true }
    // 最近 10 个会话（listConversations 默认按 id 升序，这里按 updatedAt 降序取最近）
    const list = (await rt.session.listConversations(ctx.scopeUserId, ctx.groupId))
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, 10)
    const c = Config.get().agent?.devLog
    const devDir = c?.dir ? path.resolve(c.dir) : Config.path.logs
    const gid = ctx.groupId || 'private', uid = ctx.scopeUserId
    const collected = []
    for (const conv of list) {
      const prefix = `${gid}-${uid}-${conv.id}-`
      let files = []
      try { files = fs.readdirSync(devDir).filter((f) => f.startsWith(prefix) && f.endsWith('.log')) } catch { /* noop */ }
      for (const f of files) collected.push({ conv, file: f })
    }
    if (!collected.length) { await this.e.reply('未找到你的会话日志（可能尚未触发过 AI 或日志已关闭）。'); return true }
    // 合并成单个 .log 文本（零新依赖，必成功）；每段前加分隔头便于主人定位
    const ts = new Date()
    const p2 = (n) => String(n).padStart(2, '0')
    const stamp = `${ts.getFullYear()}${p2(ts.getMonth() + 1)}${p2(ts.getDate())}-${p2(ts.getHours())}${p2(ts.getMinutes())}`
    const bundlePath = path.join(Config.path.temp, `agents-bug-${uid}-${stamp}.log`)
    let header = `# agents-plugin 错误上报\n# 用户：${ctx.userId}（群：${ctx.groupId || '私聊'}）\n# 描述：${desc || '(无)'}\n# 时间：${ts.toLocaleString('zh-CN')}\n# 会话数：${collected.length}\n`
    let body = ''
    for (const { conv, file } of collected) {
      body += `\n===== 会话 ${conv.shortId || `#${conv.id}`} ${conv.title || ''} | createdAt ${conv.createdAt} | updatedAt ${conv.updatedAt} | file ${file} =====\n`
      try { body += fs.readFileSync(path.join(devDir, file), 'utf8') } catch (e) { body += `(读取失败: ${e?.message})\n` }
    }
    try { fs.mkdirSync(Config.path.temp, { recursive: true }); fs.writeFileSync(bundlePath, header + body) }
    catch (e) { await this.e.reply(`打包失败：${e?.message || e}`); return true }
    // 发主人私信。关键：`bot?.pickFriend?.(mid)?.sendMsg` 在 bot/pickFriend 不可用时是静默 no-op，
    // 既不抛错也不计入 okCnt —— 此前会"上报成功 0/N"却无任何日志。这里显式判定每一步并落错误日志。
    const bot = (typeof Bot !== 'undefined' && Bot) || null
    const errors = []      // 致命失败（该 master 连文本都没送达）
    const fileFails = []   // 非致命：文本已送达，仅日志文件发送失败
    let okCnt = 0
    const textMsg = `🐛 用户上报错误\n用户：${ctx.userId}（群：${ctx.groupId || '私聊'}）\n描述：${desc || '(无)'}\n会话数：${collected.length}\n时间：${ts.toLocaleString('zh-CN')}`
    if (!bot) {
      errors.push('Bot 未就绪（协议端未连接）')
      Log.error('[reportBug] 发送失败：globalThis.Bot 为空，无法私信 master')
    }
    for (const rawMid of masters) {
      // masters 条目在不同环境可能是数字/字符串/带空白的字符串——统一 String 归一，避免下游对非字符串 .trim() 抛错
      const mid = String(rawMid ?? '').trim()
      if (!mid) { errors.push('存在空的 master 条目'); continue }
      let friend
      try {
        friend = bot?.pickFriend?.(mid)
      } catch (e) {
        errors.push(`${mid}：pickFriend 异常（${e?.message || e}）`)
        Log.error(`[reportBug] 获取 master ${mid} 会话异常：${e?.message || e}`)
        continue
      }
      if (!friend || typeof friend.sendMsg !== 'function') {
        errors.push(`${mid}：无法获取好友会话（pickFriend 不可用或该 QQ 非好友）`)
        Log.error(`[reportBug] 发送失败：无法获取 master ${mid} 的好友会话（pickFriend 不可用）`)
        continue
      }
      // ① 先发文本（关键信息）：失败即该 master 整体失败
      try {
        await friend.sendMsg(textMsg)
      } catch (e) {
        errors.push(`${mid}：文本发送失败（${e?.message || e}）`)
        Log.error(`[reportBug] 发送 master ${mid} 文本失败：${e?.message || e}`)
        continue
      }
      // ② 再发日志文件：失败不致命（文本已送达），单独记录，不吞、不阻断其它 master
      try {
        await friend.sendMsg(toFileSegment(bundlePath, `上报日志-${uid}-${stamp}.log`))
      } catch (e) {
        fileFails.push(`${mid}：${e?.message || e}`)
        Log.error(`[reportBug] 发送 master ${mid} 日志文件失败（文本已送达）：${e?.message || e}`)
      }
      okCnt++
    }
    const lines = []
    if (okCnt > 0) {
      lines.push(`✅ 已上报给 ${okCnt}/${masters.length} 位 master（含最近 ${collected.length} 个会话日志）`)
      if (errors.length) lines.push(`⚠️ 另有 ${errors.length} 位 master 发送失败：${errors.slice(0, 3).join('；')}`)
      if (fileFails.length) lines.push(`⚠️ ${fileFails.length} 位 master 日志文件未送达（文本已送达）：${fileFails.slice(0, 3).join('；')}`)
    } else {
      lines.push(`❌ 上报失败：未能发送给任何 master（${errors[0] || '未知原因'}）`)
      lines.push('失败原因已打印到控制台日志，请联系管理员检查 agent.masters 配置与协议端连接后重试。')
    }
    lines.push('如需进一步帮助：加入官方 QQ 群 960179589 @群主，并附上本次上报的问题描述/日志。')
    // 群聊反馈本身也可能失败：显式 catch 并落日志，不静默
    try { await this.e.reply(lines.join('\n')) } catch (e) { Log.error('[reportBug] 群聊反馈发送失败', e?.message || e) }
    return true
  }
,


  // —— 命令优先级兜底 ——
  /**
   * accept 在所有插件规则之前执行，用来解决 `/uid` 被喵喵/原神插件的 #uid
   * （priority 300，先于本插件 9999）抢先处理的问题：官方机器人下必须由本插件
   * 打印 openid；普通协议则交回喵喵，避免抢它的指令。
   *
   * 官方协议判断不依赖命令前缀（TRSS 默认把行首 `/` 转成 `#`），只认适配器/ID 形态。
   */
  async accept() {
    const msg = String(this.e?.msg || '').trim()
    if (!/^[#/]\s*uid\s*$/i.test(msg)) return
    let official = false
    try { official = !!describeQQContext(this.e).official } catch { /* 取不到上下文时不拦，交给普通规则 */ }
    if (!official) return
    await this.showUid()
    return 'return'
  }
,


  // —— QQ 官方机器人：ID / 上下文诊断 ——
  /**
   * /uid 返回发言人 ID（含完整与去前缀两种形态），用于 agent.masters、群白名单等配置。
   * 官方机器人下 user_id 不是 QQ 号，按 QQ 号配置会静默不生效（权限/白名单全部落空）。
   */
  async showUid() {
    const info = describeQQContext(this.e)
    const lines = [
      '【发言人 ID】',
      `完整 user_id：${info.fullUserId || '(空)'}`,
      `去前缀：${info.rawUserId || '(空)'}`,
      `适配器：${info.adapterId || info.adapterName || '未知'}${info.official ? '（QQ 官方机器人）' : '（非官方协议）'}`,
      `上下文：${info.contextLabel}`,
      `是否主人：${isCtxMaster(this.e, Config.get().agent || {}) ? '是' : '否'}`,
      `scopeId：${info.scopeId}`,
      '',
      '配置位置：',
      '· agent.masters（主人/审批通知，每行一个）：官方机器人请填上面的「完整 user_id」或「去前缀」值（Web 配置中心「主人列表」可直接粘贴）',
      '· 群白名单（如 agent.groupWorld.groups）：请用 /groupid 给出的值',
    ]
    return this.e.reply(lines.join('\n'))
  }
,


  /** /groupid 返回当前群聊 ID（官方机器人下是 openid；频道会拆 guild/channel） */
  async showGroupId() {
    const info = describeQQContext(this.e)
    if (!info.isGroup) {
      return this.e.reply([
        '【当前会话 ID】',
        `这是${info.contextLabel}，没有群聊 ID。`,
        `完整 user_id：${info.fullUserId || '(空)'}`,
        `scopeId：${info.scopeId}`,
        '（私聊会话按用户隔离；如需群信息请在群里发 /groupid）',
      ].join('\n'))
    }
    const lines = [
      '【群聊 ID】',
      `完整 group_id：${info.fullGroupId || '(空)'}`,
      `去前缀：${info.rawGroupId || '(空)'}`,
      `适配器：${info.adapterId || info.adapterName || '未知'}${info.official ? '（QQ 官方机器人）' : '（非官方协议）'}`,
      `上下文：${info.contextLabel}`,
    ]
    if (info.guildId) {
      lines.push(`频道 guild_id：${info.guildId}`, `子频道 channel_id：${info.channelId}`)
    }
    lines.push('', '配置位置：')
    lines.push('· 群白名单（agent.groupWorld.groups / humanize.groups / sticker.discoverGroups 等）：填上面的「完整 group_id」或「去前缀」值')
    lines.push('· 官方机器人的群号不是 QQ 群号，直接用 QQ 群号填白名单不会命中')
    return this.e.reply(lines.join('\n'))
  }
,


  // —— 模型切换 ——
  async switchModel() {
    const id = this.e.msg.replace(/^#模型切换\s+/, '').trim()
    if (!id) { await this.e.reply('用法：#模型切换 <模型名>'); return true }
    const rt = await getRuntime()
    try {
      const c = Config.get()
      if (!c.agent) c.agent = {}
      // 引用制（配置了 agent.providerId + llmProviders/llmModels）下，单一真源是 agent.modelId：
      // 只写镜像字段 agent.model 会在 Config.save() → syncBaseModel 时被按当前条目回填覆盖，
      // 表现为「回复已切换、重载/重启后回退」（复核 #25/#26）。故按模型名反查条目并改引用。
      if (c.agent.providerId) {
        const models = Array.isArray(c.agent.llmModels) ? c.agent.llmModels : []
        const hit = models.find((m) => m && m.model === id && m.providerId === c.agent.providerId)
          || models.find((m) => m && m.model === id)
        if (!hit) {
          const names = [...new Set(models.map((m) => m?.model).filter(Boolean))]
          await this.e.reply(`❌ 未找到模型：${id}\n当前「厂商/模型列表」可用模型名：${names.length ? names.join('、') : '（空，请先在面板添加）'}\n如需指定列表之外的任意模型名，请先清空 agent.providerId（改用扁平配置）。`)
          return true
        }
        c.agent.modelId = hit.id
        if (hit.providerId && hit.providerId !== c.agent.providerId) c.agent.providerId = hit.providerId
      } else {
        c.agent.model = id
      }
      rt.agentConfig.model = id // 立即生效（与落盘同一对象；引用制下 save 会同步镜像字段）
      Config.save()
    } catch (e) {
      Log.warn('模型切换持久化失败', e?.message || e)
      await this.e.reply(`⚠ 已临时切换模型：${id}，但写入配置失败（${e?.message || e}），重启后会回退`)
      return true
    }
    await this.e.reply(`已切换模型：${id}`)
    return true
  }
,


  // —— 沙箱出口网络诊断（master）——
  // 「沙箱连不上网/DNS 也不通」有四种成因：配置关/收窄了出口、旧语义遗留的 denyOut 全拒、
  // 跑在有意断网的验证/进化档位、自托管没做 NAT。前两类静态可判，后两类必须看沙箱内实测。
  async sandboxDiag() {
    const cfg = Config.get().agent || {}
    const sb = cfg.sandbox || {}
    const arg = String(this.e.msg.match(/^#沙箱诊断(?:\s+(\S+))?$/)?.[1] || '').trim()
    if (arg === '修复' || arg === 'fix') {
      const plan = egressPlan(sb)
      if (!plan.legacy) { await this.e.reply(`✅ 当前出口配置没有需要迁移的旧值。\n\n${formatPlan(plan, { cfg: sb })}`); return true }
      sb.network = { ...(sb.network || {}), denyOut: [] }
      try { Config.save() } catch (e) { await this.e.reply(`⚠️ 已就地清除（本次会话生效）但写盘失败：${e?.message || e}`); return true }
      await this.e.reply(`✅ 已清除旧语义的全拒出口项 denyOut:["${plan.legacy.from}"] 并写回 config.yaml。\n\n${formatPlan(egressPlan(sb), { cfg: sb })}`)
      return true
    }
    if (arg === '预览' || arg === 'plan') { await this.e.reply(formatPlan(egressPlan(sb), { cfg: sb })); return true }
    if (arg && arg !== '实测') { await this.e.reply('用法：#沙箱诊断（沙箱内实测）· #沙箱诊断 预览（只看配置实际下发什么）· #沙箱诊断 修复（清理旧语义的全拒项并写回）'); return true }
    const rt = await getRuntime()
    await this.e.reply('🔎 正在沙箱内实测出口网络（最长约 60 秒）…')
    try {
      const report = await diagnoseSandbox({
        manager: rt?.sandbox?.manager,
        key: `net-diag:${String(this.e.user_id || 'master')}`,
        cfg: sb,
        mode: sb.mode,
        selfHosted: !!(sb.apiUrl || sb.domain),
        logger: Log.tag('sandbox'),
      })
      await this.e.reply(formatReport(report, { cfg: sb }))
    } catch (e) {
      await this.e.reply(`沙箱诊断失败：${e?.message || e}`)
    }
    return true
  }
,


  // —— 网页抓取环境（crawl4ai + Chromium，master）——
  async crawlSetup() {
    const arg = String(this.e.msg.match(/^#抓取环境(?:\s+(\S+))?$/)?.[1] || '').trim()
    const status = await getCrawlSetupStatus()
    // 安装结束（成功/失败）都推回触发会话：后台任务只写控制台日志时用户看不到结果。
    const notifyResult = (r) => {
      const text = formatCrawlInstallResult(r)
      return Promise.resolve().then(() => this.e.reply(text)).catch(async (err) => {
        Log.warn('[crawl] 安装结果回复失败，按会话信息重发', err?.message || err)
        const target = {
          selfId: String(this.e.self_id || this.e.selfId || ''),
          groupId: this.e.group_id != null ? String(this.e.group_id) : null,
          userId: String(this.e.user_id || this.e.userId || ''),
        }
        try { await sendByInfo(target, text) } catch (e2) {
          Log.warn('[crawl] 安装结果重发失败', e2?.message || e2)
        }
      })
    }
    if (arg === '安装' || arg === '修复') {
      if (status.engine === 'fetch') {
        await this.e.reply('当前抓取引擎是 fetch（纯 HTTP，不需要浏览器）。\n如需抓 SPA/JS 动态页，先把 agent.kb.crawl.engine 改为 crawl4ai。')
        return true
      }
      if (status.execution === 'sandbox') {
        await this.e.reply('当前抓取执行面是 sandbox：crawl4ai 必须预装在 agent.sandbox.template 指向的 E2B 模板内，本机安装不会生效。\n如需宿主浏览器，请把 agent.kb.crawl.execution 改回 local。')
        return true
      }
      if (status.ready) { await this.e.reply('✅ 抓取环境已可用，无需安装。'); return true }
      // 启动自检可能已经在装：先尝试挂到运行中的任务上，装完仍会在这里反馈。
      const attached = attachCrawlInstallFinish(notifyResult)
      if (status.installing) {
        await this.e.reply(attached
          ? '⏳ 抓取环境正在安装中，完成后会在这里通知你。'
          : '⏳ 抓取环境正在安装中（由其他进程启动），完成后请发 #抓取环境 查看结果。')
        return true
      }
      const r = await startCrawl4aiInstall({ mode: 'auto', force: arg === '修复', probeResult: status, onFinish: attached ? null : notifyResult })
      if (r.ready) { await this.e.reply('✅ 抓取环境已可用，无需安装。'); return true }
      if (r.already) {
        await this.e.reply(attached
          ? '⏳ 抓取环境正在安装中，完成后会在这里通知你。'
          : '⏳ 抓取环境正在安装中（由其他进程启动），完成后请发 #抓取环境 查看结果。')
        return true
      }
      if (r.error) { await this.e.reply(`❌ 无法启动安装：${r.error}`); return true }
      await this.e.reply(`⏳ 已开始后台${r.mode === 'browser' ? '补装 Chromium' : '安装 crawl4ai + Chromium'}（约 300-500MB）。\n完成或失败都会在这里推送结果；失败会自动降级纯 HTTP。\n日志：${r.log}`)
      return true
    }
    if (arg && arg !== '状态') {
      await this.e.reply('用法：#抓取环境（查看状态）· #抓取环境 安装（首次安装）· #抓取环境 修复（忽略失败冷却重试）')
      return true
    }
    await this.e.reply(formatCrawlSetupStatus(status))
    return true
  }
,


  // —— 配置热重载（立即重建运行时：provider/model/tools/skills/mcp）——
  async agentsReload() {
    try {
      Config.reload()
      invalidateRuntime()
      await getRuntime()
      await this.e.reply('✅ 已重载配置并重建运行时（model / tools / skills / mcp）')
    } catch (e) {
      Log.error('[reload] 重载失败', e?.message || e)
      await this.e.reply(`重载失败：${e?.message || e}`)
    }
    return true
  }
,


  // —— 审批 ——（框架 ConfirmStore：schedule 等需要二次确认的工具）
  // 注：terminal 已沙箱化、stagehand act 不单独审批，均不走审批（无 #确认 / 无自包含审批队列）。
  async approve() {
    const id = this.e.msg.match(/\d+/)?.[0]
    if (!isEventMaster(this.e)) return this.e.reply('无权限：仅主人可审批'), true
    const rt = await getRuntime()
    if (rt.confirm.resolve(id, true)) return this.e.reply(`已批准 #${id}`), true
    await this.e.reply(`未找到待审 #${id}`)
    return true
  }
,


  async reject() {
    const id = this.e.msg.match(/\d+/)?.[0]
    if (!isEventMaster(this.e)) return this.e.reply('无权限：仅主人可审批'), true
    const rt = await getRuntime()
    if (rt.confirm.resolve(id, false)) return this.e.reply(`已拒绝 #${id}`), true
    await this.e.reply(`未找到待审 #${id}`)
    return true
  }
,


  async pending() {
    if (!isEventMaster(this.e)) return this.e.reply('无权限：仅主人可查看'), true
    const rt = await getRuntime()
    const list = rt.confirm.list()
    if (!list.length) return this.e.reply('当前无待审批'), true
    const lines = []
    for (const p of list) lines.push(`#${p.id} ${p.tool} ${JSON.stringify(p.args || {}).slice(0, 80)}`)
    await this.e.reply(lines.join('\n'))
    return true
  }

}
