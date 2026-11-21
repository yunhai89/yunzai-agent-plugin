/**
 * AI SDK LanguageModelV2 适配器：把旧 provider.chat() 包装成 AI SDK/Mastra 模型。
 *
 * 仅用于 S11 后仍持有旧 provider 实例的外围模块（研究/多代理/评测）；
 * 主聊天走 ModelFactory 的真实 AI SDK provider，不经过本文件。
 */

function messageText(content) {
  if (content == null) return ''
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.filter((p) => p && p.type === 'text').map((p) => p.text || '').join('\n')
  return String(content)
}

function toLegacyContent(parts = []) {
  const out = []
  for (const p of parts) {
    if (!p) continue
    if (p.type === 'text') out.push({ type: 'text', text: p.text || '' })
    else if (p.type === 'file') {
      const data = p.data
      const url = typeof data === 'string'
        ? (data.startsWith('data:') || /^https?:/.test(data) ? data : `data:${p.mediaType || 'application/octet-stream'};base64,${data}`)
        : ''
      if (url) out.push({ type: 'image_url', image_url: { url } })
    }
  }
  return out
}

function parseToolArgs(v) {
  if (typeof v !== 'string') return v
  try { return JSON.parse(v) } catch { return v }
}

export function promptToLegacyMessages(prompt = []) {
  const out = []
  for (const m of prompt) {
    if (!m) continue
    if (m.role === 'system') { out.push({ role: 'system', content: messageText(m.content) }); continue }
    if (m.role === 'user') {
      const parts = toLegacyContent(m.content)
      const text = parts.length === 1 && parts[0].type === 'text' ? parts[0].text : parts
      out.push({ role: 'user', content: text })
      continue
    }
    if (m.role === 'assistant') {
      let text = ''
      const toolCalls = []
      const native = []
      for (const p of m.content || []) {
        if (p.type === 'text') { text += p.text || ''; native.push({ type: 'text', text: p.text || '' }); continue }
        if (p.type === 'reasoning') { native.push({ type: 'thinking', thinking: p.text || '' }); continue }
        if (p.type === 'tool-call') {
          toolCalls.push({ id: p.toolCallId, type: 'function', function: { name: p.toolName, arguments: JSON.stringify(p.input ?? {}) } })
          native.push({ type: 'tool_use', id: p.toolCallId, name: p.toolName, input: p.input ?? {} })
        }
      }
      const msg = { role: 'assistant', content: text }
      if (toolCalls.length) msg.tool_calls = toolCalls
      const reasoning = (m.content || []).filter((p) => p.type === 'reasoning').map((p) => p.text || '').join('\n')
      if (reasoning) msg.reasoning = reasoning
      out.push(msg)
      continue
    }
    if (m.role === 'tool') {
      for (const p of m.content || []) {
        if (p.type !== 'tool-result') continue
        const value = p.output?.value ?? p.result ?? ''
        out.push({ role: 'tool', tool_call_id: p.toolCallId || '', name: p.toolName || '', content: typeof value === 'string' ? value : JSON.stringify(value) })
      }
    }
  }
  return out
}

function toLegacyTools(tools = []) {
  return tools.filter((t) => t && t.type === 'function').map((t) => ({
    name: t.name, description: t.description || '', parameters: t.inputSchema || { type: 'object', properties: {} },
  }))
}

function mapToolChoice(tc) {
  if (!tc || tc.type === 'auto') return 'auto'
  if (tc.type === 'none') return 'none'
  if (tc.type === 'required') return 'any'
  if (tc.type === 'tool') return { mode: 'tool', name: tc.toolName }
  return tc
}

function mapFinishReason(r) {
  if (r === 'tool_calls' || r === 'tool-calls') return 'tool-calls'
  if (r === 'length' || r === 'max_tokens') return 'length'
  if (r === 'content_filter') return 'content-filter'
  if (r === 'stop') return 'stop'
  return r || 'stop'
}

function mapUsage(u) {
  if (!u) return { inputTokens: undefined, outputTokens: undefined, totalTokens: undefined }
  const input = u.prompt_tokens ?? u.input_tokens ?? u.input
  const output = u.completion_tokens ?? u.output_tokens ?? u.output
  return {
    inputTokens: Number.isFinite(Number(input)) ? Number(input) : undefined,
    outputTokens: Number.isFinite(Number(output)) ? Number(output) : undefined,
    totalTokens: Number.isFinite(Number(u.total_tokens ?? u.total)) ? Number(u.total_tokens ?? u.total) : (Number(input) || 0) + (Number(output) || 0) || undefined,
  }
}

export function createLegacyProviderModel({ provider, model, providerName = 'legacy' } = {}) {
  if (!provider || typeof provider.chat !== 'function') throw new Error('legacy provider 缺少 chat()')
  const modelId = model || provider.defaultModel || 'legacy-model'

  async function doGenerate(options = {}) {
    const { prompt = [], tools = [], toolChoice, abortSignal, temperature, maxOutputTokens, topP } = options
    const messages = promptToLegacyMessages(prompt)
    const legacyTools = toLegacyTools(tools)
    if (!legacyTools.length) {
      const sys = messages.filter((m) => m.role === 'system')
      if (sys.length) messages.splice(0, messages.length, ...sys, ...messages.filter((m) => m.role !== 'system'))
    }
    const r = await provider.chat({
      model: modelId,
      messages,
      ...(legacyTools.length ? { tools: legacyTools } : {}),
      ...(toolChoice ? { tool_choice: mapToolChoice(toolChoice) } : {}),
      ...(temperature != null ? { temperature } : {}),
      ...(maxOutputTokens != null ? { max_tokens: maxOutputTokens } : {}),
      ...(topP != null ? { top_p: topP } : {}),
      ...(abortSignal ? { signal: abortSignal } : {}),
      stream: false,
    })
    const content = []
    if (r?.reasoning) content.push({ type: 'reasoning', text: String(r.reasoning) })
    if (r?.content) content.push({ type: 'text', text: String(r.content) })
    for (const tc of r?.toolCalls || []) {
      content.push({
        type: 'tool-call',
        toolCallId: tc.id || `call_${content.length}`,
        toolName: tc.name || tc.function?.name || 'unknown',
        input: JSON.stringify(parseToolArgs(tc.arguments ?? tc.function?.arguments ?? {})),
      })
    }
    return {
      content,
      finishReason: mapFinishReason(r?.finishReason),
      usage: mapUsage(r?.usage),
      warnings: [],
      providerMetadata: {},
      request: { body: { messages } },
      response: { id: `legacy-${Date.now()}`, timestamp: new Date(), modelId },
    }
  }

  return {
    specificationVersion: 'v2',
    provider: providerName,
    modelId,
    supportedUrls: {},
    doGenerate,
    async doStream(options = {}) {
      const { prompt = [], tools = [], toolChoice, abortSignal, temperature, maxOutputTokens, topP } = options
      const messages = promptToLegacyMessages(prompt)
      const legacyTools = toLegacyTools(tools)
      const deltas = []
      const reasonings = []
      const r = await provider.chat({
        model: modelId,
        messages,
        ...(legacyTools.length ? { tools: legacyTools } : {}),
        ...(toolChoice ? { tool_choice: mapToolChoice(toolChoice) } : {}),
        ...(temperature != null ? { temperature } : {}),
        ...(maxOutputTokens != null ? { max_tokens: maxOutputTokens } : {}),
        ...(topP != null ? { top_p: topP } : {}),
        ...(abortSignal ? { signal: abortSignal } : {}),
        stream: true,
        onDelta: (d) => { if (d) deltas.push(String(d)) },
        onReasoning: (d) => { if (d) reasonings.push(String(d)) },
      })
      const chunks = []
      const text = deltas.length ? deltas.join('') : String(r?.content || '')
      if (text) {
        chunks.push({ type: 'text-start', id: 'text-1' })
        chunks.push({ type: 'text-delta', id: 'text-1', delta: text })
        chunks.push({ type: 'text-end', id: 'text-1' })
      }
      const reasoning = reasonings.length ? reasonings.join('') : String(r?.reasoning || '')
      if (reasoning) {
        chunks.push({ type: 'reasoning-start', id: 'reason-1' })
        chunks.push({ type: 'reasoning-delta', id: 'reason-1', delta: reasoning })
        chunks.push({ type: 'reasoning-end', id: 'reason-1' })
      }
      for (const tc of r?.toolCalls || []) {
        chunks.push({
          type: 'tool-call',
          toolCallId: tc.id || `call_${chunks.length}`,
          toolName: tc.name || tc.function?.name || 'unknown',
          input: JSON.stringify(parseToolArgs(tc.arguments ?? tc.function?.arguments ?? {})),
        })
      }
      chunks.push({ type: 'finish', finishReason: mapFinishReason(r?.finishReason), usage: mapUsage(r?.usage) })
      return {
        stream: new ReadableStream({
          start(controller) {
            for (const c of chunks) controller.enqueue(c)
            controller.close()
          },
        }),
        request: { body: { messages } },
        response: { id: `legacy-${Date.now()}`, timestamp: new Date(), modelId },
      }
    },
  }
}
