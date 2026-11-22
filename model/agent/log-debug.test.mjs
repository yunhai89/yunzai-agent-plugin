/**
 * Web 调试日志：debug=true 时必须绕过 Yunzai info 级别过滤。
 * 运行：node model/agent/log-debug.test.mjs
 */
import Log from '../../utils/Log.js'

let passed = 0, failed = 0
const ok = (c, m) => { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }
const eq = (a, b, m) => { const s = JSON.stringify(a) === JSON.stringify(b); ok(s, `${m}${s ? '' : `（实际 ${JSON.stringify(a)}）`}`) }

const calls = []
globalThis.Bot = { makeLog: (level, msg, tag) => calls.push({ level, msg, tag }) }

console.log('\n[debug off：保持原级别]')
Log.setDebug(false)
Log.debug('off-probe')
eq(calls.at(-1)?.level, 'debug', 'debug off 时原样交给 Bot.makeLog')

console.log('\n[debug on：info 通道 + [DEBUG] 前缀]')
Log.setDebug(true)
Log.debug('on-probe')
eq(calls.at(-1)?.level, 'info', 'debug on 时改走 info 通道')
ok(String(JSON.stringify(calls.at(-1)?.msg)).includes('[DEBUG]'), '带 [DEBUG] 前缀')
Log.setDebug(false)

console.log(`\n========================================`)
console.log(`通过 ${passed}，失败 ${failed}`)
console.log(`========================================`)
if (failed > 0) process.exitCode = 1
