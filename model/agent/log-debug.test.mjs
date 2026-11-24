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

console.log('\n[多参数日志：单行可读，不再打印数组结构]')
Log.debug('[tool]', 'tool call', 'web_search', 'args=', { queries: ['a', 'b'], max_results: 8 })
const msg = String(calls.at(-1)?.msg)
ok(typeof msg === 'string', 'msg 是字符串（不是数组）')
ok(msg.includes('[tool] tool call web_search args= {"queries":["a","b"],"max_results":8}'), '参数按顺序拼成可读一行')
ok(!msg.includes('[length]') && !msg.includes("'[tool]'"), '无 [length]/数组引号噪声')
Log.debug('[tool]', 'tool done', 'web_search', new Error('boom'))
ok(/Error: boom/.test(String(calls.at(-1)?.msg)), 'Error 保留 message')
Log.setDebug(false)

console.log(`\n========================================`)
console.log(`通过 ${passed}，失败 ${failed}`)
console.log(`========================================`)
if (failed > 0) process.exitCode = 1
