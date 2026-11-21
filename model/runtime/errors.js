/**
 * Runtime 错误归一（PR1 骨架，不接主链路）。
 *
 * 目标：把 Mastra / AI SDK / storage / abort / timeout 抛出的异构错误收敛为稳定 code，
 * 供 Facade、DevLog、Web health 与 PR4 的 stopReason 映射复用。**不在这里做用户文案**；
 * 用户可读文案仍由 apps 的 STOP_REASON_CN / reply 层决定。
 *
 * 约束：错误消息里不得包含 API Key / DSN；调用方负责脱敏，本模块只做结构归一。
 */

export class RuntimeError extends Error {
  constructor(code, message, { cause = null, retryable = false, phase = 'runtime' } = {}) {
    super(message || code)
    this.name = 'RuntimeError'
    this.code = code
    this.phase = phase
    this.retryable = retryable
    if (cause) this.cause = cause
  }
}

export class RuntimeConfigError extends RuntimeError {
  constructor(message, opts = {}) {
    super(opts.code || 'runtime_config_invalid', message, { ...opts, phase: 'config' })
    this.name = 'RuntimeConfigError'
  }
}

export class StorageInitError extends RuntimeError {
  constructor(message, opts = {}) {
    super('storage_init_failed', message, { retryable: true, ...opts, phase: 'storage' })
    this.name = 'StorageInitError'
  }
}

export class MastraNotReadyError extends RuntimeError {
  constructor(message = 'Mastra runtime 尚未接线（PR4 前只创建骨架）', opts = {}) {
    super('mastra_not_ready', message, { ...opts, phase: 'mastra' })
    this.name = 'MastraNotReadyError'
  }
}

/** 取消类错误：AbortError / 现有 Agent 的 'aborted' / signal.reason */
export function isAbortError(error, signal = null) {
  if (signal?.aborted) return true
  const name = String(error?.name || '')
  const msg = String(error?.message || error || '')
  return name === 'AbortError' || /^(aborted|cancelled|canceled)$/i.test(msg.trim())
}

export function isTimeoutError(error) {
  const name = String(error?.name || '')
  const code = String(error?.code || '')
  return name === 'TimeoutError' || code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT'
}

function messageOf(error) {
  if (!error) return ''
  if (typeof error === 'string') return error
  return String(error.message || error)
}

/**
 * @param {unknown} error
 * @param {{signal?:AbortSignal|null, phase?:string}} [opts]
 * @returns {{code:string, phase:string, message:string, retryable:boolean, stopReason:string|null}}
 */
export function normalizeRuntimeError(error, { signal = null, phase = 'runtime' } = {}) {
  if (error?.code && error instanceof RuntimeError) {
    return {
      code: error.code,
      phase: error.phase || phase,
      message: error.message,
      retryable: error.retryable === true,
      stopReason: error.code === 'mastra_not_ready' ? 'runtime_error' : null,
    }
  }
  if (isAbortError(error, signal)) {
    return { code: 'aborted', phase, message: messageOf(error) || 'aborted', retryable: false, stopReason: 'cancelled' }
  }
  if (isTimeoutError(error)) {
    return { code: 'timeout', phase, message: messageOf(error) || 'timeout', retryable: true, stopReason: 'time_budget' }
  }
  const msg = messageOf(error)
  const lower = msg.toLowerCase()
  if (/api key|unauthorized|401|403|authentication|invalid.*key/.test(lower)) {
    return { code: 'provider_auth', phase: 'provider', message: msg, retryable: false, stopReason: 'provider_error' }
  }
  if (/rate limit|429|overloaded|503|502|timeout|network|fetch failed|econn/.test(lower)) {
    return { code: 'provider_unavailable', phase: 'provider', message: msg, retryable: true, stopReason: 'provider_error' }
  }
  if (/tool/.test(lower) && /(fail|error|throw)/.test(lower)) {
    return { code: 'tool_error', phase: 'tool', message: msg, retryable: false, stopReason: 'tool_error' }
  }
  return { code: 'runtime_error', phase, message: msg || 'runtime error', retryable: false, stopReason: null }
}

/** 带超时的 Promise；超时抛 TimeoutError（不吞原错误） */
export function withTimeout(promise, ms, label = 'operation') {
  const timeout = Math.max(1, Number(ms) || 1)
  let timer = null
  return Promise.race([
    Promise.resolve(promise).finally(() => { if (timer) clearTimeout(timer) }),
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        const e = new Error(`${label} timeout after ${timeout}ms`)
        e.name = 'TimeoutError'
        e.code = 'ETIMEDOUT'
        reject(e)
      }, timeout)
    }),
  ])
}
