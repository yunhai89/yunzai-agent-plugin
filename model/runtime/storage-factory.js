/**
 * Storage / Vector Factory（PR1）。
 *
 * 约束：
 *  - LibSQL 本地默认路径 `<plugin>/data/mastra/mastra.db`，运行时转**绝对路径**；
 *    官方明确相对 `file:./x.db` 会按进程 cwd 解析，热重载/不同工作目录会打开不同库。
 *  - `:memory:` 只用于单测；生产/真机必须落盘。
 *  - PostgreSQL DSN 只从环境变量读取，绝不写入配置、日志或 health。
 *  - 关闭顺序由 mastra-runtime 负责：mastra.shutdown → memory.settled → vector.close → storage.close。
 */
import fs from 'node:fs'
import path from 'node:path'
import { StorageInitError, RuntimeConfigError, withTimeout } from './errors.js'

const STORE_ID = 'yz-mastra'
const VECTOR_ID = 'yz-mastra-vector'

function envName(cfg) {
  return String(cfg?.connectionStringEnv || 'MASTRA_DATABASE_URL').trim()
}

function requireDsn(cfg, driver) {
  const name = envName(cfg)
  const value = process.env[name]
  if (!value) {
    throw new StorageInitError(`缺少 ${name}（driver=${driver}）；请只通过环境变量提供 DSN`, { code: 'storage_missing_dsn' })
  }
  return { name, value }
}

/** 只允许绝对 file:/libsql:/:memory:；拒绝按 cwd 解析的相对 file: */
export function resolveLibsqlUrl(cfg, { dataDir } = {}) {
  const raw = String(cfg?.libsqlUrl || '').trim()
  if (raw) {
    if (raw === ':memory:' || raw === 'file::memory:') return { url: 'file::memory:', memory: true, path: null }
    if (raw.startsWith('libsql://') || raw.startsWith('https://')) return { url: raw, memory: false, path: null }
    if (!raw.startsWith('file:')) throw new RuntimeConfigError(`libsqlUrl 不支持的协议：${raw}`)
    const p = raw.slice('file:'.length)
    if (!path.isAbsolute(p)) throw new RuntimeConfigError(`libsqlUrl 必须使用绝对路径（收到 ${raw}）；相对路径会按 cwd 打开不同库`)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    return { url: raw, memory: false, path: p }
  }
  if (!dataDir) throw new RuntimeConfigError('缺少 dataDir，无法解析 LibSQL 路径')
  const file = path.resolve(dataDir, String(cfg?.libsqlFile || 'mastra/mastra.db'))
  if (!path.isAbsolute(file)) throw new RuntimeConfigError('LibSQL 路径解析失败（不是绝对路径）')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  return { url: `file:${file}`, memory: false, path: file }
}

/**
 * 创建并初始化 storage。返回普通对象，不向调用方暴露 DSN。
 * @returns {Promise<{store:object,driver:string,url?:string,path?:string,schemaName?:string,describe:Function,ping:Function,close:Function}>}
 */
export async function createStorage(cfg, { dataDir, logger: _logger = null } = {}) {
  const driver = String(cfg?.driver || 'libsql')
  if (driver === 'libsql') {
    const target = resolveLibsqlUrl(cfg, { dataDir })
    let store
    try {
      const { LibSQLStore } = await import('@mastra/libsql')
      store = new LibSQLStore({
        id: STORE_ID,
        url: target.url,
        ...(cfg?.maxRetries != null ? { maxRetries: Number(cfg.maxRetries) } : {}),
      })
      await store.init()
    } catch (e) {
      throw new StorageInitError(`LibSQL 初始化失败：${e?.message || e}`, { cause: e })
    }
    let closed = false
    return {
      store,
      driver,
      url: target.url,
      path: target.path,
      describe: () => ({ driver, path: target.path || ':memory:', memory: target.memory }),
      async ping() {
        if (closed) return false
        await store.init()
        return true
      },
      async close() {
        if (closed) return
        closed = true
        await store.close()
      },
    }
  }

  if (driver === 'postgres') {
    const { name, value: connectionString } = requireDsn(cfg, driver)
    let store
    try {
      const { PostgresStore } = await import('@mastra/pg')
      store = new PostgresStore({
        id: STORE_ID,
        connectionString,
        schemaName: String(cfg?.schemaName || 'mastra'),
        ...(cfg?.ssl != null ? { ssl: cfg.ssl } : {}),
        ...(cfg?.max != null ? { max: Number(cfg.max) } : {}),
        ...(cfg?.idleTimeoutMillis != null ? { idleTimeoutMillis: Number(cfg.idleTimeoutMillis) } : {}),
        ...(cfg?.disableInit === true ? { disableInit: true } : {}),
      })
      await store.init()
    } catch (e) {
      throw new StorageInitError(`Postgres 初始化失败：${e?.message || e}`, { cause: e })
    }
    let closed = false
    return {
      store,
      driver,
      schemaName: String(cfg?.schemaName || 'mastra'),
      envName: name,
      describe: () => ({ driver, schemaName: String(cfg?.schemaName || 'mastra'), env: name }),
      async ping() {
        if (closed) return false
        await store.db.one('select 1 as ok')
        return true
      },
      async close() {
        if (closed) return
        closed = true
        await store.close()
      },
    }
  }

  throw new RuntimeConfigError(`不支持的 storage driver：${driver}`)
}

/** 可选 Vector；默认关闭。失败时由调用方关闭 storage。 */
export async function createVector(cfg, { storage = null, logger: _logger = null } = {}) {
  if (!cfg?.enable) return null
  const driver = String(cfg.driver || 'libsql')
  if (driver === 'libsql') {
    let url
    if (storage?.driver === 'libsql' && storage.url) url = storage.url
    else {
      const target = resolveLibsqlUrl({ ...cfg, libsqlUrl: cfg.libsqlUrl || '' }, { dataDir: cfg.dataDir })
      url = target.url
    }
    try {
      const { LibSQLVector } = await import('@mastra/libsql')
      const store = new LibSQLVector({ id: VECTOR_ID, url })
      let closed = false
      return {
        store,
        driver,
        indexName: String(cfg.indexName || 'yz_memory'),
        dimensions: Number(cfg.dimensions) || 1536,
        describe: () => ({ driver, indexName: String(cfg.indexName || 'yz_memory'), dimensions: Number(cfg.dimensions) || 1536 }),
        async close() {
          if (closed) return
          closed = true
          await store.close()
        },
      }
    } catch (e) {
      throw new StorageInitError(`LibSQL Vector 初始化失败：${e?.message || e}`, { cause: e })
    }
  }
  if (driver === 'postgres') {
    const { value: connectionString } = requireDsn(storage || cfg, driver)
    try {
      const { PgVector } = await import('@mastra/pg')
      const store = new PgVector({
        id: VECTOR_ID,
        connectionString,
        schemaName: String(storage?.schemaName || cfg.schemaName || 'mastra'),
      })
      let closed = false
      return {
        store,
        driver,
        indexName: String(cfg.indexName || 'yz_memory'),
        dimensions: Number(cfg.dimensions) || 1536,
        describe: () => ({ driver, indexName: String(cfg.indexName || 'yz_memory'), dimensions: Number(cfg.dimensions) || 1536 }),
        async close() {
          if (closed) return
          closed = true
          await store.close()
        },
      }
    } catch (e) {
      throw new StorageInitError(`PgVector 初始化失败：${e?.message || e}`, { cause: e })
    }
  }
  throw new RuntimeConfigError(`不支持的 vector driver：${driver}`)
}

/** 创建 storage + 可选 vector；vector 失败时回滚 storage。 */
export async function createStorageBundle(cfg, { dataDir, logger = null } = {}) {
  const storage = await createStorage(cfg?.storage || cfg, { dataDir, logger })
  let vector = null
  try {
    vector = await createVector(cfg?.vector || {}, { storage, dataDir, logger })
  } catch (e) {
    try { await storage.close() } catch { /* noop */ }
    throw e
  }
  return {
    storage,
    vector,
    async ping({ timeoutMs = 5_000 } = {}) {
      return withTimeout(storage.ping(), timeoutMs, 'storage.ping')
    },
    async close() {
      try { await vector?.close?.() } catch { /* noop */ }
      try { await storage.close() } catch { /* noop */ }
    },
  }
}
