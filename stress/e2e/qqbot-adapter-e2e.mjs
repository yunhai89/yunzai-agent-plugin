/**
 * 真实 QQ 官方适配器 → 插件 Chat → Mastra → 适配器 send 的离线 E2E。
 *
 * 不连 QQ 网关、不发真实群消息：构造 QQBot 事件，走 `_onMessage` 的真实转换，
 * 再让 `Chat` 处理，最后捕获 `entry.client.send()` 的返回内容。
 *
 * 运行：node --import ./stress/e2e/hooks.mjs stress/e2e/qqbot-adapter-e2e.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), `e2e-qqbot-adapter-${process.pid}-`))
process.env.E2E_TMP = TMP
process.env.E2E_REAL_AGENT = '1'
await import(pathToFileURL(path.join(import.meta.dirname, 'hooks.mjs')).href)

const APP = '1903797111'
const GROUP = '8DCD37C891FF0FDD5ADA545EE4AA06FA'
const USER = '807AC1596B40D96591A5ACBEB3CFFA4D'

// 捕获 QQBot 适配器出站 send
const sent = []
const fakeClient = {
  on() {},
  async start() {},
  stop() {},
  status() { return { state: 'ready' } },
  async send(scene, target, msg, opts = {}) {
    sent.push({ scene, target, msg, opts })
    return { id: `sent-${sent.length}`, message_id: [`sent-${sent.length}`], data: [{}], error: [] }
  },
  async recall() { return true },
}

const cfgMod = await import('./stubs/Config.js')
cfgMod.__setConfig({
  agent: {
    apiKey: 'sk-qqbot-adapter-test', model: 'test-model',
    devLog: { dir: path.join(TMP, 'devlog') },
    qqBot: { enable: true, appId: APP, appSecret: 'offline', accounts: [] },
    mastra: { useProviderModel: true },
    reply: { mode: 'text', quote: false, atSender: false },
  },
})

let passed = 0
let failed = 0
const ok = (c, m) => { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }
const eq = (a, b, m) => { const s = JSON.stringify(a) === JSON.stringify(b); ok(s, `${m}${s ? '' : `（实际 ${JSON.stringify(a)}）`}`) }

// Bot.em 捕获适配器投递的事件（真实 Yunzai 会广播给 Chat）
let delivered = null
globalThis.Bot.bots = globalThis.Bot.bots || {}
globalThis.Bot.em = (name, data) => { if (name === 'message') delivered = data }
globalThis.segment = {
  text: (text) => ({ type: 'text', text }),
  at: (qq) => ({ type: 'at', qq }),
  image: (file) => ({ type: 'image', file }),
}

const { createQQBotAdapter } = await import('../../apps/qqbot.js')
const adapter = createQQBotAdapter({
  clientFactory: () => fakeClient,
  config: { get: () => cfgMod.get() },
  logger: () => {},
})
const entry = { client: fakeClient, account: { appId: APP, name: 'adapter-test' }, connectedAt: Date.now(), bot: null }
adapter.clients.set(APP, entry)
adapter._attachBot(APP, entry)

console.log('\n[QQBot 事件 → Chat → Mastra → send]')
{
  adapter._onMessage(APP, {
    scene: 'group',
    messageId: 'qq-msg-1',
    groupOpenid: GROUP,
    userId: USER,
    username: '蛋黄酥',
    content: `<@!${APP}> 你是谁`,
    atBot: true,
    timestamp: new Date().toISOString(),
    attachments: [],
    mentions: [{ is_you: true }],
  })
  ok(!!delivered, '适配器投递 message 事件')
  eq(delivered?.self_id, APP, 'self_id=AppID')
  eq(delivered?.group_id, `${APP}:${GROUP}`, 'group_id 含 AppID 前缀')
  ok(Array.isArray(delivered?.message) && delivered.message.some((s) => s.type === 'at'), '补了 at 段（触发 @）')

  const { Chat, getRuntime } = await import('../../apps/agent.js')
  const rt = await getRuntime()
  rt.provider.chat = async () => ({
    role: 'assistant', content: '适配器链路回复：我在。', toolCalls: [], finishReason: 'stop', usage: null,
  })
  const bot = new Chat({})
  bot.e = delivered
  await bot._handleAgent('你是谁')

  ok(sent.length > 0, '适配器收到出站 send')
  eq(sent[0]?.scene, 'group', 'send scene=group')
  eq(sent[0]?.target, GROUP, 'send target=群 openid')
  const outgoing = JSON.stringify(sent[0]?.msg)
  ok(outgoing.includes('适配器链路回复'), '捕获到插件最终回复内容')
  ok(typeof sent[0]?.opts?.msgId === 'string', '被动回复 msgId 已传递')
  await rt.scope.close('adapter-e2e')
}

fs.rmSync(TMP, { recursive: true, force: true })
console.log(`\n========================================`)
console.log(`通过 ${passed}，失败 ${failed}`)
console.log(`========================================`)
if (failed > 0) process.exitCode = 1
