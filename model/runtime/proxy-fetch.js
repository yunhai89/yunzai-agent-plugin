/**
 * 代理 fetch（PR2/D10）。
 *
 * 背景：`agent.proxy` 原实现 `import('undici')`，但 undici 未声明为依赖 → 生产实际静默直连。
 * PR2 补 `undici@8.13.0`，并把逻辑集中到这里，供 ModelFactory 与 legacy apps 复用。
 *
 * - 仅支持 http/https；SOCKS 明确告警并直连（undici ProxyAgent 不支持 socks）。
 * - 代理地址非法/undici 加载失败 → 返回 null（直连）并告警，不阻塞启动。
 * - 返回的函数与原生 fetch 同签名，可直接传给 AI SDK provider `fetch`。
 */
import Log from '../../utils/Log.js'

/**
 * @param {string} proxy
 * @param {{logger?:Function}} [opts] logger(level,...args)，默认 utils/Log
 * @returns {Promise<Function|null>}
 */
export async function createProxyFetch(proxy, { logger = null } = {}) {
  const value = String(proxy || '').trim()
  if (!value) return null
  const log = typeof logger === 'function' ? logger : (level, ...args) => {
    try {
      if (level === 'warn') Log.warn(...args)
      else if (level === 'error') Log.error(...args)
      else Log.info(...args)
    } catch { /* noop */ }
  }
  if (/^socks/i.test(value)) {
    log('warn', '[proxy] agent.proxy 不支持 SOCKS（仅 http/https），本次直连；请改用 http(s) 代理或网关')
    return null
  }
  try {
    const { ProxyAgent, fetch: undiciFetch } = await import('undici')
    const dispatcher = new ProxyAgent(value)
    const wrapped = (url, opts = {}) => undiciFetch(url, { ...opts, dispatcher })
    wrapped.__proxy = value
    wrapped.__dispatcher = dispatcher
    return wrapped
  } catch (e) {
    log('warn', '[proxy] 代理不可用（undici 未装或地址非法），本次直连', e?.message || e)
    return null
  }
}

/** 环境代理（HTTPS_PROXY/HTTP_PROXY/ALL_PROXY）；本地/内网地址仍直连。 */
export async function createEnvProxyFetch({ logger = null, direct = globalThis.fetch } = {}) {
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.ALL_PROXY || process.env.HTTP_PROXY || process.env.http_proxy
  if (!proxy) return typeof direct === 'function' ? direct : null
  const proxyFetch = await createProxyFetch(proxy, { logger })
  if (!proxyFetch) return typeof direct === 'function' ? direct : null
  const isLocal = (u) => /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(String(u))
  return (url, opts = {}) => proxyFetch(url, isLocal(url) ? { ...opts, dispatcher: undefined } : opts)
}

/** 显式代理优先；否则读环境变量；都没有用原生 fetch。 */
export async function resolveProxyFetch(proxy, { logger = null, direct = globalThis.fetch } = {}) {
  if (proxy) {
    const f = await createProxyFetch(proxy, { logger })
    return f || (typeof direct === 'function' ? direct : null)
  }
  return createEnvProxyFetch({ logger, direct })
}
