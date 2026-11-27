/**
 * 事件上下文 / 定时任务上下文 / 工具运行时能力（原 apps/agent.js）。
 * 交互、定时任务、人设补齐、子代理共用同一套身份与沙箱/视觉装配，避免语义漂移。
 */
import { randomUUID } from 'node:crypto'
import Config from '../../utils/Config.js'
import Log from '../../utils/Log.js'
import { ToolRegistry, SHARED_SCOPE_PREFIX, sharedScopeId, isLegacySharedRecord } from '../../model/agent/index.js'
import { stripMarkers } from '../../model/sticker/parser.js'
import { normalizeUsage } from '../../model/agent/messages.js'
import { thinkingLogFields as fmtThinkingLogFields } from '../../model/llm/thinking.js'
import { isCompletionToolAllowed, composePersonaSystemPrompt, groundingText, personaBreakReminder } from '../../model/persona/index.js'
import { detectAdapter as detectQQAdapter, contextKind as qqContextKind, rawUserId as qqRawUserId, rawGroupId as qqRawGroupId, safeScopePart, groupRoleOf } from '../../model/qqofficial/index.js'
import { isEventMaster } from '../../model/qqofficial/guard.js'
import { sessionKeyOf } from '../../model/sandbox/index.js'

export function ownsScheduleRecord(rec, ctx) {
  if (!rec || !ctx) return false
  if (ctx.isMaster) return true
  const owner = String(rec.userId ?? '')
  if (!owner) return false
  const mine = [ctx.userId, ctx.scopeUserId].filter((x) => x != null && x !== '').map(String)
  if (mine.includes(owner)) return true
  // 旧版群共享记录（owner='__group__'，跨群同名）只能按记录自带 groupId 判定：
  // 否则 A 群成员可以取消 B 群的任务（审计 C2 的越权路径之一）。
  return owner === SHARED_SCOPE_PREFIX && isLegacySharedRecord(rec, ctx.groupId)
}

/**
 * 主人判定：优先框架 e.isMaster；QQ 官方机器人下 e.user_id 是 openid（不是 QQ 号），
 * 框架 master 列表通常配的是 QQ 号→ 永远匹配不上，因此额外按 agent.masters 兜底
 * （支持完整 `<self_id>:<openid>` 与去前缀 openid 两种写法；/uid 会打印可直接粘贴的值）。
 * 仅在官方适配器下兜底，避免改变 OneBot 场景 masters 的既有语义（只收审批通知）。
 */
export function isCtxMaster(e, cfg) {
  // 统一走 guard.isEventMaster：官方机器人按 agent.masters（完整/去前缀、大小写不敏感），
  // 其它协议等价 e.isMaster；避免这里与规则级 gate 两套判定口径漂移。
  return isEventMaster(e, cfg)
}

export function ctxOf(e) {
  const cfgNow = Config.get().agent || {}
  const qqAdapter = detectQQAdapter(e)
  const userId = String(e.user_id ?? '')
  const isMaster = isCtxMaster(e, cfgNow)
  // 群角色：OneBot 在 sender.role/member.role，官方适配器可能在 author.member_role/
  // sender.permissions；统一归一，避免官方机器人场景永远被当成 member。
  const role = groupRoleOf(e)
  const groupId = e.group_id ? String(e.group_id) : null
  const isGroup = !!e.isGroup
  // —— 数据隔离 scope 身份 ——
  // isolation=true（默认）: 每(群,用户)独立；false: 同群共享（群体型 bot）；跨群始终隔离；私聊始终按用户。
  // userId=真实用户(个人功能/get_chat_history 自过滤/回复@)；scopeUserId=session/recall 键；scopeId=MemoryStore 文件目录。
  // QQ 官方机器人的 ID 是 `<self_id>:<openid>` / `qg_<...>`，scopeId 会被当目录名：
  // 这里统一经 safeScopePart（数字 ID 原样=旧目录兼容，官方 ID 净化+短哈希=Windows 也安全）。
  const isolation = cfgNow.isolation?.enable !== false
  const sharedGroup = !!(isGroup && groupId && !isolation)
  const scopeUserId = sharedGroup ? sharedScopeId(groupId) : userId
  const scopeId = !isGroup
    ? `u_${safeScopePart(userId)}`
    : (isolation ? `g${safeScopePart(groupId)}_u${safeScopePart(userId)}` : `g${safeScopePart(groupId)}`)
  return {
    // QQ 官方机器人（QQBot/QQGuild 适配器）：markdown/keyboard 能力、ID 形态与 OneBot 不同
    official: qqAdapter.official,
    adapterKind: qqAdapter.kind,
    adapterId: qqAdapter.adapterId,
    contextKind: qqContextKind(e, qqAdapter),
    rawUserId: qqRawUserId(e),
    rawGroupId: qqRawGroupId(e),
    selfId: String(e.self_id || e.selfId || ''),
    role,
    isMaster,
    userId,
    groupId,
    isGroup,
    // 群管理员识别：统一走 groupRoleOf（OneBot 的 member/sender.role、官方适配器的
    // author.member_role/sender.permissions 等）。bot 自身管理员身份不能代替发言人身份。
    isGroupAdmin: role === 'admin' || role === 'owner',
    isolation,
    scopeUserId,
    scopeId,
    notify: (id, info) => notifyMaster(e, id, info),
    conversationId: null,
    // 媒体被动工具（list_group_files/get_group_file/read_attachment）需读取实时事件与 Bot 句柄
    e,
    bot: (typeof Bot !== 'undefined' && Bot) || null,
    fetcher: (typeof fetch !== 'undefined' && fetch) || null,
  }
}

export function thinkingLogFields(agent, cfg) {
  return fmtThinkingLogFields({ thinkInfo: agent?.thinkInfo, thinking: agent?.thinking || cfg?.thinking || null })
}

export function notifyMaster(e, id, info) {
  const masters = Config.get().agent?.masters || []
  // 注：terminal 不再走审批（命令在 E2B 沙箱内执行），故这里没有 terminal 专用的风险特征分支
  const detail = JSON.stringify(info.args || {}).slice(0, 120)
  const text = `待审批 #${id}：${info.tool} ${detail}\n回复「#确认 ${id}」或「#拒绝 ${id}」`
  try {
    for (const rawMid of masters) {
      const mid = String(rawMid ?? '').trim()
      if (!mid) continue
      const bot = (typeof Bot !== 'undefined' && Bot) || null
      // 异步发送必须挂 rejection 处理（同步 catch 捕获不了 Promise 拒绝 → unhandledRejection）
      Promise.resolve(bot?.pickFriend?.(mid)?.sendMsg?.(text)).catch((err) => Log.warn('notifyMaster 私信发送失败', mid, err?.message || err))
    }
    if (!masters.length && e.isGroup) Promise.resolve(e.reply('⚠️ 有动作待审批，但未配置 master 接收通知（agent.masters）')).catch(() => {})
  } catch (err) {
    Log.warn('notifyMaster 失败', err?.message || err)
  }
}

export const fireReminder = async (info) => {
  try {
    const bot = (typeof Bot !== 'undefined' && (Bot[info.selfId] || Bot)) || null
    const text = `⏰ 提醒：${info.message}`
    if (info.groupId && bot?.pickGroup) await bot.pickGroup(info.groupId).sendMsg(text)
    else if (bot?.pickFriend) await bot.pickFriend(info.userId).sendMsg(text)
  } catch (err) {
    Log.warn('fireReminder 失败', err?.message || err)
  }
}

// 按目标（群/私聊）发消息（fire 路径，无 e；复用 fireReminder 的 pickGroup/pickFriend 逻辑）
export async function sendByInfo(info, text) {
  const bot = (typeof Bot !== 'undefined' && (Bot[info.selfId] || Bot)) || null
  if (!bot) return
  if (info.groupId && bot.pickGroup) await bot.pickGroup(info.groupId).sendMsg(text)
  else if (bot.pickFriend) await bot.pickFriend(info.userId).sendMsg(text)
}

// 合成 ctx（fire 时无用户事件 e）：复用 ctxOf 的 scope 逻辑，去 e 相关
export function ctxFromInfo(info) {
  const userId = String(info.userId || '')
  const groupId = info.groupId ? String(info.groupId) : null
  const isGroup = !!groupId
  const cfg = Config.get().agent || {}
  const isolation = cfg.isolation?.enable !== false
  const sharedGroup = !!(isGroup && groupId && !isolation)
  const scopeUserId = sharedGroup ? sharedScopeId(groupId) : userId
  const scopeId = !isGroup ? `u_${safeScopePart(userId)}` : (isolation ? `g${safeScopePart(groupId)}_u${safeScopePart(userId)}` : `g${safeScopePart(groupId)}`)
  // 创建者身份：定时任务 fire 时无用户事件，但任务创建者的主人身份必须保留——
  // 否则群管类工具（如 send_group_notice）会被判为 member 而 rejected_by_policy
  //（生产事故：master 建的群公告任务被误拒 + AI 反复重试）。
  const isMaster = (cfg.masters || []).map((m) => String(m).trim()).includes(String(userId))
  return {
    userId, groupId, isGroup, isMaster, role: isMaster ? 'owner' : 'member', isolation, scopeUserId, scopeId,
    bot: (typeof Bot !== 'undefined' && Bot) || null, selfId: info.selfId || '',
    // 定时任务路径同样要能投递审批请求：旧实现是空函数 → 需要审批的工具卡到超时后静默拒绝，
    // 且没有任何人收到「待审批 #id」（唯一可批通道只剩 Web 面板）。这里复用私信主人的逻辑，
    // 同时把提示发到任务创建者所在会话（群任务发群、私聊任务发私聊）。
    notify: (id, nInfo) => {
      // 私信主人（复用交互路径的通知逻辑）+ 把提示发回任务创建者所在会话
      notifyMaster({ isGroup, reply: () => {} }, id, nInfo) // reply 给空实现：未配 masters 时不因 e.reply 缺失而报错
      const text = `待审批 #${id}：${nInfo?.tool || ''}\n回复「#确认 ${id}」或「#拒绝 ${id}」`
      Promise.resolve(sendByInfo({ groupId, userId, selfId: info.selfId }, text))
        .catch((err) => Log.warn('定时任务审批通知发送失败', err?.message || err))
    },
    fetcher: (typeof fetch !== 'undefined' && fetch) || null,
    conversationId: null,
  }
}

/**
 * 工具运行时沙箱上下文（terminal 与所有沙箱化内置工具共用）。
 * 交互路径与定时任务路径必须同源装配，否则同一工具会「一处走沙箱、一处走宿主」（语义漂移 +
 * 显式选择 e2b 后仍可能回落宿主执行）。
 * 导出供接线回归（stress/e2e/agent-sandbox-wiring.mjs）断言模式与 manager 随配置切换。
 */
export function makeSandboxCtx(ctx, rt, cfg = Config.get().agent || {}) {
  return {
    mode: String(cfg.sandbox?.mode || 'off').toLowerCase(),
    manager: rt?.sandbox?.manager || null,
    defaultCwd: cfg.sandbox?.defaultCwd || '/home/user',
    maxTimeout: cfg.sandbox?.maxTimeout || 600,
    maxCommandsPerSession: cfg.sandbox?.maxCommandsPerSession ?? 50,
    audit: cfg.sandbox?.audit !== false,
    commands: rt?.sandbox?.commands || null,
    sessionKey: sessionKeyOf(ctx),
  }
}

/**
 * 给工具 ctx 挂上运行时能力（沙箱执行面 + 视觉子模型）。所有 Agent 运行入口（交互/定时任务/
 * 人设补齐/任务续跑/子代理）统一走这里，否则会出现「同一工具一处有、一处没有」的能力漂移
 * （如 analyze 一处能看视频、一处只能看字幕）。rt 允许传 { sandbox, vision } 子集。
 */
export function attachToolRuntime(ctx, rt, cfg = Config.get().agent || {}) {
  ctx.sandbox = makeSandboxCtx(ctx, rt, cfg)
  ctx.vision = rt?.vision && Config.get().agent?.media?.enable !== false ? rt.vision : null
  return ctx
}

/**
 * 人设补齐专用「只读取材」工具表：按白名单复制工具，默认拒绝新工具。
 * web_crawl 额外移除 js_code（可执行点击/提交，不属于只读取材）。
 */
export function makeCompletionToolRegistry(source) {
  const reg = new ToolRegistry()
  for (const tool of source.list()) {
    if (!isCompletionToolAllowed(tool)) continue
    if (tool.name === 'web_crawl') {
      let parameters = tool.parameters
      try { parameters = JSON.parse(JSON.stringify(tool.parameters || {})) } catch { /* 保留原 schema */ }
      if (parameters?.properties) delete parameters.properties.js_code
      reg.register({
        ...tool,
        parameters,
        execute: (params, ctx) => {
          const wait = params?.wait_for
          if (wait && !/^\s*css:/i.test(String(wait))) {
            return { error: '人设补齐任务只允许 css: 等待条件（禁止在页面执行 JS）' }
          }
          return tool.execute({ ...(params || {}), js_code: undefined }, ctx)
        },
      })
    } else {
      reg.register(tool)
    }
  }
  return reg
}

/**
 * 解析当前用户激活的人设接地（身份层 systemPrompt + 长尾检索 context），
 * 供交互对话与 #继续任务 续跑等入口统一复用（避免两处接地语义漂移）。
 * @returns {Promise<{ personaId: string|null, systemPrompt: string|undefined, context: string|undefined }>}
 */
export async function resolvePersonaGrounding(rt, ctx, queryText) {
  const none = { personaId: null, systemPrompt: undefined, context: undefined }
  try {
    const { persona } = await rt.persona.resolve(ctx.userId)
    if (!persona) return none
    const lore = rt.personaLore?.get?.(persona.id)
    const active = lore && lore.status === 'active' ? lore : null
    const basePrompt = composePersonaSystemPrompt(persona)
    // system 必须是纯静态前缀（工具数组 + system 逐轮字节一致才能命中前缀缓存）。
    // 逐轮变化的人设提醒只能进本轮 user 消息尾部（由 run 的 context 通道注入）。
    const lockReminder = personaBreakReminder(queryText)
    const systemPrompt = [basePrompt, active ? groundingText(active) : ''].filter(Boolean).join('\n\n') || undefined
    let context = lockReminder || undefined
    if (active) {
      const hits = await rt.personaLore.retrieve(active.id, queryText, 3).catch(() => [])
      if (hits.length) {
        const loreText = '【角色设定·长尾资料（检索，仅供参考；与已核实事实冲突时以已核实事实为准）】\n'
          + hits.map((h) => `- ${h.text}`).join('\n')
        context = context ? `${context}\n\n${loreText}` : loreText
      }
    }
    return { personaId: persona.id, systemPrompt, context, lockReminder }
  } catch (e) {
    Log.warn('[persona] 接地解析失败', e?.message || e)
    return none
  }
}

export const makeFireDispatch = (rt) => {
  return async (info) => {
    if (info.type === 'task' && info.prompt) {
      const cfg = Config.get().agent || {}
      const ctx = ctxFromInfo(info)
      // 定时任务同样装配工具运行时能力：显式选择 e2b 时，沙箱化工具（calculate/下载/转写等）
      // 在任务链里也必须走沙箱；多模态工具（B站看视频）同样需要视觉子模型
      attachToolRuntime(ctx, rt)
      const taskId = randomUUID() // 与交互路径同源：定时任务也落 dev trace / 用量 / 采迹
      try {
        const r = await rt.makeAgent().run(info.prompt, {
          ctx, maxTurns: cfg.schedule?.taskMaxTurns || 200, taskId,
          onToolEnd: (tc, content) => { try { rt.usageStats?.recordToolResult?.(tc?.name, content) } catch { /* 统计不阻塞 */ } },
        })
        // 与交互路径一致的可观测性：用量统计 + 进化采迹 + 自评审（此前定时任务全部旁路）
        try {
          const nu = normalizeUsage(r?.usage) || {}
          rt.usageStats?.recordRun({
            inputTokens: nu.input || 0, outputTokens: nu.output || 0,
            cacheRead: nu.cacheRead || 0, cacheWrite: nu.cacheWrite || 0, cacheObserved: !!nu.cacheObserved,
            observedInput: nu.observedInput || 0, observedOutput: nu.observedOutput || 0, observedUncached: nu.observedUncached || 0,
            turns: r?.turns, model: cfg.model || '',
          })
        } catch { /* noop */ }
        try { rt.traceStore?.record({ scope: ctx.scopeUserId, scopeId: ctx.scopeId, input: info.prompt, output: r?.content, turns: r?.turns, usage: r?.usage, stopReason: r?.stopReason, taskId }) } catch (e) { Log.warn('[evolution] 定时任务采迹失败', e?.message || e) }
        try { rt.selfReview?.tick({ ...ctx, userTexts: [] }, { input: info.prompt, output: r?.content, turns: r?.turns, usage: r?.usage, stopReason: r?.stopReason }) } catch (e) { Log.warn('[evolution] 定时任务自评审触发失败', e?.message || e) }
        // 定时任务结果外发前剥离 sticker 标记：任务链的回复不走主回复出口，
        // 若模型输出 [sticker:x]（尤其表情发送失败时）会字面泄漏给群。
        const text = `🤖 定时任务：${stripMarkers(String(r?.content || '')).trim() || '(无输出)'}`
        await sendByInfo(info, text)
        Log.info('[schedule] 任务链完成', info.id, 'turns=', r?.turns)
      } catch (e) {
        try { rt.usageStats?.recordRun({ error: true }) } catch { /* noop */ }
        Log.warn('[schedule] 任务链失败', info.id, e?.message || e)
        try { await sendByInfo(info, `⚠️ 定时任务「${String(info.prompt).slice(0, 30)}」执行失败：${e?.message || e}`) } catch { /* noop */ }
      }
    } else {
      await fireReminder(info)
    }
  }
}
