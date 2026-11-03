/**
 * 模型上下文解析测试（离线）：API 元数据 → 本地目录 → 学习值 → 兜底。
 * 运行：node model/llm/model-context.test.mjs
 */
import { resolveModelContext, learnContextLimit, learnContextFromError, isContextOverflowError, notePromptUsage, getPromptCalibration, clearModelContextCache } from './model-context.js'
import { primeModelCaps, getApiCaps, getApiContext, clearApiCaps, contextFromModelItem } from './caps-source.js'

let pass = 0, fail = 0
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m) } else { fail++; console.error('  ✗ FAIL', m) } }
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m}${JSON.stringify(a) === JSON.stringify(b) ? '' : ` (got ${JSON.stringify(a)})`}`)
const test = async (name, fn) => { console.log(`\n[${name}]`); try { await fn() } catch (e) { fail++; console.error('  ✗ THROW', e?.message || e) } }

/* ---------- 纯解析 ---------- */
await test('contextFromModelItem：主流厂商字段归一', () => {
  const openrouter = contextFromModelItem({
    id: 'openai/gpt-6.1-sol', context_length: 1050000,
    top_provider: { max_completion_tokens: 128000 },
    architecture: { input_modalities: ['text', 'image'], supported_parameters: ['tools', 'reasoning'] },
  })
  eq(openrouter && openrouter.contextWindow, 1050000, 'OpenRouter context_length')
  eq(openrouter && openrouter.maxOutputTokens, 128000, 'OpenRouter top_provider.max_completion_tokens')
  ok(openrouter && openrouter.thinking && openrouter.thinking.supported, 'OpenRouter reasoning → thinking')

  const anthropic = contextFromModelItem({ id: 'claude-sonnet-5.5', max_input_tokens: 1000000, max_tokens: 128000 })
  eq(anthropic && anthropic.maxInputTokens, 1000000, 'Anthropic max_input_tokens')
  eq(anthropic && anthropic.maxOutputTokens, 128000, 'Anthropic max_tokens')
  eq(anthropic && anthropic.contextWindowKind, 'input', 'Anthropic 输入窗口语义')

  const gemini = contextFromModelItem({ name: 'models/gemini-3.8-flash', inputTokenLimit: 1048576, outputTokenLimit: 65536 })
  eq(gemini && gemini.contextWindow, 1048576, 'Gemini inputTokenLimit')
  eq(gemini && gemini.maxOutputTokens, 65536, 'Gemini outputTokenLimit')

  const deepseek = contextFromModelItem({ id: 'deepseek-v4.1-flash', context_window: 1048576, max_output_tokens: 393216 })
  eq(deepseek && deepseek.contextWindow, 1048576, 'DeepSeek context_window')
  eq(deepseek && deepseek.contextWindowKind, 'total', 'DeepSeek total 语义')

  const opencode = contextFromModelItem({ id: 'gpt-6.1-sol', limit: { context: 1050000, input: 922000, output: 128000 } })
  eq(opencode && opencode.maxInputTokens, 922000, 'OpenCode limit.input')
  eq(opencode && opencode.maxOutputTokens, 128000, 'OpenCode limit.output')
})

/* ---------- API 优先 ---------- */
await test('API 元数据优先：OpenRouter 形状 + contextOnly', async () => {
  clearApiCaps(); clearModelContextCache()
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({ data: [{ id: 'acme/ctx-model', context_length: 200000, top_provider: { max_completion_tokens: 50000 }, architecture: { input_modalities: ['text'] }, supported_parameters: ['tools', 'reasoning'] }] }),
  })
  await primeModelCaps({ protocol: 'openai', baseURL: 'https://mock/v1', apiKey: 'k', models: ['acme/ctx-model'], fetchImpl, contextOnly: true })
  ok(getApiCaps('acme/ctx-model') == null, 'contextOnly 不写能力位')
  const ctx = getApiContext('acme/ctx-model')
  eq(ctx && ctx.contextWindow, 200000, 'API context 已缓存')
  const r = resolveModelContext({ model: 'acme/ctx-model' })
  eq(r.source, 'api', '解析 source=api')
  eq(r.inputBudget, 150000, '总窗口 - 输出 = 输入预算')
  eq(r.maxOutputTokens, 50000, '输出上限来自 top_provider')
  const rt = resolveModelContext({ model: 'acme/ctx-model', thinking: true })
  eq(rt.thinkingMode, 'on', '思考模式解析')
})

/* ---------- API 元数据：Anthropic / Gemini 形状 ---------- */
await test('API 元数据：Anthropic max_input_tokens / Gemini inputTokenLimit', async () => {
  clearApiCaps(); clearModelContextCache()
  const anth = await primeModelCaps({
    protocol: 'anthropic', baseURL: 'https://mock-anthropic/v1', apiKey: 'k',
    models: ['claude-test-5'], fetchImpl: async () => ({
      ok: true,
      json: async () => ({ data: [{ id: 'claude-test-5', max_input_tokens: 1000000, max_tokens: 128000 }] }),
    }),
  })
  const a = resolveModelContext({ model: 'claude-test-5' })
  eq(a.source, 'api', 'Anthropic 走 API')
  eq(a.contextWindow, 1000000, 'Anthropic max_input_tokens 作为窗口')
  eq(a.inputBudget, 1000000, 'Anthropic 输入独立预算')
  eq(a.maxOutputTokens, 128000, 'Anthropic max_tokens 作为输出上限')

  clearApiCaps(); clearModelContextCache()
  await primeModelCaps({
    protocol: 'gemini', baseURL: 'https://mock-gemini/v1beta/openai', apiKey: 'k',
    models: ['models/gemini-test-4'], fetchImpl: async () => ({
      ok: true,
      json: async () => ({ models: [{ name: 'models/gemini-test-4', inputTokenLimit: 1048576, outputTokenLimit: 65536 }] }),
    }),
  })
  const g = resolveModelContext({ model: 'models/gemini-test-4' })
  eq(g.source, 'api', 'Gemini 走 API（缓存键归一 models/ 前缀）')
  eq(g.contextWindow, 1048576, 'Gemini 输入窗口')
  eq(g.maxOutputTokens, 65536, 'Gemini 输出上限')
})

/* ---------- 本地目录 ---------- */
await test('本地目录：OpenAI / Qwen / Kimi / GLM / 网关前缀', () => {
  clearApiCaps(); clearModelContextCache()
  const gpt = resolveModelContext({ model: 'gpt-6.1-sol' })
  eq(gpt.source, 'catalog', 'OpenAI 无 /models 元数据 → catalog')
  eq(gpt.inputBudget, 922000, 'GPT-6.1 输入预算')
  eq(gpt.contextWindow, 1050000, 'GPT-6.1 总窗口')

  const gw = resolveModelContext({ model: 'openai/gpt-6.1-sol' })
  eq(gw.source, 'catalog', '网关厂商前缀可回退目录')
  eq(gw.inputBudget, 922000, '网关 GPT-6.1 输入预算')

  const qwen = resolveModelContext({ model: 'qwen3-max', thinking: false })
  eq(qwen.maxOutputTokens, 65536, 'Qwen3-Max 非思考输出')
  const qwenOn = resolveModelContext({ model: 'qwen3-max', thinking: true })
  eq(qwenOn.maxOutputTokens, 32768, 'Qwen3-Max 思考输出')

  eq(resolveModelContext({ model: 'kimi-k3' }).contextWindow, 1048576, 'Kimi K3 1M')
  eq(resolveModelContext({ model: 'glm-4.6' }).contextWindow, 204800, 'GLM-4.6 200K')
  eq(resolveModelContext({ model: 'claude-sonnet-5.5' }).contextWindow, 1048576, 'Claude 5.5 1M')
  eq(resolveModelContext({ model: 'minimax-m2.5' }).inputBudget, 102400, '输出=窗口时不把输入压到 1K')
  eq(resolveModelContext({ model: 'doubao-seed-2.1-turbo' }).inputBudget, 131072, '豆包 Turbo 输出预留封顶 50%')
  eq(resolveModelContext({ model: 'gemini-4-pro' }).inputBudget, 1048576, 'Gemini 4 输入独立预算')
})

/* ---------- 学习 / 校准 / 兜底 ---------- */
await test('学习值与估算校准', () => {
  clearModelContextCache()
  const before = resolveModelContext({ model: 'mystery-model' })
  eq(before.source, 'fallback', '未知模型走 128K 兜底')
  eq(before.inputBudget, 128000, '兜底输入预算')

  const learned = learnContextLimit('mystery-model', 50000)
  eq(learned, 45000, '学习值 = 已用 90%')
  const after = resolveModelContext({ model: 'mystery-model' })
  eq(after.source, 'learned', '学习值优先于兜底')
  eq(after.inputBudget, 45000, '学习值进入输入预算')

  const ratio = notePromptUsage('mystery-model', 1000, 1500)
  eq(ratio, 1.5, 'prompt usage 校准系数')
  eq(getPromptCalibration('mystery-model'), 1.5, '读取校准系数')
  clearModelContextCache()
  eq(getPromptCalibration('mystery-model'), 1, '清空后回到 1')
})

/* ---------- 厂商报错学习 ---------- */
await test('上下文超限识别与真实上限学习', () => {
  clearApiCaps(); clearModelContextCache()
  ok(isContextOverflowError({ message: "This model's maximum context length is 131072 tokens. However you requested 150000 tokens." }), 'OpenAI 超限文案')
  ok(isContextOverflowError({ status: 400, message: 'prompt is too long: 210000 tokens > 200000 maximum' }), 'Anthropic 超限文案')
  ok(isContextOverflowError({ message: '输入内容超过上下文窗口上限' }), '中文超限文案')
  ok(!isContextOverflowError({ status: 429, message: 'rate limit exceeded' }), '限流不误判')

  const stated = learnContextFromError('overflow-model', new Error('maximum context length is 8000 tokens'), 10000)
  eq(stated, 7600, '声明的窗口取 95%')
  eq(resolveModelContext({ model: 'overflow-model' }).inputBudget, 7600, '学习值进入解析')

  clearModelContextCache()
  const inferred = learnContextFromError('overflow-model-2', new Error('prompt is too long'), 50000)
  eq(inferred, 45000, '无声明窗口时按已用量 90% 学习')
})

/* ---------- 收尾 ---------- */
clearApiCaps()
clearModelContextCache()
console.log(`\n========================================`)
console.log(`通过 ${pass}，失败 ${fail}`)
console.log(`========================================`)
process.exit(fail ? 1 : 0)
