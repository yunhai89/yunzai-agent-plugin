/**
 * MCP 服务端管理命令（原 apps/agent.js）。
 * 注意：#添加mcp 的「等待用户发 JSON」状态只在本进程有效（TTL 2 分钟），重启即清空。
 */
import Config from '../../../utils/Config.js'
import { getRuntime } from '../runtime.js'

// #添加mcp 交互式监听：私聊下记录"待接收 mcpServers JSON"的用户（带 TTL 防卡死；进程重启清空）
const MCP_ADD_PENDING_TTL = 120000 // 2 分钟
const mcpAddPending = new Map() // userId(String) -> { at }

/** 该用户是否正在等待补 MCP JSON；超时自动清理。 */
export function takeMcpAddPending(userId) {
  const uid = String(userId)
  const p = mcpAddPending.get(uid)
  if (!p) return false
  if (Date.now() - p.at > MCP_ADD_PENDING_TTL) { mcpAddPending.delete(uid); return false }
  return true
}

export const mcpCommands = {

  // —— MCP 启停 ——
  async enableMcp() {
    const name = this.e.msg.replace(/^#启用mcp\s+/, '').trim()
    const rt = await getRuntime()
    const cfg = Config.get().agent?.mcp?.servers?.[name]
    if (!cfg) return this.e.reply(`未在配置中找到 MCP 服务端：${name}`), true
    await rt.mcp.add(name, cfg)
    const s = rt.mcp.status()[name]
    await this.e.reply(s?.status === 'connected' ? `已启用 ${name}（${s.tools} 个工具）` : `启用 ${name} 失败：${s?.error || ''}`)
    return true
  }
,


  async disableMcp() {
    const name = this.e.msg.replace(/^#停止mcp\s+/, '').trim()
    const rt = await getRuntime()
    await rt.mcp.remove(name)
    await this.e.reply(`已停止 ${name}`)
    return true
  }
,


  // —— 添加 MCP（标准 mcpServers JSON）→ 连接验证 → 成功则持久化 ——
  // 两种用法：① #添加mcp <JSON> 一行带配置（任意会话）；
  //          ② 私聊发 #添加mcp（不带 JSON）进入监听，下一条消息当作 JSON 处理（onTrigger 拦截），处理一次即结束。
  //          群聊不带 JSON 只显示用法（群聊不开监听，避免群消息被吞）。
  async addMcp() {
    const body = this.e.msg.replace(/^#添加mcp\b\s*/i, '').trim()
    if (!body) {
      if (!this.e.isGroup) {
        // 私聊：进入交互式监听，等下一条消息作为 mcpServers JSON
        mcpAddPending.set(String(this.e.user_id), { at: Date.now() })
        await this.e.reply([
          '📝 已进入添加 MCP 模式，请直接发送 mcpServers JSON 配置。',
          '支持 Claude Desktop / Z.AI 标准格式，例如：',
          '```json',
          '{ "mcpServers": { "zai": { "type": "stdio", "command": "npx", "args": ["-y","@z_ai/mcp-server"], "env": { "Z_AI_API_KEY": "xxx" } } } }',
          '```',
          '收到后会立即连接验证；成功则写入配置（持久化、热加载），失败会报错。',
          `（${MCP_ADD_PENDING_TTL / 1000} 秒内有效；处理一次即结束）`,
        ].join('\n'))
        return true
      }
      // 群聊：不开启监听（避免群消息被吞），提示用一行带 JSON 的方式或去私聊
      await this.e.reply([
        '用法：#添加mcp <mcpServers JSON>',
        '或私聊发送 #添加mcp 进入交互式添加（直接粘贴 JSON 即可）。',
        '示例：',
        '```json',
        '{ "mcpServers": { "zai": { "type": "stdio", "command": "npx", "args": ["-y","@z_ai/mcp-server"], "env": { "Z_AI_API_KEY": "xxx" } } } }',
        '```',
      ].join('\n'))
      return true
    }
    const parsed = this._parseMcpBody(body)
    if (!parsed.ok) { await this.e.reply(parsed.msg); return true }
    await this.e.reply('⏳ 正在连接验证…')
    await this.e.reply((await this._applyMcpServers(parsed.servers)).join('\n'))
    return true
  }
,


  /** 解析 mcpServers JSON：成功 {ok:true, servers}；失败 {ok:false, msg}（不回复，由调用方决定） */
  _parseMcpBody(body) {
    let parsed
    try { parsed = JSON.parse(body) }
    catch (e) { return { ok: false, msg: `❌ JSON 解析失败：${e?.message || e}\n请粘贴完整的 mcpServers JSON。` } }
    const servers = parsed?.mcpServers || parsed
    if (!servers || typeof servers !== 'object' || Array.isArray(servers)) {
      return { ok: false, msg: '❌ 未找到服务端配置（需 { "mcpServers": {...} } 或 { "name": {...} }）' }
    }
    return { ok: true, servers }
  }
,


  /** 逐个连接验证 + 注册工具；成功的写入配置持久化（触发热加载）。返回结果行数组。 */
  async _applyMcpServers(servers) {
    const rt = await getRuntime()
    const results = []
    const okServers = []
    // 冲突检测基线：连接验证是秒级 await，期间 fs.watch 热加载或面板保存都可能替换配置对象。
    // Config.get() 返回的是活引用 _data，而 Config.save(data) 是整份覆盖写（无 merge），
    // 所以绝不能在 await 之前取快照、await 之后原样写回（会吞掉期间的所有并发修改，复核 #42）。
    // 基线必须是**深拷贝**：就地修改同一对象时，活引用会跟着一起变，冲突就检测不出来。
    const before = (() => {
      try { return JSON.parse(JSON.stringify(Config.get()?.agent?.mcp?.servers || {})) } catch { return {} }
    })()
    for (const [name, scfg] of Object.entries(servers)) {
      try {
        // add() 会连接 + 注册工具 + 验证可用（失败 entry.status='error'）
        const entry = await rt.mcp.add(name, { ...scfg, enabled: true })
        if (entry.status === 'connected') {
          okServers.push([name, scfg])
          results.push(`✅ ${name}：已连接，注册 ${entry.tools} 个工具（已写入配置）`)
        } else {
          results.push(`❌ ${name}：${entry.error || entry.status}（未写入配置）`)
        }
      } catch (e) {
        results.push(`❌ ${name}：${e?.message || e}（未写入配置）`)
      }
    }
    if (okServers.length) {
      const cfg = Config.get() // await 之后再取快照
      cfg.agent = cfg.agent || {}
      cfg.agent.mcp = cfg.agent.mcp || {}
      cfg.agent.mcp.servers = cfg.agent.mcp.servers || {}
      for (const [name, scfg] of okServers) {
        const cur = cfg.agent.mcp.servers[name]
        if (cur && JSON.stringify(cur) !== JSON.stringify(before[name])) {
          results.push(`⚠ ${name}：配置在连接验证期间被其它操作修改，已保留较新的那份（未覆盖）`)
          continue
        }
        cfg.agent.mcp.servers[name] = scfg
      }
      Config.save(cfg) // 持久化成功的 + 触发热加载
    }
    return results
  }
,


  /** 交互式添加：把监听期间收到的那条消息当作 mcpServers JSON 处理（处理一次即结束监听）。 */
  async _consumeMcpAddJson(raw) {
    const uid = String(this.e.user_id)
    mcpAddPending.delete(uid) // 无论成败都结束监听
    const body = (raw || '').trim()
    if (!body) { await this.e.reply('⚠️ 内容为空，已退出添加流程。重新发送 #添加mcp 可再试。'); return true }
    const parsed = this._parseMcpBody(body)
    if (!parsed.ok) { await this.e.reply(`${parsed.msg}\n（已退出添加流程，重新发送 #添加mcp 可再试）`); return true }
    await this.e.reply('⏳ 收到配置，正在连接验证…')
    await this.e.reply((await this._applyMcpServers(parsed.servers)).join('\n'))
    return true
  }
,



  async mcpStatus() {
    const rt = await getRuntime()
    const status = rt.mcp.status()
    const names = Object.keys(status)
    if (!names.length) return this.e.reply('未配置 MCP 服务端'), true
    const lines = names.map((n) => {
      const s = status[n]
      return `${s.status === 'connected' ? '✅' : s.status === 'error' ? '❌' : '⏳'} ${n}：${s.tools} 工具${s.error ? `（${s.error}）` : ''}`
    })
    await this.e.reply(lines.join('\n'))
    return true
  }

}
