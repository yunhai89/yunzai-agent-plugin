/**
 * 长期记忆 / 用户画像 / 知识库 / 清空数据命令（原 apps/agent.js）。
 */
import Config from '../../../utils/Config.js'
import Log from '../../../utils/Log.js'
import { isSharedScopeId, parseCron } from '../../../model/agent/index.js'
import { getRuntime } from '../runtime.js'
import { ctxOf } from '../context.js'

// userId → 确认清空的时间戳（2 步确认）
const _clearPending = new Map()

export const memoryCommands = {

  // —— 记忆 / 提醒 ——
  async showMemory() {
    const rt = await getRuntime()
    const ctx = ctxOf(this.e)
    const list = await rt.recall.listByUser(ctx.scopeUserId)
    const text = list.length ? rt.recall.formatForPrompt(list.slice(0, 20)) : rt.memory.snapshotAll(ctx.scopeId)
    await this.e.reply((text || '(记忆为空)').slice(0, 4000))
    return true
  }
,


  async forget() {
    const kw = this.e.msg.replace(/^#忘掉\s+/, '').trim()
    const rt = await getRuntime()
    const ctx = ctxOf(this.e)
    const n = await rt.recall.forget(ctx.scopeUserId, kw)
    await this.e.reply(n ? `已遗忘 ${n} 条含「${kw}」的记忆` : `未找到含「${kw}」的记忆`)
    return true
  }
,


  // 统一用户画像：查看当前 scope 的结构化长期归纳
  async showProfile() {
    const rt = await getRuntime()
    if (!rt.profile) return this.e.reply('用户画像未启用（agent.profile.enable=false）'), true
    const ctx = ctxOf(this.e)
    const block = await rt.profile.build(ctx.scopeUserId)
    await this.e.reply((block || '(画像为空，继续对话会自动积累；可在配置中关闭 agent.profile.enable)').slice(0, 4000))
    return true
  }
,


  // 从画像中移除（标记 superseded，保留审计链）
  async forgetProfile() {
    const kw = this.e.msg.replace(/^#忘记画像\s+/, '').trim()
    if (!kw) return this.e.reply('用法：#忘记画像 <关键词>'), true
    const rt = await getRuntime()
    if (!rt.profile) return this.e.reply('用户画像未启用（agent.profile.enable=false）'), true
    const ctx = ctxOf(this.e)
    const r = await rt.profile.correct(ctx.scopeUserId, { matchText: kw })
    await this.e.reply(r.superseded ? `已从画像中移除 ${r.superseded} 条含「${kw}」的内容` : `画像中未找到含「${kw}」的内容`)
    return true
  }
,


  // —— 知识库（全局共享文档库，embedding RAG）——
  async addKnowledge() {
    const rt = await getRuntime()
    const ctx = ctxOf(this.e)
    if (!ctx.isMaster) return this.e.reply('仅主人可添加知识库'), true
    // kb.enable 是总开关（yaml：关则不注册 kb_search、不入库）；crawlEnable 额外管「URL 抓取/刷新」。
    // 此前两个键只 gate 工具注册，命令仍会入库/抓网页（配置互搏审计 F12）。
    const kbCfgNow = Config.get().agent?.kb || {}
    if (kbCfgNow.enable === false) return this.e.reply('知识库已关闭（agent.kb.enable=false），不接收入库'), true
    let text = this.e.msg.replace(/^#知识库添加\s*/, '').trim()
    // 回复一条消息入库：命令无文本但有 reply_id → 取被回复消息正文
    if (!text && this.e.reply_id != null) {
      try {
        const replied = await (this.e.getReply?.() || this.e.bot?.getMsg?.(this.e.reply_id))
        const msg = replied?.message
        if (Array.isArray(msg)) text = msg.filter((s) => s?.type === 'text').map((s) => s.text || '').join('')
        else if (typeof replied?.content === 'string') text = replied.content
      } catch { /* noop */ }
    }
    if (!text) return this.e.reply('用法：\n#知识库添加 <文本或网址>\n例：\n#知识库添加 https://example.com\n#知识库添加 一段资料…\n或回复一条消息后发：#知识库添加'), true
    // URL 入库：抓取网页正文（crawl4ai 优先，降级 fetch）→ ingest
    if (/^https?:\/\//i.test(text)) {
      if (kbCfgNow.crawlEnable === false) return this.e.reply('网页抓取已关闭（agent.kb.crawlEnable=false），URL 不能入库；可改发文本内容'), true
      await this.e.reply(`🌐 抓取入库中（${text}）…`)
      const r = await rt.knowledge.ingestUrl(text)
      if (r.error) return this.e.reply(r.error), true
      await this.e.reply(`✓ 已抓取入库 ${r.id}：${r.title}\n${r.chunkCount} 块（via ${r.via}）${r.embedded ? '·已向量化' : '·关键词检索'}\n定时刷新最新：#知识库定时 ${r.id} 每天8点`)
      return true
    }
    const r = await rt.knowledge.ingest(text, { source: `command:${ctx.userId}` })
    if (r.error) return this.e.reply(r.error), true
    await this.e.reply(`✓ 已入库 ${r.id}：${r.chunkCount} 块${r.embedded ? '（已向量化）' : '（未配 embedding，关键词检索）'}`)
    return true
  }
,


  async listKnowledge() {
    const rt = await getRuntime()
    const docs = await rt.knowledge.listDocs()
    if (!docs.length) return this.e.reply('知识库为空（web 知识库页 或 #知识库添加 入库）'), true
    const lines = docs.map((d) => {
      const tag = d.url ? '🌐' : '📄'
      const cron = d.refreshCron ? ` ·定时(${d.refreshCron})` : ''
      const refreshed = d.lastCrawled ? ` ·刷新${new Date(d.lastCrawled).toLocaleDateString('zh-CN')}` : ''
      return `${tag} ${d.id} | ${d.title} | ${d.chunkCount}块${cron}${refreshed} | ${new Date(d.createdAt).toLocaleDateString('zh-CN')}`
    })
    await this.e.reply(`知识库（${docs.length} 篇；🌐=网页URL 可 #知识库刷新/#知识库定时）：\n${lines.join('\n')}`)
    return true
  }
,


  async delKnowledge() {
    const rt = await getRuntime()
    const id = (this.e.msg.match(/^#知识库删除\s+(\S+)/) || [])[1] || ''
    if (!id) return this.e.reply('用法：#知识库删除 <id>（id 见 #知识库列表）'), true
    const n = await rt.knowledge.removeDoc(id)
    await this.e.reply(n ? `已删除 ${id}` : `未找到 ${id}`)
    return true
  }
,


  async vectorStatus() {
    const rt = await getRuntime()
    const kb = Config.get().agent?.kb || {}
    const st = rt.knowledge?.vector?.stats?.() || null
    const gpu = rt.gpuInfo || {}
    const lines = [
      '🧠 向量库状态',
      `后端：${st?.backend || 'off'}${st?.requestedBackend ? `（请求：${st.requestedBackend}）` : ''}`,
      st?.backendReason ? `降级原因：${st.backendReason}` : '',
      `索引：${st?.size ?? 0} 条 / ${st?.dimension || 0} 维`,
      `GPU：${gpu.hasGpu ? `${gpu.name}${gpu.memoryMB ? `（${gpu.memoryMB}MB）` : ''}${gpu.driver ? ` · 驱动 ${gpu.driver}` : ''}` : `未检测到${gpu.reason ? `（${gpu.reason}）` : ''}`}`,
      `GPU 授权：${kb.vectorGpuConsent === true ? '已开启' : '未开启（auto 不会启用 GPU）'}`,
    ].filter(Boolean)
    if (gpu.hasGpu && kb.vectorBackend !== 'cuvs') {
      lines.push('开启 GPU：安装 cuvs-node 后设 agent.kb.vectorBackend=cuvs、agent.kb.vectorGpuConsent=true（确认 GPU 空闲后再开）')
    }
    if (st?.hnsw) lines.push(`HNSW：m=${st.hnsw.m} efConstruction=${st.hnsw.efConstruction} efSearch=${st.hnsw.efSearch} rerank=${st.hnsw.rerank}`)
    if (st?.cuvs) lines.push(`cuVS：algorithm=${st.cuvs.algorithm} rerank=${st.cuvs.rerank}`)
    await this.e.reply(lines.join('\n'))
    return true
  }
,


  async rebuildKnowledge() {
    const rt = await getRuntime()
    await this.e.reply('开始重建知识库索引…')
    const r = await rt.knowledge.rebuild()
    await this.e.reply(r.error ? r.error : `✓ 重建完成：${r.rebuilt} 块${r.indexed != null ? `（向量索引 ${r.indexed} 条）` : ''}`)
    return true
  }
,


  async refreshKnowledge() {
    const rt = await getRuntime()
    if (!ctxOf(this.e).isMaster) return this.e.reply('仅主人可操作'), true
    if (Config.get().agent?.kb?.crawlEnable === false) return this.e.reply('网页抓取已关闭（agent.kb.crawlEnable=false），无法刷新 URL 文档'), true
    const id = (this.e.msg.match(/^#知识库刷新\s+(\S+)/) || [])[1] || ''
    if (!id) return this.e.reply('用法：#知识库刷新 <id>（id 见 #知识库列表，仅 🌐 网页文档可刷新）'), true
    await this.e.reply(`🔄 刷新中（${id}）…`)
    const r = await rt.knowledge.refreshDoc(id)
    if (r.error) return this.e.reply(r.error), true
    await this.e.reply(`✓ 已刷新 ${id}：${r.chunkCount} 块（via ${r.via}）`)
    return true
  }
,


  async refreshAllKnowledge() {
    const rt = await getRuntime()
    if (!ctxOf(this.e).isMaster) return this.e.reply('仅主人可操作'), true
    if (Config.get().agent?.kb?.crawlEnable === false) return this.e.reply('网页抓取已关闭（agent.kb.crawlEnable=false），无法刷新 URL 文档'), true
    const urlDocs = await rt.knowledge.listUrlDocs()
    if (!urlDocs.length) return this.e.reply('知识库暂无网页 URL 文档（#知识库添加 <网址> 入库）'), true
    await this.e.reply(`🔄 开始刷新 ${urlDocs.length} 个网页文档（串行）…`)
    const r = await rt.knowledge.refreshAll()
    await this.e.reply(`✓ 刷新完成：${r.refreshed}/${r.total} 成功`)
    return true
  }
,


  async setKbRefresh() {
    const rt = await getRuntime()
    if (!ctxOf(this.e).isMaster) return this.e.reply('仅主人可操作'), true
    if (Config.get().agent?.kb?.enable === false || Config.get().agent?.kb?.crawlEnable === false) return this.e.reply('知识库/网页抓取已关闭（agent.kb.enable / agent.kb.crawlEnable），不能设定时刷新'), true
    const m = this.e.msg.match(/^#知识库定时\s+(\S+)\s+([\s\S]+)/) || []
    const id = m[1] || ''
    const when = (m[2] || '').trim()
    if (!id || !when) return this.e.reply('用法：#知识库定时 <id> <时间>\n如：#知识库定时 kbXXX 每天8点\n时间支持：每天8点 / 每2小时 / 工作日9点 / 每周一8点30'), true
    const cron = parseCron(when)
    if (!cron) return this.e.reply(`无法识别时间「${when}」。支持：每天8点 / 每2小时 / 工作日9点 / 每周一8点30`), true
    const r = await rt.knowledge.setRefresh(id, cron)
    if (r.error) return this.e.reply(r.error), true
    await this.e.reply(`✓ 已设定时刷新 ${id}\n周期：${when}（${cron}）\n取消：#知识库取消定时 ${id}`)
    return true
  }
,


  async cancelKbRefresh() {
    const rt = await getRuntime()
    if (!ctxOf(this.e).isMaster) return this.e.reply('仅主人可操作'), true
    const id = (this.e.msg.match(/^#知识库取消定时\s+(\S+)/) || [])[1] || ''
    if (!id) return this.e.reply('用法：#知识库取消定时 <id>'), true
    await rt.knowledge.cancelRefresh(id)
    await this.e.reply(`✓ 已取消 ${id} 的定时刷新`)
    return true
  }
,


  // —— 清空自己的所有记录（不含配置文件；2 步确认）——
  async clearMyData() {
    const rt = await getRuntime()
    const uid = String(this.e.user_id)
    const ctx = ctxOf(this.e)
    const sharedGroup = isSharedScopeId(ctx.scopeUserId) // 关闭隔离的群聊：会话/记忆为群共享，不清（避免一人清空全群）
    const now = Date.now()
    const last = _clearPending.get(uid)
    if (!last || now - last > 60000) {
      _clearPending.set(uid, now)
      await this.e.reply([
        '⚠️ 确认清空你的所有记录？将删除：',
        '· 全部对话历史',
        '· 长期记忆（recall）',
        '· 压缩归档（context_recall 的原文）',
        '· 个人笔记',
        '· 提醒',
        '· 人设绑定（恢复默认）',
        ...(sharedGroup ? ['（当前为「群共享」模式，群共享的对话/记忆不在此次清理范围）'] : []),
        '',
        '**不删除配置文件**。60 秒内再发一次「#清空所有记录」执行。',
      ].join('\n'))
      return true
    }
    _clearPending.delete(uid)
    try {
      const cleared = []
      // 会话：扫描归属当前用户的 session 键（keyUid=该 key 的归属用户；ON=本人各群会话；群共享 '__group__' 跳过）
      const sessPrefix = 'Yz:agent:sess:'
      let nSess = 0
      for (const k of await rt.kv.scan(sessPrefix)) {
        const tail = String(k).slice(sessPrefix.length)
        const parts = tail.split(':')
        // 保留编号序列（conv:seq:*）：对话 id 是不可复用身份，清空后新对话必须换新 id，
        // 否则会重新绑定到已删会话遗留的压缩归档目录（F02）。只清会话/活跃指针/消息。
        if (parts[0] === 'conv' && parts[1] === 'seq') continue
        let keyUid = null
        if (parts[0] === 'conv') keyUid = parts[1] === 'active' ? parts[3] : parts[2]
        else keyUid = parts[1] // 旧 group:user 会话 <gid>:<uid>
        if (keyUid === uid && !isSharedScopeId(keyUid)) { await rt.session.clear(k); nSess++ }
      }
      if (nSess) cleared.push(`对话历史(${nSess})`)
      // 压缩归档独立于会话 KV 落盘（按 convKey 分目录）：「清空所有记录」必须一并清理，
      // 否则旧原文仍可被新会话召回（F02）。群共享归档在 '__group__' 域，purge(uid) 不会误伤。
      const compactArchive = rt.agentConfig?.compactArchive
      if (compactArchive && typeof compactArchive.purge === 'function') {
        const nArch = compactArchive.purge(uid)
        if (nArch) cleared.push(`压缩归档(${nArch})`)
      }
      // 召回记忆（按真实 uid：ON=本人 recall；群共享 recall 在 '__group__' 下，不会被误清）
      await rt.recall.clearAll(uid); cleared.push('长期记忆')
      // 统一用户画像（按真实 uid，与 recall 同域）
      if (rt.profile) { await rt.profile.clear(uid); cleared.push('用户画像') }
      // 声明式记忆（按 scopeId 隔离的 MEMORY.md/USER.md；群共享模式跳过）
      if (!sharedGroup) { rt.memory.clear(ctx.scopeId); cleared.push('声明式记忆') }
      // 个人笔记
      await rt.kv.del(`Yz:agent:note:${uid}`); cleared.push('笔记')
      // 提醒
      const rems = await rt.schedule.listByUser(uid)
      for (const r of rems) await rt.schedule.cancel(r.id)
      if (rems.length) cleared.push(`提醒(${rems.length})`)
      // 任务账本（P0-3）：清理归属当前用户的任务记录（群共享任务不清，避免一人清全群）
      if (rt.taskStore) {
        // 分页扫全库（2026-10-17 审计 L2 + 回归审计 medium-7）：先只**收集**、扫完再删。
        // 边扫边删会让后续 offset 跳行；且旧实现「本页无命中就 break」，本人记录全在最新 500 条
        // 之外时一条也删不掉，却照样回「已清空你的所有记录」。
        const mineTasks = []
        for (let off = 0; off < 200 * 500; off += 500) {
          const batch = await rt.taskStore.list({ limit: 500, offset: off })
          if (!batch.length) break
          for (const t of batch) {
            const au = t.scope?.userId != null ? String(t.scope.userId) : ''
            const su = t.scope?.scopeUserId != null ? String(t.scope.scopeUserId) : ''
            if (isSharedScopeId(su)) continue // 群共享域：按群隔离，不清（避免一人清空全群）
            if (au === uid || su === uid) mineTasks.push(t)
          }
          if (batch.length < 500) break // 已是最后一页
        }
        let nTask = 0
        for (const t of mineTasks) {
          const r = await rt.taskStore.remove(t.taskId, { scopeKey: t.scopeKey })
          if (r?.ok) nTask++
        }
        if (nTask) cleared.push(`任务记录(${nTask})`)
      }
      // 人设绑定
      await rt.persona.resetActive(uid); cleared.push('人设绑定')
      await this.e.reply('✅ 已清空你的所有记录：' + cleared.join('、') + '\n（配置文件未动）')
    } catch (e) {
      Log.error('[clear] 清空失败', e?.message || e)
      await this.e.reply(`清空失败：${e?.message || e}`)
    }
    return true
  }

}
