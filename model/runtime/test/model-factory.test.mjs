/**
 * ModelFactory 契约（PR2）。
 *
 * 覆盖：
 *  - 现有 providerId/modelId → AI SDK model（含 utility/vision/fallback）；
 *  - 19 个可迁移 preset 的 URL/header/body（openai 12 + anthropic 7）；
 *  - thinking providerOptions（OpenAI effort / Anthropic budget / 其它 legacy-only）；
 *  - Gemini/Azure legacy-only；
 *  - fetch 透传（代理入口）与 fallback 重试语义；
 *  - modelSettings / Anthropic max_tokens > thinking budget。
 *
 * 运行：node model/runtime/test/model-factory.test.mjs
 */
import {
  ModelFactory, createModelFactory, createLanguageModel, modelSupport,
  resolveMainRef, resolveUtilityRef, resolveVisionRef, resolveFallbackRefs,
  resolveThinkingOptions, resolveModelSettings, generateWithFallback,
} from '../model-factory.js'
import { createProxyFetch, resolveProxyFetch } from '../proxy-fetch.js'
import { presets as openaiPresets } from '../../openai/presets.js'
import { presets as anthropicPresets } from '../../anthropic/presets.js'
import { scriptedAiSdkModel } from './fixtures/scripted-model.js'

let passed = 0
let failed = 0
function ok(c, m) {
  if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) }
}
function eq(a, b, m) {
  const same = JSON.stringify(a) === JSON.stringify(b)
  ok(same, `${m}${same ? '' : `  (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`}`)
}

function openAIResponse(text = 'ok', usage = { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 }) {
  return new Response(JSON.stringify({
    id: 'chatcmpl-test', object: 'chat.completion', created: 1, model: 'test-model',
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage,
  }), { status: 200, headers: { 'content-type': 'application/json' } })
}
function anthropicResponse(text = 'ok') {
  return new Response(JSON.stringify({
    id: 'msg_test', type: 'message', role: 'assistant', model: 'test-model',
    content: [{ type: 'text', text }], stop_reason: 'end_turn',
    usage: { input_tokens: 10, output_tokens: 2 },
  }), { status: 200, headers: { 'content-type': 'application/json' } })
}

function captureFetch(responseFactory) {
  const calls = []
  return {
    calls,
    fetch: async (url, opts = {}) => {
      calls.push({ url: String(url), headers: opts.headers || {}, body: opts.body ? JSON.parse(opts.body) : null })
      return responseFactory()
    },
  }
}

const PROMPT = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]

console.log('\n[配置解析：主 / utility / vision / fallback]')
{
  const cfg = {
    providerId: 'p1', modelId: 'm1',
    llmProviders: [
      { id: 'p1', name: 'openai', protocol: 'openai', preset: 'openai', baseURL: 'https://api.openai.com/v1', apiKey: 'k1' },
      { id: 'p2', name: 'deepseek', protocol: 'openai', preset: 'deepseek', baseURL: 'https://api.deepseek.com', apiKey: 'k2' },
    ],
    llmModels: [
      { id: 'm1', name: 'gpt', providerId: 'p1', model: 'gpt-5', temperature: 0.3, maxTokens: 1234 },
      { id: 'm2', name: 'ds', providerId: 'p2', model: 'deepseek-chat' },
    ],
    utilityModel: 'm2',
    vision: { model: 'gpt-5' },
    fallbackModels: [{ model: 'deepseek-chat', baseURL: 'https://api.deepseek.com', apiKey: 'k2', protocol: 'openai', preset: 'deepseek' }],
  }
  const main = resolveMainRef(cfg)
  eq([main.providerId, main.model, main.temperature, main.maxTokens], ['p1', 'gpt-5', 0.3, 1234], '主模型引用 + 条目覆盖')
  const util = resolveUtilityRef(cfg, main)
  eq([util.providerId, util.model], ['p2', 'deepseek-chat'], 'utility 条目 id')
  const vision = resolveVisionRef(cfg, main)
  eq(vision.model, 'gpt-5', 'vision 复用注册表模型')
  const fb = resolveFallbackRefs(cfg, main)
  eq(fb.length, 1, 'fallback 数量')
  eq([fb[0].protocol, fb[0].preset, fb[0].apiKey], ['openai', 'deepseek', 'k2'], 'fallback 独立连接')
  const flat = resolveMainRef({ apiKey: 'k', model: 'm', protocol: 'openai', preset: 'deepseek', baseURL: 'https://x' })
  eq([flat.source, flat.model], ['flat', 'm'], '旧扁平字段兼容')
  eq(resolveMainRef({}), null, '无 apiKey 未配置')
}

console.log('\n[可迁移 preset 矩阵：URL / body / session header]')
{
  let supported = 0
  for (const [name, preset] of Object.entries(openaiPresets)) {
    if (name === 'gemini' || name === 'azure') continue
    const baseURL = preset.baseURL || 'https://example.test/v1'
    const cap = captureFetch(() => openAIResponse())
    const m = createLanguageModel({
      protocol: 'openai', preset: name, baseURL, apiKey: 'sk-test', model: 'test-model',
    }, { fetchImpl: cap.fetch, sessionId: 'sess-1' })
    const res = await m.doGenerate({ prompt: PROMPT, temperature: 0.2, maxOutputTokens: 64 })
    const call = cap.calls[0]
    ok(call.url.startsWith(baseURL.replace(/\/+$/, '') + '/'), `${name}: URL 基于 baseURL`)
    ok(call.body?.model === 'test-model', `${name}: body.model`)
    ok(call.body?.messages?.[0]?.content === 'hi', `${name}: body.messages`)
    ok(res.content?.[0]?.text === 'ok', `${name}: 响应文本解析`)
    if (preset.sessionHeader) {
      ok(call.headers[preset.sessionHeader] === 'sess-1', `${name}: ${preset.sessionHeader}`)
    }
    if (preset.headers?.['User-Agent']) {
      ok(String(call.headers['user-agent'] || '').includes('yunzai-agent-plugin'), `${name}: 自定义 UA`)
    }
    supported++
  }
  for (const [name, preset] of Object.entries(anthropicPresets)) {
    const baseURL = preset.baseURL || 'https://example.test/v1'
    const cap = captureFetch(() => anthropicResponse())
    const m = createLanguageModel({
      protocol: 'anthropic', preset: name, baseURL, apiKey: 'sk-ant-test', model: 'test-model',
    }, { fetchImpl: cap.fetch, sessionId: 'sess-1' })
    const res = await m.doGenerate({ prompt: PROMPT })
    const call = cap.calls[0]
    ok(call.url.endsWith('/messages'), `${name}: /messages`)
    eq(call.body?.model, 'test-model', `${name}: body.model`)
    ok(call.headers['x-api-key'] === 'sk-ant-test', `${name}: x-api-key`)
    ok(!!call.headers['anthropic-version'], `${name}: anthropic-version`)
    ok(res.content?.[0]?.text === 'ok', `${name}: 响应文本解析`)
    if (preset.sessionHeader) ok(call.headers[preset.sessionHeader] === 'sess-1', `${name}: session header`)
    supported++
  }
  eq(supported, 19, '19 个可迁移 preset（12 OpenAI + 7 Anthropic）')
}

console.log('\n[thinking 映射]')
{
  const oa = { protocol: 'openai', preset: 'openai', model: 'gpt-5' }
  const high = resolveThinkingOptions({ ref: oa, depth: 'high', budget: 12000 })
  eq(high.providerOptions, { openai: { reasoningEffort: 'high' } }, 'OpenAI high → reasoningEffort')
  eq([high.supported, high.legacyOnly], [true, false], 'OpenAI 支持')
  const medium = resolveThinkingOptions({ ref: oa, depth: 'medium', budget: 8000 })
  eq(medium.providerOptions.openai.reasoningEffort, 'medium', 'OpenAI medium')
  const off = resolveThinkingOptions({ ref: oa, thinking: { type: 'disabled' } })
  eq([off.providerOptions, off.supported], [{}, true], '关闭思考不报 legacy-only')

  const an = { protocol: 'anthropic', preset: 'anthropic', model: 'claude-sonnet-4-5' }
  const at = resolveThinkingOptions({ ref: an, depth: 'high', budget: 12000 })
  eq(at.providerOptions, { anthropic: { thinking: { type: 'enabled', budgetTokens: 12000 } } }, 'Anthropic → budgetTokens')
  eq([at.supported, at.legacyOnly], [true, false], 'Anthropic 支持')

  const ds = { protocol: 'openai', preset: 'deepseek', model: 'deepseek-chat' }
  const dt = resolveThinkingOptions({ ref: ds, depth: 'high', budget: 8000 })
  eq([dt.providerOptions, dt.supported, dt.legacyOnly], [{}, false, true], 'DeepSeek 自定义 thinking → legacy-only')
  ok(dt.reason.includes('unsupported'), '记录 legacy-only 原因')

  const manual = resolveThinkingOptions({ ref: an, thinking: { type: 'enabled', budget_tokens: 4096 } })
  eq(manual.providerOptions.anthropic.thinking.budgetTokens, 4096, '手动 thinking budget 保留')
}

console.log('\n[modelSettings / Anthropic body]')
{
  const an = { protocol: 'anthropic', preset: 'anthropic', model: 'claude', maxTokens: 4096 }
  const to = resolveThinkingOptions({ ref: an, depth: 'high', budget: 12000 })
  const { modelSettings } = resolveModelSettings(an, { thinkingOptions: to })
  eq(modelSettings.maxOutputTokens, 4096, 'Anthropic 默认/显式 maxOutputTokens 保留')
  const cap = captureFetch(() => anthropicResponse())
  const m = createLanguageModel({ ...an, baseURL: 'https://example.test/v1', apiKey: 'k' }, { fetchImpl: cap.fetch })
  await m.doGenerate({ prompt: PROMPT, providerOptions: to.providerOptions, ...modelSettings })
  ok(cap.calls[0].body.max_tokens > to.budget, 'body max_tokens > thinking budget（AI SDK 自动加）')
  eq(cap.calls[0].body.thinking, { type: 'enabled', budget_tokens: 12000 }, 'body.thinking.budget_tokens')
}

console.log('\n[legacy-only 矩阵]')
{
  eq(modelSupport({ protocol: 'gemini' }).legacyOnly, true, 'Gemini legacy-only')
  eq(modelSupport({ protocol: 'openai', preset: 'azure' }).legacyOnly, true, 'Azure legacy-only')
  eq(modelSupport({ protocol: 'openai', preset: 'opencode-go' }).legacyOnly, false, 'opencode-go 可迁移')
  const f = createModelFactory({ cfg: { apiKey: 'k', model: 'gemini-2.5', protocol: 'gemini', preset: 'gemini' } })
  eq(f.main().legacyOnly, true, 'Gemini 主模型不创建 AI SDK model')
  let gemErr = null
  try { createLanguageModel({ protocol: 'gemini', model: 'g', apiKey: 'k' }) } catch (e) { gemErr = e }
  eq(gemErr?.code, 'gemini_legacy_only', '直接创建 Gemini model 抛 legacy_only')
}

console.log('\n[ModelFactory / modelList]')
{
  const cfg = {
    providerId: 'p1', modelId: 'm1',
    llmProviders: [{ id: 'p1', protocol: 'openai', preset: 'openai', baseURL: 'https://example.test/v1', apiKey: 'k' }],
    llmModels: [{ id: 'm1', providerId: 'p1', model: 'gpt-5' }],
    utilityModel: 'm1', vision: { model: 'gpt-5' },
    fallbackModels: [{ model: 'fallback', baseURL: 'https://example.test/v1', apiKey: 'k2', protocol: 'openai' }],
  }
  const f = createModelFactory({ cfg, sessionId: 's' })
  eq(f.configured, true, 'configured')
  eq(f.main().model.modelId, 'gpt-5', 'main modelId')
  eq(f.utility().model.modelId, 'gpt-5', 'utility')
  eq(f.vision().model.modelId, 'gpt-5', 'vision')
  eq(f.fallbacks().length, 1, 'fallback')
  eq(f.modelList().length, 2, 'modelList 主+fallback')
  eq(f.describe().protocol, 'openai', 'describe protocol')
}

console.log('\n[fetch 透传 / 代理]')
{
  const cap = captureFetch(() => openAIResponse())
  const m = createLanguageModel({ protocol: 'openai', preset: 'opencode-go', baseURL: 'https://example.test/v1', apiKey: 'k', model: 'm' }, { fetchImpl: cap.fetch })
  await m.doGenerate({ prompt: PROMPT })
  eq(cap.calls.length, 1, '自定义 fetch 被调用（代理入口）')
  const okProxy = await createProxyFetch('http://127.0.0.1:7890', { logger: () => {} })
  ok(typeof okProxy === 'function', 'http 代理返回 fetch 函数')
  eq(await createProxyFetch('socks5://127.0.0.1:1080', { logger: () => {} }), null, 'socks 明确不支持')
  const resolved = await resolveProxyFetch('http://127.0.0.1:7890', { logger: () => {} })
  ok(typeof resolved === 'function', 'resolveProxyFetch 返回函数')
}

console.log('\n[fallback：仅可重试错误换模型]')
{
  const fail503 = {
    specificationVersion: 'v4', provider: 'test', modelId: 'fail503', supportedUrls: {},
    async doGenerate() { throw Object.assign(new Error('503 rate limit'), { status: 503 }) },
  }
  const okModel = scriptedAiSdkModel([{ text: 'fallback-ok' }])
  const r = await generateWithFallback({ models: [{ model: fail503 }, { model: okModel }], prompt: 'hi' })
  eq(r.result.text, 'fallback-ok', '503 后切换模型成功')
  eq(r.attempts.length, 2, '记录了两次尝试')
  eq(r.attempts[0].code, 'provider_unavailable', '第一次归为可重试')

  const fail401 = {
    specificationVersion: 'v4', provider: 'test', modelId: 'fail401', supportedUrls: {},
    async doGenerate() { throw Object.assign(new Error('401 invalid api key'), { status: 401 }) },
  }
  let e = null
  try { await generateWithFallback({ models: [{ model: fail401 }, { model: okModel }], prompt: 'hi' }) } catch (err) { e = err }
  eq(e?.code, 'provider_all_failed', '401 不重试并抛 all_failed')
  eq(e?.attempts?.length, 1, '只尝试一次')

  let toolErr = null
  try { await generateWithFallback({ models: [{ model: okModel }], prompt: 'hi', tools: {} }) } catch (err) { toolErr = err }
  eq(toolErr?.code, 'runtime_config_invalid', '带 tools 禁止 fallback（防重复副作用）')
}

console.log(`\n========================================`)
console.log(`通过 ${passed}，失败 ${failed}`)
console.log(`========================================`)
if (failed > 0) process.exitCode = 1
