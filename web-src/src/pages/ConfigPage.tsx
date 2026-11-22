import { useEffect, useMemo, useState } from 'react'
import {
  Bot, Boxes, Brain, CalendarClock, ChevronRight, Cpu, Database, ExternalLink, FlaskConical,
  Globe2, KeyRound, Layers, ListChecks, MessageSquare, Plus, RefreshCw, Search, Send,
  ShieldCheck, SlidersHorizontal, Sparkles, Terminal, Trash2, Wrench, X, Zap,
} from 'lucide-react'
import { api } from '@/lib/api'
import { useAsync } from '@/lib/hooks'
import { useAgentConfig, CfgSection, CfgRow, SaveBar, Note, SubHead, deepMerge, deepClone, diffPaths, parseNum } from '@/lib/config'
import { Button, CopyButton, Input, Select, Switch, TagEditor, Tag, Textarea, EmptyState, ErrorState, PageHeader } from '@/components/ui'
import { useConfirm, useToast } from '@/components/Overlay'
import { cn } from '@/lib/cn'

/* ───────────────────────── defaults ───────────────────────── */

const DEFAULTS = {
  debug: false, trigger: 'at', triggerCommand: '#ai', commandPassThrough: true, isolation: { enable: false },
  providerId: '', modelId: '', protocol: '', preset: '', baseURL: '', apiKey: '', model: '', utilityModel: '', proxy: '',
  llmProviders: [] as any[], llmModels: [] as any[], fallbackModels: [] as any[],
  thinking: null as any, thinkingAuto: { enable: false, classifier: 'auto', maxBudget: 32768 },
  maxTurns: 200, temperature: 1, maxTokens: null, maxToolResultChars: 8000, reflect: 'auto',
  taskStore: { enable: false, dir: 'data/tasks' }, progress: true, progressRecall: 3,
  reply: { mode: 'text', renderScale: 1, atSender: true, quote: true, narrate: false },
  render: { card: true, helpTimeoutMs: 300000, timeoutMs: 15000, replyTimeoutMs: 30000 },
  qqBot: { enable: false, appId: '', appSecret: '', name: '', accounts: [] as any[], intents: 0, markdown: 'auto', preferMarkdownText: false, sandbox: false },
  qqOfficial: { markdown: { enable: true, maxChars: 3500, templateId: '' }, keyboard: { enable: true }, progress: false, narrate: false },
  webApi: { enable: true, port: 6098, publicUrl: '', printTokenOnStart: true, consoleTokenTtlHours: 720 },
  memory: { enable: false, threatScan: true }, memoryLimits: { memory: 2200, user: 1375 },
  recall: { cap: 200, extractEvery: 5, minScore: 0, model: '', embedProvider: '', diversity: { enable: true, lambda: 0.7, perTypeCap: 3 }, usage: { enable: true } },
  profile: { enable: true, infer: true, maxChars: 600, maxPerFacet: 8 },
  selfReview: { enable: false, every: 20, model: '', dailyBudgetTokens: 0, autoApplyMemory: true, autoApplyPrompt: false },
  evolution: { traceDir: '', promptDir: '', suggestionDir: '' },
  toolEvo: { enable: false, maxRepairAttempts: 1, dbPath: '', artifactsDir: '', runnerTimeoutMs: 120000 },
  chatPermission: 'master', privateChat: false, confirmTimeout: 300, guardAction: 'flag', guardSensitivity: 'medium',
  untrustedGuard: true, redactSecrets: true, masterSkipConfirm: false, masters: [] as string[],
  devLog: { enable: false, dir: '' }, persona: { defaultId: '', skipInjectionCheck: false, styleExamples: [] as string[] },
  systemPrompt: '', personaLore: { dir: '', adoptionsDir: '' }, policy: { categoryMin: {} as any },
  media: { enable: false, maxImages: 5, degrade: 'note' }, vision: { enable: false, model: '' },
  stt: { enable: true, apiBase: '', apiKey: '', model: '', language: '' },
  research: { permission: 'master', maxConcurrent: 2, evaluation: true },
  miyoushe: { cookie: '', defaultGid: '', maxImages: 9 },
  kb: {
    enable: false, vectorStore: true, vectorBackend: 'auto', vectorGpuConsent: false,
    hnsw: { m: 16, efConstruction: 200, efSearch: 256, rerank: 4 }, cuvs: { algorithm: 'brute_force', rerank: 4 },
    crawl: { engine: 'crawl4ai', autoInstall: true, execution: 'local', stealth: true, retryBlocked: true, allowPrivateHosts: false, sessionPersist: true, sessionTtlHours: 12, sessionProfile: false, siteMemory: true, perHostIntervalMs: 1200, hostConcurrency: 1 },
    crawlEnable: true, crawlTimeout: 60, chunkSize: 800, chunkOverlap: 100, topK: 5, minScore: 0,
  },
  schedule: { taskEnabled: false, taskMaxTurns: 200 }, tools: { builtin: true, dir: 'tools' },
  skill: { dir: 'skills', historyCount: 20 }, calc: { enable: false, timeout: 10, python: '' }, document: { soffice: '' },
  diagram: {
    enable: true, renderer: 'kroki', fallbackRenderer: 'none', defaultTheme: 'paper-blue', defaultFormat: 'png',
    timeoutMs: 20000, targetWidth: 1200, maxNodes: 30, maxEdges: 60, maxWidth: 2400, maxHeight: 2400,
    maxPixels: 8000000, maxOutputBytes: 8000000, tempTtlMinutes: 30,
    kroki: { endpoint: 'http://127.0.0.1:8000', allowPublicEndpoint: false, enabled: true, imageTag: '', connectTimeoutMs: 3000, requestTimeoutMs: 15000, maxConcurrency: 2, maxResponseBytes: 4000000, maxSourceBytes: 200000, circuitBreaker: { enabled: true, failureThreshold: 3, cooldownMs: 30000 }, d2: { layout: 'elk' }, allowedDiagramTypes: [] as string[] },
  },
  download: { enable: false, maxMB: 100, sendLimitMB: 50, maxTimeoutSec: 300, bin: 'yt-dlp', dir: 'data/downloads', allowPrivateHosts: false },
  tempFiles: { enable: true, ttlHours: 24, maxFiles: 500 },
  search: {
    engine: 'auto', safeSearch: 'off', cacheMinutes: 5, bing: true, ddg: true, searxng: { url: '' },
    anysearch: { apiKey: '' }, keenable: { apiKey: '' }, firecrawl: { apiKey: '' }, parallel: { apiKey: '' }, you: { apiKey: '' },
    tavily: { apiKey: '' }, exa: { apiKey: '' }, brave: { apiKey: '' }, perplexity: { apiKey: '' },
  },
  sandbox: {
    mode: 'off', apiKey: '', apiUrl: '', domain: '', sandboxUrl: '', template: 'base', maxTimeout: 300,
    maxSandboxes: 2, idleMs: 600000, maxCommandsPerSession: 0, audit: true, defaultCwd: '/home/user',
    sandboxTtlMs: 1800000, concurrencyWaitMs: 30000, requestTimeoutMs: 60000, retries: 1, allowPublicTraffic: false,
    network: { allowInternet: true, allowOut: [] as string[], denyOut: [] as string[] },
    toolEvoVerifyTimeoutMs: 120000, verifyTemplate: '',
  },
  shell: { intercept: [] as string[] },
  jev: { enable: false, providerId: '', modelId: '', model: '', timeoutMs: 4000, maxRetries: 1, decisions: { llmTool: false, terminalRisk: false }, thresholds: { thinkingMinConfidence: 0.5, terminalRiskFloor: 0.75, reflectFloor: 0.5 }, allowDestructive: false },
  stagehand: {
    enable: false, permission: 'master', stealth: true, maxSessions: 3, maxCallsPerMinute: 10, maxCallsPerDay: 200,
    opTimeoutMs: 60000, llmTimeoutMs: 30000, domSettleTimeoutMs: 3000, blockedHosts: [] as string[],
    mode: 'local', headless: true, region: '', executablePath: '', browserbaseApiKey: '', idleTimeoutMs: 600000,
    userAgent: '', modelName: '', modelApiKey: '',
  },
  multiagent: { enable: false, topology: 'spawn', maxConcurrent: 2, maxSpawnsPerConversation: 3, workerMaxTurns: 200, workerTimeBudgetMs: 3600000, workerMaxTokens: 16384, resultCap: 48000, reserveTokens: 32000, workerModel: '', defaultTools: [] as string[] },
  selfState: {
    enabled: false, shadowMode: true, groups: [] as string[], emotion: { maxNormalImpulse: 0.2, maxHighSalienceImpulse: 0.35, moodEmaAlpha: 0.3, moodResetHours: 6 },
    eventDetection: { semantic: true }, resentment: { maxSingleEventDelta: 0.05 }, expectations: { minimumWindowSeconds: 90, minIgnoredConfidence: 0.65 },
    stability: { maxNegativeMoodHours: 24 },
  },
  mcp: { requestTimeout: 60000, servers: {} as any },
  humanize: { groupsOverride: {} as any },
}

/* ───────────────────────── schema helpers ───────────────────────── */

type FieldType = 'switch' | 'number' | 'text' | 'mono' | 'textarea' | 'json' | 'select' | 'tags' | 'range' | 'readonly'
type Field = {
  path: string; label: string; hint?: string; type: FieldType; danger?: boolean; full?: boolean;
  options?: [string, string][]; min?: number; max?: number; step?: number; placeholder?: string; unit?: string; readonly?: (f: any) => string
}
type Section = { id: string; name: string; icon: any; desc: string; fields: Field[]; custom?: boolean; keywords?: string }
const S = (path: string, label: string, hint?: string, extra: Partial<Field> = {}): Field => ({ path, label, hint, type: 'switch', ...extra })
const N = (path: string, label: string, hint?: string, extra: Partial<Field> = {}): Field => ({ path, label, hint, type: 'number', ...extra })
const T = (path: string, label: string, hint?: string, extra: Partial<Field> = {}): Field => ({ path, label, hint, type: 'text', ...extra })
const M = (path: string, label: string, hint?: string, extra: Partial<Field> = {}): Field => ({ path, label, hint, type: 'mono', ...extra })
const SEL = (path: string, label: string, options: [string, string][], hint?: string, extra: Partial<Field> = {}): Field => ({ path, label, hint, type: 'select', options, ...extra })

const TRIGGER: [string, string][] = [['at', '@机器人触发'], ['command', '触发词触发'], ['both', '两者皆可']]
const PROTOCOL: [string, string][] = [['openai', 'OpenAI 兼容'], ['anthropic', 'Anthropic 兼容'], ['gemini', 'Gemini 原生']]
const PRESET: [string, string][] = [
  ['', '预设（无）'], ['deepseek', 'DeepSeek'], ['openai', 'OpenAI'], ['gemini', 'Gemini'], ['dashscope', '通义（DashScope）'],
  ['zhipu', '智谱'], ['moonshot', 'Kimi（Moonshot）'], ['mimo', '小米 MiMo'], ['minimax', 'MiniMax'], ['doubao', '豆包（火山方舟）'],
  ['anthropic', 'Anthropic'], ['openrouter', 'OpenRouter'], ['opencode', 'OpenCode Zen'], ['opencode-go', 'OpenCode Go'], ['commandcode', 'Command Code'], ['jev', 'Jev（TypeSafe）'],
]
const SEARCH_ENGINE: [string, string][] = [['auto', '自动（推荐）'], ['bing', 'Bing'], ['ddg', 'DuckDuckGo'], ['anysearch', 'AnySearch'], ['exa', 'Exa'], ['tavily', 'Tavily'], ['keenable', 'Keenable'], ['firecrawl', 'Firecrawl'], ['parallel', 'Parallel'], ['you', 'You.com'], ['searxng', 'SearXNG'], ['brave', 'Brave'], ['perplexity', 'Perplexity']]
const PERMISSION: [string, string][] = [['master', '仅主人'], ['admin', '管理员'], ['owner', '群主'], ['all', '所有人']]
const PROVIDER_MODELS: Record<string, { protocol: string; preset: string; baseURL: string }> = {
  deepseek: { protocol: 'openai', preset: 'deepseek', baseURL: 'https://api.deepseek.com' },
  openai: { protocol: 'openai', preset: 'openai', baseURL: 'https://api.openai.com/v1' },
  gemini: { protocol: 'gemini', preset: 'gemini', baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai' },
  dashscope: { protocol: 'openai', preset: 'dashscope', baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  zhipu: { protocol: 'openai', preset: 'zhipu', baseURL: 'https://open.bigmodel.cn/api/paas/v4' },
  moonshot: { protocol: 'openai', preset: 'moonshot', baseURL: 'https://api.moonshot.ai/v1' },
  mimo: { protocol: 'openai', preset: 'mimo', baseURL: 'https://api.xiaomimimo.com/v1' },
  minimax: { protocol: 'openai', preset: 'minimax', baseURL: 'https://api.minimaxi.com/v1' },
  doubao: { protocol: 'openai', preset: 'doubao', baseURL: 'https://ark.cn-beijing.volces.com/api/v3' },
  anthropic: { protocol: 'anthropic', preset: 'anthropic', baseURL: 'https://api.anthropic.com' },
  openrouter: { protocol: 'openai', preset: 'openrouter', baseURL: 'https://openrouter.ai/api/v1' },
  opencode: { protocol: 'openai', preset: 'opencode', baseURL: 'https://opencode.ai/zen/v1' },
  'opencode-go': { protocol: 'openai', preset: 'opencode-go', baseURL: 'https://opencode.ai/zen/go/v1' },
  commandcode: { protocol: 'openai', preset: 'commandcode', baseURL: 'https://api.commandcode.ai/provider/v1' },
}

const SECTIONS: Section[] = [
  {
    id: 'basic', name: '基础 / 模型', icon: Cpu, desc: '触发、主接入、回退与网络', custom: true, keywords: '主模型 厂商 触发 代理 回退 Jev',
    fields: [
      SEL('trigger', '触发模式', TRIGGER, '群里如何触发 Agent。'),
      T('triggerCommand', '触发词', '配合「触发词触发」使用。', { placeholder: '#ai' }),
      S('commandPassThrough', '指令透传', '允许主人指令穿过 Agent 直接执行。'),
      S('isolation.enable', '多用户数据隔离', '按群 / 私聊拆分记忆。'),
      S('debug', '调试日志', '写入更详细的运行日志。'),
      M('utilityModel', '旁路小模型', '高频小任务使用；留空 = 主模型。', { placeholder: '模型 ID' }),
      M('proxy', '代理', 'http / https 代理地址。', { placeholder: 'http://127.0.0.1:7890' }),
    ],
  },
  { id: 'providers', name: '厂商配置', icon: Boxes, desc: '登记 LLM 服务商与 API Key', custom: true, keywords: 'provider baseURL apiKey 厂商 预设', fields: [] },
  { id: 'models', name: '模型列表', icon: Bot, desc: '挂在厂商下的模型条目', custom: true, keywords: '模型 model provider 温度 思考', fields: [] },
  { id: 'features', name: '功能分配', icon: Zap, desc: '主模型、小模型、视觉、评审等槽位', custom: true, keywords: '功能分配 视觉 embedding 子代理 伪人 群世界', fields: [] },
  {
    id: 'multiagent', name: '子代理编排', icon: Layers, desc: '并行 / 同步子代理与预算',
    fields: [
      S('multiagent.enable', '启用子代理委派'), SEL('multiagent.topology', '编排拓扑', [['spawn', 'spawn（异步三件套）'], ['orchestrator', 'orchestrator（同步编排）']]),
      N('multiagent.maxConcurrent', '最大并发子代理', undefined, { min: 1, max: 10 }), N('multiagent.maxSpawnsPerConversation', '单次对话上限', undefined, { min: 1, max: 20 }),
      N('multiagent.workerMaxTurns', '工具循环上限', undefined, { min: 1, max: 1000 }), N('multiagent.workerTimeBudgetMs', '时间预算（ms）', undefined, { min: 10000, max: 7200000, step: 60000 }),
      N('multiagent.workerMaxTokens', '单轮输出上限', undefined, { min: 256, max: 65536, step: 256 }), N('multiagent.resultCap', '结果回传上限', undefined, { min: 2000, max: 200000, step: 1000 }),
      N('multiagent.reserveTokens', '编排预留 tokens', undefined, { min: 0, step: 1000 }),
      { path: 'multiagent.workerModel', label: '子代理模型', type: 'readonly', readonly: (f) => f.multiagent?.workerModel || '（留空=主模型）', hint: '在功能分配中设置。' },
      { path: 'multiagent.defaultTools', label: '子代理默认工具', type: 'tags', full: true, placeholder: '如 web_search / memory_search' },
    ],
  },
  {
    id: 'selfstate', name: '自我状态', icon: Brain, desc: '情绪 / 心境 / 期待 / 反思',
    fields: [
      S('selfState.enabled', '启用 SelfState'), S('selfState.shadowMode', 'Shadow Mode', '只观察不注入，建议先开。', { danger: true }),
      { path: 'selfState.groups', label: '观察群白名单', type: 'tags', full: true, placeholder: '群号回车；为空时回落群聊小世界 / 伪人白名单' },
      N('selfState.emotion.maxNormalImpulse', '普通事件脉冲上限', undefined, { min: 0.05, max: 0.5, step: 0.01 }),
      N('selfState.emotion.maxHighSalienceImpulse', '高显著脉冲上限', undefined, { min: 0.1, max: 0.5, step: 0.01 }),
      N('selfState.emotion.moodEmaAlpha', '心境惯性系数', undefined, { min: 0.05, max: 1, step: 0.05 }),
      N('selfState.emotion.moodResetHours', '心境回基线时长（时）', undefined, { min: 1, max: 48 }),
      S('selfState.eventDetection.semantic', '语义近邻检测'), N('selfState.resentment.maxSingleEventDelta', '单次怨气增量上限', undefined, { min: 0.01, max: 0.2, step: 0.01 }),
      N('selfState.expectations.minimumWindowSeconds', '期待等待窗下限（秒）', undefined, { min: 30, max: 1800 }),
      N('selfState.expectations.minIgnoredConfidence', '冷落判定置信门槛', undefined, { min: 0.6, max: 0.95, step: 0.05 }),
      N('selfState.stability.maxNegativeMoodHours', '负心境恢复上限（小时）', undefined, { min: 1, max: 48 }),
      { path: 'selfstate-link', label: '实时状态', type: 'readonly', readonly: () => '侧栏「自我状态」页查看与重置', full: true },
    ],
  },
  {
    id: 'reason', name: '推理参数', icon: Zap, desc: '温度 / 轮次 / 深度思考 / 反思',
    fields: [
      { path: 'temperature', label: '采样温度', type: 'range', min: 0, max: 2, step: 0.1 },
      N('maxTurns', '工具调用轮次上限', undefined, { min: 1, max: 1000 }),
      S('thinking', '深度思考', '开启时写入 budget_tokens=16000；关闭则清空 thinking。'),
      S('thinkingAuto.enable', '思考自动决策'),
      SEL('thinkingAuto.classifier', '判档方式', [['auto', 'auto（小模型+规则）'], ['always', 'always（总是小模型）'], ['off', 'off（纯规则）'], ['jev', 'jev（Jev 决策）']]),
      N('thinkingAuto.maxBudget', '自动预算上限', undefined, { min: 1024, max: 128000, step: 1024 }),
      N('maxTokens', '单次回复最大 token', '留空 = 厂商默认。', { min: 1 }),
      N('maxToolResultChars', '工具结果字符上限', undefined, { min: 100 }),
      SEL('reflect', '反思模式', [['off', '关闭'], ['auto', '自动'], ['always', '总是'], ['jev', 'Jev 决策']]),
    ],
  },
  {
    id: 'task', name: '任务账本', icon: ListChecks, desc: '可恢复任务的落盘与目录',
    fields: [S('taskStore.enable', '任务账本'), M('taskStore.dir', '任务库目录', undefined, { placeholder: 'data/tasks' })],
  },
  {
    id: 'reply', name: '进度 / 回复渲染', icon: Send, desc: '进度消息、卡片图与回复方式',
    fields: [
      S('progress', '工具调用进度消息'), N('progressRecall', '进度消息撤回（秒）', undefined, { min: 0, max: 120 }),
      SEL('reply.mode', '回复渲染方式', [['text', '纯文本（默认）'], ['image', '图片渲染']]), N('reply.renderScale', '回复图清晰度倍率', undefined, { min: 1, max: 4 }),
      S('render.card', '帮助 / 列表卡片图'), N('render.helpTimeoutMs', '帮助图渲染超时', undefined, { min: 1000, step: 1000 }),
      N('render.timeoutMs', '卡片图渲染超时', undefined, { min: 1000 }), N('render.replyTimeoutMs', '回复图渲染超时', undefined, { min: 1000 }),
      S('reply.atSender', '群聊 @ 发言人'), S('reply.quote', '群聊引用原消息'), S('reply.narrate', '中途播报'),
    ],
  },
  { id: 'qqofficial', name: 'QQ 官方机器人', icon: Bot, desc: '适配器开关、账号与 Markdown', custom: true, keywords: 'QQ 官方 appId appSecret intents markdown 按钮', fields: [] },
  { id: 'web', name: 'Web 面板', icon: Globe2, desc: '端口、对外地址与令牌有效期', custom: true, keywords: 'web 面板 端口 token 地址', fields: [] },
  {
    id: 'memory', name: '记忆系统', icon: Database, desc: '声明式记忆、长期记忆、画像',
    fields: [
      S('memory.enable', '声明式记忆'), S('memory.threatScan', '记忆注入扫描'),
      N('memoryLimits.memory', 'MEMORY 字符上限', undefined, { min: 200 }), N('memoryLimits.user', 'USER 字符上限', undefined, { min: 200 }),
      N('recall.cap', '长期记忆条数上限', undefined, { min: 10 }), N('recall.extractEvery', 'LLM 抽取间隔（轮）', undefined, { min: 1 }),
      N('recall.minScore', '召回最低分', undefined, { min: 0, max: 1, step: 0.05 }),
      S('recall.diversity.enable', '召回去冗余（MMR）'), N('recall.diversity.lambda', '去冗余相关权重', undefined, { min: 0, max: 1, step: 0.05 }),
      N('recall.diversity.perTypeCap', '同类型最多条数', undefined, { min: 1, max: 10 }), S('recall.usage.enable', '记忆使用反馈'),
      S('profile.enable', '用户画像'), S('profile.infer', '隐式风格推断'), N('profile.maxChars', '画像注入上限（字符）', undefined, { min: 100, max: 2000, step: 50 }),
      N('profile.maxPerFacet', '每分面保留条数', undefined, { min: 1, max: 20 }),
    ],
  },
  {
    id: 'evolution', name: '自进化', icon: FlaskConical, desc: '后台自评审与工具进化',
    fields: [
      S('selfReview.enable', '后台自评审'), N('selfReview.every', '评审间隔（轮）', undefined, { min: 5 }),
      N('selfReview.dailyBudgetTokens', '日 token 预算', undefined, { min: 0, step: 10000 }),
      S('selfReview.autoApplyMemory', '记忆自动应用'), S('selfReview.autoApplyPrompt', 'prompt 自动应用', undefined, { danger: true }),
      S('toolEvo.enable', '工具进化'), N('toolEvo.maxRepairAttempts', '候选修复次数', undefined, { min: 0, max: 3 }),
      M('toolEvo.dbPath', '工具进化库路径', undefined, { placeholder: 'data/tool-evo' }), M('toolEvo.artifactsDir', '工具制品目录', undefined, { placeholder: 'data/tool-evo/artifacts' }),
      N('toolEvo.runnerTimeoutMs', 'stable 工具超时（ms）', undefined, { min: 100, step: 500 }),
      M('evolution.traceDir', '产物目录 · trace'), M('evolution.promptDir', '产物目录 · prompt'), M('evolution.suggestionDir', '产物目录 · suggestion'),
    ],
  },
  { id: 'security', name: '权限 / 安全 / 日志', icon: ShieldCheck, desc: '权限、注入防御、主人、人设与日志', custom: true, keywords: '权限 安全 主人 人设 日志 脱敏 注入', fields: [] },
  { id: 'mcp', name: 'MCP 服务', icon: Wrench, desc: 'MCP 服务端与超时', custom: true, keywords: 'mcp stdio http headers 服务', fields: [] },
  {
    id: 'search', name: '搜索', icon: Search, desc: '搜索源、安全搜索与 Key',
    fields: [
      SEL('search.engine', '首选引擎', SEARCH_ENGINE), SEL('search.safeSearch', '安全搜索', [['off', 'off'], ['moderate', 'moderate'], ['strict', 'strict']]),
      N('search.cacheMinutes', '搜索缓存（分钟）', undefined, { min: 0, max: 60 }),
      S('search.bing', 'Bing 免费引擎'), S('search.ddg', 'DuckDuckGo 免费兜底'),
      M('search.searxng.url', 'SearXNG 地址', undefined, { placeholder: 'http://localhost:8080', full: true }),
      M('search.anysearch.apiKey', 'AnySearch Key'), M('search.keenable.apiKey', 'Keenable Key'), M('search.firecrawl.apiKey', 'Firecrawl Key'),
      M('search.parallel.apiKey', 'Parallel Key'), M('search.you.apiKey', 'You.com Key'), M('search.tavily.apiKey', 'Tavily Key'),
      M('search.exa.apiKey', 'Exa Key'), M('search.brave.apiKey', 'Brave Key'), M('search.perplexity.apiKey', 'Perplexity Key'),
    ],
  },
  {
    id: 'sandbox', name: 'E2B 沙箱', icon: Terminal, desc: '终端执行沙箱与出口控制',
    fields: [
      SEL('sandbox.mode', '执行面模式', [['off', 'off（关闭）'], ['e2b', 'e2b（沙箱执行）']]),
      M('sandbox.apiKey', 'E2B API Key', undefined, { placeholder: 'e2b_xxx' }), M('sandbox.apiUrl', '控制面地址'), M('sandbox.domain', '沙箱域名'),
      M('sandbox.sandboxUrl', '数据面地址'), M('sandbox.template', '沙箱模板', undefined, { placeholder: 'base' }),
      N('sandbox.maxTimeout', '单命令超时上限（秒）', undefined, { min: 1, max: 3600 }), N('sandbox.maxSandboxes', '并发沙箱上限', undefined, { min: 1, max: 64 }),
      N('sandbox.idleMs', '闲置回收（毫秒）', undefined, { min: 10000, step: 10000 }), N('sandbox.maxCommandsPerSession', '单会话命令数上限', undefined, { min: 0 }),
      S('sandbox.audit', '命令审计日志'), T('sandbox.defaultCwd', '默认工作目录'),
      { path: 'sandbox.network.allowOut', label: '出口白名单', type: 'tags', full: true, placeholder: '如 1.2.3.4/32' },
      { path: 'sandbox.network.denyOut', label: '额外拒绝网段', type: 'tags', full: true, placeholder: '不要写 0.0.0.0/0' },
      S('sandbox.network.allowInternet', '允许互联网', '关闭后沙箱完全断网。'),
      N('sandbox.sandboxTtlMs', '沙箱 TTL（ms）', undefined, { min: 10000, step: 60000 }), N('sandbox.concurrencyWaitMs', '等待并发名额（ms）', undefined, { min: 0, step: 1000 }),
      N('sandbox.requestTimeoutMs', 'SDK 请求超时（ms）', undefined, { min: 1000, step: 1000 }), N('sandbox.retries', 'SDK 重试次数', undefined, { min: 0, max: 5 }),
      S('sandbox.allowPublicTraffic', '公开 URL 需鉴权'), N('sandbox.toolEvoVerifyTimeoutMs', '候选验证超时（ms）', undefined, { min: 1000, step: 1000 }),
      M('sandbox.verifyTemplate', '候选验证沙箱模板'),
    ],
  },
  {
    id: 'shell', name: 'Shell 命令安全', icon: ShieldCheck, desc: '拦截片段与 Jev 风险检查',
    fields: [
      { path: 'shell.intercept', label: '自定义拦截指令', type: 'tags', full: true, placeholder: '回车添加要拦截的指令片段' },
      S('jev.decisions.terminalRisk', '启用 Jev 风险检查', '需先在「基础 / 模型」启用并选择 Jev。'),
      S('jev.allowDestructive', '允许破坏性命令', undefined, { danger: true }),
      N('jev.thresholds.terminalRiskFloor', '破坏性命令置信阈值', undefined, { min: 0, max: 1, step: 0.05 }),
    ],
  },
  {
    id: 'stagehand', name: '浏览器自动化', icon: Globe2, desc: 'Stagehand 本地 / 云浏览器',
    fields: [
      S('stagehand.enable', '启用浏览器自动化'), SEL('stagehand.permission', '使用权限', [['master', '仅主人（默认）'], ['all', '全部成员']]),
      S('stagehand.stealth', '真机化指纹'), M('stagehand.userAgent', '固定 User-Agent（可选）', undefined, { placeholder: '留空=随机设备指纹' }),
      SEL('stagehand.mode', '浏览器模式', [['local', 'local 本地（Playwright + Chromium）'], ['cloud', 'cloud Browserbase 云']]),
      S('stagehand.headless', '无头模式（本地）'), N('stagehand.maxSessions', '并发会话上限', undefined, { min: 1, max: 10 }),
      N('stagehand.maxCallsPerMinute', '每分钟上限', undefined, { min: 1 }), N('stagehand.maxCallsPerDay', '每日上限', undefined, { min: 1 }),
      M('stagehand.executablePath', 'Chrome 路径（本地，可选）'), M('stagehand.browserbaseApiKey', 'Browserbase apiKey', undefined, { placeholder: 'bb_live_...' }),
      SEL('stagehand.region', '云区域', [['', '默认 us-west-2'], ['us-east-1', 'us-east-1'], ['eu-central-1', 'eu-central-1'], ['ap-southeast-1', 'ap-southeast-1']]),
      { path: 'stagehand.modelName', label: 'Stagehand 原生模型', type: 'readonly', readonly: (f) => f.stagehand?.modelName || '（留空=复用 provider）' },
      N('stagehand.idleTimeoutMs', '会话空闲超时（毫秒）', undefined, { min: 60000, step: 60000 }), N('stagehand.opTimeoutMs', '操作截止时间（毫秒）', undefined, { min: 1000, step: 1000 }),
      N('stagehand.llmTimeoutMs', 'LLM 截止时间（毫秒）', undefined, { min: 1000, step: 1000 }), N('stagehand.domSettleTimeoutMs', 'DOM 稳定等待（毫秒）', undefined, { min: 0, step: 500 }),
      { path: 'stagehand.blockedHosts', label: '额外禁访主机', type: 'tags', full: true, placeholder: '如 internal.example.com' },
    ],
  },
  {
    id: 'ext', name: '多模态 / 工具 / 扩展', icon: SlidersHorizontal, desc: '媒体、STT、知识库、示意图与下载',
    fields: [
      S('media.enable', '多模态'), N('media.maxImages', '单次最多图片', undefined, { min: 1, max: 20 }),
      SEL('media.degrade', '降级策略', [['skip', 'skip 丢弃'], ['note', 'note 占位说明'], ['text', 'text 文本类提取']]),
      S('vision.enable', '视觉子模型'), { path: 'vision.model', label: '视觉模型', type: 'readonly', readonly: (f) => f.vision?.model || '（留空=复用主模型）' },
      S('stt.enable', '语音转写 STT'), M('stt.apiBase', 'STT API 地址'), M('stt.apiKey', 'STT API Key'), M('stt.model', 'STT 模型', undefined, { placeholder: 'whisper-1' }), M('stt.language', 'STT 语言', undefined, { placeholder: '留空=自动' }),
      SEL('research.permission', '深度研究权限', [['master', '仅主人（防滥用）'], ['all', '所有人']]),
      M('miyoushe.cookie', '米游社 Cookie', undefined, { full: true }), M('miyoushe.defaultGid', '米游社默认分区'), N('miyoushe.maxImages', '米游社单帖最大图', undefined, { min: 1 }),
      S('kb.enable', '启用知识库'), S('kb.vectorStore', '本地向量索引'), SEL('kb.vectorBackend', '向量后端', [['auto', 'auto'], ['hnsw', 'hnsw'], ['flat', 'flat'], ['cuvs', 'cuvs']]),
      S('kb.vectorGpuConsent', 'GPU 向量检索授权'), SEL('kb.cuvs.algorithm', 'cuVS 算法', [['brute_force', 'brute_force'], ['cagra', 'cagra']]),
      S('kb.crawlEnable', '启用网页抓取'), SEL('kb.crawl.engine', '网页抓取引擎', [['crawl4ai', 'crawl4ai 真浏览器'], ['fetch', 'fetch 纯 HTTP']]),
      S('kb.crawl.autoInstall', '自动安装抓取浏览器'), SEL('kb.crawl.execution', '抓取执行面', [['local', 'local 宿主 venv'], ['sandbox', 'sandbox 会话沙箱']]),
      S('kb.crawl.stealth', '抓取反检测'), S('kb.crawl.retryBlocked', '被拦截自动升级'), S('kb.crawl.allowPrivateHosts', '允许抓内网地址', undefined, { danger: true }),
      S('kb.crawl.sessionPersist', '会话复用（清关凭证）'), N('kb.crawl.sessionTtlHours', '会话有效期（小时）', undefined, { min: 0.1, max: 720, step: 0.1 }),
      S('kb.crawl.siteMemory', '站点难度记忆'), N('kb.crawl.perHostIntervalMs', '同站抓取间隔（毫秒）', undefined, { min: 0, max: 60000, step: 100 }), N('kb.crawl.hostConcurrency', '同站并发上限', undefined, { min: 1, max: 8 }),
      S('kb.crawl.sessionProfile', '持久浏览器 profile'), N('kb.crawlTimeout', '抓取超时（秒）', undefined, { min: 1 }), N('kb.chunkSize', '分块大小', undefined, { min: 100 }),
      N('kb.chunkOverlap', '分块重叠', undefined, { min: 0 }), N('kb.topK', '默认返回片段数', undefined, { min: 1 }), N('kb.minScore', '最低相似度', undefined, { min: 0, max: 1, step: 0.01 }),
      S('schedule.taskEnabled', '启用定时任务链'), N('schedule.taskMaxTurns', '任务链轮次上限', undefined, { min: 1 }),
      S('tools.builtin', '内置工具包'), M('tools.dir', '工具包目录'), M('skill.dir', '技能目录'), N('skill.historyCount', '技能历史条数', undefined, { min: 0 }),
      S('calc.enable', 'Python 计算沙盒'), N('calc.timeout', '计算超时（秒）', undefined, { min: 1, max: 3600 }), M('calc.python', 'Python 解释器'),
      M('document.soffice', '文档转 PDF soffice 路径'),
      S('diagram.enable', '启用示意图工具'), SEL('diagram.renderer', '渲染引擎', [['kroki', 'kroki 自托管容器']]),
      SEL('diagram.fallbackRenderer', '失败回退', [['none', '无（结构化失败）'], ['beautiful-mermaid', '本地 beautiful-mermaid']]),
      SEL('diagram.defaultTheme', '默认主题', [['paper-blue', '米白纸蓝'], ['soft-pastel', '柔和粉彩'], ['technical', '技术蓝灰'], ['midnight', '午夜深色'], ['sketch', '手绘素描（仅 D2）']]),
      SEL('diagram.defaultFormat', '默认格式', [['png', 'PNG 图片'], ['svg', 'SVG 源文件']]), M('diagram.kroki.endpoint', 'Kroki endpoint'),
      SEL('diagram.kroki.d2.layout', 'D2 布局', [['elk', 'elk（复杂图）'], ['dagre', 'dagre（轻量）']]), S('diagram.kroki.allowPublicEndpoint', '允许公共 Kroki', undefined, { danger: true }),
      N('diagram.kroki.connectTimeoutMs', '连接 / 响应头超时（ms）', undefined, { min: 500, step: 500 }), N('diagram.kroki.requestTimeoutMs', '单请求总超时（ms）', undefined, { min: 1000, step: 1000 }),
      N('diagram.kroki.maxConcurrency', '渲染并发上限', undefined, { min: 1, max: 8 }), N('diagram.timeoutMs', '渲染总预算（ms）', undefined, { min: 3000, step: 1000 }),
      N('diagram.targetWidth', '输出宽度（px）', undefined, { min: 800, step: 100 }), N('diagram.maxNodes', '节点数上限', undefined, { min: 5, max: 50 }),
      N('diagram.tempTtlMinutes', '临时文件保留（分）', undefined, { min: 5 }),
      S('download.enable', '启用媒体下载'), N('download.maxMB', '单文件大小上限（MB）', undefined, { min: 1 }), N('download.sendLimitMB', '发送大小上限（MB）', undefined, { min: 1 }),
      N('download.maxTimeoutSec', '下载超时（秒）', undefined, { min: 10 }), M('download.bin', 'yt-dlp 路径'), M('download.dir', '输出目录'), S('download.allowPrivateHosts', '允许内网地址'),
      S('tempFiles.enable', '临时文件自动清理'), N('tempFiles.ttlHours', '保留时长（小时）', undefined, { min: 1 }), N('tempFiles.maxFiles', '文件数上限', undefined, { min: 1 }),
      { path: 'humanize.groupsOverride', label: '伪人 · 群级行为覆盖', type: 'json', full: true, placeholder: '{"群号":{"talkValue":0.4}}' },
    ] as Field[],
  },
]


/* ───────────────────────── generic field ───────────────────────── */

function JsonField({ value, onChange, placeholder }: { value: any; onChange: (v: any) => void; placeholder?: string }) {
  const [text, setText] = useState(typeof value === 'string' ? value : JSON.stringify(value ?? {}, null, 2))
  const [err, setErr] = useState('')
  useEffect(() => { setText(typeof value === 'string' ? value : JSON.stringify(value ?? {}, null, 2)) }, [value])
  return (
    <div>
      <Textarea
        className="mono min-h-[90px]"
        value={text}
        placeholder={placeholder}
        spellCheck={false}
        onChange={(e) => { setText(e.target.value); setErr('') }}
        onBlur={() => {
          try { onChange(JSON.parse(text)) } catch { setErr('JSON 解析失败，原值保留') }
        }}
      />
      {err && <p className="mt-1 text-[10px] text-coral">{err}</p>}
    </div>
  )
}

function FieldControl({ f, form, field, modelIds }: { f: Field; form: any; field: (p: string, v: any) => void; modelIds: string[] }) {
  const get = (p: string) => p.split('.').reduce((o, k) => o?.[k], form)
  const v = get(f.path)
  const set = (val: any) => field(f.path, val)
  if (f.type === 'switch') return <div className="pt-1"><Switch checked={!!v} onChange={set} label={f.label} /></div>
  if (f.type === 'readonly') return <span className="mono block break-words text-[11px] text-ink-2">{f.readonly ? f.readonly(form) : String(v ?? '—')}</span>
  if (f.type === 'select') return <Select aria-label={f.label} value={v ?? ''} onChange={(e) => set(e.target.value)}>{(f.options || []).map(([val, label]) => <option key={val} value={val}>{label}</option>)}</Select>
  if (f.type === 'tags') return <TagEditor value={Array.isArray(v) ? v.map(String) : []} onChange={set} placeholder={f.placeholder} mono ariaLabel={f.label} />
  if (f.type === 'range') {
    const n = Number(v) || 0
    return <div className="flex items-center gap-3"><input type="range" min={f.min ?? 0} max={f.max ?? 1} step={f.step ?? 0.05} value={n} onChange={(e) => set(Number(e.target.value))} className="w-full accent-lagoon" /><span className="mono w-10 text-right text-[11px]">{n.toFixed(1)}</span></div>
  }
  if (f.type === 'json') return <JsonField value={v} onChange={set} placeholder={f.placeholder} />
  if (f.type === 'textarea') return <Textarea aria-label={f.label} className="mono min-h-[100px]" value={typeof v === 'string' ? v : JSON.stringify(v ?? {}, null, 2)} onChange={(e) => set(e.target.value)} placeholder={f.placeholder} />
  if (f.type === 'number') return <Input aria-label={f.label} className="w-[130px]" type="number" min={f.min} max={f.max} step={f.step} value={v ?? ''} onChange={(e) => set(e.target.value === '' ? '' : Number(e.target.value))} placeholder={f.placeholder} />
  return <Input aria-label={f.label} className={f.type === 'mono' ? 'mono' : ''} value={v ?? ''} onChange={(e) => set(e.target.value)} placeholder={f.placeholder} list={modelIds.length && /Model|model/.test(f.path) ? 'cfg-model-ids' : undefined} />
}

export function ConfigPage() {
  const toast = useToast()
  const confirm = useConfirm()
  const { form, field, orig, setForm, setOrig, dirty: baseDirty, ready, loading, error, refresh, raw } = useAgentConfig(null, DEFAULTS)
  const personas = useAsync(() => api.get('/personas').catch(() => []), [])
  const [saving, setSaving] = useState(false)
  const [q, setQ] = useState('')
  const [openSections, setOpenSections] = useState<Record<string, boolean>>({ basic: true })
  const [highlight, setHighlight] = useState('')
  const [mcpText, setMcpText] = useState('')
  const [mcpInitial, setMcpInitial] = useState('')
  const [mcpError, setMcpError] = useState('')
  const [webUrl, setWebUrl] = useState<any>(null)
  const [webLoading, setWebLoading] = useState(false)
  const [mcpReady, setMcpReady] = useState(false)

  const hasJev = raw ? Object.prototype.hasOwnProperty.call(raw, 'jev') : true
  const hasShell = raw ? Object.prototype.hasOwnProperty.call(raw, 'shell') : true
  const visibleSections = useMemo(() => SECTIONS.filter((s) => s.id !== 'shell' || hasShell), [hasShell])
  const providers = (form.llmProviders || []) as any[]
  const models = (form.llmModels || []) as any[]
  const mainProvider = providers.find((p) => p.id === form.providerId)
  const mainModels = models.filter((m) => m.providerId === form.providerId)
  const modelIds = useMemo(() => [...new Set(models.map((m) => m.model).filter(Boolean))], [models])

  useEffect(() => {
    if (ready && !mcpReady) {
      const text = JSON.stringify(form.mcp?.servers || {}, null, 2)
      setMcpText(text); setMcpInitial(text)
      setMcpReady(true)
    }
  }, [ready, mcpReady, form.mcp])

  const dirty = baseDirty || (mcpReady && mcpText !== mcpInitial)

  const setBaseProvider = (pid: string) => {
    field('providerId', pid)
    const pm = models.filter((m) => m.providerId === pid)
    if (!pm.some((m) => m.id === form.modelId)) field('modelId', pm[0]?.id || '')
  }
  const setBaseModel = (mid: string) => {
    if (!mid) { field('modelId', ''); return }
    const m = models.find((x) => x.id === mid)
    if (m && m.providerId !== form.providerId) field('providerId', m.providerId)
    field('modelId', mid)
  }

  const addProvider = () => {
    const id = 'p' + Date.now().toString(36)
    field('llmProviders', [...providers, { id, name: '', protocol: 'openai', preset: '', baseURL: '', apiKey: '' }])
  }
  const removeProvider = async (idx: number) => {
    const p = providers[idx]
    if (p.id === form.providerId) { toast('该厂商正被基础模型使用，请先切换基础模型', 'warn'); return }
    if (models.some((m) => m.providerId === p.id)) { toast('该厂商下还有模型条目，请先删除或改挂', 'warn'); return }
    const ok = await confirm({ title: '删除这个厂商？', message: p.name || p.id, confirmText: '删除', danger: true })
    if (!ok) return
    field('llmProviders', providers.filter((_, i) => i !== idx))
  }
  const addModel = () => {
    const id = 'm' + Date.now().toString(36)
    field('llmModels', [...models, { id, name: '', providerId: form.providerId || providers[0]?.id || '', model: '', thinking: 'inherit', note: '' }])
  }
  const removeModel = async (idx: number) => {
    const m = models[idx]
    if (m.id === form.modelId) { toast('该模型正被基础模型使用，请先切换', 'warn'); return }
    const ok = await confirm({ title: '删除这个模型条目？', message: m.name || m.model || m.id, confirmText: '删除', danger: true })
    if (!ok) return
    field('llmModels', models.filter((_, i) => i !== idx))
  }

  const featureRows = [
    { key: 'main', label: '主模型', path: '', hint: '对话主力：推理 / 工具调用 / 复杂任务' },
    { key: 'utility', label: '旁路小模型', path: 'utilityModel' },
    { key: 'vision', label: '视觉模型', path: 'vision.model' },
    { key: 'recall', label: '记忆抽取模型', path: 'recall.model' },
    { key: 'embed', label: 'Embedding 模型', path: 'recall.embedProvider' },
    { key: 'review', label: '自进化评审模型', path: 'selfReview.model' },
    { key: 'worker', label: '子代理模型', path: 'multiagent.workerModel' },
    { key: 'hzp', label: '伪人 Planner', path: 'humanize.planner.model' },
    { key: 'hzr', label: '伪人 Replyer', path: 'humanize.replyer.model' },
    { key: 'hzm', label: '伪人记忆', path: 'humanize.memory.model' },
    { key: 'gw', label: '群世界分析', path: 'groupWorld.analysis.modelProfile' },
  ]

  const searchResults = useMemo(() => {
    const s = q.trim().toLowerCase()
    if (!s) return []
    const out: { section: Section; field?: Field }[] = []
    for (const sec of visibleSections) {
      if (`${sec.name} ${sec.desc} ${sec.keywords || ''}`.toLowerCase().includes(s)) out.push({ section: sec })
      for (const f of sec.fields) {
        if (`${f.label} ${f.hint || ''} ${f.path}`.toLowerCase().includes(s)) out.push({ section: sec, field: f })
      }
    }
    return out.slice(0, 14)
  }, [q, visibleSections])

  const jump = (sec: Section, path?: string) => {
    setOpenSections((o) => ({ ...o, [sec.id]: true }))
    setHighlight(path || '')
    window.setTimeout(() => {
      let el = path ? document.querySelector(`[data-cf-path="${path}"]`) : null
      if (!el) el = document.getElementById(`cfg-${sec.id}`)
      el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }, 60)
    setQ('')
  }

  const loadWebUrl = async () => {
    setWebLoading(true)
    try { setWebUrl(await api.get('/web/console-url')) }
    catch (e: any) { toast(e?.message || '获取失败', 'error') }
    finally { setWebLoading(false) }
  }

  const save = async () => {
    setMcpError('')
    let parsedMcp: any = null
    if (mcpText.trim()) {
      try { parsedMcp = JSON.parse(mcpText) } catch (e: any) { setMcpError('MCP JSON 解析失败：' + (e?.message || e)); toast('MCP JSON 解析失败', 'error'); return }
    }
    const next = deepClone(form)
    try {
      if (typeof next.persona?.styleExamples === 'string') next.persona.styleExamples = JSON.parse(next.persona.styleExamples)
      if (typeof next.policy?.categoryMin === 'string') next.policy.categoryMin = JSON.parse(next.policy.categoryMin)
      if (typeof next.humanize?.groupsOverride === 'string') next.humanize.groupsOverride = JSON.parse(next.humanize.groupsOverride)
    } catch {
      toast('JSON 字段解析失败，请检查说话风格示例 / 策略 / 群级覆盖', 'error')
      return
    }
    if (mcpText !== mcpInitial) next.mcp.servers = parsedMcp
    for (const a of (next.qqBot?.accounts || [])) {
      if (!String(a.appId || '').trim()) { toast('QQ 机器人账号存在空 AppID', 'warn'); return }
    }
    const changes = diffPaths(orig, next, 'agent', { nullClearedNumbers: true, wholePaths: ['mcp.servers'] })
    delete changes['agent.debug']
    if (!!orig.debug !== !!next.debug) changes.debug = !!next.debug
    if (!Object.keys(changes).length) { toast('无改动', 'warn'); return }
    setSaving(true)
    try {
      const r = await api.put('/config', { changes })
      const fresh = await api.get('/config')
      const merged = deepMerge(DEFAULTS, fresh)
      setForm(merged); setOrig(deepClone(merged))
      setMcpReady(false)
      const t = JSON.stringify(merged.mcp?.servers || {}, null, 2)
      setMcpText(t); setMcpInitial(t); setMcpReady(true)
      toast(`已保存 ${r?.applied ?? Object.keys(changes).length} 项（已热加载）`, 'success')
    } catch (e: any) { toast(e?.message || '保存失败', 'error') }
    finally { setSaving(false) }
  }

  const reset = () => {
    const o = deepClone(orig)
    setForm(o)
    const t = JSON.stringify(o.mcp?.servers || {}, null, 2); setMcpText(t); setMcpInitial(t)
    toast('已还原为当前生效配置', 'info')
  }

  const renderSection = (sec: Section) => {
    const open = !!openSections[sec.id]
    const toggle = () => setOpenSections((o) => ({ ...o, [sec.id]: !o[sec.id] }))
    return (
      <CfgSection key={sec.id} id={`cfg-${sec.id}`} title={sec.name} description={sec.desc} icon={<sec.icon size={15} />} open={open} onToggle={toggle}>
        {sec.custom ? renderCustom(sec) : sec.fields.map((f) => (
          f.path === 'thinking' ? (
            <CfgRow key={f.path} label={f.label} hint={f.hint} full={f.full} danger={f.danger} path="thinking" highlight={highlight === 'thinking'}>
              <div className="pt-1"><Switch checked={!!form.thinking && form.thinking !== 'off' && form.thinking?.type !== 'disabled'} onChange={(v) => field('thinking', v ? { type: 'enabled', budget_tokens: 16000 } : null)} label={f.label} /></div>
            </CfgRow>
          ) : (
            <CfgRow key={f.path} label={f.label} hint={f.hint} full={f.full} danger={f.danger} path={f.path} highlight={highlight === f.path}>
              <FieldControl f={f} form={form} field={field} modelIds={modelIds} />
            </CfgRow>
          )
        ))}
      </CfgSection>
    )
  }

  const renderCustom = (sec: Section) => {
    if (sec.id === 'basic') return (
      <>
        {sec.fields.map((f) => <CfgRow key={f.path} label={f.label} hint={f.hint} full={f.full} danger={f.danger} path={f.path} highlight={highlight === f.path}><FieldControl f={f} form={form} field={field} modelIds={modelIds} /></CfgRow>)}
        <SubHead hint="只改引用，镜像字段由后端回填">主接入（对话主模型）</SubHead>
        <CfgRow label="厂商" hint="基础模型的唯一来源。" full>
          <div className="flex flex-wrap items-center gap-2">
            <Select value={form.providerId || ''} onChange={(e) => setBaseProvider(e.target.value)} className="w-[260px]">
              <option value="">{providers.length ? '清空 = 停用主模型' : '无厂商，请先添加'}</option>
              {providers.map((p) => <option key={p.id} value={p.id}>{p.name || '（未命名）'} · {p.baseURL || '未填地址'}</option>)}
            </Select>
            <button className="text-[11px] text-lagoon hover:underline" onClick={() => jump(SECTIONS.find((s) => s.id === 'providers')!)}>管理厂商</button>
          </div>
        </CfgRow>
        <CfgRow label="模型" hint="从所选厂商的模型条目中选择。" full>
          <div className="flex flex-wrap items-center gap-2">
            <Select value={form.modelId || ''} onChange={(e) => setBaseModel(e.target.value)} disabled={!form.providerId} className="w-[260px]">
              <option value="">清空 = 停用主模型</option>
              {mainModels.map((m) => <option key={m.id} value={m.id}>{m.name ? `${m.name} · ` : ''}{m.model}</option>)}
            </Select>
            <button className="text-[11px] text-lagoon hover:underline" onClick={() => jump(SECTIONS.find((s) => s.id === 'models')!)}>管理模型</button>
          </div>
        </CfgRow>
        {mainProvider ? (
          <div className="my-3 rounded-lg border border-line-soft bg-white/40 px-3 py-2 text-[10.5px] leading-relaxed text-ink-2">
            当前生效：<span className="mono">{form.model || '—'}</span> · {mainProvider.protocol || 'openai'} · <span className="mono">{mainProvider.baseURL || '(未填接口地址)'}</span> · {mainProvider.apiKey ? 'Key 已填' : 'Key 未填'}
          </div>
        ) : <Note tone="amber">主模型未接入：先在「厂商配置」添加厂商，再到「模型列表」挂模型，最后在这里选择。</Note>}
        <SubHead hint="失败时按顺序回退">回退模型链</SubHead>
        <div className="mb-2 flex justify-end"><Button size="sm" variant="secondary" onClick={() => field('fallbackModels', [...(form.fallbackModels || []), { model: '', baseURL: '', apiKey: '', protocol: 'openai' }])} icon={<Plus size={12} />}>添加回退</Button></div>
        {(form.fallbackModels || []).length === 0 ? <p className="pb-3 text-[11px] text-ink-3">没有回退模型。主模型失败时会直接报错。</p> : (form.fallbackModels || []).map((fb: any, i: number) => (
          <div key={i} className="mb-2 grid grid-cols-1 gap-2 rounded-lg border border-line-soft bg-white/35 p-2.5 sm:grid-cols-[1fr_130px_1fr_1fr_auto]">
            <Input value={fb.model || ''} placeholder="模型 ID" onChange={(e) => { const arr = [...form.fallbackModels]; arr[i] = { ...fb, model: e.target.value }; field('fallbackModels', arr) }} />
            <Select value={fb.protocol || 'openai'} onChange={(e) => { const arr = [...form.fallbackModels]; arr[i] = { ...fb, protocol: e.target.value }; field('fallbackModels', arr) }}>{PROTOCOL.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>
            <Input className="mono" value={fb.baseURL || ''} placeholder="baseURL" onChange={(e) => { const arr = [...form.fallbackModels]; arr[i] = { ...fb, baseURL: e.target.value }; field('fallbackModels', arr) }} />
            <Input className="mono" type="password" value={fb.apiKey || ''} placeholder="apiKey" onChange={(e) => { const arr = [...form.fallbackModels]; arr[i] = { ...fb, apiKey: e.target.value }; field('fallbackModels', arr) }} />
            <Button size="icon" variant="ghost" className="btn-sm hover:text-coral" onClick={() => field('fallbackModels', form.fallbackModels.filter((_: any, j: number) => j !== i))} aria-label="删除回退"><Trash2 size={12} /></Button>
          </div>
        ))}
        {hasJev && (<>
        <SubHead hint="opt-in · 数据外发判断服务">Jev 判断模型</SubHead>
        <Note tone="amber">启用后，判断请求会发送到 Jev（TypeSafe）。未启用时所有判断回退规则。</Note>
        <CfgRow label="启用 Jev"><Switch checked={!!form.jev?.enable} onChange={(v) => field('jev.enable', v)} label="启用 Jev" /></CfgRow>
        <CfgRow label="Jev 厂商"><Select value={form.jev?.providerId || ''} disabled={!form.jev?.enable} onChange={(e) => field('jev.providerId', e.target.value)}><option value="">（未选择）</option>{providers.map((p) => <option key={p.id} value={p.id}>{p.name || p.id}</option>)}</Select></CfgRow>
        <CfgRow label="Jev 模型"><Input className="mono" value={form.jev?.model || ''} onChange={(e) => field('jev.model', e.target.value)} placeholder="模型 ID" /></CfgRow>
        <CfgRow label="注册 jev 工具"><Switch checked={!!form.jev?.decisions?.llmTool} onChange={(v) => field('jev.decisions.llmTool', v)} label="注册 jev 工具" /></CfgRow>
        <CfgRow label="超时（ms）"><Input className="w-[130px]" type="number" min={500} step={500} value={form.jev?.timeoutMs ?? ''} onChange={(e) => field('jev.timeoutMs', Number(e.target.value))} /></CfgRow>
        <CfgRow label="重试次数"><Input className="w-[100px]" type="number" min={0} max={5} value={form.jev?.maxRetries ?? ''} onChange={(e) => field('jev.maxRetries', Number(e.target.value))} /></CfgRow>
        <CfgRow label="思考档位置信阈值"><Input className="w-[120px]" type="number" min={0} max={1} step={0.05} value={form.jev?.thresholds?.thinkingMinConfidence ?? ''} onChange={(e) => field('jev.thresholds.thinkingMinConfidence', Number(e.target.value))} /></CfgRow>
        <CfgRow label="反思触发阈值"><Input className="w-[120px]" type="number" min={0} max={1} step={0.05} value={form.jev?.thresholds?.reflectFloor ?? ''} onChange={(e) => field('jev.thresholds.reflectFloor', Number(e.target.value))} /></CfgRow>
        </>)}
      </>
    )

    if (sec.id === 'providers') return (
      <>
        <div className="flex flex-wrap items-center justify-between gap-2 py-2">
          <p className="text-[11px] text-ink-3">没有默认厂商：这里登记的就是全部可用厂商。基础模型通过引用选择。</p>
          <Button size="sm" variant="secondary" onClick={addProvider} icon={<Plus size={12} />}>添加厂商</Button>
        </div>
        {providers.length === 0 ? <EmptyState title="暂无厂商">先添加至少一个厂商，填接口地址与 Key。</EmptyState> : providers.map((p, i) => (
          <div key={p.id} className="mb-2 rounded-lg border border-line-soft bg-white/35 p-3">
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <Input value={p.name || ''} placeholder="厂商名称（如 豆包）" onChange={(e) => { const arr = [...providers]; arr[i] = { ...p, name: e.target.value }; field('llmProviders', arr) }} />
              <div className="flex gap-2"><Select value={p.protocol || 'openai'} onChange={(e) => { const arr = [...providers]; arr[i] = { ...p, protocol: e.target.value }; field('llmProviders', arr) }}>{PROTOCOL.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select><Select value={p.preset || ''} onChange={(e) => { const arr = [...providers]; const preset = e.target.value; const pick = PROVIDER_MODELS[preset]; arr[i] = { ...p, preset, ...(pick ? { protocol: pick.protocol, baseURL: pick.baseURL } : {}) }; field('llmProviders', arr) }}>{PRESET.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select></div>
              <Input className="mono" value={p.baseURL || ''} placeholder="接口地址 baseURL" onChange={(e) => { const arr = [...providers]; arr[i] = { ...p, baseURL: e.target.value }; field('llmProviders', arr) }} />
              <Input className="mono" type="password" value={p.apiKey || ''} placeholder="API Key" onChange={(e) => { const arr = [...providers]; arr[i] = { ...p, apiKey: e.target.value }; field('llmProviders', arr) }} autoComplete="new-password" />
            </div>
            <div className="mt-2 flex items-center justify-between"><div className="flex gap-1.5">{p.id === form.providerId && <Tag tone="jade">基础模型在用</Tag>}{p.preset && <Tag tone="neutral">{p.preset}</Tag>}</div><Button size="sm" variant="danger" onClick={() => void removeProvider(i)} icon={<Trash2 size={11} />}>删除</Button></div>
          </div>
        ))}
      </>
    )

    if (sec.id === 'models') return (
      <>
        <div className="flex flex-wrap items-center justify-between gap-2 py-2"><p className="text-[11px] text-ink-3">模型条目挂在厂商下；只有 providerId / modelId 是真源。</p><Button size="sm" variant="secondary" onClick={addModel} icon={<Plus size={12} />}>添加模型</Button></div>
        <datalist id="cfg-model-ids">{modelIds.map((id) => <option key={id} value={id} />)}</datalist>
        {models.length === 0 ? <EmptyState title="暂无模型">先添加模型条目，再到「基础 / 模型」选作主模型。</EmptyState> : models.map((m, i) => (
          <div key={m.id} className="mb-2 rounded-lg border border-line-soft bg-white/35 p-3">
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <Input value={m.name || ''} placeholder="别名（可选）" onChange={(e) => { const arr = [...models]; arr[i] = { ...m, name: e.target.value }; field('llmModels', arr) }} />
              <Select value={m.providerId || ''} onChange={(e) => { const arr = [...models]; arr[i] = { ...m, providerId: e.target.value }; field('llmModels', arr) }}><option value="">（未挂厂商）</option>{providers.map((p) => <option key={p.id} value={p.id}>{p.name || p.id}</option>)}</Select>
              <Input className="mono" list="cfg-model-ids" value={m.model || ''} placeholder="模型 ID（可手输）" onChange={(e) => { const arr = [...models]; arr[i] = { ...m, model: e.target.value }; field('llmModels', arr) }} />
              <Select value={m.thinking || 'inherit'} onChange={(e) => { const arr = [...models]; arr[i] = { ...m, thinking: e.target.value }; field('llmModels', arr) }}><option value="inherit">思考 · 继承全局</option><option value="on">思考 · 开启</option><option value="off">思考 · 关闭</option></Select>
              <Input type="number" step={0.1} min={0} max={2} value={m.temperature ?? ''} placeholder="温度（留空=继承）" onChange={(e) => { const arr = [...models]; arr[i] = { ...m, temperature: parseNum(e.target.value) }; field('llmModels', arr) }} />
              <Input type="number" step={256} min={1} value={m.maxTokens ?? ''} placeholder="maxTokens（留空=默认）" onChange={(e) => { const arr = [...models]; arr[i] = { ...m, maxTokens: parseNum(e.target.value) }; field('llmModels', arr) }} />
              <Input className="sm:col-span-2" value={m.note || ''} placeholder="备注（可选）" onChange={(e) => { const arr = [...models]; arr[i] = { ...m, note: e.target.value }; field('llmModels', arr) }} />
            </div>
            <div className="mt-2 flex items-center justify-between">{m.id === form.modelId ? <Tag tone="jade">基础模型</Tag> : <span />}<Button size="sm" variant="danger" onClick={() => void removeModel(i)} icon={<Trash2 size={11} />}>删除</Button></div>
          </div>
        ))}
      </>
    )

    if (sec.id === 'features') return (
      <>
        <Note tone="neutral">每个槽位填模型 ID（可直接手输）；留空 = 继承主模型。主模型请在「基础 / 模型」用引用选择。</Note>
        <datalist id="cfg-model-ids">{modelIds.map((id) => <option key={id} value={id} />)}</datalist>
        <CfgRow label="主模型" hint="对话主力：推理 / 工具调用 / 复杂任务"><Select value={form.modelId || ''} onChange={(e) => setBaseModel(e.target.value)}><option value="">（未选择）</option>{models.map((m) => <option key={m.id} value={m.id}>{m.name ? `${m.name} · ` : ''}{m.model || m.id}</option>)}</Select></CfgRow>
        {featureRows.filter((f) => f.path).map((f) => {
          const value = f.path.split('.').reduce((o: any, k) => o?.[k], form) ?? ''
          const set = (v: string) => {
            const parts = f.path.split('.')
            if (parts.length === 1) field(parts[0], v)
            else field(f.path, v)
          }
          return <CfgRow key={f.key} label={f.label} hint="可选任意厂商；运行时会解析端点"><Input className="mono" list="cfg-model-ids" value={value} placeholder="留空=主模型" onChange={(e) => set(e.target.value)} /></CfgRow>
        })}
        <CfgRow label="Stagehand 原生模型"><Input className="mono" value={form.stagehand?.modelName || ''} onChange={(e) => field('stagehand.modelName', e.target.value)} placeholder="留空=复用 provider" /></CfgRow>
      </>
    )

    if (sec.id === 'qqofficial') {
      const accounts = form.qqBot?.accounts || []
      const addAcc = () => field('qqBot.accounts', [...accounts, { appId: '', appSecret: '', name: `账号 ${accounts.length + 1}` }])
      const setAcc = (i: number, patch: any) => { const arr = [...accounts]; arr[i] = { ...arr[i], ...patch }; field('qqBot.accounts', arr) }
      return (
        <>
          <CfgRow label="启用自实现适配器"><Switch checked={!!form.qqBot?.enable} onChange={(v) => field('qqBot.enable', v)} label="启用自实现适配器" /></CfgRow>
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2 py-2"><p className="text-[11px] text-ink-3">账号列表是运行时唯一来源；旧版扁平 AppID / AppSecret 保存后会清空。</p><Button size="sm" variant="secondary" onClick={addAcc} icon={<Plus size={12} />}>添加账号</Button></div>
          {form.qqBot?.appId && <Note tone="amber">检测到旧版扁平字段（AppID {form.qqBot.appId}）。把它并入下方账号列表并保存后，旧字段会清空。</Note>}
          {accounts.length === 0 ? <p className="pb-3 text-[11px] text-ink-3">还没有账号。也可以到「机器人账号」页管理连接状态。</p> : accounts.map((a: any, i: number) => (
            <div key={i} className="mb-2 grid grid-cols-1 gap-2 rounded-lg border border-line-soft bg-white/35 p-2.5 sm:grid-cols-[1fr_1fr_1fr_auto]">
              <Input className="mono" value={a.appId || ''} placeholder="AppID（纯数字）" onChange={(e) => setAcc(i, { appId: e.target.value })} />
              <Input className="mono" type="password" value={a.appSecret || ''} placeholder="AppSecret" onChange={(e) => setAcc(i, { appSecret: e.target.value })} autoComplete="new-password" />
              <Input value={a.name || ''} placeholder="名称（可选）" onChange={(e) => setAcc(i, { name: e.target.value })} />
              <Button size="icon" variant="ghost" className="btn-sm hover:text-coral" onClick={() => field('qqBot.accounts', accounts.filter((_: any, j: number) => j !== i))} aria-label="删除账号"><Trash2 size={12} /></Button>
            </div>
          ))}
          <SubHead>账号默认参数</SubHead>
          <CfgRow label="Markdown 能力"><Select value={form.qqBot?.markdown || 'auto'} onChange={(e) => field('qqBot.markdown', e.target.value)}><option value="auto">auto（推荐）</option><option value="true">true（总是 Markdown）</option><option value="false">false（纯文本）</option></Select></CfgRow>
          <CfgRow label="纯文本也走 Markdown"><Switch checked={!!form.qqBot?.preferMarkdownText} onChange={(v) => field('qqBot.preferMarkdownText', v)} label="纯文本也走 Markdown" /></CfgRow>
          <CfgRow label="沙箱环境"><Switch checked={!!form.qqBot?.sandbox} onChange={(v) => field('qqBot.sandbox', v)} label="沙箱环境" /></CfgRow>
          <CfgRow label="事件订阅位图 intents"><Input className="w-[150px]" type="number" min={0} value={form.qqBot?.intents ?? 0} onChange={(e) => field('qqBot.intents', Number(e.target.value))} /></CfgRow>
          <CfgRow label="Markdown 直发"><Switch checked={!!form.qqOfficial?.markdown?.enable} onChange={(v) => field('qqOfficial.markdown.enable', v)} label="Markdown 直发" /></CfgRow>
          <CfgRow label="Markdown 单条上限"><Input className="w-[130px]" type="number" min={500} max={4000} step={100} value={form.qqOfficial?.markdown?.maxChars ?? 3500} onChange={(e) => field('qqOfficial.markdown.maxChars', Number(e.target.value))} /></CfgRow>
          <CfgRow label="Markdown 模板 ID"><Input className="mono" value={form.qqOfficial?.markdown?.templateId || ''} onChange={(e) => field('qqOfficial.markdown.templateId', e.target.value)} placeholder="可选" /></CfgRow>
          <CfgRow label="按钮卡片工具"><Switch checked={!!form.qqOfficial?.keyboard?.enable} onChange={(v) => field('qqOfficial.keyboard.enable', v)} label="按钮卡片工具" /></CfgRow>
          <CfgRow label="官方下发进度消息"><Switch checked={!!form.qqOfficial?.progress} onChange={(v) => field('qqOfficial.progress', v)} label="官方下发进度消息" /></CfgRow>
          <CfgRow label="官方下中途播报"><Switch checked={!!form.qqOfficial?.narrate} onChange={(v) => field('qqOfficial.narrate', v)} label="官方下中途播报" /></CfgRow>
          <a href="#/qqbot" className="mt-2 inline-flex items-center gap-1 text-[11px] text-lagoon hover:underline">去机器人账号查看连接状态 <ChevronRight size={11} /></a>
        </>
      )
    }

    if (sec.id === 'web') return (
      <>
        <CfgRow label="启用 Web 面板"><Switch checked={!!form.webApi?.enable} onChange={(v) => field('webApi.enable', v)} label="启用 Web 面板" /></CfgRow>
        <CfgRow label="面板端口"><Input className="w-[120px]" type="number" min={1} max={65535} value={form.webApi?.port ?? 6098} onChange={(e) => field('webApi.port', Number(e.target.value))} /></CfgRow>
        <CfgRow label="对外地址（可选）"><Input className="mono" value={form.webApi?.publicUrl || ''} onChange={(e) => field('webApi.publicUrl', e.target.value)} placeholder="留空=自动探测" /></CfgRow>
        <CfgRow label="启动时打印访问地址"><Switch checked={!!form.webApi?.printTokenOnStart} onChange={(v) => field('webApi.printTokenOnStart', v)} label="启动时打印访问地址" /></CfgRow>
        <CfgRow label="启动地址令牌有效期（小时）"><Input className="w-[130px]" type="number" min={1} max={8760} value={form.webApi?.consoleTokenTtlHours ?? 720} onChange={(e) => field('webApi.consoleTokenTtlHours', Number(e.target.value))} /></CfgRow>
        <div className="my-3 rounded-lg border border-line-soft bg-white/40 p-3">
          <div className="flex items-center justify-between gap-2"><span className="text-[11px] font-medium">当前默认登录地址</span><Button size="sm" variant="secondary" onClick={() => void loadWebUrl()} loading={webLoading} icon={<RefreshCw size={11} />}>获取</Button></div>
          {webUrl ? <div className="mt-2 space-y-1.5"><div className="flex gap-2"><Input className="mono" readOnly value={webUrl.local || ''} onFocus={(e) => e.currentTarget.select()} /><CopyButton text={webUrl.local || ''} label="复制" /></div>{webUrl.public && <div className="mono break-all text-[10px] text-ink-3">{webUrl.public}</div>}</div> : <p className="mt-1 text-[10.5px] text-ink-3">令牌地址也会写入 data/web/console-url.txt（权限 600）。</p>}
        </div>
      </>
    )

    if (sec.id === 'security') return (
      <>
        <CfgRow label="#ai 命令权限"><Select value={form.chatPermission || 'master'} onChange={(e) => field('chatPermission', e.target.value)}>{PERMISSION.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select></CfgRow>
        <CfgRow label="私聊对话"><Switch checked={!!form.privateChat} onChange={(v) => field('privateChat', v)} label="私聊对话" /></CfgRow>
        <CfgRow label="确认超时（秒）"><Input className="w-[120px]" type="number" min={10} value={form.confirmTimeout ?? 300} onChange={(e) => field('confirmTimeout', Number(e.target.value))} /></CfgRow>
        <CfgRow label="注入防御动作"><Select value={form.guardAction || 'flag'} onChange={(e) => field('guardAction', e.target.value)}><option value="block">拦截（block）</option><option value="flag">隔离标注（flag）</option><option value="sanitize">脱敏（sanitize）</option></Select></CfgRow>
        <CfgRow label="防御灵敏度"><Select value={form.guardSensitivity || 'medium'} onChange={(e) => field('guardSensitivity', e.target.value)}><option value="low">低（0.95）</option><option value="medium">中（0.7）</option><option value="high">高（0.5）</option></Select></CfgRow>
        <CfgRow label="外部内容注入扫描"><Switch checked={!!form.untrustedGuard} onChange={(v) => field('untrustedGuard', v)} label="外部内容注入扫描" /></CfgRow>
        <CfgRow label="回复脱敏"><Switch checked={!!form.redactSecrets} onChange={(v) => field('redactSecrets', v)} label="回复脱敏" /></CfgRow>
        <CfgRow label="人设注入检测免检" danger><Switch checked={!!form.persona?.skipInjectionCheck} onChange={(v) => field('persona.skipInjectionCheck', v)} label="人设注入检测免检" /></CfgRow>
        <CfgRow label="全链路日志 devLog"><Switch checked={!!form.devLog?.enable} onChange={(v) => field('devLog.enable', v)} label="全链路日志 devLog" /></CfgRow>
        <CfgRow label="主人任务免确认" danger><Switch checked={!!form.masterSkipConfirm} onChange={(v) => field('masterSkipConfirm', v)} label="主人任务免确认" /></CfgRow>
        <CfgRow label="主人列表" hint="QQ 号或官方 openid；回车添加。" full><TagEditor value={form.masters || []} onChange={(v) => field('masters', v)} placeholder="QQ 号 / openid" mono /></CfgRow>
        <CfgRow label="默认人设"><Select value={form.persona?.defaultId || ''} onChange={(e) => field('persona.defaultId', e.target.value)}><option value="">不使用（systemPrompt / 内置默认）</option>{((personas.data || []) as any[]).map((p) => <option key={p.id} value={p.id}>{p.name}（{p.id}）</option>)}{form.persona?.defaultId && !((personas.data || []) as any[]).some((p) => p.id === form.persona.defaultId) && <option value={form.persona.defaultId}>当前：{form.persona.defaultId}</option>}</Select></CfgRow>
        <CfgRow label="默认身份 systemPrompt" full><Textarea value={form.systemPrompt || ''} onChange={(e) => field('systemPrompt', e.target.value)} placeholder="留空 = 使用内置默认身份" /></CfgRow>
        <CfgRow label="伪人说话风格示例" hint="JSON 字符串数组。" full>
          <Textarea className="mono" value={typeof form.persona?.styleExamples === 'string' ? form.persona.styleExamples : JSON.stringify(form.persona?.styleExamples || [], null, 2)} onChange={(e) => field('persona.styleExamples', e.target.value)} onBlur={(e) => { try { const v = JSON.parse(e.target.value); if (Array.isArray(v)) field('persona.styleExamples', v) } catch { toast('风格示例不是合法 JSON 数组', 'warn') } }} />
        </CfgRow>
        <SubHead>高级目录</SubHead>
        <CfgRow label="日志目录"><Input className="mono" value={form.devLog?.dir || ''} onChange={(e) => field('devLog.dir', e.target.value)} /></CfgRow>
        <CfgRow label="人设资料库目录"><Input className="mono" value={form.personaLore?.dir || ''} onChange={(e) => field('personaLore.dir', e.target.value)} /></CfgRow>
        <CfgRow label="人设采纳审批目录"><Input className="mono" value={form.personaLore?.adoptionsDir || ''} onChange={(e) => field('personaLore.adoptionsDir', e.target.value)} /></CfgRow>
        <CfgRow label="策略类别最低角色" hint='JSON，如 {"mcp_write":1}' full><Input className="mono" value={typeof form.policy?.categoryMin === 'string' ? form.policy.categoryMin : JSON.stringify(form.policy?.categoryMin || {})} onChange={(e) => field('policy.categoryMin', e.target.value)} onBlur={(e) => { try { const v = JSON.parse(e.target.value); if (v && typeof v === 'object') field('policy.categoryMin', v) } catch { toast('策略 JSON 解析失败', 'warn') } }} /></CfgRow>
      </>
    )

    if (sec.id === 'mcp') return (
      <>
        <CfgRow label="MCP 请求超时（ms）"><Input className="w-[130px]" type="number" min={1000} step={1000} value={form.mcp?.requestTimeout ?? 60000} onChange={(e) => field('mcp.requestTimeout', Number(e.target.value))} /></CfgRow>
        <Note tone="amber">这里的 JSON 是 agent.mcp.servers 全量对象；保存时整体替换。缺 <span className="mono">category</span> 的工具默认 system（仅主人）。</Note>
        <Textarea className="mono min-h-[260px]" value={mcpText} onChange={(e) => { setMcpText(e.target.value); setMcpError('') }} spellCheck={false} />
        {mcpError && <p className="mt-1 text-[10.5px] text-coral">{mcpError}</p>}
        <div className="mt-2 flex gap-2"><Button size="sm" variant="secondary" onClick={() => { try { setMcpText(JSON.stringify(JSON.parse(mcpText), null, 2)); setMcpError('') } catch (e: any) { setMcpError(e?.message || 'JSON 非法') } }}>格式化</Button></div>
      </>
    )
    return null
  }

  return (
    <div className="page page-narrow !max-w-[1500px]">
      <PageHeader
        title="配置中心"
        description="常用项、安全项与高级项都在这一页。保存只写差异并热加载；极少数冷门字段仍以 config.yaml / 锅巴为准。"
        actions={(
          <>
            <Button variant="secondary" size="sm" onClick={() => void refresh()} icon={<RefreshCw size={14} />}>重新读取</Button>
            <Button variant="primary" size="sm" onClick={() => void save()} loading={saving}>保存并热加载</Button>
          </>
        )}
        meta={<><span>agent.* 命名空间</span><span className="h-3 w-px bg-ink/10" /><span>基础模型镜像字段由引用回填</span></>}
      />

      {error && <div className="mb-4"><ErrorState message={`读取 /api/config 失败：${error}`} onRetry={() => void refresh()} /></div>}
      {!ready && loading ? <div className="panel p-8 text-center text-[12px] text-ink-3">正在加载配置…</div> : (
        <div className="grid grid-cols-1 gap-5 xl:grid-cols-[230px_minmax(0,1fr)]">
          <aside className="hidden xl:block">
            <div className="sticky top-[76px]">
              <div className="relative mb-2">
                <Input icon={<Search size={14} />} value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索配置项 / 路径…" />
                {q && searchResults.length > 0 && (
                  <div className="absolute left-0 right-0 top-[42px] z-20 max-h-[360px] overflow-y-auto rounded-xl border border-white/80 bg-white/95 p-1 shadow-[0_24px_50px_-28px_rgba(10,60,56,.45)] backdrop-blur-xl">
                    {searchResults.map((r, i) => (
                      <button key={i} className="flex w-full items-start gap-2 rounded-lg px-2.5 py-2 text-left hover:bg-lagoon-soft/60" onClick={() => jump(r.section, r.field?.path)}>
                        <span className="mt-1 h-1 w-1 flex-none rounded-full bg-lagoon" />
                        <span className="min-w-0"><span className="block text-[11px] font-medium">{r.field?.label || r.section.name}</span><span className="mono block truncate text-[9px] text-ink-3">{r.field?.path || r.section.desc}</span></span>
                      </button>
                    ))}
                  </div>
                )}
                {q && searchResults.length === 0 && <div className="absolute left-0 right-0 top-[42px] z-20 rounded-xl border border-white/80 bg-white/95 px-3 py-3 text-[10.5px] text-ink-3 shadow-lg">没有匹配的配置项</div>}
              </div>
              <nav className="panel max-h-[calc(100dvh-160px)] overflow-y-auto p-2">
                {visibleSections.map((s) => (
                  <button key={s.id} className={cn('mb-0.5 flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[11px] transition', openSections[s.id] ? 'bg-lagoon-soft/60 text-lagoon-deep' : 'text-ink-3 hover:bg-white/50 hover:text-ink')} onClick={() => jump(s)}>
                    <s.icon size={13} /> <span className="min-w-0 flex-1 truncate">{s.name}</span>
                  </button>
                ))}
              </nav>
              <p className="mt-2 px-1 text-[9.5px] leading-relaxed text-ink-4">极少数冷门字段仍以 config.yaml / 锅巴为准。</p>
            </div>
          </aside>

          <div className="min-w-0 space-y-4">
            <datalist id="cfg-model-ids">{modelIds.map((id) => <option key={id} value={id} />)}</datalist>
            {visibleSections.map(renderSection)}
          </div>
        </div>
      )}

      <SaveBar dirty={dirty} onReset={reset} onSave={() => void save()} busy={saving} />
    </div>
  )
}
