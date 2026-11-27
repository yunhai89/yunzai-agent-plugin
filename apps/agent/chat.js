/**
 * Chat 插件类：构造函数/触发判定 + 各命令组装配（原 apps/agent.js 类主体）。
 *
 * 命令实现按领域拆到 ./commands/*：
 *   chat      AI 对话主循环、会话管理
 *   admin     模型/沙箱/抓取环境/重载/ID/错误上报/审批
 *   mcp       MCP 服务端管理
 *   memory    长期记忆/画像/知识库/清空数据
 *   tasks     提醒/定时任务/任务账本
 *   persona   人设与资料补齐
 *   evolution 工具进化/提示词进化/自评审
 */
import plugin from '../../../../lib/plugins/plugin.js'
import Config from '../../utils/Config.js'
import Log from '../../utils/Log.js'
import { recordGroupMessage } from '../../model/group/history-store.js'
import { installMasterGate, isEventMaster } from '../../model/qqofficial/guard.js'
import { groupRoleOf } from '../../model/qqofficial/index.js'
import { getRuntime, logInitErrorOnce } from './runtime.js'
import { takeMcpAddPending } from './commands/mcp.js'
import { chatCommands } from './commands/chat.js'
import { adminCommands } from './commands/admin.js'
import { mcpCommands } from './commands/mcp.js'
import { memoryCommands } from './commands/memory.js'
import { taskCommands } from './commands/tasks.js'
import { personaCommands } from './commands/persona.js'
import { evolutionCommands } from './commands/evolution.js'

/**
 * chatPermission 未知取值告警去重（Chat 每事件 new，不能挂在实例上）。
 */
let _chatPermWarned = false

/**
 * agents-plugin 对话命令。
 *   触发 AI：艾特机器人（默认）或自定义触发词（agent.trigger: at|command|both + triggerCommand）
 *   #聊天列表 / #进入聊天 <id> / #new          多对话管理
 *   #确认/#拒绝/#待确认（master）              审批
 *   #记忆 / #忘掉 <kw>                         长期记忆
 *   #画像 / #忘记画像 <kw>                      统一用户画像（查看/移除）
 *   #我的提醒 / #取消提醒 <id>                  提醒
 *   #模型切换 <id>（master）                    切换模型
 *   #启用mcp <名> / #停止mcp <名>（master）     MCP 服务端启停
 *   #mcp（master）                             MCP 状态
 *   #沙箱诊断 [预览|修复]（master）              E2B 出口网络自检 + 沙箱内实测
 * 主人判定：主人指令用 Yunzai 原生 permission:'master'（即 e.isMaster / cfg.master）。
 * 例外：terminal 工具已全员开放（无身份门槛，隔离靠 E2B microVM），不再有独立认领。
 */
export class Chat extends plugin {
  constructor() {
    super({
      name: 'agent对话',
      dsc: 'AI Agent 对话（多轮/工具/记忆/安全/审批/MCP）',
      event: 'message',
      priority: 9999,
      rule: [
        // —— 主人指令 ——
        { reg: '^#启用mcp\\s+(.+)', fnc: 'enableMcp', permission: 'master' },
        { reg: '^#停止mcp\\s+(.+)', fnc: 'disableMcp', permission: 'master' },
        { reg: '^#模型切换\\s+(.+)', fnc: 'switchModel', permission: 'master' },
        { reg: '^#确认\\s*(\\d+)', fnc: 'approve' }, // 审批（定时任务等；terminal 已沙箱化、stagehand act 不单独审批）
        { reg: '^#拒绝\\s*(\\d+)', fnc: 'reject' },
        { reg: '^#待确认$', fnc: 'pending' },
        { reg: '^#mcp$', fnc: 'mcpStatus', permission: 'master' },
        { reg: '^#沙箱诊断(?:\\s+(\\S+))?$', fnc: 'sandboxDiag', permission: 'master' },
        { reg: '^#抓取环境(?:\\s+(\\S+))?$', fnc: 'crawlSetup', permission: 'master' },
        { reg: '^#添加[Mm][Cc][Pp]', fnc: 'addMcp', permission: 'master' },
        { reg: '^#agent重载$', fnc: 'agentsReload', permission: 'master' },
        { reg: '^#进化工具\\s+([\\s\\S]+)', fnc: 'toolEvoEvolve', permission: 'master' },
        { reg: '^#工具进化列表$', fnc: 'toolEvoList', permission: 'master' },
        { reg: '^#采纳工具\\s+(\\S+)', fnc: 'toolEvoAdopt', permission: 'master' },
        { reg: '^#淘汰工具\\s+(\\S+)', fnc: 'toolEvoDecommission', permission: 'master' },
        { reg: '^#回滚工具\\s+(\\S+)\\s+(\\S+)', fnc: 'toolEvoRollback', permission: 'master' },
        { reg: '^#工具健康$', fnc: 'toolEvoHealth', permission: 'master' },
        { reg: '^#openrouter余额$', fnc: 'openrouterBalance', permission: 'master' },
        { reg: '^#知识库添加[\\s\\S]*', fnc: 'addKnowledge', permission: 'master' },
        { reg: '^#知识库列表$', fnc: 'listKnowledge' },
        { reg: '^#知识库删除\\s+(\\S+)', fnc: 'delKnowledge', permission: 'master' },
        { reg: '^#知识库重建$', fnc: 'rebuildKnowledge', permission: 'master' },
        { reg: '^#知识库刷新全部$', fnc: 'refreshAllKnowledge', permission: 'master' },
        { reg: '^#知识库刷新\\s+(\\S+)', fnc: 'refreshKnowledge', permission: 'master' },
        { reg: '^#知识库定时\\s+(\\S+)\\s+([\\s\\S]+)', fnc: 'setKbRefresh', permission: 'master' },
        { reg: '^#知识库取消定时\\s+(\\S+)', fnc: 'cancelKbRefresh', permission: 'master' },
        { reg: '^#向量库状态$', fnc: 'vectorStatus', permission: 'master' },
        { reg: '^#定时任务\\s+[\\s\\S]+', fnc: 'addCronTask', permission: 'master' },
        { reg: '^#定时任务列表$', fnc: 'listCronTask' },
        { reg: '^#取消定时任务\\s+(\\S+)', fnc: 'cancelCronTask', permission: 'master' },
        { reg: '^#LLM进化$', fnc: 'llmEvolve', permission: 'master' },
        // —— 所有用户 ——
        { reg: '^#聊天列表$', fnc: 'chatList' },
        { reg: '^#进入聊天\\s*([0-9a-zA-Z]+)', fnc: 'enterChat' },
        { reg: '^#new$', fnc: 'newChat' },
        { reg: '^#记忆$', fnc: 'showMemory' },
        { reg: '^#忘掉\\s+(.+)', fnc: 'forget' },
        { reg: '^#画像$', fnc: 'showProfile' },
        { reg: '^#忘记画像\\s+(.+)', fnc: 'forgetProfile' },
        { reg: '^#我的提醒$', fnc: 'myReminders' },
        { reg: '^#取消提醒\\s*(\\d+)', fnc: 'cancelReminder' },
        { reg: '^#任务列表$', fnc: 'listTasks' },
        { reg: '^#任务状态\\s+(\\S+)', fnc: 'taskStatus' },
        { reg: '^#继续任务\\s+(\\S+)', fnc: 'resumeTask' },
        { reg: '^#恢复任务\\s+(\\S+)', fnc: 'recoverTask' },
        { reg: '^#取消任务\\s+(\\S+)', fnc: 'cancelTask' },
        { reg: '^#清空所有记录$', fnc: 'clearMyData' },
        // —— 人设 ——（更具体的规则在前，避免被 #人设+id 吞掉）
        { reg: '^#人设列表$', fnc: 'personaList' },
        { reg: '^#人设详情\\s+(.+)', fnc: 'personaDetail' },
        { reg: '^#新建人设\\s+(.+)', fnc: 'personaCreate' },
        { reg: '^#删除人设\\s+(.+)', fnc: 'personaDelete' },
        { reg: '^#人设补齐\\s+(.+)', fnc: 'personaComplete', permission: 'master' },
        { reg: '^#查看补齐\\s+(.+)', fnc: 'personaDraftView', permission: 'master' },
        { reg: '^#采纳补齐\\s+(.+)', fnc: 'personaDraftAdopt', permission: 'master' },
        { reg: '^#丢弃补齐\\s+(.+)', fnc: 'personaDraftDiscard', permission: 'master' },
        { reg: '^#刷新人设资料\\s+(.+)', fnc: 'personaDraftRefresh', permission: 'master' },
        { reg: '^#人设资料定时列表$', fnc: 'personaDraftScheduleList', permission: 'master' },
        { reg: '^#人设资料取消定时\\s+(.+)', fnc: 'personaDraftCancelSchedule', permission: 'master' },
        { reg: '^#人设资料定时\\s+(.+)', fnc: 'personaDraftSchedule', permission: 'master' },
        { reg: '^#重置人设$', fnc: 'personaReset' },
        { reg: '^#人设$', fnc: 'personaList' },
        { reg: '^#人设\\s+(.+)', fnc: 'personaSwitch' },
        // —— QQ 官方机器人协议排障：ID 与上下文 ——
        // 官方机器人返回的是 openid（<self_id>:<openid> / qg_...），不是 QQ 号/群号；
        // 这两个指令打印「可直接粘贴进配置」的原始 ID，避免按 QQ 号配置后静默不生效。
        // TRSS 默认把行首 `/` 转成 `#`（config.bot["/→#"]=true），两种写法都要认。
        // 与喵喵/原神插件的 #uid（priority 300）重名：官方协议下由 accept 抢先接管，
        // 普通协议让给喵喵；#uidinfo 是本插件的无冲突别名。
        { reg: '^\\s*[#/]\\s*uidinfo\\s*$', fnc: 'showUid' },
        { reg: '^\\s*[#/]\\s*uid\\s*$', fnc: 'showUid' },
        { reg: '^\\s*[#/]\\s*groupid\\s*$', fnc: 'showGroupId' },
        // —— 在线自进化：审阅 / 采纳 / 拒绝 / 回滚（主人）——
        { reg: '^#审阅进化$', fnc: 'reviewList', permission: 'master' },
        { reg: '^#采纳\\s+(.+)', fnc: 'reviewAdopt', permission: 'master' },
        { reg: '^#拒绝进化\\s+(.+)', fnc: 'reviewReject', permission: 'master' },
        { reg: '^#回滚\\s+(.+)', fnc: 'promptRollback', permission: 'master' },
        { reg: '^#进化\\s+prompt\\s+(.+)', fnc: 'evolvePrompt', permission: 'master' },
        // —— 错误上报 ——
        { reg: '^#上报错误(?:\\s+([\\s\\S]+))?$', fnc: 'reportBug' },
        // —— AI 触发（catch-all，最后匹配；@或自定义触发词）——
        // 必须匹配空串：引用图片 + @机器人 时 e.msg 里没有 text 段（图片/at/reply 都不进 msg），
        // 旧规则 `+` 要求至少一个字符 → 消息根本进不到 onTrigger，表现就是"只引用图片不触发"。
        // 真正的空消息拦截放在 onTrigger 里（裸 @、无媒体时返回 false）。
        { reg: '^[\\s\\S]*$', fnc: 'onTrigger', log: false },
      ],
    })
    // QQ 官方机器人主人兜底：规则级 permission:'master' 依赖框架 e.isMaster（按 QQ 号匹配），
    // openid 场景永远 false → 所有主人指令不可用。改为插件内判定（agent.masters 支持完整/去前缀 openid）。
    installMasterGate(this)
    // 运行时装配完成后会自动恢复定时调度（见 getRuntime 的 .then）；此处只预热运行时并处理初始化失败提示。
    getRuntime().catch(logInitErrorOnce)
  }

  // —— AI 触发 ——
  async onTrigger() {
    // 过滤 bot 自己发的消息：NapCat 开了 report-self-message 时，bot 的发言（如"思考中…"进度、
    // 工具播报）会被投递回 message 事件。私聊下 onTrigger 无脑触发，若不过滤 self 会死循环——
    // bot 发"思考中…" → 被当用户输入 → 回复 → 又发进度消息 → 再触发……（曾烧出单轮 27k token 循环）
    const __selfId = this.e.self_id || this.e.bot?.self_id
    if (__selfId && (String(this.e.user_id) === String(__selfId) || String(this.e.sender?.user_id || '') === String(__selfId))) {
      return false
    }
    // 本地群消息缓存：QQ 官方机器人没有历史消息 API，get_chat_history 需要这份兜底数据。
    // 放在触发判定之前，确保非 @ 的旁听消息也能进入缓存（需官方平台「全量消息」权限）。
    try { recordGroupMessage(this.e) } catch { /* 缓存失败不影响正常对话 */ }
    // #添加mcp 交互式监听：私聊下，待接收 JSON 的用户，本条消息当作 mcpServers 配置处理
    if (!this.e.isGroup && takeMcpAddPending(this.e.user_id)) return this._consumeMcpAddJson(this.e.msg)
    const cfg = Config.get().agent || {}
    const mode = cfg.trigger || 'at' // at | command | both
    const cmd = cfg.triggerCommand || '#ai'
    const text = (this.e.msg || '').trim()
    const atMode = mode !== 'command'
    const cmdMode = mode !== 'at'
    const isAt = !!this.e.atBot
    const cmdRe = new RegExp(`^${cmd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`)
    const isCmd = cmdMode && cmdRe.test(text)
    // 指令透传：`#设置主人` / `#重启` / `#帮助` 这类 **Yunzai 与其它插件的指令** 不能被 AI 抢走。
    // 官方机器人场景下群里通常必须 @机器人 才能发消息，@ + `#指令` 会被 catch-all 先接到 AI；
    // 私聊开了 privateChat 后同理。这里识别「指令前缀且不是本插件触发词」后 return false，
    // 框架会继续把事件交给后续插件（loader: res === false → continue）。
    const looksLikeCommand = /^\s*[#＃/／＊*※]/.test(text)
    if (cfg.commandPassThrough !== false && looksLikeCommand && !isCmd) {
      Log.mark('[trigger]', `指令透传（交给框架/其它插件）user=${this.e.user_id} gid=${this.e.group_id || '-'} text=${text.slice(0, 40)}`)
      return false
    }
    // media.enable=false 时不把媒体算作触发条件（图片/文件消息不触发，避免每张图都回"未识别到"）
    const hasMedia = cfg.media?.enable !== false && this._hasMedia(this.e)
    // 触发条件：命令匹配 ｜（@机器人 且（有文字 或 有媒体））。
    // 关键：纯引用图片/文件无文字也算触发（问题4）—— 媒体由 _handleAgent 注入默认指令处理。
    // 私聊直接触发（私聊无 @，at 模式下原本不触发；私聊任何消息都该能对话）
    const isPrivate = !this.e.isGroup
    // 私聊默认禁用（agent.privateChat=false）；开启后私聊任何消息直接触发。
    // 注意：位置在 `#添加mcp` 交互监听之后，主人私聊补 MCP JSON 的流程不受影响。
    if (isPrivate && cfg.privateChat !== true) {
      Log.mark('[trigger]', `私聊对话已禁用（agent.privateChat=false）user=${this.e.user_id}`)
      return false
    }
    if (!(isPrivate || isCmd || (atMode && isAt && (text || hasMedia)))) return false
    // chatPermission：仅约束群内 `#ai` 命令（@机器人/私聊不受限，保持向后兼容）
    if (isCmd && !isPrivate && !this._hasChatPermission(cfg)) {
      Log.mark('[trigger]', `命令权限不足：user=${this.e.user_id} gid=${this.e.group_id || '-'} need=${cfg.chatPermission || 'master'}`)
      try { await this.e.reply(`你没有使用「${cmd}」的权限（agent.chatPermission=${cfg.chatPermission || 'master'}）；可直接 @机器人 对话。`) } catch { /* best effort */ }
      return true
    }
    const input = isCmd ? text.replace(cmdRe, '').trim() : text
    if (!input && !hasMedia) return false // 既无文字又无媒体（如裸 `#ai`）：不触发
    Log.mark('[trigger]', `user=${this.e.user_id} gid=${this.e.group_id || '-'} mode=${isCmd ? 'cmd' : 'at'} inputLen=${input.length} media=${hasMedia}`)
    return this._handleAgent(input)
  }


  /**
   * chatPermission：群内 `#ai` 命令的触发权限（master/admin/owner/all；@机器人 与私聊不受限）。
   * 兜底 master（yaml 默认），未知取值按 master 处理并留痕——此前是 `|| 'all'` +「未知一律放行」，
   * 字段被清空/拼错时权限会静默放宽到所有人（配置互搏审计 F6/F8）。
   */
  _hasChatPermission(cfg) {
    const raw = String(cfg?.chatPermission ?? '').trim().toLowerCase()
    const perm = raw || 'master'
    if (!['master', 'admin', 'owner', 'all'].includes(perm)) {
      // 模块级去重（Chat 每个事件都 new，实例字段挡不住日志刷屏）
      if (!_chatPermWarned) {
        _chatPermWarned = true
        Log.warn(`[chatPermission] 未知取值「${raw}」，按 master 处理（合法值：master/admin/owner/all）`)
      }
      return isEventMaster(this.e)
    }
    if (perm === 'all') return true
    if (isEventMaster(this.e)) return true
    const role = groupRoleOf(this.e)
    const isOwner = role === 'owner'
    const isAdmin = role === 'admin'
    if (perm === 'owner') return isOwner
    if (perm === 'admin') return isOwner || isAdmin
    return false // master：仅主人（isMaster 已在上面放行）
  }


  /** 轻量探测：消息是否含图片/文件/音视频/合并转发(聊天记录)段，或引用了某条消息（引用的媒体由 collectActive 兜底拉取）。不发网络请求。 */
  _hasMedia(e) {
    const segs = e?.message
    const hasSeg = Array.isArray(segs) && segs.some((s) => s && ['image', 'file', 'record', 'video', 'flash', 'forward', 'xml', 'json'].includes(s.type))
    return !!(hasSeg || e?.reply_id != null)
  }

}

// 命令组装配：所有方法挂到同一 prototype，constructor 里的 fnc 字符串按名解析；
// 组内方法通过 this.* 互相调用，与拆分前完全一致。
Object.assign(
  Chat.prototype,
  chatCommands,
  adminCommands,
  mcpCommands,
  memoryCommands,
  taskCommands,
  personaCommands,
  evolutionCommands,
)
