/**
 * Agent 常量与轻量工具（原 apps/agent.js 顶部）。
 * 插件根目录、内置预算/思考档、进度标签、进度参数摘要。
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** 插件根目录：apps/agent/ 向上两级 = agents-plugin/（用于 tools/、skills/、data/ 等）。 */
export const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * 已从用户配置中移除的推理/循环参数：这里内置偏宽松的最优值。
 * 目标：复杂任务优先跑完，不再让用户调「护栏 / 预算 / 收尾 / 兼容性」细节。
 */
export const BUILTIN_AGENT_LIMITS = Object.freeze({
  loop: Object.freeze({
    maxSameAction: 4,
    maxConsecutiveFailures: 6,
    noProgressWindow: 8,
    timeBudgetMs: 7200000, // 2 小时：复杂任务/长工具链优先跑完
    tokenBudget: 2000000, // 有效工作 token（缓存命中读按 0.1x 折算）
    finalizeGraceMs: 120000, // 收尾独立宽限 2 分钟，避免总结被截断
  }),
  toolMaxParallel: 4,
  finalizeMaxTokens: 8192,
  reflectMaxIterations: 1,
  rootTokenBudget: 0, // 0=不限；子代理/编排仍受各自预算约束
})
export const BUILTIN_THINKING = Object.freeze({
  manualBudget: 16000,
  classifierTimeoutMs: 2500,
  budgets: Object.freeze({ low: 4096, medium: 8192, high: 32768 }),
})
// 工具定义全量常驻（缓存优先）：tools 数组跨轮逐字节恒定；tool_search 仅保留为目录速查/帮助，
// 不再提供「按需发现」开关。首轮多付约 1 万 token，之后全部命中前缀缓存。
export const BUILTIN_TOOL_DISCOVERY = Object.freeze({ enable: true, method: 'llm', stableList: true })

// ─── 进度反馈：工具调用时推送节流进度消息，消除"干等几十秒"的僵化感 ───
// 真正的逐字流式依赖 QQ 适配器（icqq/napcat 差异大、编辑消息不稳），故默认只做可靠的进度反馈；
// 逐字流式固定关闭（适配器差异大、稳定性优先）；进度反馈仍默认开启。
export const PROGRESS_LABELS = {
  web_search: '🔍 联网搜索',
  ddg: '🔍 联网搜索',
  tavily: '🔍 联网搜索',
  exa: '🔍 联网搜索',
  brave: '🔍 联网搜索',
  perplexity: '🔍 联网搜索',
  skill: '📖 加载技能',
  reload_skills: '🔄 重载技能',
  tts_speak: '🔊 语音合成',
  read_attachment: '📎 读取附件',
  get_group_file: '📎 获取文件',
  list_group_files: '📎 列出文件',
  terminal: '💻 执行命令',
  calculate: '🧮 计算中',
  file_to_pdf: '📄 转PDF',
  process: '💻 进程操作',
  group_info: '⚙️ 查群信息',
  group_members: '⚙️ 查成员',
  group_member: '⚙️ 查成员',
  group_kick: '⚙️ 群操作',
  group_mute: '⚙️ 群操作',
  group_mute_all: '⚙️ 群操作',
  group_set_card: '⚙️ 群操作',
  group_set_title: '⚙️ 群操作',
  group_set_admin: '⚙️ 群操作',
  group_set_name: '⚙️ 群操作',
  miyoushe_search: '🎮 查米游社',
  enka_genshin: '🎮 查原神展柜',
  enka_hsr: '🚂 查星铁展柜',
  enka_zzz: '📺 查绝区零展柜',
  enka_build: '🛠️ 分析配装',
  memory: '📝 更新记忆',
  memory_search: '🧠 检索记忆',
  // 群公告
  send_group_notice: '📢 发群公告',
  get_group_notice: '📢 查群公告',
  delete_group_notice: '📢 删群公告',
  // 群文件 CRUD
  upload_group_file: '📤 上传群文件',
  delete_group_file: '🗑️ 删群文件',
  create_group_folder: '📂 建文件夹',
  delete_group_folder: '🗑️ 删文件夹',
  list_group_folder: '📂 列群文件',
  get_group_file_url: '🔗 取文件直链',
  move_group_file: '📂 移动文件',
  rename_group_file: '📂 重命名',
  transfer_group_file: '📂 跨群转发',
  // AI 语音
  get_ai_characters: '🎙️ 查语音角色',
  ai_tts: '🎙️ 合成语音',
  send_group_ai_record: '🎙️ 发AI语音',
  // 合并转发
  send_forward_msg: '📦 合并转发',
  get_forward_msg: '📦 读转发消息',
  // Pixiv
  pixiv__search: '🎨 搜Pixiv',
  pixiv__illust: '🎨 取Pixiv作品',
  pixiv__ranking: '🎨 Pixiv榜单',
  pixiv__user: '🎨 查Pixiv画师',
  pixiv__tags: '🎨 查Pixiv标签',
}


/** 从工具调用参数提取关键信息，给进度消息加上下文（让用户知道在干什么，而非只看到工具名） */
export function extractArgHint(args, name) {
  let a = args
  if (typeof a === 'string') { try { a = JSON.parse(a) } catch { return null } }
  if (!a || typeof a !== 'object') return null
  const fields = {
    web_search: 'query', miyoushe_search: 'keyword', memory_search: 'query',
    enka_genshin: 'uid', enka_hsr: 'uid', enka_zzz: 'uid', enka_build: 'character',
    calculate: 'code', terminal: 'command', create_excel: 'filename', file_to_pdf: 'path',
    read_pdf: 'path', read_excel: 'path', transcribe_media: 'path',
    send_file: 'path', get_chat_history: 'count', get_group_file: 'name',
    group_member: 'userId', group_info: 'groupId',
    send_group_notice: 'content', upload_group_file: 'name',
    delete_group_file: 'fileId', get_group_file_url: 'fileId',
    create_group_folder: 'name', rename_group_file: 'newName',
    transfer_group_file: 'targetGroupId', delete_group_notice: 'noticeId',
    pixiv__search: 'word', pixiv__illust: 'id', pixiv__ranking: 'mode',
    pixiv__user: 'userId', pixiv__tags: 'word',
  }
  const field = fields[name]
  if (field && a[field] != null) {
    let v = String(a[field]).trim()
    if (name === 'calculate') v = v.split('\n')[0]
    if (name === 'terminal') v = v.split(/[;&|]/)[0].trim()
    if (field === 'path') v = v.split('/').pop()
    return v.slice(0, 40)
  }
  // 未登记工具不再 fallback 取首个字符串值（否则会把 memory 的 target='memory' 这类
  // 内部枚举字段当 hint 贴出，产出"🔧 调用 memory：memory"之类的无意义进度）。只发 label。
  return null
}
