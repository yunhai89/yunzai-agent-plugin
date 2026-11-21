/**
 * S7：scripts/migrate-mastra.mjs CLI 端到端（dry-run/apply/verify/rollback）。
 *
 * 运行：node model/runtime/test/migrate-cli.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

let passed = 0, failed = 0
const ok = (c, m) => { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }
const eq = (a, b, m) => { const s = JSON.stringify(a) === JSON.stringify(b); ok(s, `${m}${s ? '' : `（实际 ${JSON.stringify(a)}）`}`) }

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'yz-migrate-cli-'))
const source = path.join(TMP, 'source.json')
const db = path.join(TMP, 'migrate.db')
const cp = path.join(TMP, 'checkpoint.json')
fs.writeFileSync(source, JSON.stringify({
  version: 1,
  conversations: [{
    scopeUserId: 'u1', scopeGroupId: 'g1', conversationId: '1', title: 'CLI', createdAt: 1000, updatedAt: 2000,
    cacheEpoch: 2,
    messages: [
      { role: 'user', content: 'CLI-USER' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'w', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c1', name: 'w', content: '{"ok":true}' },
      { role: 'assistant', content: 'CLI-REPLY' },
    ],
  }],
}))

function run(args) {
  const r = spawnSync(process.execPath, ['scripts/migrate-mastra.mjs', ...args], { cwd: ROOT, encoding: 'utf8', timeout: 120000 })
  let json = null
  try { json = JSON.parse(r.stdout) } catch { /* output may have human lines */ }
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, json }
}

console.log('\n[dry-run / apply / verify / rollback]')
{
  const dry = run(['--source-json', source, '--dry-run', '--json'])
  eq(dry.code, 0, 'dry-run 退出 0')
  eq(dry.json?.ok, true, 'dry-run ok')
  eq(dry.json?.stats?.messages, 4, 'dry-run 4 条')

  const apply = run(['--source-json', source, '--apply', '--yes', '--json', '--libsql-url', `file:${db}`, '--checkpoint', cp])
  eq(apply.code, 0, 'apply 退出 0')
  eq(apply.json?.applied, 1, 'apply 1 个 thread')

  const verify = run(['--source-json', source, '--verify', '--json', '--libsql-url', `file:${db}`])
  eq(verify.code, 0, 'verify 退出 0')
  eq([verify.json?.ok, verify.json?.checkedMessages], [true, 4], 'verify 通过 4 条')

  const rb = run(['--rollback', '--yes', '--json', '--libsql-url', `file:${db}`, '--checkpoint', cp])
  eq(rb.code, 0, 'rollback 退出 0')
  eq(rb.json?.deletedThreads, 1, 'rollback 删除 1 thread')
}

console.log('\n[安全门：apply/rollback 缺少 --yes]')
{
  const a = run(['--source-json', source, '--apply', '--json', '--libsql-url', `file:${db}`])
  eq(a.code, 2, 'apply 无 --yes 拒绝')
  const r = run(['--rollback', '--json', '--libsql-url', `file:${db}`, '--checkpoint', cp])
  eq(r.code, 2, 'rollback 无 --yes 拒绝')
}

fs.rmSync(TMP, { recursive: true, force: true })
console.log(`\n========================================`)
console.log(`通过 ${passed}，失败 ${failed}`)
console.log(`========================================`)
if (failed > 0) process.exitCode = 1
