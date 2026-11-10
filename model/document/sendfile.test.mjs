/**
 * send_file 安全门禁离线自检：
 *  - 远程 URL 必须过 SSRF 门禁（环回/内网/元数据地址拒绝，协议端不得代取）；
 *  - 本地 file:// 路径仍受 data/ + data/temp/ 目录约束（防借模型外发宿主敏感文件）。
 * 运行：node model/document/sendfile.test.mjs
 */
import { sendFileTool } from './sendfile.js'

let passed = 0, failed = 0
function ok(c, m) { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }

console.log('\n[send_file 远程 URL SSRF 门禁]')
const loop = await sendFileTool.execute({ path: 'http://127.0.0.1:6098/api/config' }, {})
ok(loop?.code === 'ssrf_blocked', '环回地址拒绝（不交给协议端代取）')
const meta = await sendFileTool.execute({ path: 'http://169.254.169.254/latest/meta-data/' }, {})
ok(meta?.code === 'ssrf_blocked', '云元数据地址拒绝')

console.log('\n[send_file 本地路径门禁]')
const passwd = await sendFileTool.execute({ path: 'file:///etc/passwd' }, {})
ok(typeof passwd?.error === 'string' && passwd.error.includes('拒绝发送'), 'file:// 越界路径拒绝')

console.log('\n========================================')
console.log(`通过 ${passed}，失败 ${failed}`)
console.log('========================================')
if (failed > 0) process.exitCode = 1
