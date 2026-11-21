/**
 * Runtime 错误归一契约（PR1）。
 *
 * 运行：node model/runtime/test/errors.test.mjs
 */
import {
  RuntimeConfigError, StorageInitError, MastraNotReadyError,
  normalizeRuntimeError, isAbortError, isTimeoutError, withTimeout,
} from '../errors.js'

let passed = 0
let failed = 0
function ok(c, m) {
  if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) }
}
function eq(a, b, m) {
  const same = JSON.stringify(a) === JSON.stringify(b)
  ok(same, `${m}${same ? '' : `  (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`}`)
}

console.log('\n[取消 / 超时]')
{
  const ac = new AbortController()
  ac.abort()
  ok(isAbortError(new Error('anything'), ac.signal), 'signal.aborted 优先')
  const a = normalizeRuntimeError(Object.assign(new Error('aborted'), { name: 'AbortError' }))
  eq([a.code, a.stopReason], ['aborted', 'cancelled'], 'AbortError → aborted/cancelled')
  const t = normalizeRuntimeError(Object.assign(new Error('t'), { name: 'TimeoutError' }))
  eq([t.code, t.stopReason, t.retryable], ['timeout', 'time_budget', true], 'TimeoutError → timeout')
}

console.log('\n[Provider / Tool / Runtime]')
{
  eq(normalizeRuntimeError(new Error('401 Unauthorized: invalid api key')).code, 'provider_auth', '401 → provider_auth')
  eq(normalizeRuntimeError(new Error('429 rate limit')).code, 'provider_unavailable', '429 → provider_unavailable')
  eq(normalizeRuntimeError(new Error('tool execution failed')).code, 'tool_error', 'tool → tool_error')
  eq(normalizeRuntimeError(new Error('boom')).code, 'runtime_error', '未知 → runtime_error')
  const cfg = new RuntimeConfigError('bad')
  eq(normalizeRuntimeError(cfg).code, 'runtime_config_invalid', 'RuntimeConfigError 保留 code')
  const st = new StorageInitError('no db')
  eq(st.retryable, true, 'StorageInitError 可重试')
  const nr = new MastraNotReadyError()
  eq(normalizeRuntimeError(nr).code, 'mastra_not_ready', 'MastraNotReadyError 保留 code')
}

console.log('\n[withTimeout]')
{
  const v = await withTimeout(Promise.resolve(1), 1000, 'ok')
  eq(v, 1, '正常返回')
  let e = null
  try { await withTimeout(new Promise(() => {}), 5, 'slow') } catch (err) { e = err }
  ok(isTimeoutError(e), '超时抛 TimeoutError')
  eq(e.code, 'ETIMEDOUT', '超时 code')
}

console.log(`\n========================================`)
console.log(`通过 ${passed}，失败 ${failed}`)
console.log(`========================================`)
if (failed > 0) process.exitCode = 1
