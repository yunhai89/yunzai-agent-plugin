/**
 * Runtime/Mastra 配置 schema（PR1）。
 *
 * 原则：
 *  - 默认值只在 config/default_config/config.yaml，本文件是**校验与修复**，不是第二真源；
 *  - 旧配置没有 runtime/mastra 键 → 默认 legacy，行为不变；
 *  - 非法值 fail-closed 到安全默认（engine=legacy、driver=libsql、memory=sessionstore），
 *    并返回 repairs 供 Config 日志/测试；
 *  - 不读取 env、不解析 DSN；DSN 只在 storage-factory 里按 env 名读取。
 */
import { z } from 'zod'

export const RUNTIME_ENGINES = ['legacy', 'mastra']
export const STORAGE_DRIVERS = ['libsql', 'postgres']
export const MEMORY_MODES = ['sessionstore', 'mastra']

export const DEFAULT_RUNTIME_CONFIG = Object.freeze({
  engine: 'mastra',
  fallbackToLegacy: false,
  gray: Object.freeze({ users: Object.freeze([]), groups: Object.freeze([]), percent: 0 }),
})

export const DEFAULT_MASTRA_CONFIG = Object.freeze({
  storage: Object.freeze({
    driver: 'libsql',
    libsqlFile: 'mastra/mastra.db',
    libsqlUrl: '',
    connectionStringEnv: 'MASTRA_DATABASE_URL',
    schemaName: 'mastra',
    ssl: false,
    max: 10,
    idleTimeoutMillis: 30_000,
    disableInit: false,
  }),
  vector: Object.freeze({
    enable: false,
    driver: 'libsql',
    indexName: 'yz_memory',
    dimensions: 1536,
  }),
  memory: Object.freeze({
    mode: 'mastra',
    semanticRecall: false,
    onDemandMigration: true,
  }),
  identity: Object.freeze({
    botId: '',
    adapter: 'onebot',
  }),
  approval: Object.freeze({
    mode: 'legacy',
    timeoutMs: 300_000,
  }),
  useProviderModel: false,
  closeTimeoutMs: 15_000,
})

const clone = (v) => JSON.parse(JSON.stringify(v))

const engine = z.enum(RUNTIME_ENGINES)
const driver = z.enum(STORAGE_DRIVERS)
const schemaName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
const indexName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
const percent = z.number().min(0).max(100)

const runtimeStrict = z.object({
  engine: engine.default('mastra'),
  fallbackToLegacy: z.boolean().default(false),
  gray: z.object({
    users: z.array(z.string()).default([]),
    groups: z.array(z.string()).default([]),
    percent: percent.default(0),
  }).default({}),
}).passthrough()

const storageStrict = z.object({
  driver: driver.default('libsql'),
  libsqlFile: z.string().min(1).default('mastra/mastra.db'),
  libsqlUrl: z.string().default(''),
  connectionStringEnv: z.string().min(1).default('MASTRA_DATABASE_URL'),
  schemaName: schemaName.default('mastra'),
  ssl: z.union([z.boolean(), z.record(z.any())]).default(false),
  max: z.number().int().min(1).max(100).default(10),
  idleTimeoutMillis: z.number().int().min(0).default(30_000),
  disableInit: z.boolean().default(false),
}).passthrough()

const vectorStrict = z.object({
  enable: z.boolean().default(false),
  driver: driver.default('libsql'),
  indexName: indexName.default('yz_memory'),
  dimensions: z.number().int().min(1).max(8192).default(1536),
}).passthrough()

const memoryStrict = z.object({
  mode: z.enum(MEMORY_MODES).default('mastra'),
  semanticRecall: z.boolean().default(false),
  onDemandMigration: z.boolean().default(true),
}).passthrough()

const identityStrict = z.object({
  botId: z.string().max(128).default(''),
  adapter: z.enum(['onebot', 'qqbot', 'qqguild']).default('onebot'),
}).passthrough()

const approvalStrict = z.object({
  mode: z.enum(['legacy', 'bridge']).default('legacy'),
  timeoutMs: z.number().int().min(1_000).max(3_600_000).default(300_000),
}).passthrough()

const mastraStrict = z.object({
  storage: storageStrict.default({}),
  vector: vectorStrict.default({}),
  memory: memoryStrict.default({}),
  identity: identityStrict.default({}),
  approval: approvalStrict.default({}),
  useProviderModel: z.boolean().default(false),
  closeTimeoutMs: z.number().int().min(1_000).max(300_000).default(15_000),
}).passthrough()

const strictSchema = z.object({ runtime: runtimeStrict.default({}), mastra: mastraStrict.default({}) })

// 宽松版：每个字段/对象在非法时回退安全默认，保证启动不被坏配置卡死。
const runtimeLenient = z.object({
  engine: engine.catch('mastra'),
  fallbackToLegacy: z.boolean().catch(false),
  gray: z.object({
    users: z.array(z.string()).catch([]),
    groups: z.array(z.string()).catch([]),
    percent: percent.catch(0),
  }).passthrough().catch(clone(DEFAULT_RUNTIME_CONFIG.gray)),
}).passthrough().catch(clone(DEFAULT_RUNTIME_CONFIG))

const storageLenient = z.object({
  driver: driver.catch('libsql'),
  libsqlFile: z.string().min(1).catch('mastra/mastra.db'),
  libsqlUrl: z.string().catch(''),
  connectionStringEnv: z.string().min(1).catch('MASTRA_DATABASE_URL'),
  schemaName: schemaName.catch('mastra'),
  ssl: z.union([z.boolean(), z.record(z.any())]).catch(false),
  max: z.number().int().min(1).max(100).catch(10),
  idleTimeoutMillis: z.number().int().min(0).catch(30_000),
  disableInit: z.boolean().catch(false),
}).passthrough().catch(clone(DEFAULT_MASTRA_CONFIG.storage))

const vectorLenient = z.object({
  enable: z.boolean().catch(false),
  driver: driver.catch('libsql'),
  indexName: indexName.catch('yz_memory'),
  dimensions: z.number().int().min(1).max(8192).catch(1536),
}).passthrough().catch(clone(DEFAULT_MASTRA_CONFIG.vector))

const memoryLenient = z.object({
  mode: z.enum(MEMORY_MODES).catch('mastra'),
  semanticRecall: z.boolean().catch(false),
  onDemandMigration: z.boolean().catch(true),
}).passthrough().catch(clone(DEFAULT_MASTRA_CONFIG.memory))

const identityLenient = z.object({
  botId: z.string().max(128).catch(''),
  adapter: z.enum(['onebot', 'qqbot', 'qqguild']).catch('onebot'),
}).passthrough().catch(clone(DEFAULT_MASTRA_CONFIG.identity))

const approvalLenient = z.object({
  mode: z.enum(['legacy', 'bridge']).catch('legacy'),
  timeoutMs: z.number().int().min(1_000).max(3_600_000).catch(300_000),
}).passthrough().catch(clone(DEFAULT_MASTRA_CONFIG.approval))

const mastraLenient = z.object({
  storage: storageLenient,
  vector: vectorLenient,
  memory: memoryLenient,
  identity: identityLenient,
  approval: approvalLenient,
  useProviderModel: z.boolean().catch(false),
  closeTimeoutMs: z.number().int().min(1_000).max(300_000).catch(15_000),
}).passthrough().catch(clone(DEFAULT_MASTRA_CONFIG))

const lenientSchema = z.object({
  runtime: runtimeLenient,
  mastra: mastraLenient,
})

function issuePath(issue) {
  return Array.isArray(issue?.path) ? issue.path.join('.') : ''
}

/**
 * 解析但不修改入参。
 * @returns {{value:{runtime:object,mastra:object}, repairs:Array<{path:string,message:string}>}}
 */
export function parseRuntimeConfig(agent = {}) {
  const raw = {
    runtime: agent?.runtime ?? {},
    mastra: agent?.mastra ?? {},
  }
  const strict = strictSchema.safeParse(raw)
  const repairs = strict.success
    ? []
    : (strict.error.issues || []).map((i) => ({ path: issuePath(i), message: i.message }))
  return { value: lenientSchema.parse(raw), repairs }
}

/** 兼容别名：从整份配置或 agent 块解析 */
export function resolveRuntimeConfig(agent = {}) {
  return parseRuntimeConfig(agent).value
}

/**
 * 原地归一 agent.runtime/agent.mastra；返回是否发生需要落盘的变化。
 * @param {object} agent 配置的 agent 块（会被修改）
 * @param {{logger?:{warn?:Function}}} [opts]
 */
export function normalizeAgentRuntimeConfig(agent, { logger = null } = {}) {
  if (!agent || typeof agent !== 'object' || Array.isArray(agent)) return false
  const before = JSON.stringify({ runtime: agent.runtime, mastra: agent.mastra })
  const { value, repairs } = parseRuntimeConfig(agent)
  agent.runtime = value.runtime
  agent.mastra = value.mastra
  if (repairs.length && typeof logger?.warn === 'function') {
    for (const r of repairs.slice(0, 8)) {
      logger.warn(`[config] agent.${r.path || 'runtime'} 非法（${r.message}），已回退安全默认`)
    }
  }
  return JSON.stringify({ runtime: agent.runtime, mastra: agent.mastra }) !== before
}

/** 健康/日志用摘要：绝不包含 DSN、apiKey、密码 */
export function describeRuntimeConfig(value) {
  const v = value || resolveRuntimeConfig({})
  const storage = v.mastra.storage
  return {
    engine: v.runtime.engine,
    fallbackToLegacy: v.runtime.fallbackToLegacy,
    gray: { users: v.runtime.gray.users.length, groups: v.runtime.gray.groups.length, percent: v.runtime.gray.percent },
    storage: {
      driver: storage.driver,
      ...(storage.driver === 'libsql' ? { file: storage.libsqlFile || storage.libsqlUrl || '' } : { schemaName: storage.schemaName }),
    },
    vector: { enable: v.mastra.vector.enable, driver: v.mastra.vector.driver, indexName: v.mastra.vector.indexName, dimensions: v.mastra.vector.dimensions },
    memory: {
      mode: v.mastra.memory.mode,
      semanticRecall: v.mastra.memory.semanticRecall,
      onDemandMigration: v.mastra.memory.onDemandMigration,
    },
    identity: { botId: v.mastra.identity.botId ? '***' : '', adapter: v.mastra.identity.adapter },
    approval: { mode: v.mastra.approval.mode, timeoutMs: v.mastra.approval.timeoutMs },
    closeTimeoutMs: v.mastra.closeTimeoutMs,
  }
}
