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
    let nativeRelevant = false
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
      for (const r of pendingResults) out.push({ role: 'tool', tool_call_id: r.id, name: r.name, content: typeof r.result === 'string' ? r.result : JSON.stringify(r.result ?? '') })
      pendingCalls = []
      pendingResults = []
    }
    for (const p of parts) {
      if (p?.type === 'text') { text += p.text || ''; native.push({ type: 'text', text: p.text || '' }); continue }
      if (p?.type === 'reasoning') {
        reasoning += p.text || ''
        const pm = p.providerOptions || p.providerMetadata
        const sig = pm?.anthropic?.signature
        const redacted = pm?.anthropic?.redactedData
        if (sig) { nativeRelevant = true; native.push({ type: 'thinking', thinking: p.text || '', signature: sig }) }
        else if (redacted) { nativeRelevant = true; native.push({ type: 'redacted_thinking', data: redacted }) }
        continue
      }
      if (p?.type === 'tool-invocation') {
        const inv = p.toolInvocation || {}
        if (inv.state === 'result') {
          flushText()
          pendingCalls.push({ id: inv.toolCallId, name: inv.toolName, args: inv.args })
          pendingResults.push({ id: inv.toolCallId, name: inv.toolName, result: inv.result })
          nativeRelevant = true
          native.push({ type: 'tool_use', id: inv.toolCallId, name: inv.toolName, input: inv.args })
          flushTools()
        }
      }
    }
    flushText()
    flushTools()
    if ((reasoning || nativeRelevant) && out.length) {
      // 附到本 step 的第一条 assistant（有 tool_calls 时应为它；无工具则最终文本）
      const first = out[startIndex]?.role === 'assistant' ? out[startIndex] : [...out].reverse().find((x) => x.role === 'assistant')
      if (first) {
        if (reasoning) first.reasoning = reasoning
        if (nativeRelevant && native.length) first.provider_native = { type: 'anthropic', content: native }
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


/**
 * legacy 历史 → MastraDBMessage[]（Memory Phase 2 / S7）。
 *
 * 与 `legacyToMastraMessages` 的区别：
 *  - 目标不是 AI SDK ModelMessage，而是 Memory 持久化的 `content.format=2.parts`；
 *  - 工具调用使用 Mastra UI 的 `tool-invocation` 形态，结果按 `role:'tool'` 独立成消息；
 *  - id 由调用方注入（迁移用稳定 hash，新消息用 thread+seq 稳定 id），重复写入幂等。
 */
export function legacyToMastraDbMessages(messages = [], {
  threadId = '', resourceId = '', startSeq = 0, baseTime = Date.now(), makeId = null,
} = {}) {
  const out = []
  const calls = new Map()
  let seq = Number(startSeq) || 0
  const nextId = (msg) => {
    if (typeof makeId === 'function') {
      const id = makeId(seq, msg)
      if (id) return String(id)
    }
    return `yz_${seq.toString(36)}_${contentHash32(JSON.stringify(msg))}`
  }
  for (const m of messages || []) {
    if (!m || !m.role) continue
    const createdAt = new Date(Number(baseTime || Date.now()) + seq)
    const id = nextId(m)
    seq++
    if (m.role === 'user') {
      out.push({ id, role: 'user', createdAt, threadId, resourceId, content: { format: 2, parts: legacyContentToParts(m.content) } })
      continue
    }
    if (m.role === 'assistant') {
      const parts = []
      const native = anthropicNativeParts(m)
      const nativeMeta = native.length ? { yzProviderNative: 'anthropic' } : null
      if (native.length) {
        for (const p of native) {
          if (p.type === 'reasoning') parts.push({ type: 'reasoning', text: p.text || '', ...(p.providerOptions ? { providerOptions: p.providerOptions } : {}) })
          else if (p.type === 'text') parts.push({ type: 'text', text: p.text || '' })
          else if (p.type === 'tool-call') {
            parts.push({ type: 'tool-invocation', toolInvocation: { state: 'call', toolCallId: p.toolCallId, toolName: p.toolName, args: p.input ?? {} } })
            calls.set(p.toolCallId, p.input ?? {})
          }
        }
        // provider_native 未携带完整文本时兜底；避免重复
        if (!parts.some((p) => p.type === 'text')) {
          const text = textOf(m.content)
          if (text) parts.push({ type: 'text', text })
        }
      } else {
        if (m.reasoning) parts.push({ type: 'reasoning', text: String(m.reasoning) })
        const text = textOf(m.content)
        if (text) parts.push({ type: 'text', text })
        for (const tc of Array.isArray(m.tool_calls) ? m.tool_calls : []) {
          let input = tc.function?.arguments ?? tc.arguments ?? {}
          if (typeof input === 'string') { try { input = JSON.parse(input) } catch { input = { _raw: input } } }
          const callId = tc.id || `call_${seq}`
          const name = tc.function?.name || tc.name || ''
          parts.push({ type: 'tool-invocation', toolInvocation: { state: 'call', toolCallId: callId, toolName: name, args: input } })
          calls.set(callId, input)
        }
      }
      if (!parts.length) continue
      out.push({ id, role: 'assistant', createdAt, threadId, resourceId, content: { format: 2, parts, ...(nativeMeta ? { metadata: nativeMeta } : {}) } })
      continue
    }
    if (m.role === 'tool') {
      const callId = m.tool_call_id || m.toolCallId || ''
      const name = m.name || ''
      const args = calls.get(callId) ?? {}
      let result = m.content
      if (typeof result === 'string') { try { result = JSON.parse(result) } catch { /* keep string */ } }
      out.push({
        id, role: 'assistant', createdAt, threadId, resourceId,
        content: { format: 2, parts: [{
          type: 'tool-invocation',
          toolInvocation: { state: 'result', toolCallId: callId, toolName: name, args, result },
        }] },
      })
    }
  }
  return out
}

/** 32 位短 hash：仅用于兜底 id，不参与内容校验 */
function contentHash32(s) {
  let h = 0x811c9dc5
  const text = String(s)
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

/**
 * MastraDBMessage[] → legacy 历史（Memory 读取 / 迁移校验）。
 *
 * 与 `mastraMessagesToLegacy` 的差异：结果消息是独立 `role:'tool'`，且不会为每个
 * tool-result 重复生成 assistant tool_calls；只有真正含 call part 的 assistant 才生成。
 */
export function mastraDbMessagesToLegacy(messages = []) {
  const out = []
  let lastAssistant = null
  for (const m of messages || []) {
    const parts = Array.isArray(m?.content?.parts) ? m.content.parts : []
    if (m?.role === 'user') {
      const content = []
      for (const p of parts) {
        if (p?.type === 'text') content.push({ type: 'text', text: p.text || '' })
        else if (p?.type === 'image') content.push({ type: 'image_url', image_url: { url: typeof p.image === 'string' ? p.image : '' } })
        else if (p?.type === 'file') content.push({ type: 'text', text: `[文件${p.filename ? ` ${p.filename}` : ''}]` })
      }
      const t = partText(parts) || textOf(m.content?.content ?? m.content)
      const onlyText = content.length === 1 && content[0].type === 'text'
      if (!content.length && t) out.push({ role: 'user', content: t })
      else if (onlyText) out.push({ role: 'user', content: content[0].text })
      else if (content.length) out.push({ role: 'user', content })
      lastAssistant = null
      continue
    }
    if (m?.role !== 'assistant') continue
    let text = ''
    let reasoning = ''
    const native = []
    let nativeRelevant = m.content?.metadata?.yzProviderNative === 'anthropic'
    const calls = []
    const results = []
    for (const p of parts) {
      if (p?.type === 'text') {
        text += p.text || ''
        native.push({ type: 'text', text: p.text || '' })
        continue
      }
      if (p?.type === 'reasoning') {
        reasoning += p.text || ''
        const pm = p.providerOptions || p.providerMetadata
        const sig = pm?.anthropic?.signature
        const redacted = pm?.anthropic?.redactedData
        if (sig) { nativeRelevant = true; native.push({ type: 'thinking', thinking: p.text || '', signature: sig }) }
        else if (redacted) { nativeRelevant = true; native.push({ type: 'redacted_thinking', data: redacted }) }
        continue
      }
      if (p?.type === 'tool-invocation') {
        const inv = p.toolInvocation || {}
        if (inv.state === 'result' || inv.state === 'output-error' || inv.state === 'output-denied') {
          results.push({ id: inv.toolCallId, name: inv.toolName, result: inv.isError ? { error: inv.errorText || inv.result } : inv.result })
        } else if (inv.toolName) {
          calls.push({ id: inv.toolCallId, name: inv.toolName, args: inv.args })
          native.push({ type: 'tool_use', id: inv.toolCallId, name: inv.toolName, input: inv.args })
        }
        continue
      }
      if (p?.type === 'tool-call') {
        calls.push({ id: p.toolCallId, name: p.toolName, args: p.input })
        native.push({ type: 'tool_use', id: p.toolCallId, name: p.toolName, input: p.input })
        continue
      }
      if (p?.type === 'tool-result') {
        let result = p.output?.value ?? p.result
        if (typeof result === 'string') { try { result = JSON.parse(result) } catch { /* keep */ } }
        results.push({ id: p.toolCallId, name: p.toolName, result })
      }
    }
    if (calls.length) {
      const msg = {
        role: 'assistant', content: text,
        tool_calls: calls.map((c) => ({
          id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) },
        })),
      }
      if (reasoning) msg.reasoning = reasoning
      if (nativeRelevant && native.length) msg.provider_native = { type: 'anthropic', content: native }
      out.push(msg)
      lastAssistant = msg
      text = ''
    }
    if (text) {
      const msg = { role: 'assistant', content: text }
      if (reasoning && !calls.length) msg.reasoning = reasoning
      if (nativeRelevant && native.length && !calls.length) msg.provider_native = { type: 'anthropic', content: native }
      out.push(msg)
      lastAssistant = msg
    }
    for (const r of results) {
      out.push({ role: 'tool', tool_call_id: r.id || '', name: r.name || '', content: typeof r.result === 'string' ? r.result : JSON.stringify(r.result ?? '') })
    }
    if (!calls.length && !text && reasoning && lastAssistant && !lastAssistant.reasoning) lastAssistant.reasoning = reasoning
  }
  return out
}
