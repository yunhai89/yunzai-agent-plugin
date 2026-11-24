/**
 * GET /api/sessions?sid= 回归：Web 会话回放只认短会话 ID，不暴露官方长 scope。
 *
 * 运行：node --import ./stress/e2e/hooks.mjs model/web/api.sessions.test.mjs
 */
import express from 'express'
import { buildApiRouter } from './api.js'
import { errorMiddleware } from './response.js'
import { SessionStore } from '../agent/session.js'
import { memoryKv } from '../agent/store/kv.js'
import { shortConversationId } from '../agent/conversation-id.js'

let passed = 0, failed = 0
const ok = (c, m) => { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }
const eq = (a, b, m) => { const s = JSON.stringify(a) === JSON.stringify(b); ok(s, `${m}${s ? '' : `（实际 ${JSON.stringify(a)}，期望 ${JSON.stringify(b)}）`}`) }

const session = new SessionStore({ kv: memoryKv() })
const app = express()
app.use(express.json())
app.use('/api', buildApiRouter({ runtimeProvider: async () => ({ session }) }))
app.use(errorMiddleware)
const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)) })
const base = `http://127.0.0.1:${server.address().port}`
const get = async (p) => {
  const r = await fetch(base + p)
  return { status: r.status, body: await r.json() }
}

try {
  const user = '1903797111:8DCD37C891FF0FDD5ADA545EE4AA06FA'
  const conv = await session.createConversation(user, null, '短 ID 回放')
  await session.appendConversation(user, null, conv.id, [
    { role: 'user', content: '你好' },
    { role: 'assistant', content: '在的' },
  ])
  const shortId = shortConversationId({ scopeUserId: user, scopeGroupId: '', conversationId: conv.id })

  console.log('[短 ID 查询]')
  {
    const r = await get(`/api/sessions?sid=${shortId}`)
    eq([r.status, r.body.code], [200, 0], '短 ID 可读')
    eq(r.body.data.sid, shortId, '返回短会话 ID')
    eq(r.body.data.id, String(conv.id), '保留内部 id 供兼容')
    eq(r.body.data.messages.length, 2, '返回完整消息')
    ok(!JSON.stringify(r.body.data).includes(user), '响应不暴露官方长 scope')
  }

  console.log('\n[旧参数兼容]')
  {
    const r = await get(`/api/sessions?convId=${encodeURIComponent(conv.id)}&userId=${encodeURIComponent(user)}`)
    eq([r.status, r.body.code], [200, 0], '旧 convId/userId 仍可读')
    eq(r.body.data.sid, shortId, '旧参数响应也返回短 ID')
  }

  console.log('\n[未知短 ID]')
  {
    const r = await get('/api/sessions?sid=c00000000')
    eq(r.body.code, 4004, '未知短 ID → 404/4004')
  }
} finally {
  server.close()
}

console.log('\n========================================')
console.log(`通过 ${passed}，失败 ${failed}`)
console.log('========================================')
if (failed > 0) process.exitCode = 1
