/**
 * S6：Mastra 灰度路径压缩/ledger/cacheEpoch 仍由 SessionStore 保存。
 *
 * 运行：node model/runtime/test/chat-runner-compaction.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createMastraChatRunner } from '../chat-runner.js'
import { ToolRegistry } from '../../agent/tools/registry.js'
import { createPolicy } from '../../agent/policy.js'
import { CompactionArchive } from '../../agent/compact/archive.js'
import { estimateTokensApprox } from '../../agent/token-estimate.js'

let passed = 0
let failed = 0
const ok = (c, m) => { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }
const eq = (a, b, m) => { const s = JSON.stringify(a) === JSON.stringify(b); ok(s, `${m}${s ? '' : `（实际 ${JSON.stringify(a)}）`}`) }

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'yz-chat-compact-'))
const cfg = {
  apiKey: 'k', model: 'm', protocol: 'openai', preset: 'openai', baseURL: 'https://example.test/v1',
  llmProviders: [{ id: 'p', protocol: 'openai', preset: 'openai', baseURL: 'https://example.test/v1', apiKey: 'k' }],
  llmModels: [{ id: 'm', providerId: 'p', model: 'm' }], providerId: 'p', modelId: 'm',
}
const history = Array.from({ length: 12 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `历史 ${i} ` + 'x'.repeat(120) }))
const saved = []
const session = {
  key: (g, u) => `k:${u}`,
  async get() { return history },
  async getConversation() { return history },
  async getConversationState() { return { cacheEpoch: 0 } },
  async append() {},
  async appendConversation(u, g, c, msgs, extra) { saved.push({ mode: 'append', msgs, extra }) },
  async setConversation(u, g, c, msgs, extra) { saved.push({ mode: 'set', msgs, extra }) },
}
const tools = new ToolRegistry()
const archive = new CompactionArchive({ dir: path.join(TMP, 'archive') })
const agentInst = {
  _inputText: (i) => String(i), _assembleSystem: () => ({ system: 'SYS' }), _memorySnapshot: () => '',
  _screenUntrusted: (t) => t, session, tools, maxTurns: 4, temperature: 0, maxTokens: 100, thinking: null,
  policy: createPolicy(), confirm: null, taskStore: null, guard: null, untrustedGuard: true, masterSkipConfirm: false,
  contextWindow: 100, contextHighRatio: 0.8, contextLowRatio: 0.45, contextKeepRecent: 2, cacheEpoch: 0,
  compactArchive: archive, estimateTokens: estimateTokensApprox, model: 'm',
  _resolveContextForRun() {},
  _estimateHistory(system) { return estimateTokensApprox(String(system || '')) + estimateTokensApprox(JSON.stringify(history)) },
  _estimateToolsTokens() { return 0 },
}
const fetchImpl = async () => new Response(JSON.stringify({
  choices: [{ index: 0, message: { role: 'assistant', content: '压缩后回复' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
}), { status: 200, headers: { 'content-type': 'application/json' } })

const runner = createMastraChatRunner({ cfg, deps: { tools, confirm: null }, fetchImpl })
const res = await runner.runChat('新问题', { agentInst, ctx: { userId: 'u', groupId: 'g', conversationId: 1, scopeUserId: 'u' }, taskId: 't1' })
eq(res.content, '压缩后回复', '最终回复')
eq(saved.length, 1, '写回一次')
eq(saved[0].mode, 'set', '压缩后全量覆写，不用 append')
ok(saved[0].msgs.length < history.length + 2, `压缩后消息减少（${history.length} → ${saved[0].msgs.length}）`)
eq(saved[0].extra.cacheEpoch, 1, 'cacheEpoch 递增')
ok(!!saved[0].extra.compactLedger, 'compactLedger 写回')
ok(saved[0].msgs.some((m) => String(m.content || '').includes('压缩') || String(m.content || '').includes('archive')), '窗口内保留压缩台账消息')
ok(fs.readdirSync(path.join(TMP, 'archive')).length > 0, '归档已落盘')

fs.rmSync(TMP, { recursive: true, force: true })
console.log(`\n========================================`)
console.log(`通过 ${passed}，失败 ${failed}`)
console.log(`========================================`)
if (failed > 0) process.exitCode = 1
