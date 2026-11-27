/**
 * 人设与资料补齐命令（原 apps/agent.js）。
 */
import Config from '../../../utils/Config.js'
import { PERSONA_MAX_NAME_LEN, PERSONA_MAX_PROMPT_LEN, composePersonaSystemPrompt, formatDraftSummary } from '../../../model/persona/index.js'
import { buildPersonaListHtml } from '../../../model/agent/index.js'
import { parseCron } from '../../../model/agent/index.js'
import { screenshot } from '../../render.js'
import { getRuntime } from '../runtime.js'
import { ctxOf } from '../context.js'

export const personaCommands = {


  // —— 人设 ——
  async personaList() {
    const rt = await getRuntime()
    const ctx = ctxOf(this.e)
    const personas = rt.personaStore.list()
    const boundId = await rt.persona.getActiveId(ctx.userId)
    // 未单独切换时，全局默认人设同样标星，避免「列表里没一个人设是当前生效的」
    const activeId = boundId || rt.persona.getDefaultPersona()?.id || null
    const html = buildPersonaListHtml({ user: ctx.userId, personas, activeId })
    const img = Config.get().agent?.render?.card === false ? null : await screenshot('agents-plugin/persona-list', html)
    if (img) return this.e.reply(img), true
    const lines = personas.map((p, i) => `${p.id === activeId ? '★' : '·'} ${i + 1}. ${p.name}${p.builtin ? '（内置）' : ''} — ${p.description}`)
    await this.e.reply(['人设列表（#人设 + 序号切换，如 #人设 1）', ...lines].join('\n'))
    return true
  }
,


  /** 解析人设引用：数字 → #人设列表序号(1-based)，否则按 id/名称。找不到返回 null。 */
  _resolvePersonaRef(rt, input) {
    return rt.persona.resolveRef(input)
  }
,


  /** 补齐任务的真实 ctx（含活动会话 + 机器人身份）：使任务并入主任务账本、浏览器等工具可用。 */
  async _personaCompletionCtx(rt) {
    const base = ctxOf(this.e)
    try {
      // 只读活跃对话：`getActiveConversation()` 在无对话时会**新建空对话**，
      // 让一次资料补齐凭空出现在用户的 #聊天列表 里（副作用）。
      base.conversationId = await rt.session.peekActiveConversation?.(base.scopeUserId, base.groupId) || 'persona-complete'
    } catch { base.conversationId = 'persona-complete' }
    base.selfId = String(this.e.self_id || this.e.selfId || '')
    return base
  }
,


  async personaSwitch() {
    const input = this.e.msg.replace(/^#人设\s+/, '').trim()
    const rt = await getRuntime()
    const ctx = ctxOf(this.e)
    // 数字 → 列表序号（1-based）；否则按 id/名称
    let target = input
    if (/^\d+$/.test(input)) {
      const list = rt.personaStore.list()
      const idx = Number(input) - 1
      if (idx < 0 || idx >= list.length) return this.e.reply(`序号超出范围（1-${list.length}），发送 #人设 查看列表`), true
      target = list[idx].id
    }
    try {
      const p = await rt.persona.setActive(ctx.userId, target)
      await this.e.reply(`已切换人设：${p.name}${p.greeting ? `\n${p.greeting}` : ''}`)
    } catch (e) {
      await this.e.reply(e?.message || '切换失败，发送 #人设 查看列表')
    }
    return true
  }
,


  async personaDetail() {
    const input = this.e.msg.replace(/^#人设详情\s+/, '').trim()
    const rt = await getRuntime()
    // 数字 → 序号
    let target = input
    if (/^\d+$/.test(input)) {
      const list = rt.personaStore.list()
      const idx = Number(input) - 1
      if (idx < 0 || idx >= list.length) return this.e.reply(`序号超出范围（1-${list.length}）`), true
      target = list[idx].id
    }
    const p = rt.personaStore.get(target)
    if (!p) return this.e.reply(`未找到人设「${input}」`), true
    const tags = p.tags?.length ? ` | 标签：${p.tags.join('、')}` : ''
    const card = p.card && typeof p.card === 'object' ? p.card : null
    const cardMeta = card?.meta && typeof card.meta === 'object' ? card.meta : {}
    const cardLine = card
      ? ` | 角色卡：${card.spec || '未标 spec'}${cardMeta.name_en ? ` · ${cardMeta.name_en}` : ''}${cardMeta.version ? ` · v${cardMeta.version}` : ''}`
      : ''
    await this.e.reply([
      `#${p.id} ${p.name}${p.builtin ? '（内置）' : '（自定义）'}${tags}${cardLine}`,
      p.description,
      card ? '—— 人设内容（含角色卡补充）——' : '—— 人设内容 ——',
      composePersonaSystemPrompt(p),
    ].join('\n'))
    return true
  }
,


  async personaCreate() {
    const rest = this.e.msg.replace(/^#新建人设\s+/, '').trim()
    const sp = rest.indexOf(' ')
    if (sp < 0) return this.e.reply('格式：#新建人设 <名称> <人设内容>（名称与内容用空格分隔）'), true
    const name = rest.slice(0, sp).trim()
    const systemPrompt = rest.slice(sp + 1).trim()
    if (!name || systemPrompt.length < 2) return this.e.reply('名称或人设内容过短'), true
    // 配额（2026-10-17 审计 M4）：命令无 permission（README 就这么写的：任何人可建自己的人设），
    // 但 add() 原先只查重不设上限 —— 单用户可无限刷盘，且 list()/resolve() 每轮全目录解析会被拖慢。
    const MAX_NAME = PERSONA_MAX_NAME_LEN, MAX_PROMPT = PERSONA_MAX_PROMPT_LEN, MAX_PER_USER = 20
    if (name.length > MAX_NAME) return this.e.reply(`人设名称过长（${name.length} > ${MAX_NAME} 字）`), true
    if (systemPrompt.length > MAX_PROMPT) return this.e.reply(`人设内容过长（${systemPrompt.length} > ${MAX_PROMPT} 字），请精简后重试`), true
    const rt = await getRuntime()
    const ctx = ctxOf(this.e)
    const mine = rt.personaStore.list().filter((p) => !p.builtin && p.creator === ctx.userId)
    if (mine.length >= MAX_PER_USER) return this.e.reply(`你创建的人设已达上限（${MAX_PER_USER} 个），先 #删除人设 再建新的`), true
    try {
      const p = rt.personaStore.add({ name, systemPrompt }, { creator: ctx.userId })
      await rt.persona.setActive(ctx.userId, p.id)
      await this.e.reply(`已创建并切换到人设：${p.name}（#${p.id}）`)
    } catch (e) {
      await this.e.reply(e?.message || '创建失败')
    }
    return true
  }
,


  async personaDelete() {
    const idOrName = this.e.msg.replace(/^#删除人设\s+/, '').trim()
    const rt = await getRuntime()
    const ctx = ctxOf(this.e)
    const p = this._resolvePersonaRef(rt, idOrName)
    if (!p) return this.e.reply(`未找到人设「${idOrName}」（可用 #人设列表 的序号或 id）`), true
    if (p.builtin) return this.e.reply(`内置人设「${p.name}」不可删除`), true
    // 仅创建者或 master 可删
    if (p.creator && p.creator !== ctx.userId && !ctx.isMaster) {
      return this.e.reply('仅人设创建者或主人可删除'), true
    }
    rt.personaStore.remove(p.id)
    await rt.persona.resetActive(ctx.userId)
    await this.e.reply(`已删除人设：${p.name}（#${p.id}）`)
    return true
  }
,


  async personaReset() {
    const rt = await getRuntime()
    const ctx = ctxOf(this.e)
    await rt.persona.resetActive(ctx.userId)
    await this.e.reply('已恢复默认人设')
    return true
  }
,


  // —— 人设补齐 / 资料草稿管理（主人；AI 只产出草稿，须采纳才生效）——
  async personaComplete() {
    const rt = await getRuntime()
    if (!rt.personaLore || !rt.completePersona) return this.e.reply('人设资料库未启用'), true
    const idOrName = this.e.msg.replace(/^#人设补齐\s+/, '').trim()
    const p = this._resolvePersonaRef(rt, idOrName)
    if (!p) return this.e.reply(`未找到人设「${idOrName}」（可用 #人设列表 的序号或 id）`), true
    await this.e.reply(`🔎 已启动人设补齐任务（${p.name}），正在检索角色资料，请稍候…`)
    const r = await rt.completePersona(p.id, { by: String(this.e.user_id || ''), ctx: await this._personaCompletionCtx(rt) })
    if (r.error) return this.e.reply(`${r.error}（可重试 #人设补齐 ${p.id}）`), true
    await this.e.reply(formatDraftSummary(r.lore) + (r.taskId ? `\n任务：${r.taskId}（#任务状态 ${r.taskId}）` : ''))
    return true
  }
,


  async personaDraftRefresh() {
    const rt = await getRuntime()
    if (!rt.personaLore || !rt.completePersona) return this.e.reply('人设资料库未启用'), true
    const idOrName = this.e.msg.replace(/^#刷新人设资料\s+/, '').trim()
    const p = this._resolvePersonaRef(rt, idOrName)
    if (!p) return this.e.reply(`未找到人设「${idOrName}」（可用 #人设列表 的序号或 id）`), true
    await this.e.reply(`🔁 正在为人设「${p.name}」重新检索资料…`)
    const r = await rt.completePersona(p.id, { by: String(this.e.user_id || ''), ctx: await this._personaCompletionCtx(rt) })
    if (r.error) return this.e.reply(`${r.error}`), true
    await this.e.reply(formatDraftSummary(r.lore) + (r.taskId ? `\n任务：${r.taskId}` : ''))
    return true
  }
,


  async personaDraftSchedule() {
    const rt = await getRuntime()
    if (!rt.personaLore) return this.e.reply('人设资料库未启用'), true
    const input = this.e.msg.replace(/^#人设资料定时\s+/, '').trim()
    const m = input.match(/^(\S+)\s+([\s\S]+)$/)
    if (!m) return this.e.reply('用法：#人设资料定时 <人设id> <时间>（如 每天8点 / 每周一8点30 / 每12小时）'), true
    const p = this._resolvePersonaRef(rt, m[1])
    if (!p) return this.e.reply(`未找到人设「${m[1]}」（可用 #人设列表 的序号或 id）`), true
    const cron = parseCron(m[2].trim())
    if (!cron) return this.e.reply(`无法识别时间「${m[2]}」，支持：每天8点/每2小时/工作日9点/每周一8点30/每30分钟`), true
    const r = await rt.personaLore.setRefresh(p.id, cron)
    if (r.error) return this.e.reply(r.error), true
    await this.e.reply(`✓ 已为「${p.name}」（#${p.id}）设定人设资料定时刷新：${m[2].trim()}\n到点会重新检索并产出新草稿（需 #采纳补齐 提交审批、经审批门批准后生效）`)
    return true
  }
,


  async personaDraftCancelSchedule() {
    const rt = await getRuntime()
    if (!rt.personaLore) return this.e.reply('人设资料库未启用'), true
    const idOrName = this.e.msg.replace(/^#人设资料取消定时\s+/, '').trim()
    const p = this._resolvePersonaRef(rt, idOrName)
    if (!p) return this.e.reply(`未找到人设「${idOrName}」（可用 #人设列表 的序号或 id）`), true
    await rt.personaLore.cancelRefresh(p.id)
    await this.e.reply(`已取消人设「${p.name}」的资料定时刷新`)
    return true
  }
,


  async personaDraftScheduleList() {
    const rt = await getRuntime()
    if (!rt.personaLore) return this.e.reply('人设资料库未启用'), true
    const list = rt.personaLore.listRefresh()
    if (!list.length) return this.e.reply('暂无人设资料定时刷新任务'), true
    const lines = list.map((l) => `· ${l.id} · ${l.cron} · ${l.status === 'active' ? '已生效' : '草稿'}`)
    await this.e.reply(['人设资料定时刷新：', ...lines].join('\n'))
    return true
  }
,


  async personaDraftView() {
    const rt = await getRuntime()
    if (!rt.personaLore) return this.e.reply('人设资料库未启用'), true
    const idOrName = this.e.msg.replace(/^#查看补齐\s+/, '').trim()
    const p = this._resolvePersonaRef(rt, idOrName)
    if (!p) return this.e.reply(`未找到人设「${idOrName}」（可用 #人设列表 的序号或 id）`), true
    const draft = rt.personaLore.getDraft(p.id)
    const main = rt.personaLore.get(p.id)
    const lore = draft || main
    if (!lore) return this.e.reply(`人设「${p.name}」暂无补齐资料`), true
    const status = draft ? '待采纳草稿' : (lore.status === 'active' ? '已生效' : '草稿')
    const src = lore.sources.map((s, i) => `[${i + 1}] ${s.title || s.ref}（${s.ref}）`).join('\n')
    const lines = [
      `🧩 人设资料 · ${p.name}（#${p.id}）· ${status}${draft && main?.status === 'active' ? '（另有一份已生效版本）' : ''}`,
      lore.summary ? `概述：${lore.summary}` : '',
      lore.systemPromptPatch ? `风格补充：${lore.systemPromptPatch}` : '',
      '—— 事实 ——', lore.facts || '（无）',
      src ? '—— 出处 ——' : '', src,
      lore.rawNotes ? `—— 长尾资料（${lore.rawNotes.length} 字，采纳后入库供检索） ——` : '',
    ].filter(Boolean)
    await this.e.reply(lines.join('\n'))
    return true
  }
,


  async personaDraftAdopt() {
    const rt = await getRuntime()
    if (!rt.personaLore) return this.e.reply('人设资料库未启用'), true
    if (!rt.personaAdoptionQueue) return this.e.reply('人设采纳审批未启用'), true
    const idOrName = this.e.msg.replace(/^#采纳补齐\s+/, '').trim()
    const p = this._resolvePersonaRef(rt, idOrName)
    if (!p) return this.e.reply(`未找到人设「${idOrName}」（可用 #人设列表 的序号或 id）`), true
    // 采纳改为「进审批门」：不再直接生效，投递待审项，主人批准后才 draft→active
    const res = rt.personaAdoptionQueue.request({ personaId: p.id, personaName: p.name, by: String(this.e.user_id || ''), via: 'qq' })
    if (res.error) return this.e.reply(`提交采纳审批失败：${res.error}`), true
    await this.e.reply(`📥 已将「${p.name}」（#${p.id}）的资料采纳提交审批（单号 ${res.item.id}）${res.duplicated ? '（已有待审项，已刷新为最新草稿）' : ''}。\n请在 Web 面板「审批门」批准后生效。`)
    return true
  }
,


  async personaDraftDiscard() {
    const rt = await getRuntime()
    if (!rt.personaLore) return this.e.reply('人设资料库未启用'), true
    const idOrName = this.e.msg.replace(/^#丢弃补齐\s+/, '').trim()
    const p = this._resolvePersonaRef(rt, idOrName)
    if (!p) return this.e.reply(`未找到人设「${idOrName}」（可用 #人设列表 的序号或 id）`), true
    const isDraft = !!rt.personaLore.getDraft(p.id)
    const ok = rt.personaLore.discard(p.id)
    // 草稿丢弃同步撤销其待审采纳项，避免审批门残留已无法采纳的条目
    if (ok) { try { rt.personaAdoptionQueue?.cancelByPersona?.(p.id) } catch { /* noop */ } }
    await this.e.reply(ok ? `已丢弃人设资料${isDraft ? '（草稿）' : ''}：#${p.id}` : `人设「${p.name}」暂无补齐资料`)
    return true
  }

}
