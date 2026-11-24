import type { LucideIcon } from 'lucide-react'
import {
  AudioLines, Bot, Brain, CalendarClock, Drama, FlaskConical, Globe2, LayoutDashboard,
  LibraryBig, Lightbulb, ListChecks, MessagesSquare, ScrollText, ShieldCheck, SlidersHorizontal,
  Smile, Sparkles, UserRound, UsersRound, Waves, Wrench, BookOpenText,
} from 'lucide-react'

export type NavItem = {
  id: string
  path: string
  name: string
  description: string
  icon: LucideIcon
  badge?: 'approvals' | 'suggestions'
}

export type NavGroup = { id: string; name: string; items: NavItem[] }

export const NAV: NavGroup[] = [
  {
    id: 'run', name: '运行',
    items: [
      { id: 'dashboard', path: '/dashboard', name: '概览', description: '运行时状态、近 7 日用量与待处理事项', icon: LayoutDashboard },
      { id: 'confirm', path: '/confirm', name: '审批门', description: '高危工具人工把关', icon: ShieldCheck, badge: 'approvals' },
      { id: 'tasks', path: '/tasks', name: '任务账本', description: '可恢复任务的阶段 / 事件 / 检查点', icon: ListChecks },
      { id: 'schedule', path: '/schedule', name: '定时任务', description: '到点投递提醒与周期任务', icon: CalendarClock },
      { id: 'suggestions', path: '/suggestions', name: '进化建议', description: '自评审产出的待审改进项', icon: Lightbulb, badge: 'suggestions' },
      { id: 'evolution', path: '/evolution', name: '工具进化', description: '候选生成 / 验证 / 审批 / 版本', icon: FlaskConical },
    ],
  },
  {
    id: 'assets', name: '资产',
    items: [
      { id: 'memory', path: '/memory', name: '声明式记忆', description: 'MEMORY.md / USER.md · 按 scope 隔离', icon: BookOpenText },
      { id: 'recall', path: '/recall', name: '长期记忆', description: 'LLM 抽取沉淀 · L2/L3/L4 分层', icon: Waves },
      { id: 'profile', path: '/profile', name: '用户画像', description: '统一用户模型 · 分面 / 证据 / 置信 / 纠错', icon: UserRound },
      { id: 'personas', path: '/personas', name: '人设库', description: '内置 + 自定义人设 · 角色设定资料', icon: Drama },
      { id: 'skills', path: '/skills', name: '技能', description: 'skills/*.md · 按需 / 常驻注入', icon: Sparkles },
      { id: 'kb', path: '/kb', name: '知识库', description: '全局文档库 · embedding RAG', icon: LibraryBig },
      { id: 'sessions', path: '/sessions', name: '会话回放', description: '对话列表与消息历史', icon: MessagesSquare },
      { id: 'logs', path: '/logs', name: '日志时间线', description: 'devLog 全链路 · traceId 串联', icon: ScrollText },
    ],
  },
  {
    id: 'system', name: '系统',
    items: [
      { id: 'config', path: '/config', name: '配置中心', description: '修改配置并热加载；常用项、安全项与高级项都在这一页', icon: SlidersHorizontal },
      { id: 'qqbot', path: '/qqbot', name: '机器人账号', description: 'QQ 官方机器人账号 · 连接状态与排障', icon: Bot },
      { id: 'toolpacks', path: '/toolpacks', name: '外置工具', description: 'tools/ 自研工具 · 元信息与配置', icon: Wrench },
      { id: 'tts', path: '/tts', name: '语音合成', description: 'TTS 服务配置 + 参考音频库', icon: AudioLines },
      { id: 'humanize', path: '/humanize', name: '伪人模式', description: '旁听 / 门控 / 决策 / 发送', icon: UsersRound },
      { id: 'groupworld', path: '/groupworld', name: '群聊小世界', description: '群聊社会记忆层 · 画像 / 关系 / 事件 / 圈子', icon: Globe2 },
      { id: 'selfstate', path: '/selfstate', name: '自我状态', description: '情绪 / 心境 / 期待 / 心事', icon: Brain },
      { id: 'sticker', path: '/sticker', name: '表情包', description: '配置 + 库概览 · 发送策略 / 自动发现', icon: Smile },
    ],
  },
]

export const ALL_NAV = NAV.flatMap((g) => g.items)
export const navByPath = (path: string) => ALL_NAV.find((n) => path.startsWith(n.path)) || ALL_NAV[0]
export const navById = (id: string) => ALL_NAV.find((n) => n.id === id) || ALL_NAV[0]
