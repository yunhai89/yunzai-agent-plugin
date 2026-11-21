/**
 * 嵌入式 Mastra 运行时（PR1 骨架）。
 *
 * 只创建 Mastra 实例 + Storage/Vector，不注册 Agent/Workflow、不接聊天流量。
 * PR4 才在这里注册 chat Agent；PR1 的 Facade 永远回退 legacy 执行。
 *
 * 关闭顺序（与 01 §3.2 一致）：
 *   mastra.shutdown（取消/回滚在途 run）→ memory.settled → vector.close → storage.close
 */
import { Mastra } from '@mastra/core'
import { createStorageBundle } from './storage-factory.js'
import { normalizeRuntimeError, withTimeout } from './errors.js'

/**
 * @param {object} opts
 * @param {{runtime:object,mastra:object}} opts.config 已归一配置
 * @param {string} opts.dataDir
 * @param {{warn?:Function,info?:Function,debug?:Function}|null} [opts.logger]
 */
export async function createEmbeddedMastra({ config, dataDir, logger = null } = {}) {
  const startedAt = Date.now()
  const bundle = await createStorageBundle(config?.mastra, { dataDir, logger })
  let mastra = null
  try {
    mastra = new Mastra({
      storage: bundle.storage.store,
      ...(bundle.vector?.store ? { vectors: { default: bundle.vector.store } } : {}),
      logger: false,
    })
  } catch (e) {
    try { await bundle.close() } catch { /* noop */ }
    throw e
  }

  const closeTimeoutMs = Math.max(1_000, Number(config?.mastra?.closeTimeoutMs) || 15_000)
  let closing = null
  let closed = false

  return {
    mastra,
    storage: bundle.storage,
    vector: bundle.vector,
    memory: null, // Phase 2（PR5）才创建；Phase 1 历史仍由 SessionStore 唯一写
    initMs: Date.now() - startedAt,
    describe() {
      return {
        engine: 'mastra',
        storage: bundle.storage.describe(),
        vector: bundle.vector?.describe?.() || { enable: false },
        memory: { mode: config?.mastra?.memory?.mode || 'sessionstore', semanticRecall: config?.mastra?.memory?.semanticRecall === true },
      }
    },
    async health() {
      const out = { engine: 'mastra', ok: false, storage: bundle.storage.describe(), vector: bundle.vector?.describe?.() || { enable: false } }
      try {
        out.ok = await bundle.ping({ timeoutMs: Math.min(closeTimeoutMs, 5_000) })
      } catch (e) {
        out.error = normalizeRuntimeError(e, { phase: 'storage' }).code
      }
      return out
    },
    close(reason = 'close') {
      if (closing) return closing
      closing = (async () => {
        const errors = []
        const step = async (name, fn) => {
          try { await withTimeout(Promise.resolve().then(fn), closeTimeoutMs, name) } catch (e) {
            errors.push({ step: name, code: normalizeRuntimeError(e, { phase: 'close' }).code })
          }
        }
        // 1) 取消在途 run / 释放线程租约；2) Memory 后台向量清理；3) Vector 连接；4) Storage 连接
        await step('mastra.shutdown', () => mastra.shutdown({ drainTimeout: closeTimeoutMs }))
        await step('memory.settled', () => null)
        await step('vector.close', () => bundle.vector?.close?.())
        await step('storage.close', () => bundle.storage.close())
        closed = true
        if (errors.length) {
          try { logger?.warn?.('[runtime] Mastra 关闭存在异常', errors.map((e) => `${e.step}:${e.code}`).join(',')) } catch { /* noop */ }
        }
        return { ok: errors.length === 0, reason, errors }
      })()
      return closing
    },
    get closed() { return closed },
  }
}
