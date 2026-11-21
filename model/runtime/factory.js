/**
 * Runtime 工厂（PR1）：按配置选择 legacy | mastra。
 *
 * 关键约束：
 *  - **默认 legacy**；不配置 runtime 时不加载任何 Mastra 代码/数据库。
 *  - Mastra 只在 engine=mastra 时动态 import，避免拖慢插件扫描与 legacy 启动。
 *  - fallbackToLegacy=true 时，Mastra 初始化失败只降级并告警；false 时抛错（fail-closed）。
 *  - scope 注册 close，沿用 RuntimeScope 的逆序/幂等清理；generation 由 apps 的 _runtimeGen 传入。
 */
import { AgentRuntimeFacade } from './facade.js'
import { parseRuntimeConfig } from './schemas/config.js'
import { normalizeRuntimeError } from './errors.js'

function makeLoggerAdapter(fn) {
  if (typeof fn !== 'function') return null
  return {
    warn: (...args) => fn('warn', ...args),
    info: (...args) => fn('info', ...args),
    debug: (...args) => fn('debug', ...args),
  }
}

/**
 * @param {object} opts
 * @param {object} opts.cfg agent 配置块
 * @param {string} opts.dataDir 插件 data 目录（LibSQL 绝对路径基准）
 * @param {object|null} [opts.scope] RuntimeScope（存在则登记 close）
 * @param {{makeAgent?:Function,runChat?:Function}} [opts.legacy]
 * @param {Function|null} [opts.logger] (level,...args)
 * @param {number} [opts.generation]
 * @returns {Promise<AgentRuntimeFacade>}
 */
export async function createRuntimeFacade({ cfg = {}, dataDir, scope = null, legacy = null, chat = null, logger = null, generation = 0 } = {}) {
  const { value: config, repairs } = parseRuntimeConfig(cfg)
  if (repairs.length && typeof logger === 'function') {
    for (const r of repairs.slice(0, 8)) logger('warn', `配置 agent.${r.path || 'runtime'} 非法（${r.message}），已回退安全默认`)
  }

  const requested = config.runtime.engine
  let mastra = null
  let initError = null
  if (requested === 'mastra') {
    try {
      const { createEmbeddedMastra } = await import('./mastra-runtime.js')
      mastra = await createEmbeddedMastra({ config, dataDir, logger: makeLoggerAdapter(logger) })
      try { logger?.('mark', `Mastra 骨架已创建（storage=${mastra.storage?.driver}，${mastra.initMs}ms；未接聊天流量）`) } catch { /* noop */ }
    } catch (e) {
      initError = normalizeRuntimeError(e, { phase: 'mastra' })
      if (config.runtime.fallbackToLegacy !== true) {
        try { logger?.('error', 'Mastra 初始化失败且 fallbackToLegacy=false', initError.code, initError.message) } catch { /* noop */ }
        throw e
      }
      try { logger?.('warn', 'Mastra 初始化失败，已回退 legacy', initError.code, initError.message) } catch { /* noop */ }
    }
  }

  let history = null
  if (mastra && config.mastra.memory.mode === 'mastra') {
    try {
      const { MastraMemoryBridge } = await import('./memory-bridge.js')
      history = new MastraMemoryBridge({
        memory: mastra.memory,
        storage: mastra.storage?.store,
        legacySession: chat?.session || null,
        botId: chat?.identity?.botId || '',
        adapter: chat?.identity?.adapter || 'onebot',
        onDemandMigration: config.mastra.memory.onDemandMigration !== false,
        logger: makeLoggerAdapter(logger),
      })
      logger?.('mark', '[runtime] Mastra Memory 已接管会话历史（迁移可回退 SessionStore）')
    } catch (e) {
      initError = normalizeRuntimeError(e, { phase: 'mastra_memory' })
      logger?.('warn', '[runtime] Mastra Memory 初始化失败，历史将回退 SessionStore', initError.code, initError.message)
    }
  }

  let chatRunner = null
  if (mastra && chat) {
    try {
      const { createMastraChatRunner } = await import('./chat-runner.js')
      chatRunner = createMastraChatRunner({ cfg, deps: { ...chat, mastra: mastra?.mastra, memory: history }, logger })
      logger?.('mark', '[runtime] Mastra 非流式聊天 Runner 已就绪（仅灰度命中时使用）')
    } catch (e) {
      initError = normalizeRuntimeError(e, { phase: 'mastra' })
      logger?.('warn', '[runtime] Mastra 聊天 Runner 初始化失败，灰度将回退 legacy', initError.code, initError.message)
    }
  }
  const facade = new AgentRuntimeFacade({
    engine: requested,
    legacy,
    mastra,
    chatRunner,
    gray: config.runtime.gray,
    config,
    initError,
    logger,
    generation,
    history,
  })
  if (scope && typeof scope.register === 'function') {
    scope.register(() => facade.close('scope_close'), { name: 'runtime-facade', order: 0 })
  }
  return facade
}

export { AgentRuntimeFacade }
