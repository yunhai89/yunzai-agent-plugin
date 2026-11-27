/**
 * crawl4ai 运行时安装 / 自检（开箱即用）。
 *
 * 背景：crawl4ai 的 Python 包装好不等于能用——还必须装 Playwright Chromium。此前依赖用户
 * 自己跑 scripts/install-crawl4ai.sh，很多人只装了 Python 包或完全没装，web_crawl 便一直降级
 * 纯 HTTP。本模块在插件启动时后台检测，缺什么补什么：
 *   - 缺 venv / crawl4ai → 跑完整安装脚本；
 *   - crawl4ai 在、Chromium 缺 → 只补浏览器（不重复升级 Python 包）。
 * 浏览器默认装到插件目录（.crawl4ai-browsers），不是全局缓存；已显式设置
 * PLAYWRIGHT_BROWSERS_PATH / CRAWL4AI_BROWSERS_DIR 时尊重用户选择。
 *
 * 安装是后台的，不阻塞 Yunzai 启动；失败继续降级 fetch，状态写入
 * data/crawl/setup-status.json，日志写 data/crawl/setup.log。
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import Config from '../../utils/Config.js'
import Log from '../../utils/Log.js'
import {
  CRAWL4AI_VENV_DIR, CRAWL4AI_BROWSERS_DIR, crawl4aiPython, crawl4aiEnv,
  isCrawl4aiAvailable, resetCrawl4aiProbe,
} from './crawl4ai.js'

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const INSTALL_SCRIPT = path.join(PLUGIN_ROOT, 'scripts', 'install-crawl4ai.sh')
const DATA_DIR = path.join(Config.path.data, 'crawl')
const STATUS_FILE = path.join(DATA_DIR, 'setup-status.json')
const LOCK_FILE = path.join(DATA_DIR, 'setup.lock')
const LOG_FILE = path.join(DATA_DIR, 'setup.log')
const LOCK_STALE_MS = 30 * 60 * 1000
const AUTO_RETRY_MS = 6 * 60 * 60 * 1000

let _installing = null
let _starting = false

const file = (p) => String(p || '').replace(/\\/g, '/')

function ensureDir() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 }) } catch { /* Windows 无权限位 */ }
}

function readJson(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')) } catch { return null }
}

function writeJson(filePath, data) {
  ensureDir()
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 })
    try { fs.chmodSync(filePath, 0o600) } catch { /* Windows 无权限位 */ }
  } catch (e) {
    Log.warn('[crawl] 写入抓取环境状态失败', e?.message || e)
  }
}

function pidAlive(pid) {
  const n = Number(pid)
  if (!Number.isFinite(n) || n <= 0) return false
  try { process.kill(n, 0); return true } catch (e) { return e?.code === 'EPERM' }
}

/** 读取安装锁；进程已退出/锁过期的自动清理。 */
function readLock() {
  const lock = readJson(LOCK_FILE)
  if (!lock || typeof lock !== 'object') return null
  if (pidAlive(lock.pid)) return lock
  if (!lock.pid && Number(lock.startedAt) && Date.now() - Number(lock.startedAt) < LOCK_STALE_MS) return lock
  try { fs.unlinkSync(LOCK_FILE) } catch { /* 已清理 */ }
  return null
}

/** 安装模式：已有 crawl4ai 只是浏览器缺失时只补浏览器。 */
export function pickInstallMode(probe = {}) {
  const reason = String(probe?.reason || '')
  // 浏览器文件缺失/探测超时：只补浏览器；Playwright 本身坏了或 crawl4ai 不可用：完整安装。
  if (probe?.version && (reason === 'browser_missing' || reason === 'browser_probe_timeout')) return 'browser'
  return 'full'
}

export function crawlSetupPaths() {
  return {
    venv: CRAWL4AI_VENV_DIR,
    python: crawl4aiPython(),
    browsers: crawl4aiEnv().PLAYWRIGHT_BROWSERS_PATH || CRAWL4AI_BROWSERS_DIR,
    script: INSTALL_SCRIPT,
    log: LOG_FILE,
    status: STATUS_FILE,
    lock: LOCK_FILE,
  }
}

/**
 * 当前抓取环境状态（fresh probe，供 #抓取环境 / 自动安装前判断）。
 * 注意：探测会 spawn 一次 venv python（import crawl4ai + 查 Chromium 路径），约 1 秒。
 */
export async function getCrawlSetupStatus({ probe = true } = {}) {
  const cfg = Config.get()?.agent || {}
  const crawl = cfg.kb?.crawl || {}
  const engine = String(crawl.engine || 'crawl4ai')
  const execution = String(crawl.execution || 'local')
  const lock = readLock()
  const installing = !!_installing || !!lock
  const last = readJson(STATUS_FILE)

  let p = null
  if (probe) {
    try { p = await isCrawl4aiAvailable({ ttl: 0 }) } catch (e) {
      p = { ok: false, reason: 'probe_error', error: e?.message || String(e) }
    }
  }
  const paths = crawlSetupPaths()
  return {
    ready: !!(p && p.ok),
    installing,
    engine,
    execution,
    autoInstall: crawl.autoInstall !== false,
    version: p?.version || '',
    python: p?.python || paths.python,
    browser: p?.browser || '',
    browsersDir: p?.browsersDir || paths.browsers,
    reason: p?.reason || '',
    error: p?.error || '',
    hint: p?.hint || '',
    venv: paths.venv,
    log: paths.log,
    last: last || null,
    installMode: lock?.mode || _installing?.mode || last?.mode || '',
    startedAt: lock?.startedAt || _installing?.startedAt || 0,
  }
}

function appendStatus(data) {
  const prev = readJson(STATUS_FILE) || {}
  writeJson(STATUS_FILE, { ...prev, ...data })
}

/**
 * 启动后台安装（不等待完成；返回 started 表示是否真的启动了）。
 * @param {object} o
 * @param {'auto'|'browser'|'full'} o.mode
 * @param {boolean} o.force 忽略 6 小时失败冷却/陈旧状态（不终止正在运行的安装）
 * @param {object} o.probeResult 已探测的状态，避免重复 spawn
 * @param {function} o.onFinish 安装结束（成功/失败）后回调，用于把结果推回聊天；
 *   安装已在运行时会把回调挂到当前任务上，仍能收到结果。
 */
export async function startCrawl4aiInstall(options = {}) {
  if (_installing) {
    attachCrawlInstallFinish(options?.onFinish)
    return { started: false, already: true, mode: _installing.mode, log: LOG_FILE }
  }
  if (_starting) return { started: false, already: true, log: LOG_FILE }
  _starting = true
  try {
    return await _startCrawl4aiInstall(options)
  } finally {
    _starting = false
  }
}

/**
 * 给正在后台运行的安装挂一个结束回调（成功/失败都会触发）。
 * 供 #抓取环境 在安装已由启动自检发起时仍能收到聊天反馈。
 * @returns {boolean} 是否挂上（没有正在进行的安装时为 false）
 */
export function attachCrawlInstallFinish(cb) {
  if (typeof cb !== 'function' || !_installing) return false
  _installing.onFinish.push(cb)
  return true
}

async function _startCrawl4aiInstall({ mode = 'auto', force = false, probeResult = null, onFinish = null } = {}) {
  if (_installing) return { started: false, already: true, mode: _installing.mode, log: LOG_FILE }
  const lock = readLock()
  if (lock) return { started: false, already: true, mode: lock.mode || '', log: LOG_FILE }

  if (process.platform === 'win32') {
    return {
      started: false,
      error: 'Windows 下请用 WSL 或手动运行 scripts/install-crawl4ai.sh（需要 sh + python3）',
      log: LOG_FILE,
    }
  }
  if (!fs.existsSync(INSTALL_SCRIPT)) {
    return { started: false, error: `安装脚本不存在：${file(INSTALL_SCRIPT)}`, log: LOG_FILE }
  }

  const probe = probeResult || await getCrawlSetupStatus({ probe: true })
  if (probe.ready) return { started: false, ready: true, mode: '', log: LOG_FILE }
  const installMode = mode === 'auto' ? pickInstallMode(probe) : (mode === 'browser' ? 'browser' : 'full')
  const startedAt = Date.now()
  const env = {
    ...crawl4aiEnv(),
    // 未显式指定时，脚本会把 Playwright 浏览器装到插件目录（随后 crawl4aiEnv 自动识别）。
    CRAWL4AI_BROWSER_ONLY: installMode === 'browser' ? '1' : '0',
  }
  if (!process.env.CRAWL4AI_BROWSERS_DIR && !process.env.PLAYWRIGHT_BROWSERS_PATH) {
    env.CRAWL4AI_BROWSERS_DIR = CRAWL4AI_BROWSERS_DIR
  }

  ensureDir()
  try {
    fs.appendFileSync(LOG_FILE, `\n===== ${new Date(startedAt).toISOString()} install ${installMode} =====\n`, { mode: 0o600 })
  } catch { /* 日志失败不阻塞安装 */ }
  writeJson(LOCK_FILE, { pid: process.pid, startedAt, mode: installMode })
  appendStatus({ installing: true, mode: installMode, startedAt, log: LOG_FILE })

  let child
  try {
    child = spawn('sh', [INSTALL_SCRIPT], {
      cwd: PLUGIN_ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    // 锁记录安装子进程：Node 重启后即使旧安装仍在跑，也能被判活而不是重复启动。
    writeJson(LOCK_FILE, { pid: child.pid || process.pid, startedAt, mode: installMode })
  } catch (e) {
    try { fs.unlinkSync(LOCK_FILE) } catch { /* noop */ }
    appendStatus({ installing: false, ok: false, mode: installMode, finishedAt: Date.now(), error: e?.message || String(e) })
    return { started: false, error: e?.message || String(e), log: LOG_FILE }
  }

  // 安装结束通知（命令发起方/多个等待者）：成功或失败都要反馈，不能只写控制台日志。
  const finishListeners = typeof onFinish === 'function' ? [onFinish] : []
  let tail = ''
  let settled = false
  let logStream = null
  try {
    logStream = fs.createWriteStream(LOG_FILE, { flags: 'a', mode: 0o600 })
    logStream.on('error', () => { try { logStream.destroy() } catch { /* noop */ } })
  } catch { /* noop */ }
  const onData = (d) => {
    const text = String(d)
    tail = (tail + text).slice(-6000)
    try { logStream?.write(text) } catch { /* noop */ }
  }
  child.stdout?.on('data', onData)
  child.stderr?.on('data', onData)

  const finish = (result) => {
    if (settled) return
    settled = true
    try { logStream?.end() } catch { /* noop */ }
    try { fs.unlinkSync(LOCK_FILE) } catch { /* noop */ }
    resetCrawl4aiProbe()
    const ok = result.ok === true
    const status = {
      installing: false,
      ok,
      mode: installMode,
      startedAt,
      finishedAt: Date.now(),
      code: result.code ?? null,
      signal: result.signal || null,
      error: result.error || '',
      log: LOG_FILE,
      tail: tail.slice(-4000),
    }
    appendStatus(status)
    _installing = null
    if (ok) {
      Log.mark('[crawl] 抓取环境安装完成：crawl4ai + Chromium 已就绪，web_crawl 将使用真浏览器渲染')
    } else {
      Log.warn('[crawl] 抓取环境安装失败：仍会降级纯 HTTP fetch。发 #抓取环境 查看原因/重试，日志', LOG_FILE)
    }
    for (const cb of finishListeners.splice(0)) {
      try {
        Promise.resolve(cb(status)).catch((e) => Log.warn('[crawl] 安装结果通知发送失败', e?.message || e))
      } catch (e) {
        Log.warn('[crawl] 安装结果通知发送失败', e?.message || e)
      }
    }
  }

  _installing = { mode: installMode, startedAt, promise: null, onFinish: finishListeners }
  const promise = new Promise((resolve) => {
    child.on('error', (e) => { finish({ ok: false, error: e?.message || String(e) }); resolve() })
    child.on('close', (code, signal) => { finish({ ok: code === 0, code, signal }); resolve() })
  })
  _installing.promise = promise

  Log.mark(`[crawl] 开始在后台${installMode === 'browser' ? '补装 Chromium' : '安装 crawl4ai + Chromium'}（日志 ${LOG_FILE}）`)
  return { started: true, mode: installMode, log: LOG_FILE, promise }
}

/**
 * 启动时自动补齐（默认开）。失败冷却 6 小时，避免无网络环境每次重启都重试几百 MB；
 * 手动 #抓取环境 修复 会 force 绕过冷却。
 */
export async function maybeAutoInstallCrawl4ai({ force = false, deps = {} } = {}) {
  const cfg = deps.cfg || Config.get()?.agent || {}
  const crawl = cfg.kb?.crawl || {}
  if (cfg.kb?.crawlEnable === false) return { skipped: 'crawl_disabled' }
  if (String(crawl.engine || 'crawl4ai') !== 'crawl4ai') return { skipped: 'engine_fetch' }
  if (String(crawl.execution || 'local') !== 'local') return { skipped: 'execution_sandbox' }
  if (crawl.autoInstall === false) return { skipped: 'auto_install_off' }

  const getStatus = deps.getStatus || getCrawlSetupStatus
  const start = deps.start || startCrawl4aiInstall
  const status = await getStatus({ probe: true })
  if (status.ready) return { skipped: 'ready', status }
  if (status.installing) {
    Log.info('[crawl] 抓取环境正在安装中，暂不重复启动')
    return { skipped: 'installing', status }
  }
  const last = status.last
  if (!force && last && last.ok === false && last.finishedAt
    && Date.now() - Number(last.finishedAt) < AUTO_RETRY_MS) {
    Log.info('[crawl] 上次抓取环境安装失败未满 6 小时，跳过自动重试；发 #抓取环境 修复 可立即重试')
    return { skipped: 'cooldown', status }
  }
  const r = await start({ mode: 'auto', force, probeResult: status })
  if (r.error) Log.warn('[crawl] 抓取环境自动安装未启动：', r.error)
  return { ...r, status }
}

function reasonText(s) {
  if (s.reason === 'browser_missing') return 'crawl4ai 已装，但缺少 Playwright Chromium'
  if (s.reason === 'browser_probe_failed') return 'Playwright 浏览器探测失败（可能未装浏览器或系统库缺失）'
  if (s.reason === 'probe_timeout') return '抓取环境探测超时（venv/Python 无响应）'
  if (s.reason === 'spawn_failed') return '未找到 crawl4ai venv 的 Python 解释器（确认系统有 python3 ≥3.10）'
  return s.reason || s.error || '未安装或不可用'
}

/** 安装日志尾部：去掉 ANSI 与进度条噪音，只保留最后几条可读输出。 */
function readableTail(text, n = 3) {
  return String(text || '')
    .replace(/\x1b\[[0-9;]*m/g, '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/^\|■/.test(l) && !/% of /.test(l))
    .slice(-n)
}

/**
 * 后台安装结束后的聊天反馈（成功/失败都发；失败附带退出码、日志尾部和重试命令）。
 * 与 formatCrawlSetupStatus 分离：状态报告用于主动查询，这里用于安装完成推送。
 */
export function formatCrawlInstallResult(r = {}) {
  const ok = r.ok === true
  const mode = r.mode === 'browser' ? '补装 Chromium' : '安装 crawl4ai + Chromium'
  const lines = [`${ok ? '✅' : '❌'} 抓取环境${mode}${ok ? '完成' : '失败'}`]
  if (ok) {
    lines.push('web_crawl 现在会使用真浏览器渲染，无需重启。')
  } else {
    lines.push(`退出码：${r.code != null ? r.code : '未知'}${r.signal ? ` · signal ${r.signal}` : ''}`)
    if (r.error) lines.push(`原因：${r.error}`)
    lines.push('当前继续降级纯 HTTP fetch，插件其他功能不受影响。')
    const tail = readableTail(r.tail, 3)
    if (tail.length) lines.push(`日志尾部：\n${tail.join('\n')}`)
    lines.push('发 #抓取环境 查看完整状态，或 #抓取环境 修复 重新安装。')
  }
  if (r.log) lines.push(`日志：${file(r.log)}`)
  return lines.join('\n')
}

/** #抓取环境 的纯文本报告（保持可单测）。 */
export function formatCrawlSetupStatus(s = {}) {
  const lines = ['🧰 网页抓取环境']
  if (s.engine === 'fetch') {
    lines.push('引擎：fetch（纯 HTTP + cheerio，不需要浏览器）')
    lines.push('如需 SPA/JS 动态页，把 agent.kb.crawl.engine 改为 crawl4ai 后发 #抓取环境 安装')
    return lines.join('\n')
  }
  if (s.execution === 'sandbox') {
    lines.push('执行面：sandbox（crawl4ai 必须在 agent.sandbox.template 的 E2B 模板内预装）')
    lines.push('本机安装不会生效；如需宿主浏览器请把 agent.kb.crawl.execution 改回 local')
    return lines.join('\n')
  }
  lines.push(`执行面：local${s.autoInstall ? ' · 自动安装开启' : ' · 自动安装关闭'}`)
  if (s.installing) {
    lines.push(`状态：⏳ 安装中（${s.installMode || 'auto'}）${s.startedAt ? ` · 开始于 ${new Date(Number(s.startedAt)).toLocaleString('zh-CN')}` : ''}`)
    lines.push('安装完成后发 #抓取环境 查看结果；当前抓取会先降级纯 HTTP')
  } else {
    lines.push(s.ready ? '状态：✅ 可用（crawl4ai 真浏览器渲染）' : '状态：❌ 不可用（当前自动降级纯 HTTP fetch）')
  }
  if (s.version) lines.push(`crawl4ai：${s.version}`)
  lines.push(`解释器：${file(s.python || '') || '-'}`)
  lines.push(`浏览器：${file(s.browser || s.browsersDir || '') || '-'}`)
  if (!s.ready && !s.installing) lines.push(`原因：${reasonText(s)}`)
  if (s.last && s.last.ok === false && !s.installing) {
    const when = s.last.finishedAt ? new Date(Number(s.last.finishedAt)).toLocaleString('zh-CN') : ''
    lines.push(`上次安装失败：${when}${s.last.code != null ? `（exit ${s.last.code}）` : ''}`)
    const tail = readableTail(s.last.tail, 3)
    if (tail.length) lines.push(`日志尾部：\n${tail.join('\n')}`)
  }
  lines.push(`安装日志：${file(s.log || '') || '-'}`)
  if (!s.ready && !s.installing) lines.push('修复：发 #抓取环境 安装（或 #抓取环境 修复 忽略失败冷却重试）')
  return lines.join('\n')
}
