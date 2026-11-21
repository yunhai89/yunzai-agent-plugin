#!/usr/bin/env node
/**
 * ModelFactory 真实 Provider 冒烟（PR2）。
 *
 * 读取当前 `config/config.yaml` 的主模型，分别用：
 *   1) AI SDK ModelFactory + generateText
 *   2) legacy createProvider + chat
 * 发同一句短请求，打印文本/usage/finish，验证 AI SDK 能真实连通。
 *
 * 不打印 API Key/DSN；不写任何配置。
 * 运行：node scripts/mastra-model-smoke.mjs
 */
import Config from '../utils/Config.js'
import { createModelFactory } from '../model/runtime/model-factory.js'
import { resolveProxyFetch } from '../model/runtime/proxy-fetch.js'
import { createProvider } from '../model/agent/provider/index.js'
import { generateText } from 'ai'

const cfg = Config.get().agent || {}
const prompt = '只回复四个字：模型可用'
let failed = 0
const ok = (c, m) => { console.log(c ? '  ✓' : '  ✗ FAIL', m); if (!c) failed++ }

console.log(`\n[主模型] ${cfg.providerId || '(flat)'} / ${cfg.modelId || '(flat)'} · ${cfg.protocol || 'openai'} / ${cfg.preset || '-'} / ${cfg.model}`)
const fetchImpl = await resolveProxyFetch(cfg.proxy, { logger: (level, ...args) => console.log(`  · [${level}]`, ...args) })
const factory = createModelFactory({ cfg, fetchImpl, sessionId: 'yz-mastra-smoke' })
const main = factory.main()
if (!main) {
  console.error('  ✗ 未配置可用的主模型（providerId/modelId 或扁平 apiKey）')
  process.exit(1)
}
console.log('  · describe', JSON.stringify(factory.describe()))
if (main.legacyOnly) {
  console.log(`  ⊘ 主模型是 legacy-only（${main.reason}），跳过 AI SDK 调用`)
  process.exit(0)
}

console.log('\n[1] AI SDK generateText')
let aiText = ''
let aiUsage = null
try {
  const t0 = Date.now()
  const r = await generateText({ model: main.model, prompt, maxOutputTokens: 64, temperature: 0 })
  aiText = String(r.text || '').trim()
  aiUsage = r.usage
  ok(aiText.length > 0, `AI SDK 返回非空：${JSON.stringify(aiText).slice(0, 60)}（${Date.now() - t0}ms）`)
  ok(r.finishReason === 'stop', `finishReason=${r.finishReason}`)
  ok(Number(aiUsage?.totalTokens) > 0, `usage.totalTokens=${aiUsage?.totalTokens}`)
  console.log('  · usage', JSON.stringify(aiUsage))
} catch (e) {
  console.error('  ✗ AI SDK 调用失败：', e?.message || e)
  failed++
}

console.log('\n[2] legacy Provider 对照')
try {
  const { presets: openaiPresets } = await import('../model/openai/presets.js')
  const { presets: anthropicPresets } = await import('../model/anthropic/presets.js')
  const preset = cfg.protocol === 'anthropic' ? anthropicPresets[cfg.preset] : openaiPresets[cfg.preset]
  const p = createProvider({
    protocol: cfg.protocol || 'openai', ...(preset || {}),
    ...(cfg.baseURL ? { baseURL: cfg.baseURL } : {}),
    apiKey: cfg.apiKey, model: cfg.model,
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  })
  const t0 = Date.now()
  const r = await p.chat({ model: cfg.model, messages: [{ role: 'user', content: prompt }], max_tokens: 64, temperature: 0, sessionId: 'yz-mastra-smoke-legacy' })
  const text = String(r?.content || '').trim()
  ok(text.length > 0, `legacy 返回非空：${JSON.stringify(text).slice(0, 60)}（${Date.now() - t0}ms）`)
  console.log('  · legacy usage', JSON.stringify(r?.usage || null))
} catch (e) {
  console.error('  ✗ legacy 调用失败：', e?.message || e)
  failed++
}

console.log(`\n${failed ? `失败 ${failed}` : '通过'}`)
if (failed) process.exitCode = 1
