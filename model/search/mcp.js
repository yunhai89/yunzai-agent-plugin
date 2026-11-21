/**
 * 搜索 provider 共用：MCP (streamable HTTP) 调用与响应解析。
 *
 * 参考 dsh-free-search（MIT）的 mcp_adapter 思路，简化到本项目所需：
 * JSON 与 SSE 双格式、JSON-RPC error、工具级 isError、超时/取消。
 */

/** 解析 MCP 响应体：纯 JSON 或 SSE data: 帧；取带 result/error 的 envelope */
export function parseMcpResponseText(rawText) {
  const text = String(rawText || '')
  if (!text) return null
  const direct = tryJson(text)
  if (direct) return direct

  const payloads = []
  for (const event of text.split(/\r?\n\r?\n/)) {
    const data = []
    for (const line of event.split(/\r?\n/)) {
      if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
    }
    if (data.length) payloads.push(data.join('\n'))
  }
  if (!payloads.length) {
    for (const line of text.split(/\r?\n/)) {
      if (line.startsWith('data:')) payloads.push(line.slice(5).replace(/^ /, ''))
    }
  }
  let fallback = null
  for (const payload of payloads) {
    const parsed = tryJson(payload)
    if (!parsed || typeof parsed !== 'object') continue
    if (parsed.result !== undefined || parsed.error !== undefined) return parsed
    fallback = fallback || parsed
  }
  return fallback
}

function tryJson(text) {
  try {
    const v = JSON.parse(text)
    return v && typeof v === 'object' ? v : null
  } catch { return null }
}

/** 从 tools/call 结果中取出所有 text 块并拼接 */
export function mcpContentText(result) {
  if (!result || !Array.isArray(result.content)) return ''
  return result.content
    .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join('\n')
}

/**
 * 调用 MCP 工具。
 * @param {(url:string, opts?:object)=>Promise<Response>} fetcher 注入的 fetch（可走代理）
 * @param {object} o { endpoint, tool, args, headers, timeoutMs, signal, label }
 * @returns {Promise<object>} CallToolResult
 */
export async function mcpCallTool(fetcher, { endpoint, tool, args = {}, headers = {}, timeoutMs = 20000, signal = null, label = 'MCP' } = {}) {
  const f = fetcher || globalThis.fetch
  if (!f) throw new Error(`${label} 缺少 fetcher`)
  if (!endpoint) throw new Error(`${label} 缺少 endpoint`)
  if (!tool) throw new Error(`${label} 缺少 tool`)

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), Math.max(3000, Number(timeoutMs) || 20000))
  const onAbort = () => ctrl.abort()
  if (signal) {
    if (signal.aborted) ctrl.abort()
    else signal.addEventListener('abort', onAbort, { once: true })
  }
  let text
  try {
    const res = await f(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'accept': 'application/json, text/event-stream',
        ...headers,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: Date.now(),
        method: 'tools/call',
        params: { name: tool, arguments: args },
      }),
      signal: ctrl.signal,
    })
    if (res.status === 401 || res.status === 403) throw new Error(`${label} authentication failed (HTTP ${res.status})`)
    if (res.ok === false || res.status >= 400) {
      const detail = await res.text().catch(() => '')
      throw new Error(`${label} HTTP ${res.status}: ${String(detail).replace(/\s+/g, ' ').slice(0, 180)}`)
    }
    text = await res.text()
  } catch (e) {
    if (e?.name === 'AbortError') throw new Error(`${label} timeout/aborted`)
    throw e
  } finally {
    clearTimeout(timer)
    if (signal) signal.removeEventListener('abort', onAbort)
  }

  const envelope = parseMcpResponseText(text)
  if (!envelope) throw new Error(`${label} 响应不是合法 JSON/SSE：${String(text).slice(0, 160)}`)
  if (envelope.error) {
    throw new Error(`${label} JSON-RPC error ${envelope.error.code ?? '?'}: ${envelope.error.message || 'unknown'}`)
  }
  const result = envelope.result
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new Error(`${label} 响应缺少 result`)
  }
  if (result.isError) {
    const errText = mcpContentText(result)
    throw new Error(`${label} tool error: ${errText.slice(0, 200) || 'unknown'}`)
  }
  return result
}

/** 解析 “Title: … / URL: … / Snippets: …” 文本块（Exa/Keenable MCP） */
export function parseTitleBlocks(text, { snippetsKey = 'Snippets' } = {}) {
  const blocks = String(text || '').split(/\n(?=Title:)/)
  const out = []
  for (const block of blocks) {
    const title = block.match(/^Title:\s*(.+)$/m)?.[1]?.trim()
    const url = block.match(/^URL:\s*(\S+)$/m)?.[1]?.trim()
    if (!url) continue
    const published = block.match(/^Published:\s*(.+)$/m)?.[1]?.trim()
    const snippets = block.split(new RegExp(`^${snippetsKey}:\\s*$`, 'm'))[1]
      ?.split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 3)
      .join(' ')
    out.push({
      title: title || '',
      url,
      content: snippets || '',
      ...(published && /^\d{4}-\d{2}-\d{2}/.test(published) ? { published } : {}),
    })
  }
  return out
}

/** 解析 Parallel MCP 返回的 JSON 结果块 */
export function parseParallelResult(text) {
  const blocks = String(text || '').split(/\n(?=\{)/)
  for (const block of blocks) {
    try {
      const data = JSON.parse(block)
      if (Array.isArray(data?.results)) return data.results
    } catch { /* noop */ }
  }
  const direct = tryJson(text)
  return Array.isArray(direct?.results) ? direct.results : []
}

/* 供 provider 复用的小工具 */
export function cleanText(s) {
  return String(s || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
}

export function queryTokens(query) {
  const q = String(query || '').toLowerCase()
  const cjk = q.match(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) || []
  const words = q.replace(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/g, ' ').match(/[a-z0-9]{2,}/g) || []
  const out = new Set(words)
  for (let i = 0; i < cjk.length - 1; i++) out.add(cjk[i] + cjk[i + 1])
  if (!out.size && cjk.length) out.add(cjk[0])
  return [...out]
}

/** HTML/聚合引擎的“结果与本查询是否沾边”粗检：避免把 Bing 的无关缓存页当结果 */
export function looksRelevant(query, results) {
  const tokens = queryTokens(query)
  if (!tokens.length) return true
  let hits = 0
  for (const r of results || []) {
    const hay = `${r.title || ''} ${r.content || ''} ${r.url || ''}`.toLowerCase()
    if (tokens.some((t) => hay.includes(t))) hits++
  }
  return hits >= Math.max(1, Math.ceil((results?.length || 0) / 3))
}
