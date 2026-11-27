/**
 * 提醒 / 定时任务 / 任务账本命令（原 apps/agent.js）。
 */
import Config from '../../../utils/Config.js'
import { parseCron, formatScheduleList, selectScheduleForList, scopeKeyOfCtx, resolveExecutionMeta, validateToolArgs } from '../../../model/agent/index.js'
import { stripMarkers } from '../../../model/sticker/parser.js'
import { getRuntime, maybeRedact, runtimeGeneration } from '../runtime.js'
import { ctxOf, attachToolRuntime, ownsScheduleRecord, resolvePersonaGrounding, makeFireDispatch } from '../context.js'

export const taskCommands = {

  // —— 定时任务（cron 重复 + 任务链：到点跑 Agent 任务 + 发结果）——
  async addCronTask() {
    const rt = await getRuntime()
    if (Config.get().agent?.schedule?.taskEnabled === false) return this.e.reply('定时任务功能已关闭'), true
    const raw = this.e.msg.replace(/^#定时任务\s+/, '').trim()
    const sp = raw.indexOf(' ')
    if (sp < 0) return this.e.reply('用法：#定时任务 <时间> <任务描述>\n如：#定时任务 每天8点 搜索今日AI资讯\n时间支持：每天8点 / 每2小时 / 工作日9点 / 每周一8点30 / 每30分钟'), true
    const when = raw.slice(0, sp).trim()
    const prompt = raw.slice(sp + 1).trim()
    const cron = parseCron(when)
    if (!cron) return this.e.reply(`无法识别时间「${when}」。支持：每天8点 / 每2小时 / 工作日9点 / 每周一8点30 / 每30分钟`), true
    const rec = await rt.schedule.add({
      type: 'task', cron, prompt,
      userId: String(this.e.user_id || ''), groupId: this.e.group_id ? String(this.e.group_id) : null,
      selfId: String(this.e.self_id || this.e.selfId || ''),
    }, makeFireDispatch(rt))
    if (rec?.error) return this.e.reply(`✗ 创建失败：${rec.error}`), true
    await this.e.reply(`✓ 定时任务 #${rec.id}\n周期：${when}（${cron}）\n任务：${prompt}`)
    return true
  }
,


  async listCronTask() {
    const rt = await getRuntime()
    const ctx = ctxOf(this.e)
    const all = await rt.schedule.listAll()
    // 展示：所有任务链（群级）+ 仅本人的提醒。修复「AI 用 reminder_set 建了提醒、web 看得到、
    // #定时任务列表 却返回暂无」——此前只 filter(type==='task')，把 type='reminder' 的记录全漏掉。
    const list = selectScheduleForList(all, { userId: ctx.userId, scopeUserId: ctx.scopeUserId, isMaster: ctx.isMaster, groupId: ctx.groupId })
    if (!list.length) return this.e.reply('暂无定时任务/提醒（#定时任务 <时间> <任务> 创建；或用 AI 帮你设）'), true
    await this.e.reply(`定时任务 / 提醒（${list.length}）：\n${formatScheduleList(list).join('\n')}`)
    return true
  }
,


  async cancelCronTask() {
    const rt = await getRuntime()
    const id = (this.e.msg.match(/^#取消定时任务\s+(\S+)/) || [])[1] || ''
    if (!id) return this.e.reply('用法：#取消定时任务 <id>（id 见 #定时任务列表）'), true
    const all = await rt.schedule.listAll()
    const rec = all.find((r) => String(r.id) === String(id))
    if (!rec) return this.e.reply(`未找到 #${id}（用 #定时任务列表 查看）`), true
    if (!ownsScheduleRecord(rec, ctxOf(this.e))) return this.e.reply('无权取消该任务（仅创建者或主人可取消）'), true
    await rt.schedule.cancel(id)
    await this.e.reply(`已取消定时任务 #${id}`)
    return true
  }
,


  async myReminders() {
    const rt = await getRuntime()
    const ctx = ctxOf(this.e)
    const all = await rt.schedule.listAll()
    const list = all.filter((r) => String(r?.userId) === String(ctx.userId) || String(r?.userId) === String(ctx.scopeUserId))
    if (!list.length) return this.e.reply('暂无提醒'), true
    await this.e.reply(`我的提醒 / 任务（${list.length}）：\n${formatScheduleList(list).join('\n')}`)
    return true
  }
,


  async cancelReminder() {
    const id = this.e.msg.match(/\d+/)?.[0]
    if (!id) return this.e.reply('用法：#取消提醒 <id>（id 见 #我的提醒）'), true
    const rt = await getRuntime()
    const all = await rt.schedule.listAll()
    const rec = all.find((r) => String(r.id) === String(id))
    if (!rec) return this.e.reply(`未找到 #${id}（用 #我的提醒 查看）`), true
    // 归属校验：此前无权限、无归属校验 → 任意用户可按 5 位顺序号取消他人提醒与主人的周期任务链
    if (!ownsScheduleRecord(rec, ctxOf(this.e))) return this.e.reply('无权取消该提醒/任务（仅创建者或主人可取消）'), true
    await rt.schedule.cancel(id)
    await this.e.reply(`已取消提醒 #${id}`)
    return true
  }
,


  // —— 任务账本（P0-3）：列表 / 状态 / 取消 / 继续 ——
  async _taskScope() {
    const rt = await getRuntime()
    const ctx = ctxOf(this.e)
    try { ctx.conversationId = await rt.session.getActiveConversation(ctx.scopeUserId, ctx.groupId) } catch { /* 无活动会话按默认 */ }
    // 任务续跑/恢复会重新跑 Agent 工具链：运行时能力（沙箱/视觉）与交互路径同口径
    attachToolRuntime(ctx, rt)
    return { rt, ctx, scopeKey: scopeKeyOfCtx(ctx) }
  }
,


  async _resolveTaskId(rt, scopeKey, input) {
    if (!input) return null
    if (await rt.taskStore.get(input, { scopeKey })) return input
    const list = await rt.taskStore.list({ scopeKey, limit: 200 })
    const hits = list.filter((t) => String(t.taskId).startsWith(input))
    return hits.length === 1 ? hits[0].taskId : null
  }
,


  async listTasks() {
    const { rt, scopeKey } = await this._taskScope()
    if (!rt.taskStore) return this.e.reply('任务账本未启用（config agent.taskStore.enable=true）'), true
    const tasks = await rt.taskStore.list({ scopeKey, limit: 20 })
    if (!tasks.length) return this.e.reply('当前会话暂无任务记录'), true
    const icon = (p) => ({ completed: '✅', paused: '⏸️', interrupted: '⚠️', failed: '❌', cancelled: '🚫', running: '▶️', waiting_input: '💬', queued: '🕒' }[p] || '·')
    const lines = tasks.map((t) => `${icon(t.phase)} ${t.taskId} [${t.phase}]${t.stopReason ? ` ${t.stopReason}` : ''}`)
    await this.e.reply(`任务记录（${tasks.length}，最近在前）：\n${lines.join('\n')}\n\n#任务状态 <id> · #取消任务 <id> · #继续任务 <id>`)
    return true
  }
,


  async taskStatus() {
    const { rt, scopeKey } = await this._taskScope()
    if (!rt.taskStore) return this.e.reply('任务账本未启用（config agent.taskStore.enable=true）'), true
    const input = (this.e.msg.match(/^#任务状态\s+(\S+)/) || [])[1]
    const id = await this._resolveTaskId(rt, scopeKey, input)
    if (!id) return this.e.reply('未找到任务（可能不属于当前会话或不存在）'), true
    const t = await rt.taskStore.get(id, { scopeKey })
    const events = await rt.taskStore.listEvents(id)
    const recent = events.slice(-8).map((e) => `  · ${e.kind}${e.callId ? `(${e.callId})` : ''}${e.phase ? ` →${e.phase}` : ''}`)
    await this.e.reply([
      `任务 ${t.taskId}`,
      `状态：${t.phase}${t.stopReason ? `（${t.stopReason}）` : ''} · completion=${t.completion || '-'}`,
      `事件 ${events.length} 条（最近 ${recent.length}）：`, ...recent,
    ].join('\n'))
    return true
  }
,


  async cancelTask() {
    const { rt, scopeKey } = await this._taskScope()
    if (!rt.taskStore) return this.e.reply('任务账本未启用'), true
    const input = (this.e.msg.match(/^#取消任务\s+(\S+)/) || [])[1]
    const id = await this._resolveTaskId(rt, scopeKey, input)
    if (!id) return this.e.reply('未找到任务'), true
    const r = await rt.taskStore.cancel(id, { scopeKey })
    await this.e.reply(r.ok ? `已取消任务 ${id}` : `无法取消：${r.code || '未知'}`)
    return true
  }
,


  async resumeTask() {
    const { rt, ctx, scopeKey } = await this._taskScope()
    if (!rt.taskStore) return this.e.reply('任务账本未启用'), true
    const input = (this.e.msg.match(/^#继续任务\s+(\S+)/) || [])[1]
    const id = await this._resolveTaskId(rt, scopeKey, input)
    if (!id) return this.e.reply('未找到任务'), true
    const r = await rt.taskStore.resume(id, { scopeKey })
    if (!r.ok) return this.e.reply(`无法继续：${r.code}${r.phase ? `（${r.phase}）` : ''}`), true
    const p = r.plan
    const planLine = p ? `恢复计划：复用 ${p.counts.reuse} · 可重试 ${p.counts.retry} · 需核实 ${p.counts.reconcile} · 阻断 ${p.counts.block}` : ''
    // 存在未知写副作用 → 不自动续跑，先人工核实（与恢复门一致）
    if (p?.hasBlocking) {
      const lines = p.steps.map((s) => `· ${s.name || s.callId} → ${s.action}（${s.reason}）`)
      await this.e.reply([`任务 ${id} 存在未知写副作用，禁止自动续跑：`, planLine, ...lines, '⚠️ 请先人工核实外部实际状态。'].join('\n'))
      return true
    }
    // F06：从检查点重建已提交步骤并续跑同一任务（新 run 关联 parentTaskId）
    const cp = await rt.taskStore.getCheckpoint(id, { scopeKey })
    if (!cp.ok) return this.e.reply(`无法读取检查点：${cp.code}`), true
    await this.e.reply(`任务 ${id} 续跑中（${planLine || '无已完成步骤'}）…`)
    try {
      const agent = rt.makeAgent()
      // 与人设接地统一：续跑也应用当前用户激活人设（静态核心事实 + 按原任务输入的长尾检索）
      const pg = await resolvePersonaGrounding(rt, ctx, String(cp?.input || ''))
      const out = await agent.continueFrom(cp, {
        ctx, parentTaskId: id, runtimeGeneration: runtimeGeneration(),
        systemPrompt: pg.systemPrompt, context: pg.context,
      })
      const body = stripMarkers(maybeRedact(out?.content || '')).trim()
      await this.e.reply(body || '续跑未产出内容（可查看任务状态或重新发起）。')
    } catch (e) {
      await this.e.reply(`续跑失败：${e?.message || e}`)
    }
    return true
  }
,


  async recoverTask() {
    const { rt, ctx, scopeKey } = await this._taskScope()
    if (!rt.taskStore) return this.e.reply('任务账本未启用'), true
    const input = (this.e.msg.match(/^#恢复任务\s+(\S+)/) || [])[1]
    const id = await this._resolveTaskId(rt, scopeKey, input)
    if (!id) return this.e.reply('未找到任务'), true
    const planned = await rt.taskStore.recoveryPlan(id, { scopeKey })
    if (!planned.ok) return this.e.reply(`无法读取：${planned.code}`), true
    const p = planned.plan
    const lines = p.steps.map((s) => `· ${s.name || s.callId} → ${s.action}（${s.reason}）`)
    if (p.hasBlocking) {
      await this.e.reply([
        `任务 ${id} 恢复计划（存在未知写副作用，禁止自动重放）：`,
        ...lines,
        '⚠️ 请先人工核实外部实际状态后再决定是否重发任务。',
      ].join('\n'))
      return true
    }
    if (!p.autoResumable) return this.e.reply(`任务 ${id} 无可自动恢复的只读步骤（复用 ${p.counts.reuse}）`), true
    // 有限自动恢复：仅重跑「仍为只读」且可安全重放的步骤；执行前用实时工具重新校验 effect，
    // 并走与普通执行相同的门（schema 校验 + 权限策略），不得绕过（F08）。
    const exec = async (step) => {
      const tool = rt.tools.get(step.name)
      if (!tool) throw new Error(`工具 ${step.name} 已不存在`)
      const meta = resolveExecutionMeta(tool, step.args || {}, ctx)
      if (meta.effect !== 'read' || meta.replay !== 'safe') throw new Error(`工具 ${step.name} 当前不再是只读可重放，已中止`)
      const v = validateToolArgs(tool, step.args || {})
      if (!v.ok) throw new Error(`参数校验失败：${(v.fields || []).map((f) => f.message).join('；') || v.code || 'invalid'}`)
      if (rt.agentConfig?.policy) {
        const dec = rt.agentConfig.policy.decide(ctx, tool)
        if (dec?.decision === 'deny') throw new Error(`权限拒绝：${dec.reason || 'policy'}`)
      }
      const toolCtx = Object.assign({}, ctx, { signal: null, taskId: id })
      return await tool.execute(step.args || {}, toolCtx)
    }
    const out = await rt.taskStore.recoverReadOnly(id, { scopeKey, execute: exec })
    if (!out.ok) return this.e.reply(`自动恢复未执行：${out.code}`), true
    const done = out.applied.filter((a) => a.applied).length
    await this.e.reply(`任务 ${id} 只读步骤恢复：成功 ${done}/${out.applied.length}${out.applied.filter((a) => a.error).length ? `（${out.applied.filter((a) => a.error).map((a) => a.error).join('；')}）` : ''}`)
    return true
  }

}
