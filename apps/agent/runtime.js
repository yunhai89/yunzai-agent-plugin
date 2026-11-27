/**
 * 运行时装配与生命周期（原 apps/agent.js 的 buildRuntime/getRuntime）。
 * 配置热加载、作用域清理、并发构建合并、定时任务恢复都在这里；
 * 命令层只通过 getRuntime()/invalidateRuntime() 访问。
 */

import fs from 'node:fs'
import path from 'node:path'

import Config from '../../utils/Config.js'
import Log from '../../utils/Log.js'
import { Agent, createProvider, createModelRouter, ToolRegistry, MemoryStore, createMemoryTool, makeRecallTool, ProfileStore, SessionStore, RecallStore, ScheduleStore, reminderSetTool, reminderListTool, reminderCancelTool, scheduleTaskTool, ConfirmStore, nodeScheduleAdapter, memoryKv, redisKv, noteTools, clarifyTool, checkInput, screenUntrusted, systemHardening, createPolicy, TaskStore, RuntimeScope, abortActiveRun, abortAllActiveRuns, ToolScheduler } from '../../model/agent/index.js'
import { presets as openaiPresets } from '../../model/openai/index.js'
import { presets as anthropicPresets } from '../../model/anthropic/index.js'
import { McpManager } from '../../model/mcp/index.js'
import { makeMediaTools } from '../../model/media/index.js'
import { detectCapabilities } from '../../model/llm/capabilities.js'
import { primeModelCaps } from '../../model/llm/caps-source.js'
import { buildEmbed } from '../../model/llm/embed-wiring.js'
import { KnowledgeStore, makeKbSearchTool } from '../../model/agent/knowledge.js'
import { detectGpu } from '../../model/agent/vector-backends.js'
import { webCrawlTool, resetCrawl4aiProbe } from '../../model/crawl/index.js' // web_crawl：抓取网页正文（常驻）
import { CompactionArchive } from '../../model/agent/compact/archive.js' // 无损压缩：原文内容寻址归档
import { makeContextRecallTool } from '../../model/agent/compact/recall.js' // context_recall：取回归档原文
import { groupInfoTools, groupManageTools, groupHistoryTools, groupNoticeTools, groupFileTools, aiVoiceTools, forwardTools } from '../../model/group/index.js'
import { miyousheTools } from '../../model/miyoushe/index.js'
import { enkaTools } from '../../model/enka/index.js'
import { loadToolPacks } from '../../model/toolkit/index.js'
import { createSearchManager, makeSearchTools } from '../../model/search/index.js'
import { PersonaStore, PersonaService, PersonaLore, PersonaAdoptionQueue, PERSONA_COMPLETION_SYSTEM, buildCompletionInput, parseCompletionOutput, buildLoreDraft } from '../../model/persona/index.js'
import { VisionService, resolveVisionBaseURL, resolveVisionRoute } from '../../model/vision/index.js'
import { getStickerManager } from '../../model/sticker/manager.js'

import { stripMarkers } from '../../model/sticker/parser.js'
import { makeSendKeyboardTool } from '../../model/qqofficial/tool.js'
import { redactSecrets } from '../../model/agent/redact.js'
import { randomUUID } from 'node:crypto'
import devLog from '../../utils/DevLog.js'
import { SkillRegistry, loadSkillPack, makeSkillTool } from '../../model/skill/index.js'
import { makeInstallSkillTool } from '../../model/skill/install.js'
import { PromptRegistry, PromptTemplate, TEMPLATES } from '../../model/prompt/index.js'
import { TraceStore } from '../../model/evolution/trace.js'
import { SelfReviewer } from '../../model/evolution/review.js'
import { makeTerminalTool } from '../../model/terminal/index.js'
import { createJevClient, makeJevTool, JEV_MODEL_DEFAULT, resolveThresholds } from '../../model/agent/jev/index.js'
import { createSandboxRuntime, legacyEgressFix } from '../../model/sandbox/index.js'
import { makeStagehand } from '../../model/stagehand/index.js'
import { makeDownloadTool } from '../../model/download/index.js'
import { makeSpawnSubagentTools, Semaphore, Orchestrator, SubagentSpec, buildWorkerTools, normalizeSubagentResult } from '../../model/multiagent/index.js'
import { calcTool } from '../../model/calc/index.js'
import { sendFileTool } from '../../model/document/sendfile.js'
import { readPdfTool } from '../../model/document/pdf.js'
import { createExcelTool, readExcelTool } from '../../model/document/excel.js'
import { fileToPdfTool } from '../../model/document/topdf.js'
import { transcribeMediaTool } from '../../model/document/media_stt.js'
import { TtsService, makeTtsSpeakTool } from '../../model/tts/index.js'
import { DiagramService } from '../../model/diagram/index.js'
import { startTempSweep } from '../../model/temp-sweeper.js'
import { makeDiagramTool } from '../../model/diagram/tool.js'
import { createUsageStats } from '../../model/agent/store/usage-stats.js'


import { PLUGIN_ROOT, BUILTIN_AGENT_LIMITS, BUILTIN_THINKING, BUILTIN_TOOL_DISCOVERY } from './constants.js'
import { makeFireDispatch, makeCompletionToolRegistry, attachToolRuntime } from './context.js'

let _runtime = null
let _runtimePromise = null // in-flight buildRuntime()，并发安全：多调用方共享同一次构建
let _runtimeFailed = null  // buildRuntime 失败原因缓存；非 null 则 getRuntime 直接抛、不再重试，避免每条消息刷屏重建
let _runtimeGen = 0        // 运行时代际：invalidateRuntime 递增；在途构建据此丢弃旧配置结果，防止热重载后复活旧运行时
let _closingPromise = null // 旧运行时 scope.close() 的在途 Promise：getRuntime 在重建前 await，避免旧资源与新运行时并存
let _initErrLogged = false // 初始化失败日志限首（防每条消息重复打 ERRO）
const _initFailNotified = new Set() // 已提示过"初始化失败"的用户(每用户仅提示一次，防刷屏)；runtime 重建时清

/** 初始化失败日志限首（原 _initErrLogged）：握手 / 首条消息共用，避免每条消息重复打 ERROR。 */
export function logInitErrorOnce(e) {
  if (_initErrLogged) return
  _initErrLogged = true
  Log.error('agent 初始化失败（修复 config 后重启，或保存 config 触发热加载自动恢复）', e?.message || e)
}

/** 运行时初始化失败是否已提示过该用户（每用户一次，重建时清）。 */
export function wasInitFailureNotified(userId) {
  return _initFailNotified.has(String(userId))
}

export function markInitFailureNotified(userId) {
  _initFailNotified.add(String(userId))
}

/** 当前运行时代际（热重载递增）：落任务账本用于判断任务是否属于旧运行时。 */
export function runtimeGeneration() {
  return _runtimeGen
}

function getKv() {
  if (typeof globalThis !== 'undefined' && globalThis.redis) return redisKv(globalThis.redis)
  return memoryKv()
}

// 一次性把旧「TRSS data 目录」下的插件数据迁到插件自己目录（Config.path.data 下）。幂等。
// memories/personas 等持久数据；首次迁移后旧目录留空壳（不删，避免误伤）。
function migratePluginData() {
  try {
    const moves = [
      ['memories', Config.path.memories],
      ['personas', Config.path.personas],
    ]
    for (const [name, dst] of moves) {
      const src = path.join(Config.path.yunzai, 'data/agents-plugin', name)
      if (!fs.existsSync(src)) continue
      // 目标已有内容则不迁（避免覆盖）
      let dstHas = false
      try { dstHas = fs.existsSync(dst) && fs.readdirSync(dst).length > 0 } catch { /* noop */ }
      if (dstHas) continue
      try { fs.mkdirSync(path.dirname(dst), { recursive: true }) } catch { /* noop */ }
      // 整目录搬移（rename 跨设备会失败 → 退化逐项复制）
      try { fs.renameSync(src, dst); Log.mark('[migrate] 迁移', name, '→', dst); continue }
      catch { /* 跨设备，走逐项复制 */ }
      try {
        fs.mkdirSync(dst, { recursive: true })
        for (const f of fs.readdirSync(src)) {
          const s = path.join(src, f), d = path.join(dst, f)
          fs.copyFileSync(s, d)
        }
        Log.mark('[migrate] 复制', name, '→', dst, '（旧目录保留）')
      } catch (e) { Log.warn('[migrate] 迁移失败', name, e?.message || e) }
    }
  } catch { /* noop */ }
}

/**
 * 官方机器人适配器的失败形态：sendMsg 内部 catch 后返回 { message_id:[], data:[], error:[...] }，
 * 不抛错也不算 retcode 失败。这里识别「error 非空且没有任何 message_id」= 发送失败，
 * 由回复路径降级到纯文本（markdown 被平台拒绝时的兜底）。
 */
export function apiRejected(ret) {
  if (!ret || typeof ret !== 'object') return false
  if (typeof ret.retcode === 'number' && ret.retcode !== 0) return true
  if (Array.isArray(ret.error) && ret.error.length) {
    const ids = Array.isArray(ret.message_id) ? ret.message_id.length : 0
    if (!ids) return true
  }
  return false
}

// 配置数值判空：null/''/undefined → null；0 是合法值，必须保留（不要用 Number(x) 判存在：
// Number(null)===0 会把「留空/继承全局」误判为显式 0，2026-10-29 配置互搏审计 P0/F1）。

function numOrNull(v) {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** 统一外发脱敏：redactSecrets=false 时所有发送路径都不脱敏（此前播报/错误/续跑无条件脱敏，开关只关一半）。 */
export function maybeRedact(text) {
  const s = String(text ?? '')
  if (Config.get().agent?.redactSecrets === false) return s
  return redactSecrets(s)
}

// 构造走代理的 fetch（undici ProxyAgent）；undici 未装/地址错则返回 null（直连）。供 provider 访问海外 LLM（GPT/Gemini 等）
async function makeProxyFetch(proxy) {
  if (!proxy) return null
  // yaml 注释曾承诺 HTTP/SOCKS 双协议，但 undici ProxyAgent 只认 http(s)：
  // socks5:// 会在构造时抛错并被下面 catch 静默直连（2026-10-29 配置互搏审计 F28）。显式提示，
  // 避免用户以为请求已走代理；如需 SOCKS 请改用环境代理/网关。
  if (/^socks/i.test(String(proxy).trim())) {
    if (!makeProxyFetch._socksWarned) {
      makeProxyFetch._socksWarned = true
      Log.warn('[provider] agent.proxy 不支持 SOCKS 协议（仅 http/https），本次将直连；请改用 http(s) 代理或网关')
    }
    return null
  }
  try {
    const { ProxyAgent, fetch: uFetch } = await import('undici')
    const dispatcher = new ProxyAgent(proxy)
    return (url, opts = {}) => uFetch(url, { ...opts, dispatcher })
  } catch (e) {
    Log.warn('[provider] 代理不可用（undici 未装或地址错误），将直连', e?.message || e)
    return null
  }
}

/**
 * 搜索专用 fetch：
 *  - 显式配了 agent.proxy → 直接用该代理；
 *  - 否则若环境变量有 HTTP(S)_PROXY/ALL_PROXY（Node 原生 fetch 默认不读，curl 却读，极易误判"直连能通"）
 *    → 用环境代理，但本地/内网地址（SearXNG localhost 等）仍直连；
 *  - 都没有 → 原生 fetch。
 * 目的：让 DDG 等海外兜底源在受限网络下真正可用（此前搜索固定裸 fetch，配了代理也不生效）。
 */
async function makeSearchFetch(proxyFetch) {
  const direct = (typeof fetch !== 'undefined' && fetch) || undefined
  if (proxyFetch) return proxyFetch
  const envProxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.ALL_PROXY
    || process.env.HTTP_PROXY || process.env.http_proxy
  if (!envProxy) return direct
  try {
    const { ProxyAgent, fetch: uFetch } = await import('undici')
    const dispatcher = new ProxyAgent(envProxy)
    const isLocal = (u) => /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(String(u))
    return (url, opts = {}) => uFetch(url, isLocal(url) ? opts : { ...opts, dispatcher })
  } catch (e) {
    Log.warn('[search] 环境代理不可用，搜索将直连', e?.message || e)
    return direct
  }
}


async function buildRuntime() {
  // P0-4：为本次构建创建资源作用域；构建失败按逆序回滚已获取资源，避免半成品残留。
  const scope = new RuntimeScope({ name: 'runtime' })
  try {
    return await _buildRuntime(scope)
  } catch (e) {
    try { await scope.close('build_failed') } catch { /* noop */ }
    throw e
  }
}

async function _buildRuntime(scope) {
  const rootCfg = Config.get() || {}
  const cfg = rootCfg.agent || {}
  // Web「调试日志」顶层开关：强制 debug/trace 输出到后台（Yunzai logger 默认 info 会过滤）。
  Log.setDebug(rootCfg.debug === true)
  // 每次运行时重建（含 #agent重载）清空 crawl4ai 可用性探测缓存：
  // 用户跑完 scripts/install-crawl4ai.sh 后发 #agent重载 即可立即启用真浏览器抓取
  try { resetCrawl4aiProbe() } catch { /* noop */ }
  // 显式打印本轮生效的步数上限：便于确认配置是否已随运行时重建生效（出现过"改了配置仍是旧值"的困惑）
  Log.mark('[limits]', `maxTurns=${cfg.maxTurns ?? 200} · schedule.taskMaxTurns=${cfg.schedule?.taskMaxTurns ?? 200} · multiagent.workerMaxTurns=${cfg.multiagent?.workerMaxTurns ?? 200} · workerTimeBudget=${Math.round((cfg.multiagent?.workerTimeBudgetMs ?? 3600000) / 60000)}min · workerMaxTokens=${cfg.multiagent?.workerMaxTokens ?? 16384} · resultCap=${cfg.multiagent?.resultCap ?? 48000} · rootTimeBudget=${Math.round(BUILTIN_AGENT_LIMITS.loop.timeBudgetMs / 60000)}min · rootTokenBudget=${BUILTIN_AGENT_LIMITS.loop.tokenBudget}`)
  // F14：最先登记——关闭时取消并等待在途 Agent run 退出，再关依赖资源/账本（关库晚于最后写账本者）
  scope.register(async () => { try { const n = await abortAllActiveRuns(); if (n) Log.info(`[runtime] 关闭：已取消并等待 ${n} 个在途任务退出`) } catch { /* noop */ } }, { name: 'active-runs', order: -1 })
  const startupInfo = {} // 运行时构建期采集的摘要信息（供末尾统一面板输出）
  // cfg.protocol/preset/baseURL/apiKey/model 是「基础模型引用」的解析镜像（由 Config 按 agent.providerId/modelId 回填）
  if (!cfg.apiKey) throw new Error(`未选定可用的基础模型：请在 Web 配置中心「厂商配置」维护厂商（填 baseURL + API Key）、「模型列表」挂模型，再到「基础 / 模型」选中厂商与模型（等价于 config.yaml 的 agent.providerId / agent.modelId）。当前 agent.apiKey 为空——它是上面引用的解析结果，直接改它会在下次加载被覆盖。`)

  const protocol = cfg.protocol || 'openai'
  const presetMap = protocol === 'anthropic' ? anthropicPresets : openaiPresets
  const preset = cfg.preset ? presetMap[cfg.preset] : {}
  const proxyFetch = cfg.proxy ? await makeProxyFetch(cfg.proxy) : null
  // provider 传输层日志（长任务稳定性审计 P1：重试含 attempt/原因/退避时长，曾是无声 no-op）；
  // 经 clientOpts 透传到底层 Client 的 requestWithRetry(log)
  const providerLog = Log.tag('provider')
  const provider = createProvider({
    protocol,
    ...preset,
    ...(cfg.baseURL ? { baseURL: cfg.baseURL } : {}),
    apiKey: cfg.apiKey,
    model: cfg.model,
    log: providerLog,
    ...(proxyFetch ? { fetch: proxyFetch } : {}),
  })
  // 官方模型能力（数据驱动）：从厂商 /models 拉取模态元数据（OpenRouter 等）prime 一次，供 detectCapabilities 同步叠加；
  // 未暴露模态的厂商（含小米 MiMo）返回空 → 回退内置注册表 + media.caps 覆盖。best-effort，不阻塞启动失败。
  // 模型上下文窗口始终优先走官方 /models（即使关闭媒体能力拉取）；媒体 caps 仅在开关允许时叠加。
  try {
    await primeModelCaps({
      protocol, baseURL: cfg.baseURL, apiKey: cfg.apiKey, preset: cfg.preset,
      models: [cfg.model, cfg.vision?.model].filter(Boolean),
      fetchImpl: proxyFetch || undefined,
      contextOnly: cfg.media?.capsFromApi === false,
    })
  } catch { /* 忽略：回退本地模型目录 */ }

  // 缓存策略内置：cacheControl 仅官方 Anthropic 端点自动开启（兼容网关未知字段可能 400）；
  // prompt_cache_key 仅官方 OpenAI preset 下发（绝不发 DeepSeek/兼容网关）
  provider.cacheCaps = {
    // 官方端点判定 = 未自定义 baseURL 且 preset 为空或官方同名（deepseek/minimax 等第三方 anthropic/openai 兼容预设不算）
    cacheControlAuto: protocol === 'anthropic' && !cfg.baseURL && (!cfg.preset || cfg.preset === 'anthropic'),
    promptCacheKey: protocol === 'openai' && !cfg.baseURL && (!cfg.preset || cfg.preset === 'openai'),
  }

  // 功能模型路由：让记忆抽取/自进化评审/子代理/伪人/群世界等功能模型可落在任意已注册厂商
  // （llmProviders），不再局限于主端点。引用按 llmModels[].id 或 model 字符串解析，裸模型名回退主 provider。
  const modelRouter = createModelRouter({ cfg, mainProvider: provider, mainModel: cfg.model, proxyFetch, providerLog })

  // 可选 embedding 函数：填了 recall.embedProvider 才造（OpenAI 兼容 /embeddings 端点），供工具检索 + recall 语义召回共用。
  // 与 groupworld/humanize 共用同一装配 helper（曾两处手写重复——改一处漏一处）
  const { embedFn, embedModel } = buildEmbed({ provider })

  // 回退 provider：每条独立 baseURL/apiKey/protocol（可跨厂商，如主 DeepSeek + 回退 GPT）
  const fallbackProviders = []
  // F7 单真源：只读 agent.fallbackModels[]（旧扁平字段由 utils/Config.js 启动时迁移进数组并删除）
  const fbList = Array.isArray(cfg.fallbackModels) ? cfg.fallbackModels : []
  for (const fb of fbList) {
    if (!fb || !fb.model || !fb.apiKey) continue
    try {
      const fbp = fb.protocol || 'openai'
      const fbPreset = fb.preset ? (fbp === 'anthropic' ? anthropicPresets : openaiPresets)[fb.preset] : {}
      const fp = createProvider({
        protocol: fbp, ...fbPreset,
        ...(fb.baseURL ? { baseURL: fb.baseURL } : {}),
        apiKey: fb.apiKey, model: fb.model,
        log: providerLog,
        ...(proxyFetch ? { fetch: proxyFetch } : {}),
      })
      // 回退 provider 的缓存能力按【自身】配置推导（与主 provider 同一套规则）：
      // 之前只有主 provider 设 cacheCaps，回退时 _cacheControlFor/_promptCacheKeyFor 沿用主模型能力，
      // 会把主模型才支持的 prompt_cache_key/cacheControl 发给不支持的回退端点。装配一次不漏。
      fp.cacheCaps = {
        cacheControlAuto: fbp === 'anthropic' && !fb.baseURL && (!fb.preset || fb.preset === 'anthropic'),
        promptCacheKey: fbp === 'openai' && !fb.baseURL && (!fb.preset || fb.preset === 'openai'),
      }
      fallbackProviders.push({ provider: fp, model: fb.model })
    } catch (e) { Log.warn('[fallback] 回退模型装配失败', fb?.model, e?.message || e) }
  }

  // 一切数据存插件自己目录（Config.path.data 下）；首次运行把旧 TRSS data 目录的数据迁过来
  migratePluginData()
  const memoryDir = Config.path.memories
  // 记忆威胁扫描（声明式记忆 + 召回记忆共用）：写入前检测指令注入（复用入口 guard.checkInput）。
  // 声明式记忆会注入 system，命中即拒写（MemoryThreatError），防把注入持久化进每轮 system。
  const threatScanFn = cfg.memory?.threatScan === false ? null : (text) => {
    try {
      return checkInput(String(text || ''), { sensitivity: 'medium', action: 'flag' })
    } catch { return { flagged: false, score: 0, hits: [] } }
  }
  const memory = new MemoryStore({
    dir: memoryDir,
    limits: cfg.memoryLimits || undefined, // 接通死配置；null 会覆盖默认 → undefined 回落 DEFAULT_LIMITS
    enabled: cfg.memory?.enable === false ? { memory: false, user: false } : undefined,
    scan: threatScanFn, // 声明式记忆写入注入扫描
  })
  const personaDir = Config.path.personas
  // 高危免检开关（默认关）：开启后新建/编辑人设、人设资料不再做越狱/注入检测
  const skipPersonaInjectionCheck = cfg.persona?.skipInjectionCheck === true
  if (skipPersonaInjectionCheck) Log.warn('[persona] 已开启人设注入检测免检（agent.persona.skipInjectionCheck=true）：人设/资料内容将不做越狱/注入校验，请确认来源可信')
  const personaStore = new PersonaStore({ dir: personaDir, skipInjectionCheck: skipPersonaInjectionCheck })
  const K = getKv()
  // 用量统计采集器：对话/工具用量按本地日聚合写 KV（Web 端 overview 趋势主数据源，替代读日志的不稳定路径）
  const usageStats = createUsageStats({ kv: K, logger: Log })
  // F16：获取即登记清理（带 order），构建中途失败时也可回滚
  scope.register(async () => { try { await usageStats?.flushNow?.() } catch { /* noop */ } ; try { usageStats?.stop?.() } catch { /* noop */ } }, { name: 'usageStats', order: 70 })
  const session = new SessionStore({ kv: K })

  // 可恢复任务账本（P0-3，opt-in）：任务事件/检查点落 sqlite 事务；重启把未结算任务标 interrupted
  // （默认不自动重放副作用）。与 SessionStore（对话历史投影）职责分离。
  let taskStore = null
  if (cfg.taskStore?.enable === true) {
    try {
      taskStore = new TaskStore({ dir: path.resolve(PLUGIN_ROOT, cfg.taskStore?.dir || 'data/tasks'), logger: Log.tag('task') })
      await taskStore.open()
      const n = await taskStore.markInterrupted({ runtimeGeneration: _runtimeGen })
      if (n) Log.info(`[task] 重启：${n} 个未结算任务已标记 interrupted（默认不自动重放）`)
      // F02：取消落账后联动中止在途 Agent run（QQ/Web 取消真正停止执行）
      taskStore.setCancelHook((id) => { try { abortActiveRun(id) } catch { /* noop */ } })
      scope.register(async () => { try { await taskStore?.close?.() } catch { /* noop */ } }, { name: 'taskStore', order: 90 })
      Log.debug('[task] 任务账本已启用')
    } catch (e) {
      Log.warn('[task] 任务账本初始化失败，降级为不可恢复模式', e?.message || e)
      try { await taskStore?.close?.() } catch { /* noop */ } // F16：初始化失败关闭已打开连接
      taskStore = null
    }
  }
  // 召回记忆威胁扫描：复用同一 threatScanFn，按 0.6 更严阈值判定（召回内容会进上下文）
  const recallScanFn = threatScanFn ? (text) => {
    try {
      const g = threatScanFn(text)
      return !!g.blocked || (typeof g.score === 'number' && g.score >= 0.6)
    } catch { return false }
  } : null
  const recall = new RecallStore({
    kv: K,
    cap: cfg.recall?.cap,
    extractEvery: cfg.recall?.extractEvery,
    minScore: cfg.recall?.minScore,
    diversity: cfg.recall?.diversity,
    usage: cfg.recall?.usage,
    scanFn: recallScanFn,
    // embedding（可选）：填了 recall.embedProvider 即走 cosine 语义召回，否则纯关键词 jaccard
    embedFn,
  })
  // 统一用户画像（跨会话结构化用户模型）：复用召回威胁扫描；infer:false 关闭隐式偏好推断
  const profile = cfg.profile?.enable === false ? null : new ProfileStore({
    kv: K,
    scanFn: recallScanFn,
    maxChars: cfg.profile?.maxChars,
    maxPerFacet: cfg.profile?.maxPerFacet,
    inferAfter: cfg.profile?.infer === false ? Infinity : cfg.profile?.inferAfter,
  })
  // 知识库（全局共享文档库）：复用 recall 的 embedFn，chunk+向量化存 KV，kb_search 检索（RAG）
  // GPU 只做检测与提示，绝不自动启用：cuvs 需显式 backend + 用户授权，避免抢占用户 GPU 上正在跑的任务。
  const kbCfg = cfg.kb || {}
  const gpuInfo = kbCfg.enable === false ? { hasGpu: false, reason: 'kb_disabled' } : await detectGpu({ timeoutMs: 1200 })
  if (gpuInfo.hasGpu) {
    if (kbCfg.vectorBackend === 'cuvs' && kbCfg.vectorGpuConsent !== true) {
      Log.warn(`[kb] 检测到 GPU（${gpuInfo.name}），但未获授权：已回退 CPU 向量检索。确认 GPU 空闲后可设 agent.kb.vectorGpuConsent: true + vectorBackend: cuvs`)
    } else if (kbCfg.vectorBackend !== 'cuvs') {
      Log.mark(`[kb] 检测到 NVIDIA GPU（${gpuInfo.name}，显存 ${gpuInfo.memoryMB || '?'}MB）：如需 GPU 向量检索，安装 cuvs-node 后设 vectorBackend: cuvs + vectorGpuConsent: true（需确认 GPU 空闲）`)
    }
  }
  const knowledge = new KnowledgeStore({
    kv: K, embedFn,
    logger: Log.tag('kb'),
    vectorDir: (kbCfg.vectorStore === false || !embedFn) ? null : path.join(Config.path.data, 'vectors', 'kb'),
    vectorSignature: embedModel,
    vectorBackend: kbCfg.vectorBackend || 'auto',
    vectorGpuConsent: kbCfg.vectorGpuConsent === true,
    hnsw: kbCfg.hnsw || {},
    cuvs: kbCfg.cuvs || {},
    chunkSize: kbCfg.chunkSize, chunkOverlap: kbCfg.chunkOverlap,
    topK: kbCfg.topK, minScore: kbCfg.minScore,
  })
  scope.register(() => { try { knowledge?.shutdown?.() } catch { /* noop */ } }, { name: 'knowledge', order: 20 })
  // confirmTimeout 配置单位是「秒」，ConfirmStore 用「毫秒」，这里换算（默认 300 秒）
  const confirm = new ConfirmStore({ timeout: (cfg.confirmTimeout || 300) * 1000 })
  const scheduler = await nodeScheduleAdapter()
  const schedule = new ScheduleStore({ kv: K, scheduler, logger: Log.tag('schedule') })
  scope.register(() => { try { schedule?.shutdown?.() } catch { /* noop */ } }, { name: 'schedule', order: 10 })
  knowledge.attachScheduler(scheduler) // KB URL 定时刷新复用同一 scheduler（注册/恢复 refresh job）
  const persona = new PersonaService({ store: personaStore, kv: K, defaultId: cfg.persona?.defaultId || null })
  if (cfg.persona?.defaultId && !personaStore.getExact(cfg.persona.defaultId)) {
    Log.warn(`[persona] 默认人设 id「${cfg.persona.defaultId}」不存在（可能已被删除），将回落 Agent 默认身份`)
  }
  // 人设资料库（按 id 独立，内置人设也可叠加补丁）：核心事实静态接地 + 长尾知识检索
  const personaLore = new PersonaLore({
    dir: path.resolve(PLUGIN_ROOT, cfg.personaLore?.dir || 'data/persona-lore'),
    kv: K, embedFn,
    skipInjectionCheck: skipPersonaInjectionCheck,
  })
  personaLore.attachScheduler(scheduler) // 长尾/资料定时刷新复用 KB 同一 scheduler
  scope.register(() => { try { personaLore?.shutdown?.() } catch { /* noop */ } }, { name: 'personaLore', order: 25 })
  // 人设资料「采纳」审批队列（持久化）：#采纳补齐 / Web 采纳按钮不再直接生效，
  // 改为投递待审项，须在 Web 审批门批准后才 draft→active（人工复核自动补齐草稿）
  const personaAdoptionQueue = new PersonaAdoptionQueue({
    dir: path.resolve(PLUGIN_ROOT, cfg.personaLore?.adoptionsDir || 'data/persona-adoptions'),
    personaLore,
    logger: Log,
  })

  // Skill（说明书 / 指令包）：从 skills/ 目录加载 .md/.js，按用户输入匹配后注入 prompt
  const skills = new SkillRegistry()
  const skillsDir = path.resolve(PLUGIN_ROOT, cfg.skill?.dir || 'skills')
  const userSkills = await loadSkillPack(skillsDir, { logger: Log.tag('skill') })
  for (const s of userSkills) {
    try { skills.register(s) } catch (e) { Log.warn('[skill] 注册失败', s.name, e?.message || e) }
  }

  // 统一搜索：免费引擎优先（Bing/DDG/AnySearch/Exa/Tavily/Keenable/Firecrawl/Parallel/You.com/SearXNG）
  // + 可选 key 引擎（Brave/Perplexity）+ 失败分类/冷却/缓存。
  // fetcher 必须与 provider 一致走代理：DDG/海外源直连在受限网络下超时（undici 默认不读 HTTP(S)_PROXY），
  // 此前搜索固定用裸 fetch → 配了 agent.proxy 也不生效，DDG 兜底形同虚设。
  const searchManager = createSearchManager({
    ...(cfg.search || {}),
    fetcher: await makeSearchFetch(proxyFetch),
    logger: Log.tag('search'),
  })
  const enabledSearch = searchManager.availableProviders
  if (enabledSearch.length) Log.debug('[search] 已启用搜索源：' + enabledSearch.join('、'))

  // 无损上下文压缩（Hermes 可逆化）：原文归档按会话分目录落盘（sha256 内容寻址），
  // context_recall 工具按 ref/query 恢复。配置项已移除：默认始终开启，路径固定。
  let compactArchive = null
  try {
    // archiveDir 仅保留为内部/测试覆盖，不作为用户配置项；默认固定路径。
    compactArchive = new CompactionArchive({ dir: path.resolve(PLUGIN_ROOT, cfg.compaction?.archiveDir || 'data/context-archive') })
  } catch (e) { Log.warn('[agent] 压缩归档初始化失败，降级为无归档压缩', e?.message || e) }

  // ── E2B 沙箱运行时（terminal 的唯一执行面 + toolEvo 的隔离面）──
  // 装配失败不抛穿：mode=off 或初始化失败都返回 manager:null，由工具层给 fail-closed 结果
  //
  // 出口配置迁移（v1.24.0 前默认 = allowInternet:false + denyOut:['0.0.0.0/0'] + 域名白名单）：
  // 新版默认改成「全放通 + 可选白名单」，但旧配置的**显式值不被覆盖** —— 老配置里那条
  // denyOut 在新语义（没有白名单）下等于「拒绝一切出口，含 DNS」：沙箱里 curl 会卡满超时后失败，
  // 且旧版既无告警也不进日志（线上真实事故）。这里只在「逐字一致的旧默认」形状上就地清理并写回。
  const legacyEgress = legacyEgressFix(cfg.sandbox)
  if (legacyEgress) {
    cfg.sandbox.network = { ...(cfg.sandbox.network || {}), denyOut: [] }
    // 注意：save() 要的是**根配置**（_data），cfg 是它的 agent 子树；这里改的正是 _data 上的活引用，
    // 所以无参调用即可（写成 Config.save(cfg) 会把整份配置覆盖成 agent 子树）。
    try { Config.save() } catch (e) { Log.warn('[sandbox] 出口配置迁移写盘失败（本次会话已生效）', e?.message || e) }
    Log.warn(`[sandbox] 检测到 v1.24.0 之前的默认出口配置 network.denyOut:["${legacyEgress.from}"]——`
      + '在当前语义（默认全放通、无白名单）下它等于**拒绝一切出口，含 DNS**，沙箱会完全无法联网；'
      + '已自动清理并写回 config.yaml（旧版的「兜底拒绝」现在由 allowInternet:false 或 allowOut 白名单承担）')
  }
  const sandbox = await createSandboxRuntime(cfg.sandbox, { logger: Log.tag('sandbox') })
  scope.register(async () => { try { await sandbox?.shutdown?.() } catch { /* noop */ } }, { name: 'sandbox', order: 100 })
  if (cfg.terminal?.enable === true && !sandbox.enabled) {
    Log.warn('[migrate] agent.terminal 已废弃：终端执行改为 E2B 沙箱。请改用 agent.sandbox.mode=e2b + apiKey（当前 terminal 工具不会注册），并删除 config.yaml 里残留的 terminal 段')
  }

  const tools = new ToolRegistry({ logger: Log.tag('tool') })
    .register(...makeSearchTools(searchManager)) // web_search（多源）+ web_extract
    .register(...noteTools({ kv: K }))
    .register(clarifyTool)
    .register(createMemoryTool(memory))
    .register(makeRecallTool(recall)) // memory_search：模型主动检索长期记忆
    // 被动媒体工具（list_group_files/get_group_file/read_attachment）：受 media.passive 门控。
    // 此前该配置只算了 passiveEnabled 没人消费，设为 false 也照样注册（配置互搏审计 F11）。
    .register(...(cfg.media?.passive !== false ? makeMediaTools() : []))
  if (compactArchive) tools.register(makeContextRecallTool({ archiveFor: () => compactArchive })) // context_recall：取回压缩归档原文（常驻）
  // kb_search：知识库检索（默认开；cfg.kb.enable:false 关闭）
  if (cfg.kb?.enable !== false) tools.register(makeKbSearchTool(knowledge))
  // web_crawl：抓取网页正文（常驻；cfg.kb.crawlEnable:false 关闭）
  if (cfg.kb?.crawlEnable !== false) tools.register(webCrawlTool)

  // 内置基础工具包：群信息 / 群管 / 米游社
  if (cfg.tools?.builtin !== false) {
    tools
      .register(...groupInfoTools)
      .register(...groupManageTools)
      .register(...groupHistoryTools) // get_chat_history：模型按需拉群聊近期记录（被动找回）
      .register(...groupNoticeTools) // 群公告：发送/获取/删除
      .register(...groupFileTools) // 群文件 CRUD：上传/删除/文件夹/列目录/直链/移动/重命名/跨群
      .register(...aiVoiceTools) // AI 语音：角色列表/文字转语音/群内发送
      .register(...forwardTools) // 合并转发：发送/获取
      .register(...miyousheTools)
      .register(...enkaTools) // Enka 角色展柜：原神/星铁/绝区零（公开接口，无需 key）
      .register(reminderSetTool) // reminder_set：对话设提醒（到时间 fireReminder 主动发消息）
      .register(reminderListTool) // reminder_list：查看当前用户提醒/定时任务
      .register(reminderCancelTool) // reminder_cancel：取消指定 id 的提醒/定时任务
    // schedule_task：对话设 cron 重复任务链（到点跑 Agent + 发结果）；taskEnabled=false 时不注册
    if (cfg.schedule?.taskEnabled !== false) tools.register(scheduleTaskTool)
    else Log.debug('[schedule] 定时任务已关闭（schedule.taskEnabled=false），schedule_task 工具不注册')
  }

  // 自定义工具包：扫描插件根 tools/ 目录自动加载（TRSS-Yunzai apps 风格）
  // （Pixiv 已从内置迁移为外置工具包 tools/pixiv/，随下方便捷加载）
  const toolsDir = path.resolve(PLUGIN_ROOT, cfg.tools?.dir || 'tools')
  const loaded = await loadToolPacks(toolsDir, { logger: Log.tag('toolkit') })
  for (const t of loaded.tools) {
    try { tools.register(t) } catch (e) { Log.warn('[toolkit] 注册失败', t.name, e?.message || e) }
  }
  // 外置工具：成功只报一条汇总，失败逐条单独报错（避免工具多时刷屏）
  if (loaded.errors.length) {
    for (const er of loaded.errors) Log.error(`[toolkit] 外部工具加载失败（${er.file}）：${er.error}`)
  }
  if (loaded.packs.length || loaded.errors.length) {
    Log.info(`[toolkit] 成功加载 ${loaded.tools.length} 个外部工具（${loaded.packs.length} 个工具包${loaded.errors.length ? `，${loaded.errors.length} 个失败` : ''}）`)
  }

  // 终端执行能力（沙箱内核；mode=off 或沙箱不可用 → 本工具不注册，宿主无 shell 执行面）
  if (sandbox.manager) {
    try {
      tools.register(makeTerminalTool({ manager: sandbox.manager }))
      Log.debug('[terminal] 已启用沙箱终端执行工具（全员可用；命令在 E2B microVM 内执行）')
    } catch (e) {
      Log.warn('[terminal] 注册失败（本工具不可用，不影响其它功能）', e?.message || e)
    }
  } else if (sandbox.enabled) {
    Log.warn(`[terminal] 沙箱未就绪，终端工具不注册（fail-closed）：${sandbox.error?.message || '未知原因'}`)
  }

  // 媒体下载（yt-dlp；受约束、仅框架主人；默认开。给 LLM 专用下载入口，避免它去抓 terminal 裸 shell）
  if (cfg.download?.enable !== false) {
    try { tools.register(makeDownloadTool()) } catch (e) { Log.warn('[download] 注册失败', e?.message || e) }
  }

  // Stagehand 浏览器自动化（可选，默认关；goto/observe/extract/act；仅框架主人；act 不单独审批）
  let stagehand = null
  if (cfg.stagehand?.enable) {
    try {
      const { pack, sessionMgr } = makeStagehand({ cfg: cfg.stagehand, agent: cfg, fetch: proxyFetch })
      for (const t of pack.resolve({})) {
        try { tools.register(t) } catch (e) { Log.warn('[stagehand] 注册失败', t.name, e?.message || e) }
      }
      stagehand = { sessionMgr }
      Log.debug(`[stagehand] 已启用浏览器自动化工具（${cfg.stagehand.mode || 'local'} 模式；4 个工具 stagehand__goto/observe/extract/act）`)
    } catch (e) { Log.warn('[stagehand] 初始化失败（@browserbasehq/stagehand 未装或浏览器不可用？）', e?.message || e) }
  }
  scope.register(async () => { try { await stagehand?.sessionMgr?.closeAll?.() } catch { /* noop */ } }, { name: 'stagehand', order: 50 })

  // Python 精确计算工具（数学/统计等；沙箱内执行，默认开）
  if (cfg.calc?.enable !== false) tools.register(calcTool)
  tools.register(sendFileTool) // send_file：发送文件到聊天
  tools.register(readPdfTool) // read_pdf：读取 PDF 文本+页面图片
  tools.register(createExcelTool) // create_excel：创建带样式 Excel
  tools.register(readExcelTool) // read_excel：读取 Excel 为表格文本
  if (cfg.stt?.enable !== false) tools.register(transcribeMediaTool) // transcribe_media：音视频转文字(STT)
  // TTS 语音合成（tts_speak）：IndexTTS 2.5 / 豆包 / MiniMax / MiMo；情绪（8 维向量）默认由 LLM
  // 结合文本+上下文自动判定（四家服务商共用一条判定链路）。
  // （情绪判定模型：agent.tts.judgeModel → agent.tts.indextts.model → utilityModel → 主模型，同旁路通道）
  // tts 服务实例暴露到运行时：自动回复语音（agent.tts.autoReply）在主回复管线里直接调用。
  // 总开关默认关（opt-in，严格 === true）：未显式开启 → 不注册工具、不合成（旧配置缺字段也静默）。
  let tts = null
  // 布尔容错：yaml 手写 `enable: 1` / `"true"` 时此前严格 === true 会静默不生效（审计 P2）
  if (cfg.tts?.enable === true || cfg.tts?.enable === 1 || cfg.tts?.enable === 'true') {
    try {
      const ttsTarget = modelRouter.resolve(cfg.tts?.judgeModel || cfg.tts?.indextts?.model || cfg.utilityModel || cfg.model)
      tts = new TtsService(cfg.tts || {}, {
        dataDir: Config.path.tts,
        logger: Log.tag('tts'),
        llm: {
          // 情绪判定（旁路小调用）：signal 由 emotion.js 超时中止时触发（abort → fetch 中断，
          // 不再让请求在后台跑到 60s/重试，白烧额度）。错误向上抛，由 planEmotion 统一记账回退。
          run: async (prompt, { signal } = {}) => {
            const res = await ttsTarget.provider.chat({ model: ttsTarget.model || cfg.model, messages: [{ role: 'user', content: prompt }], stream: false, signal })
            return { content: res?.content || '' }
          },
        },
      })
      tools.register(makeTtsSpeakTool(tts))
      const st = tts.status()
      const voiceCount = tts.voices('voice').length
      // sovits 没有音色库：面板里的「音色」恒为 0，启动横幅改用参考音频名字，免得看着像没配好
      const sovitsRef = st.provider === 'sovits'
        ? (path.basename(String(tts.cfg.sovits?.refAudioPath || '')) || '未配置')
        : ''
      startupInfo.tts = { provider: st.provider, configured: st.configured, missing: st.missing, voices: voiceCount, sovitsRef, judgeModel: ttsTarget.model || cfg.model }
      if (!st.configured) Log.debug(`[tts] tts_speak 已注册（服务商 ${st.provider}），但配置未齐全：${st.missing.join('、')}（Web 面板 → 语音合成）`)
    } catch (e) { Log.warn('[tts] 初始化失败（tts_speak 不注册）', e?.message || e) }
  }
  tools.register(fileToPdfTool) // file_to_pdf：任意文件转 PDF 并发送

  // 示意图渲染（diagram_render）：LLM 提交语义 DiagramSpec → 确定性 D2 编译 → 自托管 Kroki 渲染 SVG
  // → 安全检查 → resvg 高清 PNG。默认 renderer=kroki 需部署容器（docs/deploy/kroki-compose.yaml），
  // 未部署时结构化失败；fallbackRenderer 可选本地 beautiful-mermaid（零 DOM）。工具本身不直接发消息，
  // 成功结果由 _handleAgent 的 onToolEnd 收集、最终回复后经 replyQueue 发送（防重复/防迟到图片）。
  let diagram = null
  if (cfg.diagram?.enable !== false) {
    try {
      diagram = new DiagramService(cfg.diagram, { logger: Log.tag('diagram'), devLog })
      tools.register(makeDiagramTool(diagram))
      const eng = diagram.cfg.renderer + (diagram.cfg.fallbackRenderer !== 'none' ? `+${diagram.cfg.fallbackRenderer}` : '')
      startupInfo.diagram = eng
      Log.debug(`[diagram] 已启用示意图工具 diagram_render（引擎 ${eng}；endpoint=${diagram.kroki?.endpointId || '-'}）`)
    } catch (e) { Log.warn('[diagram] 初始化失败，工具不注册', e?.message || e) }
  }
  scope.register(() => { try { diagram?.stop?.() } catch { /* noop */ } }, { name: 'diagram', order: 60 })

  // 临时目录清理（2026-10-17 审计 A6）：temp 里堆着 PDF/Excel 转档、STT 音频、下载中转、渲染图、
  // 日志包……此前只有 diagram 有专属 TTL 清理，其余只增不减（磁盘满 → 媒体/文档整族失败）。
  // 进程内单例：热重载重建运行时不会重复起定时器。
  if (cfg.tempFiles?.enable !== false) {
    try {
      const sw = startTempSweep({
        dir: Config.path.temp,
        ttlHours: cfg.tempFiles?.ttlHours,
        maxFiles: cfg.tempFiles?.maxFiles,
        logger: Log.tag('temp'),
      })
      if (sw.started) startupInfo.tempSweep = `TTL ${Number(cfg.tempFiles?.ttlHours) || 24}h / 上限 ${Number(cfg.tempFiles?.maxFiles) || 500}`
    } catch (e) { Log.warn('[temp] 清理器启动失败', e?.message || e) }
  }

  // skill 工具：模型主动调用 skill 的通道（按 name 加载说明书正文）—— 渐进式披露的载入入口
  tools.register(makeSkillTool(skills))

  // send_sticker 工具：按情绪跨全库选图（表情包启用且未显式关闭时注册）
  if (cfg.sticker?.enable && cfg.sticker?.sendStickerTool !== false) {
    try {
      const { makeSendStickerTool } = await import('../../model/sticker/send-tool.js')
      tools.register(makeSendStickerTool(getStickerManager()))
    } catch (e) { Log.warn('[sticker] send_sticker 工具注册失败', e?.message || e) }
  }

  // send_keyboard 工具：QQ 官方机器人 inline keyboard（Markdown 正文 + 按钮）
  // 与 diagram 同约定：工具只排队，由最终回复后的 flush 统一投递（顺序/失败不污染终态）。
  // 是否可用在执行期按 ctx.e 判定（多账号部署时同一运行时可能同时服务 OneBot 与官方机器人）。
  if (cfg.qqOfficial?.keyboard?.enable !== false) {
    tools.register(makeSendKeyboardTool({ logger: Log.tag('qqofficial') }))
  }

  // 技能热加载工具：安装 SkillHub 技能后免重启即可用
  tools.register({
    name: 'reload_skills',
    description: '重新扫描技能目录(skills/)并加载新技能。用 skillhub/手动安装技能后调用，免去重启。',
    category: 'system',
    meta: { alwaysConfirm: true, interactive: true },
    parameters: { type: 'object', properties: {} },
    async execute() {
      const fresh = await loadSkillPack(skillsDir, { logger: Log.tag('skill') })
      skills.skills.clear()
      skills.register(...fresh)
      return { ok: true, count: skills.list().length, skills: skills.list().map((s) => s.name) }
    },
  })

  // 宿主侧受控技能安装器（SkillHub）：terminal 是 E2B 隔离沙箱、装不到宿主，故安装必须走宿主侧专用工具。
  // 仅主人（category:system + execute 内 isMaster 复核）+ alwaysConfirm；固定 argv 无 shell；产物仅允许 .md。
  tools.register(makeInstallSkillTool({ skillsDir, registry: skills, logger: Log.tag('skill') }))

  const mcp = new McpManager({ registry: tools, logger: Log.tag('mcp'), requestTimeout: cfg.mcp?.requestTimeout })
  scope.register(async () => { try { await mcp?.stop?.() } catch { /* noop */ } }, { name: 'mcp', order: 30 })
  mcp.start(cfg.mcp?.servers || {}).catch((e) => Log.error('[mcp] 启动失败', e?.message || e))

  // 工具按需发现：检索 embedding（可选，复用上面的 embedFn）；未填则 registry 用纯关键词 jaccard
  tools.setEmbedFn(embedFn)

  // recall 抽取用的轻量 LLM 通道：复用主 provider、换廉价 model id（utilityModel 降本，留空沿用主模型）
  // llmExtract 已自拼抽取指令+对话，此处只需做「无脑 chat 通道」（recall.js 兼容 llm.run 与函数两种形态）
  const recallTarget = modelRouter.resolve(cfg.recall?.model || cfg.utilityModel || cfg.model)
  const recallLlm = {
    run: async (prompt) => {
      try {
        const res = await recallTarget.provider.chat({ model: recallTarget.model || cfg.model, messages: [{ role: 'user', content: prompt }], stream: false })
        return { content: res?.content || '' }
      } catch (e) {
        Log.warn('[recall] llm 抽取调用失败', e?.message || e)
        return { content: '' }
      }
    },
  }

  // 思考自动决策的小模型判档通道：复用主 provider，固定使用 utilityModel（留空则主模型）。
  // 只在开启 agent.thinkingAuto 且 classifier≠off 时用；调用带超时，失败自动回退规则（见 model/llm/thinking.js）。
  const thinkingTarget = modelRouter.resolve(cfg.utilityModel || cfg.model)
  const thinkingLlm = {
    run: async (prompt) => {
      try {
        const res = await thinkingTarget.provider.chat({ model: thinkingTarget.model || cfg.model, messages: [{ role: 'user', content: prompt }], stream: false, max_tokens: 64 })
        return { content: res?.content || '' }
      } catch (e) {
        Log.warn('[thinking] 判档小模型调用失败，回退规则', e?.message || e)
        return { content: '' }
      }
    },
  }

  // —— 在线自进化三件套：PromptRegistry（prompt 版本化/回滚）+ TraceStore（数据闭环）+ SelfReviewer（后台自评审）——
  const promptDir = path.resolve(PLUGIN_ROOT, cfg.evolution?.promptDir || 'data/evolution/prompts')
  const traceDir = path.resolve(PLUGIN_ROOT, cfg.evolution?.traceDir || 'data/evolution/traces')
  const suggestionDir = path.resolve(PLUGIN_ROOT, cfg.evolution?.suggestionDir || 'data/evolution/suggestions')
  // 进化产出目录先建好：prompt 采纳/回滚直接 writeFileSync 到 promptDir，
  // 目录缺省时旧代码报 ENOENT（首次采纳必崩）。trace/suggestion 也一并确保存在。
  for (const d of [promptDir, traceDir, suggestionDir]) { try { fs.mkdirSync(d, { recursive: true }) } catch { /* noop */ } }
  const promptRegistry = new PromptRegistry()
  promptRegistry.registerAll(TEMPLATES)
  try {
    if (fs.existsSync(promptDir)) {
      for (const f of fs.readdirSync(promptDir).filter((x) => x.endsWith('.json'))) {
        try {
          const tpl = JSON.parse(fs.readFileSync(path.join(promptDir, f), 'utf8'))
          if (tpl && tpl.id) promptRegistry.register(new PromptTemplate(tpl))
        } catch (e) { Log.warn('[prompt] 加载进化产出失败', f, e?.message || e) }
      }
      if (promptRegistry.size > 0) Log.debug('[evolution] PromptRegistry 已加载进化覆盖')
    }
  } catch (e) { Log.warn('[evolution] prompts 目录加载失败', e?.message || e) }
  let traceStore = null
  try { traceStore = new TraceStore({ dir: traceDir }) } catch (e) { Log.warn('[evolution] TraceStore 初始化失败', e?.message || e) }
  const srCfg = cfg.selfReview || {}
  // 评审 / 工具进化合成共用同一「功能模型」引用：可落在任意已注册厂商
  const srTarget = modelRouter.resolve(srCfg.model || cfg.utilityModel || cfg.model)
  let selfReview = null
  if (srCfg.enable !== false) {
    try {
      selfReview = new SelfReviewer({
        provider: srTarget.provider, model: srTarget.model || cfg.model,
        traceStore, memory, skills, suggestionDir,
        botName: (typeof Bot !== 'undefined' && (Bot.nickname || Bot.name)) || '',
        every: srCfg.every, autoApplyMemory: srCfg.autoApplyMemory, autoApplyPrompt: srCfg.autoApplyPrompt,
        dailyBudgetTokens: srCfg.dailyBudgetTokens,
        logger: Log.tag('selfReview'),
      })
    } catch (e) { Log.warn('[evolution] SelfReviewer 初始化失败', e?.message || e) }
  }

  // —— Tool Evolution：版本化工具库 + 调用埋点（动态 import；sqlite3 未装/未启用则降级，不影响主流程）——
  let toolEvo = null
  if (cfg.toolEvo?.enable !== false) {
    try {
      const te = await import('../../model/toolEvo/index.js')
      // 库名同样尊重 toolEvo.dbPath（此前只取 dirname，配 custom/other.db 仍写 tevo.db）
      const teDbRel = cfg.toolEvo?.dbPath || 'data/evolution/tevo.db'
      await te.initDb({ dir: path.resolve(PLUGIN_ROOT, path.dirname(teDbRel)), file: path.basename(teDbRel) })
      const toolEvoRegistry = new te.ToolEvoRegistry({ artifactsDir: path.resolve(PLUGIN_ROOT, cfg.toolEvo?.artifactsDir || 'data/evolution/tools') })
      // 兼容迁移：为旧版本回填内容哈希/源码，使既有 stable 工具升级后仍可校验与注入
      await toolEvoRegistry.backfillFromArtifacts().catch((e) => Log.warn('[toolEvo] 旧制品哈希回填失败', e?.message || e))
      tools.setInvocationSink(te.recordInvocation)
      const artifactsDir = path.resolve(PLUGIN_ROOT, cfg.toolEvo?.artifactsDir || 'data/evolution/tools')
      // 隔离 runner：stable 工具**不在主进程执行**。两档——沙箱可用时跑在 E2B microVM 内，
      // 否则退回本地 fork worker（capability ctx 冻结 {now,log}，env 仅 PATH/HOME，不暴露 e/bot/fetcher）。
      // 显式选择 e2b 时，manager 初始化失败必须保持该执行面不可用（禁止静默降级本地）。
      // 进化工具专用 manager 出口全关（evoManager），绝不继承 terminal 的联网白名单。
      const e2bRequested = String(sandbox.mode || 'off').toLowerCase() === 'e2b'
      const runner = new te.RunnerClient({
        logger: Log.tag('toolEvo'),
        timeoutMs: cfg.toolEvo?.runnerTimeoutMs || 5000,
        sandbox: { mode: sandbox.mode, manager: sandbox.evoManager },
        artifactsDir,
      })
      const builtins = tools.list().filter((t) => !t.meta?.mcp).map((t) => ({
        name: t.name, description: t.description, parameters: t.parameters,
        sideEffects: t.meta?.sideEffects || ['none'], tags: ['builtin'],
      }))
      const seedRes = await te.seedBuiltinTools(toolEvoRegistry, builtins).catch((e) => { Log.warn('[toolEvo] seed 失败', e?.message || e); return { added: 0, bindings: [] } })
      const seeded = seedRes?.added || 0
      for (const w of (seedRes?.warnings || [])) Log.warn('[toolEvo] seed 元数据归一化', w)
      // 内置工具执行契约绑定 seed 出的版本身份（否则埋点 version_id=null，健康检测漏报，审计 P1-8）
      for (const b of (seedRes?.bindings || [])) { try { tools.bindVersion(b.name, b.versionId) } catch { /* noop */ } }
      const synthesizer = new te.ToolSynthesizer({ provider: srTarget.provider, model: srTarget.model || cfg.model, maxRepairAttempts: cfg.toolEvo?.maxRepairAttempts ?? 2, logger: Log.tag('toolEvo') })
      // 候选行为验证同样双档：沙箱可用时在出口全关的一次性 microVM 里跑候选（跑的是不可信代码），
      // 否则本地子进程 + AST 前置门。
      const engine = new te.EvolutionEngine({
        synthesizer,
        registry: toolEvoRegistry,
        logger: Log.tag('toolEvo'),
        verifySession: sandbox.verifyManager
          ? (args) => te.createSandboxCandidateSession(sandbox.verifyManager, args)
          : (e2bRequested
            ? () => { throw new Error('E2B 沙箱不可用（已显式选择 e2b），拒绝降级到本地验证候选') }
            : null),
        verifyTimeoutMs: cfg.sandbox?.toolEvoVerifyTimeoutMs || 3000,
        // 运行时名称避让：内置/Meta/MCP/多代理工具都不可被进化工具覆盖
        isNameReserved: (name) => {
          try { return name === 'tool_search' || !!tools.get(name) } catch { return false }
        },
      })
      // 注入已 stable 的进化工具（经 runner 隔离执行；重启/热重载后自动恢复，供 agent tool_search 调用）
      let stableCount = 0
      try {
        for (const s of await toolEvoRegistry.listStable()) {
          // 内置工具(provenance=human)由插件代码注册,不走制品注入(其 source 为空,execute 在插件代码);
          // 只注入进化产出(generated/refined,制品含 export run)
          if (s.manifest?.provenance?.kind === 'human') continue
          if (!s.sourceHash) { Log.warn('[toolEvo] 注入 stable 跳过：缺少源码哈希，需重新验证', s.name, s.semver); continue }
          try {
            // 启动恢复前校验制品完整性：哈希不匹配/缺失即拒绝激活（保留 fail-closed），不注入可调用契约
            await toolEvoRegistry.verifyArtifacts(s)
            tools.register(await toolEvoRegistry.toToolContract(s, runner))
            stableCount++
          } catch (e) { Log.warn('[toolEvo] 注入 stable 失败', s.name, e?.message || e) }
        }
      } catch (e) { Log.warn('[toolEvo] stable 注入失败', e?.message || e) }
      toolEvo = { registry: toolEvoRegistry, engine, runner, closeDb: te.closeDb, flushNow: te.flushNow }
      startupInfo.toolEvo = { builtins: builtins.length, stable: stableCount, backend: runner.backend === 'sandbox' ? 'E2B 沙箱' : '本地 fork' }
      Log.debug(`[toolEvo] 已初始化（内置 ${builtins.length} 个 · 本次 seed ${seeded}（已入库则跳过）· stable 进化 ${stableCount} 经隔离执行面 ${startupInfo.toolEvo.backend}）`)
    } catch (e) { Log.warn('[toolEvo] 初始化失败（sqlite3 未装？）', e?.message || e) }
  }
  scope.register(async () => {
    try { await toolEvo?.runner?.stop?.() } catch { /* noop */ }
    try { await toolEvo?.closeDb?.() } catch { /* noop */ }
  }, { name: 'toolEvo', order: 40 })

  // 模型注册表参数覆盖：当前主模型在 agent.llmModels 有登记且显式指定 thinking/温度/maxTokens 时覆盖全局
  // （web「模型列表 → 编辑」弹窗设置的参数在此生效；仅对主对话链路，各旁路功能仍用自己的配置）
  // 按 modelId 定位优先（引用制真源）：同 model 字符串可能挂在多个厂商下，比对 model 字符串会串到别家条目
  const regEntry = cfg.modelId
    ? (cfg.llmModels || []).find((m) => m && m.id === cfg.modelId)
    : (cfg.llmModels || []).find((m) => m && String(m.model) === String(cfg.model))
  const regThinking = regEntry?.thinking === 'on' ? { type: 'enabled' } : regEntry?.thinking === 'off' ? { type: 'disabled' } : null
  // 注意：模型条目未填 temperature 时是「键不存在/空」，不是 0；用 numOrNull 判存在，
  // 否则 Number(null)===0 会把模型级温度钉成 0、覆盖全局 agent.temperature（配置互搏审计 P0/F1）。
  const regTemperature = numOrNull(regEntry?.temperature)
  const regMaxTokens = numOrNull(regEntry?.maxTokens) > 0 ? numOrNull(regEntry?.maxTokens) : null

  // ── Jev（TypeSafe AI）判断模型：opt-in 决策层（默认关；未配置/失败/低置信一律回退现有方案）──
  // Jev 作为「厂商 + 模型」注册：厂商配置里选 jev 预设（或 OpenRouter 承载 jev 模型），模型列表挂模型，
  // 在「基础 / 模型」卡片打开开关并选择。安全：会把用户对话/命令内容发往第三方——默认关闭。
  let jev = null
  if (cfg.jev?.enable === true) {
    // 解析 Jev 厂商/模型；兼容旧的直填 jev.apiKey/baseURL/model
    const prov = (cfg.llmProviders || []).find((p) => p && p.id === cfg.jev.providerId)
    const mdl = (cfg.llmModels || []).find((m) => m && m.id === cfg.jev.modelId)
    const apiKey = prov?.apiKey || cfg.jev.apiKey || ''
    const baseURL = prov?.baseURL || cfg.jev.baseURL || ''
    // yaml 语义是「手填 model 优先，留空才用 modelId 指向的注册条目」；此前反了，
    // 想用 jev.model 临时钉版本会被注册条目压过（配置互搏审计 P2/A-C09）。
    const model = String(cfg.jev.model || '').trim() || mdl?.model || ''
    const client = createJevClient({ ...cfg.jev, apiKey, baseURL, model }, { logger: Log.tag('jev') })
    if (client) {
      // 决策点：thinking/reflect/toolSelection 由对应卡片的选择器派生；terminalRisk/llmTool 由 Jev 子块开关。
      const d = cfg.jev.decisions || {}
      const decisions = {
        thinking: cfg.thinkingAuto?.classifier === 'jev',
        reflect: cfg.reflect === 'jev',
        toolSelection: false, // 工具定义已全量常驻，不再需要 Jev 选择激活集
        terminalRisk: d.terminalRisk === true,
        llmTool: d.llmTool === true,
      }
      jev = {
        client,
        decisions,
        thresholds: resolveThresholds(cfg.jev.thresholds),
        toolSelectionMaxTools: 80, // 工具全量常驻后不再使用；保留字段兼容 Jev 决策层
        allowDestructive: cfg.jev.allowDestructive === true, // shell 风险：破坏性命令默认拒绝，显式开启才允许高置信放行
      }
      if (decisions.llmTool) {
        try { tools.register(makeJevTool({ client, maxStateChars: cfg.jev.maxStateChars, logger: Log.tag('jev') })) } catch (e) { Log.warn('[jev] jev 工具注册失败', e?.message || e) }
      }
      const on = Object.keys(decisions).filter((k) => decisions[k])
      startupInfo.jev = { model: model || JEV_MODEL_DEFAULT, decisions: on }
      Log.mark(`[jev] 已启用（model=${model || JEV_MODEL_DEFAULT}；决策点：${on.join(',') || '无'}）。⚠️ 对话/命令内容将发往第三方 ${baseURL || 'api.typesafe.ai'}`)
    } else {
      Log.warn('[jev] 已开启但未解析到可用 API Key（请检查 Jev 厂商配置），所有 Jev 决策回退现有方案')
    }
  }

  // 思考自动决策是否真正生效：开关只是一半——模型还须被判为「支持思考」。能力判定对未表态的
  // 新型号默认乐观启用（厂商拒绝时 provider 自动剥离+记忆，见 model/llm/capabilities.js），
  // 因此这里的警告只针对「明确判为不支持」的模型（注册表/官方数据/学习记录/配置）。
  const thinkingAutoWanted = !regThinking && (cfg.thinkingAuto?.enable || jev?.decisions?.thinking === true)
  const thinkingCapsNow = detectCapabilities({ protocol: cfg.protocol || 'openai', model: cfg.model, caps: cfg.media?.caps })
  if (thinkingAutoWanted && !thinkingCapsNow.thinking) {
    Log.warn(`[thinking] 已开启思考自动决策，但模型 ${cfg.model} 被判为不支持思考（不会下发思考参数）；如确认支持，可设 agent.media.caps.thinking=true 强制（厂商不接受时会在请求层自动剥离并记忆）`)
  }

  // 手动深度思考：只保留开关语义，预算固定为最优值（旧配置里的 budget_tokens 不再读取）。
  const manualThinking = (() => {
    const t = cfg.thinking
    if (!t) return null
    if (t === false || t === 'off' || t === 'disabled') return null
    if (t === true || t === 'on' || t === 'enabled') return { type: 'enabled', budget_tokens: BUILTIN_THINKING.manualBudget }
    if (typeof t !== 'object') return null
    if (t.type === 'disabled' || t.enabled === false) return null
    return { ...t, type: t.type || 'enabled', budget_tokens: BUILTIN_THINKING.manualBudget }
  })()

  const agentConfig = {
    provider,
    model: cfg.model,
    fallbackProviders,
    tools,
    memory,
    session,
    recall,
    profile, // 统一用户画像（结构化长期归纳；enable:false 时为 null）
    recallLlm, // 接通：让 recall.js 的 llmExtract 真正触发（覆盖"帮我记/以后都/别忘了"等自然说法）
    promptRegistry, // 进化版 prompt：_assembleSystem 优先取 registry.get('agent').system
    skills, // 让 Agent 在 system prompt 注入 <available_skills> 目录
    // screenUntrusted：间接注入防御——工具结果/网页/MCP/记忆/情境等外部内容命中注入特征时加 <untrusted_data> 边界标注（不阻断）
    guard: { checkInput, screenUntrusted, systemHardening },
    guardAction: cfg.guardAction || 'flag',
    guardSensitivity: cfg.guardSensitivity || 'medium',
    untrustedGuard: cfg.untrustedGuard !== false, // 外部内容注入扫描（默认开，可配置关闭）
    policy: createPolicy({ categoryMin: cfg.policy?.categoryMin }),
    confirm, // ConfirmStore 审批器：需确认的工具（terminal 写命令等）经它走主人 #确认/#拒绝
    masterSkipConfirm: cfg.masterSkipConfirm === true, // 主人任务免确认直执行（高危，仅主人；denylist 仍拦）
    // 留空时由 Agent 用富默认身份（model/prompt TEMPLATES.agent.system）；人设经 run opts.systemPrompt 覆盖
    systemPrompt: cfg.systemPrompt || undefined,
    maxTurns: cfg.maxTurns ?? 200, // 与 yaml 默认 200 对齐（此前 apps/Agent 两层各有 50/90 两套兜底）
    loop: { ...BUILTIN_AGENT_LIMITS.loop }, // 循环护栏/时间/token 预算内置（复杂任务偏宽松）
    temperature: regTemperature != null ? regTemperature : cfg.temperature,
    maxTokens: regMaxTokens != null ? regMaxTokens : (cfg.maxTokens || null), // 控制输出长度（消除 Anthropic 硬编码 4096 / OpenAI 不发）
    thinking: regThinking || manualThinking,
    // 思考自动决策（opt-in）：按提问复杂度自动决定是否思考与深度；模型级 thinking 显式覆盖时不启用。
    // 判档方式=jev（jev.decisions.thinking）独立生效：即便未开 thinkingAuto.enable，也启用自动判档路径，
    // 由 Jev 判档、失败/低置信回退「规则+小模型」hybrid（预算取 thinkingAuto 或内置默认）。
    thinkingAuto: thinkingAutoWanted
      ? {
          enable: true,
          classifier: cfg.thinkingAuto?.classifier || 'auto',
          maxBudget: cfg.thinkingAuto?.maxBudget ?? 32768,
          model: '', // 留空 → utilityModel → 主模型
          timeoutMs: BUILTIN_THINKING.classifierTimeoutMs,
          budgets: { ...BUILTIN_THINKING.budgets },
          style: '', // 按厂商 preset 自动选择传输风格
        }
      : null,
    thinkingClassifierLlm: thinkingLlm, // 小模型判档通道（classifier=off 时不使用）
    jev, // Jev 判断模型决策层（null=未启用；见 model/agent/jev/）
    // 思考能力不在装配期固化：Agent 每次 run 按「注册表 + 运行时学习」实时判定（含乐观假定/自动纠正），
    // 只需把 cfg.media.caps 覆盖传下去；显式布尔 thinkingCapable 仍可覆盖（测试用）。
    mediaCaps: cfg.media?.caps || null,
    protocol: cfg.protocol || 'openai',
    preset: cfg.preset || '',
    // 上下文窗口不再由用户配置：Agent 每轮按模型官方元数据 / 本地目录 / 学习值自动解析。
    // 压缩比例硬编码在 Agent（80% 触发 → 45% 目标），用户无需理解窗口与水位。
    compactArchive, // 无损压缩归档（始终开启；失败时降级为无归档压缩）
    maxToolResultChars: cfg.maxToolResultChars ?? 8000, // 与 yaml 默认 8000 对齐
    // 工具受控并发（P0-2/F10）：全局滚动池上限；未声明并发语义的工具默认独占；跨 Agent 共享同一调度器
    toolConcurrency: { maxParallel: BUILTIN_AGENT_LIMITS.toolMaxParallel },
    toolScheduler: new ToolScheduler({ maxParallel: BUILTIN_AGENT_LIMITS.toolMaxParallel }),
    toolSchemaValidate: true, // 参数 schema 预校验固定开启（安全默认）
    taskStore, // 可恢复任务账本（P0-3；null=关闭）
    keepReasoning: false, // 不回灌推理，省上下文；工具轮协议必需字段仍会保留
    // 工具按需发现：LLM 只常驻少数核心工具，其余经 tool_search 检索后动态注入（默认开；关则回退全量常驻）
    toolDiscovery: { ...BUILTIN_TOOL_DISCOVERY }, // 全量常驻；tool_search 仅作目录速查
    shellIntercept: Array.isArray(cfg.shell?.intercept) ? cfg.shell.intercept : [],
    reflect: cfg.reflect ?? 'auto',
    cacheControl: 'auto', // 仅官方 Anthropic 端点自动开；兼容网关不下发未知字段
    promptCacheKey: true, // 仅 OpenAI 官方端点自动下发；兼容网关不发
    reflectMaxIterations: BUILTIN_AGENT_LIMITS.reflectMaxIterations,
    finalizeMaxTokens: BUILTIN_AGENT_LIMITS.finalizeMaxTokens, // 收尾输出上限内置 8192，防复杂任务总结被截断
    rootTokenBudget: BUILTIN_AGENT_LIMITS.rootTokenBudget || null, // 0=不限；子代理/编排各自预算仍生效
    stickers: getStickerManager({ logger: Log.tag('sticker') }), // 表情包清单注入（_assembleSystem 用 catalog()）
    devLog: (event, data, traceId, scope) => devLog(event, data, traceId, scope), // 详细 trace（框架无关，pino 文件）；库零依赖，由 apps 注入
    logger: Log.tag('agent'),
  }
  // 多例：每请求 new Agent（共享 provider/tools/session 等引用，但 this.messages 各自独立）
  // → 并发 run 不再互相覆盖 this.messages，根治串会话/艾特错人，且不同用户真并发（不排队）
  const makeAgent = (overrides) => new Agent(overrides ? { ...agentConfig, ...overrides } : agentConfig)

  /**
   * 人设补齐：跑一次"资料员"任务（只读取材）→ 解析结构化产出 → 存草稿（不自动生效）。
   * 供 #人设补齐 命令、Web 面板、定时刷新共用。
   * 复用主 Agent 任务系统：传入调用方真实 ctx 时，任务按同一 scopeKey 记入任务账本
   * （#任务列表/#任务状态/#取消任务/#继续任务 可见可管），并保留真实身份使浏览器等工具可用；
   * run 以 ephemeral 模式执行——不读写会话历史、不注入/抽取召回记忆与画像，避免污染用户长期上下文。
   * @param {string} idOrName
   * @param {{ by?: string|null, ctx?: object|null }} opts
   * @returns {Promise<{ persona?, lore?, error?, code? }>}
   */
  const completePersona = async (idOrName, { by = null, ctx: baseCtx = null } = {}) => {
    const p = personaStore.get(idOrName)
    if (!p) return { error: `未找到人设「${idOrName}」` }
    let botUin = ''
    try { botUin = String((typeof Bot !== 'undefined' && (Bot.uin || Bot.uins?.[0])) || '') } catch { /* noop */ }
    const b = (baseCtx && typeof baseCtx === 'object') ? baseCtx : {}
    const completionCtx = {
      ...b,
      // 剥离事件 e：防只读取材工具（miyoushe_post 发图）把内容误发到群/好友；
      // 浏览器/工具身份改由下面显式 userId/selfId 提供，不依赖 e。
      e: undefined,
      userId: String(b.userId || `__persona_complete__:${p.id}`),
      selfId: String(b.selfId || botUin || ''),
      isMaster: b.isMaster === true,
      role: b.role || (b.isMaster === true ? 'owner' : 'member'),
      // 安全：补齐是"读外部资料"的自动化任务，即便发起者是主人也不给"免确认直执行"——
      // 状态类工具(terminal/浏览器/群管等)一律走审批门，防外部网页经注入驱动副作用。
      masterSelfSkip: false,
      groupId: b.groupId != null ? b.groupId : null,
      scopeUserId: String(b.scopeUserId || b.userId || `__persona_complete__:${p.id}`),
      scopeId: String(b.scopeId || `persona_complete_${p.id}`),
      // 传入真实会话时复用其 scopeKey → 任务落进该会话的主任务账本
      conversationId: b.conversationId != null ? b.conversationId : `persona-complete:${p.id}`,
      notify: typeof b.notify === 'function' ? b.notify : (() => {}),
      fetcher: b.fetcher || ((typeof fetch !== 'undefined' && fetch) || null),
      miyoushe: b.miyoushe || { cookie: cfg.miyoushe?.cookie || '', defaultGid: cfg.miyoushe?.defaultGid || 2 },
      replyMode: 'text',
    }
    // 工具运行时能力同源装配：补齐任务里若有 shell 类工具（calculate/网页抓取等）或多模态工具
    // （B站看视频等），必须与交互路径同口径（不能因"没有交互事件"而绕过沙箱选择/缺少视觉子模型）
    attachToolRuntime(completionCtx, { sandbox, vision }, cfg)
    let out
    const taskId = randomUUID()
    try {
      out = await makeAgent({
        maxTurns: cfg.schedule?.taskMaxTurns || 200,
        masterSkipConfirm: false,
        tools: makeCompletionToolRegistry(tools),
      }).run(buildCompletionInput(p), {
        ctx: completionCtx,
        systemPrompt: PERSONA_COMPLETION_SYSTEM, // 身份层替换为资料员；工具/防护仍照常追加
        ephemeral: true, // 借用真实身份/任务账本，但不污染会话历史/记忆
        // 有界运行：即便被外部资料诱导触发审批类工具，也最多等 signal 超时，不会卡满审批超时(默认 300s)
        signal: (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) ? AbortSignal.timeout(180000) : null,
        taskId,
      })
    } catch (e) { return { error: `补齐任务失败：${e?.message || e}`, taskId } }
    const parsed = parseCompletionOutput(out?.content || '')
    if (!parsed.ok) return { error: `补齐失败：${parsed.error}`, taskId }
    try {
      const lore = personaLore.saveDraft(p.id, buildLoreDraft({ data: parsed.data, by, model: cfg.model }))
      // 该人设已有待审采纳项时刷新快照：审批门看到的始终是当前草稿
      try { personaAdoptionQueue.refreshPending(p.id, { personaName: p.name }) } catch { /* noop */ }
      return { persona: p, lore, taskId }
    } catch (e) { return { error: `补齐产出未通过安全校验：${e?.message || e}`, code: e?.code, taskId } }
  }
  // 定时刷新回调：周期重跑补齐 → 出新草稿（仍需 #采纳补齐 / 面板采纳提交审批，批准后才生效）
  personaLore.setRefreshHandler((id) => completePersona(id, { by: 'schedule' }))

  // 视觉子模型（A 方案）：主模型不支持视觉时，由它把图片转成文本描述喂给主模型。
  // 注意：vision.model 留空时"复用主模型"只对本身支持视觉的主模型成立。主模型若是纯文本模型，
  // 复用会把图片发给文本模型 → 请求失败/返回空 → 表现为"识图/表情打标无任何反应"，必须直接禁用。
  let vision = null
  // D15：media.enable=false 是多模态总开关 → 视觉子模型一并关闭（否则工具看图/表情发现仍会把图片发出去）
  if (cfg.vision?.enable === true && cfg.media?.enable !== false) {
    const vcfg = cfg.vision
    // 视觉模型可落在任意已注册厂商：connection 字段全空时按视觉模型名路由到其 provider，
    // 避免「主通道 commandcode + vision.model=mimo-v2.6-pro」这种模型名发错端点。
    const vRoute = resolveVisionRoute({ vcfg, router: modelRouter, mainProtocol: protocol })
    const vProtocol = vRoute.matched ? vRoute.protocol : (vcfg.protocol || protocol)
    const vModel = vRoute.matched ? vRoute.model : (vcfg.model || cfg.model)
    // 视觉模型也可能来自另一厂商：按其 baseURL/apiKey 再 prime 一次官方能力
    if (cfg.media?.capsFromApi !== false) {
      try {
        await primeModelCaps({
          protocol: vProtocol,
          baseURL: vRoute.matched ? vRoute.baseURL : (vcfg.baseURL || cfg.baseURL),
          apiKey: vRoute.matched ? vRoute.apiKey : (vcfg.apiKey || cfg.apiKey),
          preset: vRoute.matched ? vRoute.preset : (vcfg.preset || cfg.preset),
          models: [vModel],
          fetchImpl: proxyFetch || undefined,
        })
      } catch { /* 忽略：回退注册表 */ }
    }
    const vCaps = detectCapabilities({ protocol: vProtocol, model: vModel, caps: cfg.media?.caps })
    if (!vcfg.model && !vCaps.vision) {
      Log.warn(`[vision] 未配置 agent.vision.model，且主模型 ${vModel} 不支持视觉——视觉子模型已禁用（否则图片会被发给纯文本模型、静默失败）。如需识图/表情打标，请把 agent.vision.model 设为支持视觉的模型（如 mimo-v2.6 / qwen-vl-max / glm-4v / gpt-4o）`)
    } else if (!vCaps.vision) {
      // 显式配置了视觉模型、但能力判定为非多模态（如把 deepseek 文本模型填进 vision.model）：
      // 以前只有"未配 vision.model"才告警，显式配置后静默通过——识图照发，被拒后只留 console warn，
      // 表现为"用户发图，机器人说看不到"。启动即点名，避免再对着纯文本模型排查。
      Log.warn(`[vision] agent.vision.model=${vModel} 能力判定为非多模态（vision=false）——若该模型/通道不透传图片输入，识图会静默降级为"识别失败/为空"。请改用支持视觉的模型（如 mimo-v2.6-flash / qwen-vl-max / glm-4v）；若该通道确实支持图片，可设 media.caps.vision=true 覆盖判定`)
    } else {
      try {
        if (!vcfg.model && cfg.model) Log.debug('[vision] vision.model 未配，复用支持视觉的主模型', vModel)
        const vPresetMap = vProtocol === 'anthropic' ? anthropicPresets : openaiPresets
        const vPreset = vRoute.matched ? {} : (vcfg.preset ? vPresetMap[vcfg.preset] : preset)
        // 复用主通道：README 承诺"默认复用 protocol/baseURL/apiKey"。只回退 apiKey 会让
        // vision.baseURL 留空时打到 Client 默认的 api.openai.com（换过域名的通道必失败）。
        const vBaseURL = vRoute.matched ? '' : resolveVisionBaseURL({ vcfg, preset: vPreset, mainBaseURL: cfg.baseURL })
        // 视觉模型参数覆盖：vision.model 若在「模型列表」登记且设了 thinking/温度/maxTokens，则同样生效。
        // 否则在模型列表里给视觉模型关掉思考，视觉调用仍会按默认思考（烧推理预算、易导致判定超预算）。
        const vReg = (cfg.llmModels || []).find((m) => m && String(m.model) === String(vModel))
        // 视觉识别是受限抽取任务：思考默认关（inherit/未配均视为关）。mimo-v2.6 系列默认开思考，
        // 实测 agent.vision.maxTokens=1024 时思考吃掉全部预算 → 正文为空（finish=length），表现为"图片无法识别"。
        // 需要深度推理的视觉模型，可在「模型列表」把该模型 thinking 显式设为 on。
        const vThinking = vReg?.thinking === 'on' ? { type: 'enabled' } : { type: 'disabled' }
        const vTemperature = numOrNull(vReg?.temperature) // 同 P0/F1：null/空不能当 0
        // D14：显式 agent.vision.maxTokens 优先；未显式配置时才用「模型列表」条目的 maxTokens，最后 1024
        const vCfgMaxTokens = numOrNull(vcfg.maxTokens)
        const vMaxTokens = vCfgMaxTokens > 0 ? vCfgMaxTokens : (numOrNull(vReg?.maxTokens) > 0 ? numOrNull(vReg?.maxTokens) : 1024)
        const vProvider = vRoute.matched ? vRoute.provider : createProvider({
          protocol: vProtocol,
          ...vPreset,
          ...(vBaseURL ? { baseURL: vBaseURL } : {}),
          apiKey: vcfg.apiKey || cfg.apiKey,
          model: vModel,
          log: providerLog,
          ...(proxyFetch ? { fetch: proxyFetch } : {}),
        })
        vision = new VisionService({
          provider: vProvider,
          model: vModel,
          protocol: vProtocol,
          describePrompt: vcfg.describePrompt || undefined,
          maxTokens: vMaxTokens,
          thinking: vThinking,
          temperature: vTemperature,
          videoCapable: vCaps.video, // 视频能力（mimo omni 等；可经 media.caps.video 覆盖）
          logger: Log.tag('vision'),
        })
        startupInfo.visionModel = vModel
        const routeNote = vRoute.matched ? `（厂商 ${vRoute.providerName || vRoute.baseURL || '已注册 provider'}）` : ''
        Log.debug(`[vision] 视觉子模型 ${vModel}${routeNote}${vThinking ? `（thinking: ${vThinking.type}）` : ''}${vTemperature != null ? `（temperature: ${vTemperature}）` : ''}`)
      } catch (e) {
        Log.warn('[vision] 视觉子模型装配失败，主模型不支持视觉时图片将降级', e?.message || e)
      }
    }
  }

  // 子代理编排：multiagent.topology 选择拓扑（默认 spawn=异步三件套；orchestrator=同步编排工具 orchestrate）
  // worker「功能模型」引用：可落在任意已注册厂商；留空 = 主 provider 默认模型
  const workerTarget = modelRouter.resolve(cfg.multiagent?.workerModel || '')
  let multiagent = null
  if (cfg.multiagent?.enable !== false && cfg.multiagent?.topology === 'orchestrator') {
    try {
      // Orchestrator 编排模式：注册一个同步 `orchestrate` 工具（flagship 分解 → 通用 worker 委派 → 综合）
      // worker 工具集复用 spawn 的同一能力判定（见 worker-context.js），而不是只按 category=query 粗筛
      const queryNames = tools.list()
        .filter((t) => t.name !== 'tool_search' && (t.category || 'system') === 'query')
        .map((t) => t.name)
      const { registry: workerReg, granted: workerGranted, dropped: workerDropped } = buildWorkerTools(tools, queryNames, queryNames)
      const worker = new SubagentSpec({
        name: 'worker',
        description: '通用子代理：只做被委派的独立子任务，返回精炼结果',
        systemPrompt: '你是独立子任务子代理。只完成被委派的任务，直接给出结果，不解释过程；任务自包含（你看不到主对话）。',
        tools: workerGranted.length ? workerReg : null,
        model: workerTarget.model || null,
        provider: workerTarget.provider, maxTurns: cfg.multiagent?.workerMaxTurns ?? 200,
        maxTokens: cfg.multiagent?.workerMaxTokens ?? 16384,
      })
      const orch = new Orchestrator({
        provider, model: cfg.model,
        subagents: [worker],
        tools: null,
        maxTurns: cfg.multiagent?.workerMaxTurns ?? 200,
        maxConcurrent: cfg.multiagent?.maxConcurrent ?? 3,
        logger: Log.tag('multiagent'),
      })
      tools.register({
        name: 'orchestrate',
        description: '把复杂任务交给编排器：分解为子任务→并行委派给子代理→综合成完整结果。适合需要多路检索/分头处理再汇总的复杂任务（单步查询不必用）。',
        category: 'query',
        meta: { subagent: true, resultCap: cfg.multiagent?.resultCap ?? 48000 }, // 编排结果同样不腰斩（长报告）
        parameters: { type: 'object', required: ['task'], properties: { task: { type: 'string', description: '要编排完成的复杂任务（目标+输出格式+边界）' } }, additionalProperties: false },
        async execute(params = {}, ctx) {
          const task = String(params.task || '').trim()
          if (!task) return { error: 'task 不能为空' }
          const agent = ctx?.executionContext?.agent
          // F13：嵌套工作开始前先预留根任务预算；不足则不启动（避免执行阶段超预算）
          const reserve = Math.max(0, Number(cfg.multiagent?.reserveTokens) || 8000)
          if (agent && typeof agent.reserveBudget === 'function' && !agent.reserveBudget(reserve)) {
            return { error: 'budget_exhausted', reason: `根任务 token 预算不足（需预留 ${reserve}），未启动编排。请缩小任务或拆分步骤。` }
          }
          // P0-1：把父任务取消信号与关联 ID 传入编排链（否则父任务取消后编排器仍继续跑）
          let r
          try {
            r = await orch.run(task, { ctx, signal: ctx?.signal || null, taskId: ctx?.taskId || null })
          } finally {
            agent?.releaseBudget?.(reserve) // 释放预留（实际用量经 noteExternalUsage 计入 consumed）
          }
          // 复用同一归一：预算/异常停止只标 partial，绝不把部分完成当完整完成
          const norm = normalizeSubagentResult({ content: r?.content, stopReason: r?.stopReason, usage: r?.usage, turns: r?.turns })
          // F13：把编排/子代理实际用量归集到根任务（否则只进工具正文，根 usage/预算漏计）
          try { agent?.noteExternalUsage?.(r?.usage) } catch { /* 归集失败不影响结果 */ }
          return {
            result: norm.content,
            status: norm.status,
            completion: norm.completion,
            stopReason: r?.stopReason, turns: r?.turns, usage: r?.usage || null,
            ...(r?.subagents?.length ? { subagents: r.subagents } : {}),
          }
        },
      })
      startupInfo.multiagent = 'orchestrator'
      Log.debug(
        `[multiagent] 编排模式（topology=orchestrator）：orchestrate 工具已注册（worker 工具 ${workerGranted.length} 个`
        + `${workerDropped.length ? `，剔除 ${workerDropped.length} 个不可达` : ''}）`,
      )
    } catch (e) { Log.warn('[multiagent] 编排模式装配失败', e?.message || e) }
  } else if (cfg.multiagent?.enable !== false) {
    try {
      const subagentTools = makeSpawnSubagentTools({
        provider: workerTarget.provider, model: workerTarget.model || null,
        sourceRegistry: tools,
        semaphore: new Semaphore(cfg.multiagent?.maxConcurrent ?? 3),
        maxTurns: cfg.multiagent?.workerMaxTurns ?? 200,
        maxTokens: cfg.multiagent?.workerMaxTokens ?? 16384,
        defaultTools: cfg.multiagent?.defaultTools || ['web_search', 'memory_search'],
        maxSpawns: cfg.multiagent?.maxSpawnsPerConversation ?? 5,
        defaultBudgetMs: cfg.multiagent?.workerTimeBudgetMs ?? 3600000, // 子代理时间预算默认 60 分钟（未传 timeBudgetMs 时）
        resultCap: cfg.multiagent?.resultCap ?? 48000, // check_subagent 回传上限（长报告不腰斩）
        // 主循环结束后，未被 check_subagent 取走的子代理结果/失败异步回推给会话（防"后续无反应"）
        onSettle: (info, sctx) => {
          try {
            const label = info.task ? `「${String(info.task).slice(0, 40)}」` : ''
            const head = info.status === 'done'
              ? `🤖 后台子代理任务完成${label}：`
              : (info.status === 'partial' || info.status === 'waiting_input')
                ? `⚠️ 后台子代理任务未完整完成（${info.status}）${label}：`
                : `⚠️ 后台子代理任务${info.status === 'timeout' ? '超时' : info.status === 'cancelled' ? '已中止' : '失败'}${label}：${String(info.error || '原因未记录').slice(0, 200)}`
            const body = stripMarkers(maybeRedact((info.status === 'done' || info.status === 'partial' || info.status === 'waiting_input') ? `${head}\n${String(info.result || '').slice(0, 4000)}` : head)).trim()
            if (!body) return
            const send = (m) => (sctx?.e?.reply ? sctx.e.reply(m)
              : (sctx?.bot?.pickGroup && sctx.groupId) ? sctx.bot.pickGroup(sctx.groupId).sendMsg(m)
                : (sctx?.bot?.pickFriend && sctx.userId) ? sctx.bot.pickFriend(sctx.userId).sendMsg(m)
                  : null)
            Promise.resolve(send(body)).catch((err) => Log.warn('[multiagent] 子代理结果回推失败', err?.message || err))
          } catch (e) { Log.warn('[multiagent] onSettle 异常', e?.message || e) }
        },
      })
      for (const t of subagentTools) tools.register(t)
      multiagent = subagentTools // 暴露 shutdown()：热重载/退出时终止在跑子代理
      startupInfo.multiagent = 'spawn'
      Log.debug('[multiagent] spawn_subagent + check_subagent + extend_subagent 已注册（异步委派 + 预算控制）')
    } catch (e) { Log.warn('[multiagent] 子代理工具注册失败', e?.message || e) }
  }
  scope.register(() => {
    try { const n = multiagent?.shutdown?.(); if (n) Log.info(`[multiagent] 运行时失效：已终止 ${n} 个在跑子代理`) } catch { /* noop */ }
  }, { name: 'multiagent', order: 80 })

  // ── 启动摘要面板：把散落的模块初始化结果汇总成一份对齐清单（各模块细节日志已降为 debug 级，
  // 需要排查时把日志级别调到 debug 即可查看）。仅在运行时构建成功时输出一次。
  const searchLabel = enabledSearch.length ? enabledSearch.join('、') : '未启用'
  const sandboxLabel = sandbox.manager ? (cfg.sandbox?.mode || 'e2b') : (sandbox.enabled ? '未就绪' : 'off')
  const evolutionBits = []
  if (promptRegistry.size > 0) evolutionBits.push(`prompt 覆盖 ${promptRegistry.size}`)
  if (startupInfo.toolEvo) evolutionBits.push(`toolEvo ${startupInfo.toolEvo.builtins}/${startupInfo.toolEvo.stable}（${startupInfo.toolEvo.backend}）`)
  const extras = []
  if (stagehand) extras.push('浏览器自动化')
  if (startupInfo.diagram) extras.push(`示意图(${startupInfo.diagram})`)
  if (cfg.sticker?.enable) extras.push('表情包')
  if (cfg.stt?.enable !== false) extras.push('STT')
  if (startupInfo.tts) extras.push(`TTS(${startupInfo.tts.provider}${startupInfo.tts.configured ? '' : `·待配置${startupInfo.tts.missing?.length ? ':' + startupInfo.tts.missing.join('/') : ''}`}${startupInfo.tts.sovitsRef ? `·参考音频 ${startupInfo.tts.sovitsRef}` : `·音色${startupInfo.tts.voices}`})`)
  if (cfg.multiagent?.enable !== false) extras.push(`多代理(${startupInfo.multiagent || 'spawn'})`)
  const mcpNames = Object.keys(cfg.mcp?.servers || {})
  Log.panel(`运行时就绪 · ${cfg.model}`, [
    ['模型', `${cfg.model} · ${protocol}${fallbackProviders.length ? ` · 回退 ${fallbackProviders.length}` : ''}`],
    ['工具', `${tools.list().length} 个 · 技能 ${skills.list().length} 个`],
    ['搜索', searchLabel],
    ['视觉', startupInfo.visionModel || 'off'],
    ['沙箱', sandboxLabel],
    ['进化', evolutionBits.join(' · ') || 'off'],
    ['MCP', mcpNames.length ? `${mcpNames.length} 个（${mcpNames.join('、')}）` : 'none'],
    ['其他', extras.join(' / ') || '-'],
    ['面板', cfg.webApi?.enable !== false ? `:${cfg.webApi?.port || 6098}` : 'off'],
  ])

  return { agentConfig, makeAgent, completePersona, tools, session, recall, profile, knowledge, memory, confirm, schedule, scheduler, mcp, provider, modelRouter, persona, personaStore, personaLore, personaAdoptionQueue, vision, skills, skillsDir, sticker: getStickerManager(), kv: K, usageStats, promptRegistry, traceStore, selfReview, promptDir, suggestionDir, toolEvo, stagehand, diagram, sandbox, multiagent, taskStore, scope, tts, gpuInfo }
}

export const getRuntime = async () => {
  if (_runtime) return _runtime
  // 旧运行时 scope 正在清理：等待其完成再重建，避免旧资源（Worker/浏览器/沙箱）与新运行时并存
  if (_closingPromise) { try { await _closingPromise } catch { /* noop */ } }
  // 失败缓存：apiKey 等配置类错误一旦发生，直接抛缓存原因，不再每条消息重新 buildRuntime
  // （否则每条群消息都重建+抛错+回复，刷屏 + 日志爆炸）。配置热加载后 invalidateRuntime 清缓存重试。
  if (_runtimeFailed) {
    // 配置已有 apiKey（原失败原因已解决）→ 清缓存重试，而非永远抛旧错误
    if (Config.get().agent?.apiKey) { _runtimeFailed = null; _initErrLogged = false }
    else throw _runtimeFailed
  }
  // 并发安全：启动期各 apps 构造器 / 首条消息可能并发调 getRuntime，
  // 复用同一个 in-flight buildRuntime()，避免运行时被构建多次（否则 MCP 会重复连接注册、日志打两遍）。
  if (!_runtimePromise) {
    const gen = _runtimeGen
    _runtimePromise = buildRuntime()
      .then(async (rt) => {
        // 构建期间配置被热重载（invalidateRuntime 递增 gen）→ 丢弃旧配置结果，改用新配置重建
        if (gen !== _runtimeGen) {
          try { await rt?.scope?.close?.('stale_build') } catch { /* noop */ } // F16：过期构建关闭资源，不遗留
          return getRuntime()
        }
        _runtime = rt
        _runtimeFailed = null
        // 运行时（重）建后恢复定时调度：提醒 / 定时任务链 + KB 定时刷新。
        // 放这里（而非仅 Chat 构造器）——热重载会 invalidate 旧运行时并取消其 job，
        // 新运行时必须重新 restore，否则保存配置后所有定时任务会静默停摆。
        // restore 已幂等：重复调用不会叠加 job（见 ScheduleStore.restore）。
        try { rt.schedule?.restore?.(makeFireDispatch(rt)).catch(() => {}) } catch { /* noop */ }
        // KB 总开关/抓取开关关闭时不恢复定时刷新（否则关了总闸仍会定时抓取，见配置互搏审计 F12）
        {
          const kbNow = Config.get().agent?.kb || {}
          if (kbNow.enable !== false && kbNow.crawlEnable !== false) {
            try { rt.knowledge?.restoreRefreshJobs?.((id) => rt.knowledge.refreshDoc(id).catch((e) => Log.warn('[kb] 定时刷新失败', id, e?.message || e))).catch(() => {}) } catch { /* noop */ }
          }
        }
        // 人设资料定时刷新：重启/热重载后重排 job（周期重跑补齐 → 出新草稿）
        try { rt.personaLore?.restoreRefreshJobs?.((id) => Promise.resolve(rt.completePersona?.(id, { by: 'schedule' })).catch((e) => Log.warn('[persona] 定时刷新失败', id, e?.message || e))).catch(() => {}) } catch { /* noop */ }
        return rt
      })
      .catch((e) => {
        // 仅在未被 invalidate 时才缓存失败（旧配置的失败不应污染新配置的重试）
        if (gen === _runtimeGen) _runtimeFailed = e
        throw e
      })
      .finally(() => {
        if (gen === _runtimeGen) _runtimePromise = null
      })
  }
  return _runtimePromise
}

/** 失效运行时单例（下一次 getRuntime 用新配置重建）。返回旧 scope 清理的 Promise（可等待）。 */
export function invalidateRuntime() {
  const rt = _runtime
  _runtime = null
  _runtimePromise = null
  _runtimeFailed = null  // 配置已变更：清失败缓存，下次 getRuntime 用新配置重试
  _runtimeGen++          // 在途 buildRuntime 据此丢弃旧配置结果，防止旧运行时被复活
  _initErrLogged = false // 允许再次记录初始化失败（若仍失败）
  _initFailNotified.clear() // runtime 重建：重置"已提示"标记，下次失败可再提示用户

  const prev = _closingPromise // F17：串接未完成的关闭屏障，重复 invalidate 不得绕过旧代清理
  const p = (async () => {
    if (prev) { try { await prev } catch { /* noop */ } }
    if (rt?.scope?.close) {
      // P0-4：统一走 scope（幂等、await 资源退出、按依赖顺序）
      try { const s = await rt.scope.close('invalidate'); return s } catch (e) { Log.warn('[runtime] 作用域清理异常', e?.message || e) }
    } else if (rt) {
      // 兼容：无 scope 的旧运行时退回内联清理（尽力而为）
      try { rt.schedule?.shutdown?.() } catch { /* noop */ }
      try { rt.knowledge?.shutdown?.() } catch { /* noop */ }
      try { rt.toolEvo?.runner?.stop?.() } catch { /* noop */ }
      try { await rt.toolEvo?.closeDb?.() } catch { /* noop */ }
      try { rt.stagehand?.sessionMgr?.closeAll?.() } catch { /* noop */ }
      try { rt.diagram?.stop?.() } catch { /* noop */ }
      try { await rt.usageStats?.flushNow?.() } catch { /* noop */ }
      try { rt.usageStats?.stop?.() } catch { /* noop */ }
      try { const n = rt.multiagent?.shutdown?.(); if (n) Log.info(`[multiagent] 运行时失效：已终止 ${n} 个在跑子代理`) } catch { /* noop */ }
      try { await rt.taskStore?.close?.() } catch { /* noop */ }
      try { await rt.sandbox?.shutdown?.() } catch { /* noop */ }
    }
  })()
  _closingPromise = p
  p.finally(() => { if (_closingPromise === p) _closingPromise = null })
  return p
}

// 热加载：配置文件变更 → 失效运行时单例，下次对话用新配置重建（无需重启框架）
Config.onChange(() => {
  Log.setDebug(Config.get().debug === true)
  invalidateRuntime()
  Log.info(`[config] 配置已热加载，运行时将在下次对话重建（debug=${Config.get().debug === true ? 'on' : 'off'}）`)
})
Config.startWatch() // 应用入口启动配置文件监听（不在 Config import 时启动，免得测试进程不退出）

// 供 apps/research.js 等复用已装配的 provider / 工具集

/**
 * 调度条目归属判定（越权防护）：主人可操作全部；其余人只能操作
 * 「自己创建（userId）」「本会话归属（scopeUserId，群共享模式下即本群共享任务）」的条目。
 * 判据与写入端一致：reminder_set / schedule_task 写入的是 ctx.scopeUserId。
 */
