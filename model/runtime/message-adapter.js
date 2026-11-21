/**
 * 消息适配（S6 / Memory Phase 1）：legacy OpenAI-style ↔ AI SDK/Mastra ModelMessage。
 *
 * 历史真源仍是 SessionStore；本模块只做**无损尽量**的双向转换：
 *  - text / image_url / Anthropic image/document / Gemini image/audio/document / input_audio；
 *  - assistant tool_calls ↔ tool-call + tool-result；
 *  - reasoning + Anthropic provider_native（thinking signature / redacted_thinking）；
 *  - 未知块保留为文本/JSON，不静默丢整条消息。
 *
 * S6 不启用 Mastra Memory；Mastra 只接收显式 messages。
 */

function textOf(content) {
  if (content == null) return ''
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.filter((p) => p && p.type === 'text').map((p) => p.text || '').join('\n')
  }
  return String(content)
}

function dataUrlToPart(block) {
  const src = block?.source
  if (src?.type === 'base64' && src.data) return { data: src.data, mediaType: src.media_type || block.media_type }
  if (src?.type === 'url' && src.url) return { data: src.url, mediaType: block.media_type }
  return null
}

/** legacy 用户/工具内容块 → AI SDK UserContent */
export function legacyContentToParts(content) {
  if (content == null) return []
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  if (!Array.isArray(content)) return [{ type: 'text', text: String(content) }]
  const out = []
  for (const b of content) {
    if (b == null) continue
    if (typeof b === 'string') { out.push({ type: 'text', text: b }); continue }
    if (b.type === 'text') { out.push({ type: 'text', text: b.text || '' }); continue }
    if (b.type === 'image_url') {
      const url = b.image_url?.url || b.image_url
      if (url) out.push({ type: 'image', image: url })
      continue
    }
    if (b.type === 'image') {
      if (b.data) { out.push({ type: 'image', image: b.data, mediaType: b.mime_type || b.mediaType }); continue }
      const d = dataUrlToPart(b)
      if (d) out.push({ type: 'image', image: d.data, mediaType: d.mediaType })
      continue
    }
    if (b.type === 'document' || b.type === 'file') {
      const d = dataUrlToPart(b)
      if (d) out.push({ type: 'file', data: d.data, mediaType: d.mediaType || 'application/octet-stream', filename: b.filename || b.name })
      else if (b.file_url) out.push({ type: 'file', data: b.file_url, mediaType: 'application/octet-stream' })
      continue
    }
    if (b.type === 'input_audio') {
      const fmt = b.input_audio?.format || 'mp3'
      out.push({ type: 'file', data: b.input_audio?.data || '', mediaType: `audio/${fmt}` })
      continue
    }
    if (b.type === 'audio') {
      if (b.data) out.push({ type: 'file', data: b.data, mediaType: b.mime_type || 'audio/mpeg' })
      continue
    }
    // 未知原生块：保留 JSON 文本，避免静默丢内容
    try { out.push({ type: 'text', text: JSON.stringify(b) }) } catch { /* noop */ }
  }
  return out
}

function anthropicNativeParts(m) {
  const native = m?.provider_native
  if (!native || native.type !== 'anthropic' || !Array.isArray(native.content)) return []
  const out = []
  for (const b of native.content) {
    if (!b || typeof b !== 'object') continue
    if (b.type === 'thinking') {
      out.push({ type: 'reasoning', text: b.thinking || '', providerOptions: { anthropic: { signature: b.signature } } })
    } else if (b.type === 'redacted_thinking') {
      out.push({ type: 'reasoning', text: '', providerOptions: { anthropic: { redactedData: b.data } } })
    } else if (b.type === 'text' && b.text) {
      out.push({ type: 'text', text: b.text })
    } else if (b.type === 'tool_use') {
      out.push({ type: 'tool-call', toolCallId: b.id, toolName: b.name, input: b.input ?? {} })
    }
  }
  return out
}

/** 只有无法无损表达/未知结构才返回原因；S6 默认全部可转换 */
export function hasUnsupportedLegacyShape() {
  return null
}

/** legacy 历史 → AI SDK ModelMessage[] */
export function legacyToMastraMessages(messages = []) {
  const out = []
  for (const m of messages) {
    if (!m || !m.role) continue
    if (m.role === 'system') {
      out.push({ role: 'system', content: textOf(m.content) })
      continue
    }
    if (m.role === 'user') {
      out.push({ role: 'user', content: legacyContentToParts(m.content) })
      continue
    }
    if (m.role === 'tool') {
      out.push({
        role: 'tool',
        content: [{
          type: 'tool-result',
          toolCallId: m.tool_call_id || m.toolCallId || '',
          toolName: m.name || '',
          output: { type: 'text', value: typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '') },
        }],
      })
      continue
    }
    if (m.role === 'assistant') {
      const nativeParts = anthropicNativeParts(m)
      const parts = []
      if (!nativeParts.length && m.reasoning) parts.push({ type: 'reasoning', text: String(m.reasoning) })
      if (!nativeParts.length) {
        const text = textOf(m.content)
        if (text) parts.push({ type: 'text', text })
        for (const tc of Array.isArray(m.tool_calls) ? m.tool_calls : []) {
          let input = tc.function?.arguments ?? tc.arguments ?? {}
          if (typeof input === 'string') { try { input = JSON.parse(input) } catch { input = { _raw: input } } }
          parts.push({
            type: 'tool-call',
            toolCallId: tc.id,
            toolName: tc.function?.name || tc.name,
            input,
          })
        }
      } else {
        parts.push(...nativeParts)
      }
      if (!parts.length) continue
      out.push({ role: 'assistant', content: parts })
    }
  }
  return out
}

function partText(parts = []) {
  return parts.filter((p) => p && p.type === 'text').map((p) => p.text || '').join('')
}

/**
 * Mastra FullOutput.messages → legacy 历史（用于 SessionStore 持久化）。
 */
export function mastraMessagesToLegacy(messages = [], { fromIndex = 0 } = {}) {
  const out = []
  for (const m of (messages || []).slice(fromIndex)) {
    const parts = Array.isArray(m?.content?.parts) ? m.content.parts : []
    if (m?.role === 'user') {
      const content = []
      for (const p of parts) {
        if (p?.type === 'text') content.push({ type: 'text', text: p.text || '' })
        else if (p?.type === 'image') content.push({ type: 'image_url', image_url: { url: typeof p.image === 'string' ? p.image : '' } })
        else if (p?.type === 'file') content.push({ type: 'text', text: `[文件${p.filename ? ` ${p.filename}` : ''}]` })
      }
      const t = partText(parts) || textOf(m.content?.content ?? m.content)
      if (!content.length && t) out.push({ role: 'user', content: t })
      else if (content.length) out.push({ role: 'user', content })
      continue
    }
    if (m?.role !== 'assistant') continue
    const startIndex = out.length
    let text = ''
    let reasoning = ''
    const native = []
    const flushText = () => {
      if (!text) return
      out.push({ role: 'assistant', content: text })
      text = ''
    }
    let pendingCalls = []
    let pendingResults = []
    const flushTools = () => {
      if (!pendingCalls.length) return
      out.push({
        role: 'assistant',
        content: '',
        tool_calls: pendingCalls.map((c) => ({
          id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) },
        })),
      })
      for (const r of pendingResults) out.push({ role: 'tool', tool_call_id: r.id, name: r.name, content: String(r.result ?? '') })
      pendingCalls = []
      pendingResults = []
    }
    for (const p of parts) {
      if (p?.type === 'text') { text += p.text || ''; native.push({ type: 'text', text: p.text || '' }); continue }
      if (p?.type === 'reasoning') {
        reasoning += p.text || ''
        const sig = p.providerOptions?.anthropic?.signature
        const redacted = p.providerOptions?.anthropic?.redactedData
        if (sig) native.push({ type: 'thinking', thinking: p.text || '', signature: sig })
        else if (redacted) native.push({ type: 'redacted_thinking', data: redacted })
        continue
      }
      if (p?.type === 'tool-invocation') {
        const inv = p.toolInvocation || {}
        if (inv.state === 'result') {
          flushText()
          pendingCalls.push({ id: inv.toolCallId, name: inv.toolName, args: inv.args })
          pendingResults.push({ id: inv.toolCallId, name: inv.toolName, result: inv.result })
          native.push({ type: 'tool_use', id: inv.toolCallId, name: inv.toolName, input: inv.args })
          flushTools()
        }
      }
    }
    flushText()
    flushTools()
    if ((reasoning || native.length) && out.length) {
      // 附到本 step 的第一条 assistant（有 tool_calls 时应为它；无工具则最终文本）
      const first = out[startIndex]?.role === 'assistant' ? out[startIndex] : [...out].reverse().find((x) => x.role === 'assistant')
      if (first) {
        if (reasoning) first.reasoning = reasoning
        if (native.length) first.provider_native = { type: 'anthropic', content: native }
      }
    }
  }
  return out
}

/** 当前轮 user 输入（多模态）→ AI SDK UserContent */
export function currentUserContent(input, text) {
  if (input && typeof input === 'object' && Array.isArray(input.content)) {
    const parts = legacyContentToParts(input.content)
    if (text) {
      const firstText = parts.find((p) => p.type === 'text')
      if (firstText) firstText.text = text
      else parts.unshift({ type: 'text', text })
    }
    return parts
  }
  return text
}
