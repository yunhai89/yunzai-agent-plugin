/**
 * 工具进化 / 提示词进化 / 自评审命令（原 apps/agent.js）。
 */
import fs from 'node:fs'
import path from 'node:path'
import Config from '../../../utils/Config.js'
import Log from '../../../utils/Log.js'
import { PromptTemplate, TEMPLATES, evolveTemplate, regressionGate } from '../../../model/prompt/index.js'
import { listPendingSuggestions, removeSuggestion, applySuggestion, persistSuggestion } from '../../../model/evolution/review.js'
import { getRuntime } from '../runtime.js'
import { ctxOf } from '../context.js'

export const evolutionCommands = {

  // —— 错误上报：把该用户最近 10 个会话的 dev 日志打包发给主人私信 ——
  // ============ 在线自进化：审阅 / 采纳 / 拒绝 / 回滚（主人）============
  // 后台 SelfReviewer 每 N 轮对话自动产出 suggestion：memory 类（低风险）已自动应用；
  // skill/prompt 类（高风险）落盘待审，在此人工把关。#进化 prompt 走离线 GEPA（见 evolvePrompt）。

  // ============ Tool Evolution：#进化工具 生成候选工具（主人）============
  async toolEvoEvolve() {
    let goal = this.e.msg.replace(/^#进化工具\s+/, '').trim()
    if (!goal) { await this.e.reply('用法：#进化工具 <能力描述>，或 #进化工具 修复 <工具名> <修复描述>'); return true }
    let rt; try { rt = await getRuntime() } catch (e) { await this.e.reply(String(e?.message || e)); return true }
    if (!rt?.toolEvo?.engine) { await this.e.reply('工具进化未启用（config: agent.toolEvo.enable，或 sqlite3 未装）'); return true }
    let toolId = null
    let context = ''
    const fix = goal.match(/^修复\s+(\S+)\s+([\s\S]+)$/)
    if (fix) {
      const target = await rt.toolEvo.registry.getByName(fix[1])
      if (!target) { await this.e.reply(`工具「${fix[1]}」不存在（用 #工具进化列表 查看进化工具）`); return true }
      if (target.namespace !== 'evolved') { await this.e.reply(`「${fix[1]}」是内置/受信工具，不能由工具进化改写，请在插件源码维护`); return true }
      toolId = target.id
      goal = fix[2].trim()
      try {
        const { failureClusters } = await import('../../../model/toolEvo/evaluator.js')
        const c = (await failureClusters({ namespace: 'evolved' })).find((x) => x.toolId === toolId)
        if (c) context = `该工具近期调用 ${c.total} 次，失败 ${c.failed} 次（${(c.failRate * 100).toFixed(0)}%），主要错误：${c.topErrors.join(', ')}。请保持工具名和既有能力，修复这些问题。`
      } catch { /* 聚类失败不影响生成 */ }
    }
    await this.e.reply(`🧬 正在为「${goal}」生成候选工具…（LLM 生成 + typescript AST 验证，约数秒）`)
    try {
      const r = await rt.toolEvo.engine.evolve({ goal, toolId, context })
      if (r.ok) {
        const ev = r.evidence || {}
        await this.e.reply([
          `✅ 候选已生成并通过验证：${r.name}@${r.version}`,
          `状态：${r.status}（静态通过 · 行为 ${ev.passed ?? '?'}/${ev.totalTests ?? '?'} 通过）`,
          `versionId：${r.versionId}`,
          `下一步：#采纳工具 ${r.versionId}（主人审批后上线，Agent 可经 tool_search 调用）`,
          r.assumptions?.length ? '假设：' + r.assumptions.join('；') : '',
        ].filter(Boolean).join('\n'))
      } else {
        await this.e.reply(`❌ 候选未通过（${r.status}）：\n${r.reason}${r.versionId ? `\nversionId：${r.versionId}（记录可审阅）` : ''}`)
      }
    } catch (err) { await this.e.reply('❌ 进化失败：' + (err?.message || err)) }
    return true
  }
,


  async toolEvoList() {
    let rt; try { rt = await getRuntime() } catch (e) { await this.e.reply(String(e?.message || e)); return true }
    if (!rt?.toolEvo?.registry) { await this.e.reply('工具进化未启用（config: agent.toolEvo.enable）'); return true }
    const versions = await rt.toolEvo.registry.listVersions({ namespace: 'evolved' })
    if (!versions.length) { await this.e.reply('暂无进化工具版本。用 #进化工具 <能力描述> 生成候选。'); return true }
    const icon = (s) => s === 'stable' ? '🟢' : s === 'verified' ? '🟡' : s === 'draft' ? '⚪' : '⚫'
    const lines = versions.slice(0, 20).map((v) => {
      const perms = (v.sideEffects || []).join('/') || '-'
      const head = `${icon(v.status)}${v.active ? ' ★active' : ''} ${v.name || '?'}@${v.semver} [${v.status}] 权限=${perms} 测试=${v.tests_count ?? 0} id=${v.id}`
      return v.description ? `${head}\n   ${String(v.description).slice(0, 60)}` : head
    })
    await this.e.reply(`工具进化版本（共 ${versions.length}，显示前 20）：\n${lines.join('\n')}\n\n🟡verified 可 #采纳工具 <id> 晋升 stable；★=当前上线版本`)
    return true
  }
,


  async toolEvoAdopt() {
    const versionId = this.e.msg.replace(/^#采纳工具\s+/, '').trim()
    let rt; try { rt = await getRuntime() } catch (e) { await this.e.reply(String(e?.message || e)); return true }
    if (!rt?.toolEvo?.registry) { await this.e.reply('工具进化未启用'); return true }
    const reg = rt.toolEvo.registry
    const v = await reg.getVersion(versionId)
    if (!v) { await this.e.reply(`版本 ${versionId} 不存在`); return true }
    if (v.status !== 'verified') { await this.e.reply(`仅 verified 候选可采纳（当前状态：${v.status}）`); return true }
    if (rt.toolEvo.registry.isTrustedVersion(v, await rt.toolEvo.registry.getById(v.tool_id))) { await this.e.reply('内置/受信工具版本不可采纳为进化工具'); return true }
    try {
      await reg.setStatus(versionId, 'stable', { actor: 'master:' + this.e.user_id, reason: '手动采纳' })
      const stable = (await reg.listStable()).find((s) => s.versionId === versionId)
      if (stable) rt.tools.replace(await reg.toToolContract(stable, rt.toolEvo.runner))
      await this.e.reply(`✅ ${v.manifest.name}@${v.semver} 已晋升 stable 并注入\nagent 可经 tool_search 调用（工具名：${v.manifest.name}）`)
    } catch (e) { await this.e.reply('❌ 采纳失败：' + (e?.message || e)) }
    return true
  }
,


  async toolEvoDecommission() {
    const versionId = this.e.msg.replace(/^#淘汰工具\s+/, '').trim()
    let rt; try { rt = await getRuntime() } catch (e) { await this.e.reply(String(e?.message || e)); return true }
    if (!rt?.toolEvo?.registry) { await this.e.reply('工具进化未启用'); return true }
    const reg = rt.toolEvo.registry
    const v = await reg.getVersion(versionId)
    if (!v) { await this.e.reply(`版本 ${versionId} 不存在`); return true }
    if (rt.toolEvo.registry.isTrustedVersion(v, await rt.toolEvo.registry.getById(v.tool_id))) { await this.e.reply('内置/受信工具版本不可淘汰（请在插件源码/配置维护）'); return true }
    try {
      // 淘汰只影响目标版本（审计 §4.1）：目标=active → 自动回滚到另一 stable 或下线；目标≠active → 仅 DB deprecated，不影响注入
      const tool = await reg.getById(v.tool_id)
      const wasActive = tool?.active_version_id === versionId
      await reg.setStatus(versionId, 'deprecated', { actor: 'master:' + this.e.user_id, reason: '手动淘汰' })
      if (wasActive) {
        const others = await reg.listVersions({ toolId: v.tool_id, status: 'stable' })
        if (others.length) {
          const target = others[0]
          await reg.setActiveVersion(v.tool_id, target.id, { actor: 'master:' + this.e.user_id, reason: `淘汰 ${v.semver} 后回滚` })
          const stable = (await reg.listStable()).find((s) => s.versionId === target.id)
          if (stable) rt.tools.replace(await reg.toToolContract(stable, rt.toolEvo.runner))
          await this.e.reply(`🗑️ ${v.manifest.name}@${v.semver} 已淘汰（原 active）。已自动回滚到 ${target.semver} 并重新注入。`)
        } else {
          rt.tools.unregister(v.manifest.name)
          await this.e.reply(`🗑️ ${v.manifest.name}@${v.semver} 已淘汰并下线（无其它 stable 可回滚；制品保留作审计）`)
        }
      } else {
        await this.e.reply(`🗑️ ${v.manifest.name}@${v.semver} 已淘汰（非 active，注入的 active 版本不受影响；制品保留作审计）`)
      }
    } catch (e) { await this.e.reply('❌ 淘汰失败：' + (e?.message || e)) }
    return true
  }
,


  // #回滚工具 <工具名> <semver>：切 active 到指定 stable 版本 + 重新注入（审计 §4.1 版本回滚）
  async toolEvoRollback() {
    const m = this.e.msg.match(/^#回滚工具\s+(\S+)\s+(\S+)/)
    if (!m) { await this.e.reply('用法：#回滚工具 <工具名> <semver>，如\n#回滚工具 extract_email 1.0.0'); return true }
    const [, name, semver] = m
    let rt; try { rt = await getRuntime() } catch (e) { await this.e.reply(String(e?.message || e)); return true }
    if (!rt?.toolEvo?.registry) { await this.e.reply('工具进化未启用'); return true }
    const reg = rt.toolEvo.registry
    try {
      const tool = await reg.getByName(name)
      if (!tool) { await this.e.reply(`工具「${name}」不存在`); return true }
      if (tool.namespace !== 'evolved') { await this.e.reply(`「${name}」是内置/受信工具，不可由工具进化回滚`); return true }
      const target = (await reg.listVersions({ toolId: tool.id, status: 'stable' })).find((vv) => vv.semver === semver)
      if (!target) { await this.e.reply(`「${name}」无 stable 版本 ${semver}（回滚目标须是已上线版本）`); return true }
      await reg.setActiveVersion(tool.id, target.id, { actor: 'master:' + this.e.user_id, reason: `手动回滚到 ${semver}` })
      rt.tools.unregister(name)
      const stable = (await reg.listStable()).find((s) => s.versionId === target.id)
      if (stable) rt.tools.replace(await reg.toToolContract(stable, rt.toolEvo.runner))
      await this.e.reply(`↩️ ${name} 已回滚到 ${semver} 并重新注入（active 版本切换）`)
    } catch (e) { await this.e.reply('❌ 回滚失败：' + (e?.message || e)) }
    return true
  }
,


  async toolEvoHealth() {
    let rt; try { rt = await getRuntime() } catch (e) { await this.e.reply(String(e?.message || e)); return true }
    if (!rt?.toolEvo?.registry) { await this.e.reply('工具进化未启用（config: agent.toolEvo.enable）'); return true }
    const { failureClusters, convergenceMetrics } = await import('../../../model/toolEvo/evaluator.js')
    const [clusters, metrics] = await Promise.all([failureClusters({ namespace: 'evolved' }), convergenceMetrics({ namespace: 'evolved' })])
    const head = `📊 工具库：${metrics.activeStable} active / ${metrics.stable} stable / ${metrics.totalVersions} 总版本 · 调用 ${metrics.invocations} 次（失败率 ${(metrics.invocationFailRate * 100).toFixed(0)}%）· 复用率 ${(metrics.reuseRate * 100).toFixed(0)}%`
    if (!clusters.length) {
      // 样本不足不得写成“全部健康”：需足够真实调用才能判定
      const enough = metrics.invocations >= 3 && metrics.activeStable > 0
      await this.e.reply(enough
        ? `${head}\n\n✅ 当前样本下未发现高失败率 stable 工具`
        : `${head}\n\n⚠️ 调用样本不足，暂无法判定健康（需 ≥3 次真实调用且存在 active 版本）`)
      return true
    }
    const lines = clusters.map((c) => `⚠️ ${c.toolName}（${c.versionId}）：失败率 ${(c.failRate * 100).toFixed(0)}%（${c.failed}/${c.total}）· ${c.topErrors.join(', ')}`)
    await this.e.reply(`${head}\n\n${lines.join('\n')}\n\n用 #进化工具 修复 <工具名> <修复描述> 生成修复候选（会继承父版本测试）`)
    return true
  }
,


  async reviewList() {
    let rt; try { rt = await getRuntime() } catch (e) { await this.e.reply(String(e?.message || e)); return true }
    const ctx = ctxOf(this.e)
    const list = listPendingSuggestions(rt.suggestionDir, ctx.scopeId)
    if (!list.length) {
      const every = Config.get().agent?.selfReview?.every || 20
      await this.e.reply(`当前无待审的自评审 suggestion。\n（后台每 ${every} 轮对话自动产出；memory 类已自动应用，此处仅列 skill/prompt 及低置信 memory）`)
      return true
    }
    const lines = list.map((s, i) => `${i + 1}. [${s.kind}] conf=${(s.confidence || 0).toFixed(2)} id=${s.id}\n   内容：${String(s.payload || '').slice(0, 100)}\n   理由：${String(s.rationale || '').slice(0, 60)}`)
    await this.e.reply(`待审 suggestion（共 ${list.length} 条）—— #采纳 <id> 应用 / #拒绝进化 <id> 丢弃：\n\n${lines.join('\n\n')}`)
    return true
  }
,


  async reviewAdopt() {
    // 支持 `#采纳 <id> <用户原话>`：人工放行「用户要求」类记忆时必须由操作者提供用户原话，
    // 不能用建议自带的 evidence 自证（2026-10-17 审计 medium-1：否则幻觉条目连同伪造 evidence 一起落库）。
    const raw = this.e.msg.replace(/^#采纳\s+/, '').trim()
    const sp = raw.indexOf(' ')
    const id = (sp > 0 ? raw.slice(0, sp) : raw).trim()
    const operatorText = (sp > 0 ? raw.slice(sp + 1) : '').trim()
    let rt; try { rt = await getRuntime() } catch (e) { await this.e.reply(String(e?.message || e)); return true }
    const ctx = ctxOf(this.e)
    const list = listPendingSuggestions(rt.suggestionDir, ctx.scopeId)
    const s = list.find((x) => x.id === id)
    if (!s) { await this.e.reply(`未找到待审 suggestion：${id}`); return true }
    // skill 无自动应用机制：不再「回一句已采纳 + 删掉建议文件」（那会把内容彻底丢掉），保留待审等人处理
    if (s.kind === 'skill') {
      await this.e.reply(`[skill] suggestion 需手工编辑 skills/ 对应文件，本条**保留在待审列表**：\n${String(s.payload || '').slice(0, 200)}\n\n处理完可用 #拒绝进化 ${s.id} 丢弃这条记录。`)
      return true
    }
    // 其余类型统一复用 Web 面板那条路径（prompt/memory/tool）：命令与面板行为一致，
    // 失败时 applySuggestion 会保留 suggestion（不再出现「已采纳但什么都没写、建议文件已删」的静默丢失）。
    try {
      const r = await applySuggestion(rt, s, { userTexts: operatorText ? [operatorText] : [] })
      await this.e.reply(`✅ ${r?.note || '已采纳'}`)
    } catch (e) {
      Log.warn('[evolution] 采纳失败', e?.message || e)
      await this.e.reply(`⚠️ 采纳失败（suggestion 保留，可稍后重试）：${e?.message || e}`)
    }
    return true
  }
,


  async reviewReject() {
    const id = this.e.msg.replace(/^#拒绝进化\s+/, '').trim()
    let rt; try { rt = await getRuntime() } catch (e) { await this.e.reply(String(e?.message || e)); return true }
    const ctx = ctxOf(this.e)
    const ok = removeSuggestion(rt.suggestionDir, ctx.scopeId, id)
    await this.e.reply(ok ? `已拒绝并删除 suggestion：${id}` : `未找到 suggestion：${id}`)
    return true
  }
,


  async promptRollback() {
    const key = this.e.msg.replace(/^#回滚\s+/, '').trim()
    // 键白名单：此前 `#回滚 ../../../x` 会 path.join 越出 promptDir 并 unlinkSync 删掉任意 .json
    if (!/^[A-Za-z0-9_-]+$/.test(key)) { await this.e.reply('❌ 模板键只能是字母/数字/下划线/短横线，如 #回滚 agent'); return true }
    let rt; try { rt = await getRuntime() } catch (e) { await this.e.reply(String(e?.message || e)); return true }
    const file = path.join(rt.promptDir, `${key}.json`)
    let removed = false
    try { fs.unlinkSync(file); removed = true } catch { /* 进化产出文件不存在 */ }
    const builtin = TEMPLATES[key]
    if (builtin) rt.promptRegistry.register(PromptTemplate.fromTemplateEntry(key, builtin)) // 引用共享：Agent 下轮自动用回默认
    await this.e.reply(removed ? `✅ 已回滚 ${key} 到内置默认（删除进化产出，下轮生效）` : `${key} 未找到进化产出文件（可能本就是默认版）`)
    return true
  }
,


  async evolvePrompt() {
    const key = this.e.msg.replace(/^#进化\s+prompt\s+/, '').trim()
    let rt; try { rt = await getRuntime() } catch (e) { await this.e.reply(String(e?.message || e)); return true }
    const cfg = Config.get().agent || {}
    if (!rt.traceStore?.size) { await this.e.reply('TraceStore 暂无对话轨迹，先正常聊几轮再进化（每轮对话自动采迹）。'); return true }
    // 引擎（evolveTemplate）只认内置 TEMPLATES，registry 里的非内置键（data/evolution/prompts/*.json 覆盖文件）
    // 进不去：此处必须同口径拒绝，否则先回「开始进化」再回「未知模板」，且该分支永远走不通
    if (!TEMPLATES[key]) { await this.e.reply(`未知 prompt 模板：${key}（可进化：${Object.keys(TEMPLATES).join(', ')}）`); return true }
    await this.e.reply(`⏳ 开始离线进化 prompt「${key}」：采样轨迹 → GEPA 迭代 → LLM-as-judge 评分（约 1-3 分钟、消耗较多 token，期间勿重复触发）…`)
    try {
      const samples = rt.traceStore.sample(8)
      const evalset = samples.map((t, i) => ({ id: String(i), input: String(t.input || '') })).filter((s) => s.input)
      // LLM-as-judge：无 check 的 case 用主模型评「回复是否正面回应、有无臆测/跑题」(0~1)
      const judge = {
        score: async (item, output) => {
          const p = `用户问题：${String(item.input).slice(0, 200)}\n助手回复：${String(output).slice(0, 300)}\n\n请给回复打分(0~1)：是否正面回应问题、有无明显错误/臆测/跑题。只输出一个小数。`
          try {
            const res = await rt.provider.chat({ model: cfg.model, messages: [{ role: 'user', content: p }], stream: false, temperature: 0 })
            const m = String(res?.content || '').match(/(1(?:\.0+)?|0?\.\d+)/)
            return { score: m ? Math.max(0, Math.min(1, parseFloat(m[1]))) : 0.5 }
          } catch { return { score: 0.5 } }
        },
      }
      const result = await evolveTemplate({ templateKey: key, provider: rt.provider, model: cfg.model, evalset, judge, iterations: 2, populationSize: 3, logger: Log.tag('evolve') })
      if (!result?.best) { await this.e.reply('进化未产出有效版本。'); return true }
      // 产出与当前文本相同 → 无实质进化：不落盘（否则只是刷一个新的版本号）
      if (result.unchanged || String(result.best.text) === String(TEMPLATES[key]?.system || '')) {
        await this.e.reply(`ℹ️ 本轮进化未产出与当前不同的版本（评分 ${Number(result.best.score ?? 0).toFixed(3)}），已跳过写入。可先多聊几轮积累轨迹后再试。`)
        return true
      }
      // 回归门禁：best 得分不得低于 baseline（默认允许 0.01 波动）且需达到最低分，否则不落盘
      const gate = regressionGate(
        { meanScore: result.best.score ?? 0 },
        { meanScore: result.baseline?.score },
      )
      if (!gate.passed) {
        await this.e.reply(`⛔ 未通过回归门禁，已放弃写入进化版本：\n- ${gate.reasons.join('\n- ')}`)
        return true
      }
      const tpl = rt.promptRegistry.get(key)
      const base = tpl ? tpl.toJSON() : { id: key, system: TEMPLATES[key]?.system || '' }
      // 审批闸门（2026-10-17 审计 medium）：旧实现直接写 data/evolution/prompts/<key>.json，
      // 而 getRuntime 会无条件注册该目录下所有 *.json → 下次重载即静默替换线上 system 提示词；
      // 同时 #审阅进化/#采纳 只读 suggestions/，永远找不到这条产出 —— 所谓「待审」是假的。
      // 现在只产出 pending suggestion，采纳（applySuggestion）后才落盘 prompts/ 并热生效。
      const ectx = ctxOf(this.e)
      const sug = {
        kind: 'prompt',
        action: 'replace',
        target: key,
        payload: String(result.best.text),
        rationale: `离线进化 best=${Number(result.best.score ?? 0).toFixed(3)} / baseline=${Number(result.baseline?.score ?? 0).toFixed(3)}（基线版本 ${base.version || '1.0.0'}）`,
        confidence: Number(result.best.score) || 0,
        status: 'pending',
        scope: ectx.scopeUserId,
        scopeId: ectx.scopeId,
        ts: Date.now(),
        id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      }
      if (!persistSuggestion(rt.suggestionDir, sug)) {
        await this.e.reply('⚠️ 进化完成但候选落盘失败（未写入 suggestions/，请检查 data/evolution/suggestions/ 权限）。')
        return true
      }
      await this.e.reply(`✅ 进化完成：best=${(result.best.score || 0).toFixed(3)}（baseline=${(result.baseline?.score || 0).toFixed(3)}，${result.improved ? '✨已提升' : '未提升'}）\n已生成待审候选：${sug.id}\n#审阅进化 → #采纳 ${sug.id} 应用（采纳后才写入 prompts/ 并下轮生效）；#拒绝进化 ${sug.id} 丢弃。#回滚 ${key} 可恢复内置默认。`)
    } catch (e) { await this.e.reply(`进化失败：${e?.message || e}`) }
    return true
  }
,


  // —— LLM 自进化（手动触发；平时每 N 轮自动跑）——
  async llmEvolve() {
    const rt = await getRuntime()
    if (!rt?.selfReview) return this.e.reply('⚠️ 自进化未启用（config agent.selfReview.enable）'), true
    const ctx = ctxOf(this.e)
    await this.e.reply('🧬 开始 LLM 自进化评审（近期对话轨迹 + 记忆快照 → 产出改进 suggestion）…')
    try {
      const r = await rt.selfReview.force(ctx)
      if (r?.error) return this.e.reply(`⚠️ ${r.error}`), true
      await this.e.reply(r.suggestionCount > 0
        ? `✓ 自进化完成，产出 ${r.suggestionCount} 条 suggestion\n（memory 类已自动应用；prompt/技能类待审：#审阅进化）`
        : '✓ 自进化完成，本轮无新 suggestion（近期对话暂无改进点）')
    } catch (e) {
      await this.e.reply(`⚠️ 评审失败：${e?.message || e}`)
    }
    return true
  }

}
