/**
 * 工具失败替代建议 —— 把「工具名」抽象成「能力」。
 *
 * 目标：LLM 不应把某个工具当成唯一通道。搜索接口挂了不代表不能联网，
 * 站内 API 鉴权失败也不代表拿不到内容——只要能换到「能力等价」的工具（直接抓网页、
 * 浏览器渲染、另一个搜索源），任务就能继续。
 *
 * 本模块做三件事：
 *  1. `toolCapabilities(tool)`：解析工具能力。优先读 `meta.capabilities`（扩展点），
 *     否则按工具名/描述推断，内置联网工具与第三方工具都能覆盖。
 *  2. `classifyToolFailure(content)`：把错误文本归一成 network/auth/rate_limit/not_found/...
 *     便于决定「重试同工具」还是「立刻换能力」。
 *  3. `enrichToolFailure(content, ...)`：在失败结果里追加 `_failure` / `_alternatives` / `_next`，
 *     让模型看到运行时真实可用的备选工具，而不是只有一句“失败了”。
 *
 * 设计约束：
 *  - 只做建议，不自动执行/不自动切换工具（工具语义不同，盲目替代可能产生副作用）。
 *  - 不向无权限用户泄露 system/群管类工具：传了 policy 时按当前 ctx 过滤 deny。
 *  - 建议列表排除 `meta.interactive`（交互/写类）与同一上游的重复入口，优先只读替代。
 */

export const CAP = Object.freeze({
  NET: 'net',
  NET_SEARCH: 'net.search',
  NET_FETCH: 'net.fetch',
  NET_BROWSE: 'net.browse',
  NET_DOWNLOAD: 'net.download',
})

const ALL_NET = [CAP.NET_SEARCH, CAP.NET_FETCH, CAP.NET_BROWSE, CAP.NET_DOWNLOAD]

/** 能力标签的中文检索词 —— 让 tool_search 搜“联网/网页/浏览器”也能命中。 */
const CAP_SEARCH_TERMS = {
  [CAP.NET]: ['联网', '网络', '上网', '互联网', '在线'],
  [CAP.NET_SEARCH]: ['搜索', '检索', '查询', '搜', '站内搜索', '搜索源'],
  [CAP.NET_FETCH]: ['抓取', '提取', '网页正文', '读取网页', '打开网页', 'URL', '链接', '直连'],
  [CAP.NET_BROWSE]: ['浏览器', '自动化', '动态渲染', 'JS 渲染', '点击', '页面交互'],
  [CAP.NET_DOWNLOAD]: ['下载', '音视频', '媒体文件'],
}

/** 显式 `meta.capabilities` 的别名归一（支持英文/中文标签）。 */
const CAP_ALIASES = new Map([
  ['network', [CAP.NET]], ['net', [CAP.NET]], ['联网', [CAP.NET]], ['网络', [CAP.NET]],
  ['search', [CAP.NET_SEARCH]], ['web_search', [CAP.NET_SEARCH]], ['搜索', [CAP.NET_SEARCH]], ['检索', [CAP.NET_SEARCH]],
  ['fetch', [CAP.NET_FETCH]], ['extract', [CAP.NET_FETCH]], ['http', [CAP.NET_FETCH]], ['抓取', [CAP.NET_FETCH]], ['提取', [CAP.NET_FETCH]],
  ['browse', [CAP.NET_BROWSE]], ['browser', [CAP.NET_BROWSE]], ['浏览器', [CAP.NET_BROWSE]],
  ['download', [CAP.NET_DOWNLOAD]], ['下载', [CAP.NET_DOWNLOAD]],
])

/** 名字一看就是联网工具的前缀/模式（第三方工具名也可被覆盖）。 */
const NETWORK_NAME_RE = /^(?:web_|crawl|stagehand__|bilibili__|miyoushe_|enka_|pixiv|download|weather)/i
/** 描述里的联网特征（用于没有 meta.capabilities 的第三方/MCP 工具）。 */
const NETWORK_DESC_RE = /联网|网络|网页|网站|互联网|在线|搜索|检索|抓取|爬取|浏览器|fetch|crawl|browse|browser|download|下载|\bweb\b|\binternet\b|\bonline\b|http|https|url|api|社区|百科|wiki|weather|天气/i
/** 本地检索工具即使描述里有“搜索/检索”，也不能被当成联网工具。 */
const LOCAL_ONLY_RE = /^(?:memory_search|kb_search|tool_search|context_recall|get_chat_history|get_note|get_group_file|get_group_file_url|list_group_files|get_group_notice|group_info|group_member|group_members|user_info|get_forward_msg|analyze_chat_record|read_attachment|read_excel|read_pdf|send_file)$/i

const SEARCH_RE = /search|搜索|检索|查询|排行榜|榜单|热门|popular|ranking/i
const DOWNLOAD_RE = /download|下载|音频|视频文件|媒体文件/i
const BROWSE_RE = /browse|browser|浏览器|goto|observe|动态渲染|点击|自动化|stagehand|页面交互|页面元素/i

function normalizeCaps(list) {
  const out = new Set()
  const items = Array.isArray(list) ? list : (list == null ? [] : [list])
  for (const raw of items) {
    const v = String(raw || '').trim().toLowerCase()
    if (!v) continue
    const mapped = CAP_ALIASES.get(v)
    if (mapped) for (const c of mapped) out.add(c)
    else out.add(v)
  }
  if (ALL_NET.some((c) => out.has(c))) out.add(CAP.NET)
  // 固定顺序，便于索引/日志/测试稳定：net → 具体能力 → 自定义标签
  const ordered = []
  if (out.has(CAP.NET)) ordered.push(CAP.NET)
  for (const c of ALL_NET) if (out.has(c)) ordered.push(c)
  for (const c of out) if (!ordered.includes(c)) ordered.push(c)
  return ordered
}

function inferCapabilities(tool) {
  const name = String(tool?.name || '').toLowerCase()
  const desc = String(tool?.description || '')
  const hay = `${name} ${desc}`
  if (LOCAL_ONLY_RE.test(name)) return []
  const explicit = normalizeCaps(tool?.meta?.capabilities)
  if (explicit.length) return explicit

  const network = NETWORK_NAME_RE.test(name) || NETWORK_DESC_RE.test(hay)
  if (!network) return []

  const caps = new Set([CAP.NET])
  if (SEARCH_RE.test(hay)) caps.add(CAP.NET_SEARCH)
  if (DOWNLOAD_RE.test(hay)) caps.add(CAP.NET_DOWNLOAD)
  if (BROWSE_RE.test(hay) || name.startsWith('stagehand__')) caps.add(CAP.NET_BROWSE)
  // 联网但不是搜索/下载 → 至少能按 URL 抓取/调 API；浏览器类工具同时具备抓取能力。
  if (!caps.has(CAP.NET_SEARCH) && !caps.has(CAP.NET_DOWNLOAD)) caps.add(CAP.NET_FETCH)
  return normalizeCaps([...caps])
}

/**
 * 工具能力列表。
 * @param {{name?:string, description?:string, meta?:object}} tool
 * @returns {string[]} 联网工具返回 `net` 或更具体标签；非联网工具返回空数组或自定义能力标签
 */
export function toolCapabilities(tool) {
  return inferCapabilities(tool)
}

/** 能力的中文检索词（拼进 tool_search 索引文本）。 */
export function capabilitySearchTerms(tool) {
  const out = []
  for (const c of toolCapabilities(tool)) {
    out.push(c, ...(CAP_SEARCH_TERMS[c] || []))
  }
  return [...new Set(out)]
}

function textOf(content) {
  if (content == null) return ''
  if (typeof content === 'string') {
    const s = content.trim()
    if (s.startsWith('{') || s.startsWith('[')) {
      try { return textOf(JSON.parse(s)) } catch { return s }
    }
    return s
  }
  if (typeof content === 'object') {
    const parts = []
    for (const k of ['error', 'reason', 'message', 'code', 'hint', 'detail', 'details']) {
      const v = content[k]
      if (v == null || v === '') continue
      parts.push(typeof v === 'object' ? JSON.stringify(v) : String(v))
    }
    return parts.join(' ')
  }
  return String(content)
}

const KIND_HINT = {
  network: '网络或上游服务不可达',
  auth: '认证/Key/Cookie/权限不足',
  rate_limit: '被限流或风控',
  not_found: '目标不存在或标识错误',
  invalid: '参数或 schema 不合法',
  blocked: '被安全策略或站点拦截',
  unavailable: '该能力未配置/未启用',
  unknown: '未知错误',
}

/**
 * 失败归类。顺序很重要：404/403/429 不能被宽泛的 HTTP 正则吞成 network。
 * @returns {{kind:string, retryable:boolean, hint:string}}
 */
export function classifyToolFailure(content) {
  const text = textOf(content)
  let kind = 'unknown'
  if (!text) return { kind, retryable: false, hint: KIND_HINT[kind] }

  // 强网络特征优先于错误码：搜索工具常用 code=search_unavailable，但 reason 明确写了
  // “所有搜索源均失败/fetch failed”，此时应归为 network 而不是配置缺失。
  if (/所有(?:搜索|提取)源均失败|所有源均失败|fetch failed|econn(?:refused|reset|aborted)|enotfound|eai_again|etimedout|esockettimeout|socket hang up|bad gateway|service unavailable|upstream|不可达|unreachable/i.test(text)) {
    kind = 'network'
  } else if (/无可用(?:搜索|提取)源|未配置任何搜索|not configured|未启用|未注册/i.test(text)) {
    kind = 'unavailable'
  } else if (/(?:^|\D)404(?:\D|$)|not found|不存在|找不到|无此(?:id|url|帖子|视频)|无效(?:的)?\s*(?:id|url|标识)/i.test(text)) {
    kind = 'not_found'
  } else if (/(?:^|\D)(?:401|403)(?:\D|$)|unauthorized|forbidden|api.?key|invalid.?token|未登录|need.?login|cookie|鉴权|认证失败|权限不足/i.test(text)) {
    kind = 'auth'
  } else if (/(?:^|\D)429(?:\D|$)|rate.?limit|too many requests|限流|风控|请求过于频繁/i.test(text)) {
    kind = 'rate_limit'
  } else if (/rejected_by|blocked|安全策略|已拒绝|拦截|forbidden by|访问被拒/i.test(text)) {
    kind = 'blocked'
  } else if (/invalid|schema|参数|required|missing|缺参|类型错误/i.test(text)) {
    kind = 'invalid'
  } else if (/network|网络|连接|断网|timeout|timed out|超时|dns|tls|certificate|http\s*5\d\d|connection|proxy/i.test(text)) {
    kind = 'network'
  } else if (/unavailable|not available/i.test(text)) {
    kind = 'unavailable'
  }

  return { kind, retryable: kind === 'network' || kind === 'rate_limit', hint: KIND_HINT[kind] }
}

function domainOf(name) {
  const n = String(name || '')
  if (n.includes('__')) return n.split('__')[0]
  const m = n.match(/^(miyoushe|bilibili|enka|pixiv|stagehand)_/)
  return m ? m[1] : ''
}

function requiredOf(tool) {
  const req = tool?.parameters?.required
  return Array.isArray(req) ? req.map(String).filter(Boolean) : []
}

function summaryOf(tool) {
  const raw = String(tool?.meta?.summary || tool?.description || '').replace(/\s+/g, ' ').trim()
  return raw.length > 60 ? `${raw.slice(0, 60)}…` : raw
}

function whyOf(caps) {
  if (caps.includes(CAP.NET_BROWSE)) return '浏览器打开/渲染动态页面，可绕开不可用的搜索接口'
  if (caps.includes(CAP.NET_FETCH)) return '按 URL 直接抓取正文，不依赖搜索接口'
  if (caps.includes(CAP.NET_SEARCH)) return '换一个独立搜索源或站内检索入口'
  if (caps.includes(CAP.NET_DOWNLOAD)) return '直接下载媒体文件'
  return '同类联网能力'
}

function scoreOf(candidate, failedCaps, kind, failedName) {
  const caps = candidate.caps
  let score = 0
  if (kind === 'not_found') {
    if (caps.includes(CAP.NET_SEARCH)) score += 10
    if (caps.includes(CAP.NET_FETCH)) score += 4
    if (caps.includes(CAP.NET_BROWSE)) score += 3
  } else if (kind === 'auth' || kind === 'unavailable') {
    if (caps.includes(CAP.NET_SEARCH)) score += 8
    if (caps.includes(CAP.NET_FETCH)) score += 7
    if (caps.includes(CAP.NET_BROWSE)) score += 6
    if (caps.includes(CAP.NET_DOWNLOAD)) score += 2
  } else {
    if (caps.includes(CAP.NET_FETCH)) score += 9
    if (caps.includes(CAP.NET_BROWSE)) score += 8
    if (caps.includes(CAP.NET_SEARCH)) score += 6
    if (caps.includes(CAP.NET_DOWNLOAD)) score += 2
  }

  // 与失败工具能力互补：搜索挂了优先直连网页，抓取挂了优先换浏览器/另一搜索源。
  if (failedCaps.includes(CAP.NET_SEARCH)) {
    if (caps.includes(CAP.NET_FETCH)) score += 3
    if (caps.includes(CAP.NET_BROWSE)) score += 2
  }
  if (failedCaps.includes(CAP.NET_FETCH)) {
    if (caps.includes(CAP.NET_BROWSE)) score += 3
    if (caps.includes(CAP.NET_SEARCH)) score += 2
  }
  if (failedCaps.includes(CAP.NET_BROWSE)) {
    if (caps.includes(CAP.NET_FETCH)) score += 3
    if (caps.includes(CAP.NET_SEARCH)) score += 2
  }

  // 搜索失败时，需要现成 id 的工具（帖子ID/视频号/UID）通常用不上：模型手里没有 id，
  // 反而需要先搜索。带 url/query 参数或不带必填参数的工具更适合直接接班。
  if (failedCaps.includes(CAP.NET_SEARCH)) {
    const req = requiredOf(candidate.tool)
    const idLike = req.some((r) => /(?:^|_)(?:id|postid|video|mid|uid|bvid|avid|character|user)$/i.test(r))
    const selfSufficient = req.length === 0 || req.some((r) => /(?:^|_)(?:query|queries|keyword|q|url|urls|text|instruction)$/i.test(r))
    if (idLike && !selfSufficient) score -= 4
  }

  // 同一上游大概率一起挂；但“找不到 id/URL”时同站搜索恰恰是最优解。
  const sameDomain = !!failedName && domainOf(candidate.tool.name) && domainOf(candidate.tool.name) === domainOf(failedName)
  if (sameDomain) {
    if (kind === 'not_found' && caps.includes(CAP.NET_SEARCH)) score += 4
    else if (kind === 'network' || kind === 'auth' || kind === 'rate_limit' || kind === 'unavailable') score -= 8
  }

  if (candidate.tool.category === 'query' || candidate.tool.category === 'personal') score += 2
  if (candidate.tool.category === 'system') score -= 1
  return score
}

/**
 * 找出能力等价的替代工具（只读优先、排除交互/写类与当前角色无权使用的工具）。
 * @param {object} p
 * @param {object} p.registry ToolRegistry
 * @param {object} [p.failedTool] 失败工具（可为合成对象 `{name}`；用于推断能力）
 * @param {*} [p.content] 失败结果，用于识别失败类型
 * @param {object} [p.ctx] 当前用户上下文
 * @param {object} [p.policy] RBAC 策略（有 ctx 时过滤 deny）
 * @param {number} [p.limit=4]
 * @returns {Array<{name:string, summary:string, why:string, required:string[], category:string, confirm:boolean}>}
 */
export function suggestAlternativeTools({ registry, failedTool, content, ctx, policy, limit = 4 } = {}) {
  const failedCaps = toolCapabilities(failedTool)
  if (!failedCaps.includes(CAP.NET)) return []
  const failedName = String(failedTool?.name || '')
  const { kind } = classifyToolFailure(content)
  const out = []

  for (const tool of registry?.list?.() || []) {
    if (!tool || !tool.name || tool.name === failedName) continue
    if (tool.meta?.interactive === true) continue // 交互/写类不自动推荐（可能改变页面或外部状态）
    const caps = toolCapabilities(tool)
    if (!caps.includes(CAP.NET)) continue
    // 纯下载工具不是搜索/抓取失败的有效替代（除非失败本身也在下载链路）
    if (caps.includes(CAP.NET_DOWNLOAD) && !caps.some((c) => c !== CAP.NET && c !== CAP.NET_DOWNLOAD) && !failedCaps.includes(CAP.NET_DOWNLOAD)) continue
    // 没有 ctx（子代理/内嵌调用）时只建议人人可用的只读类别，避免把 system/群管工具名带到无权限上下文
    if (!ctx && tool.category !== 'query' && tool.category !== 'personal') continue
    if (policy && ctx) {
      // 策略异常时保守跳过该候选，避免把无权限工具名带到当前上下文。
      try { if (policy.decide(ctx, tool).decision === 'deny') continue } catch { continue }
    }
    const score = scoreOf({ tool, caps }, failedCaps, kind, failedName)
    if (score <= 0) continue
    out.push({
      tool,
      caps,
      score,
      item: {
        name: tool.name,
        summary: summaryOf(tool),
        why: whyOf(caps),
        required: requiredOf(tool),
        category: tool.category || 'system',
        confirm: tool.category !== 'query' && tool.category !== 'personal',
      },
    })
  }

  out.sort((a, b) => b.score - a.score || String(a.tool.name).localeCompare(String(b.tool.name)))
  return out.slice(0, Math.max(1, Math.min(8, Number(limit) || 4))).map((x) => x.item)
}

function nextText(failedName, alternatives, diagnosis) {
  const names = alternatives.map((a) => a.name).join(' / ')
  if (alternatives.length) {
    const retry = diagnosis.retryable
      ? '若判断只是瞬时网络抖动，可对原工具同参数再试 1 次；仍失败就切换。'
      : '这类错误重试原工具通常无效，直接切换。'
    return `不要对「${failedName || '该工具'}」同参数反复空转。按能力换用备选：${names}（优先第一个）。${retry}若连续两个联网备选也因网络类错误失败，基本可判定网络整体不可用，直接如实说明，不要继续穷举。`
  }
  if (diagnosis.kind === 'network' || diagnosis.kind === 'unavailable') {
    return '当前没有已注册的可用联网替代工具；先用 tool_search 搜“联网/网页/浏览器/下载”确认能力，仍没有就如实告知用户该能力暂不可用。'
  }
  if (diagnosis.kind === 'not_found') {
    return '先换用搜索类工具确认正确的 id/URL/名称，不要反复猜同一个参数。'
  }
  if (diagnosis.kind === 'auth') {
    return '优先改用无需该凭据的工具；确需凭据时如实告知用户去配置，不要绕过鉴权。'
  }
  return '换关键词、参数或能力等价的工具再试；不要反复重试同一条失败路径。'
}

function mergeHint(base, hint) {
  const b = String(base || '').trim()
  const h = String(hint || '').trim()
  if (!h) return b || undefined
  if (!b) return h
  return b.includes(h) ? b : `${b} ${h}`
}

/**
 * 在失败结果上追加结构化诊断与替代建议。
 * @param {*} content 工具失败结果（JSON 字符串/对象/文本）
 * @param {object} opts `{ tool, registry, ctx, policy, hint, limit }`
 * @returns {object|null} 可序列化的失败对象；非错误文本返回 null（调用方保留原处理）
 */
export function enrichToolFailure(content, { tool, registry, ctx, policy, hint, limit = 4 } = {}) {
  let raw = content
  if (typeof content === 'string') {
    try { raw = JSON.parse(content) } catch {
      // MCP 约定：纯文本错误以 `Error:` / `error:` 开头。包成结构化错误后才能附诊断与替代建议；
      // 其它非错误文本保持原样（返回 null，由调用方按旧逻辑处理）。
      if (!/^error\b/i.test(content.trim())) return null
      raw = { error: content.trim() }
    }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null

  const diagnosis = classifyToolFailure(raw)
  const failedName = String(tool?.name || raw?.tool || '')
  const failedTool = tool || { name: failedName }
  const isNetwork = toolCapabilities(failedTool).includes(CAP.NET)
  const alternatives = isNetwork
    ? suggestAlternativeTools({ registry, failedTool, content: raw, ctx, policy, limit })
    : []
  const missingTool = !!failedName && failedName !== 'tool_search' && typeof registry?.has === 'function' && !registry.has(failedName)
  const out = { ...raw }
  // 非联网工具的非网络错误（参数校验、业务拒绝等）保持原样：只加 _hint，不塞无关的换工具建议，
  // 避免把“按提示修正参数”带偏成“换一个工具”。联网故障/未知工具才给诊断与下一步。
  if (isNetwork || diagnosis.kind !== 'unknown') out._failure = { kind: diagnosis.kind, retryable: diagnosis.retryable }
  if (!Array.isArray(out._alternatives) && alternatives.length) out._alternatives = alternatives
  if (missingTool && !alternatives.length) out._next = `工具「${failedName}」未注册或当前不可用：先用 tool_search 按自然语言/能力查找可用工具，不要假设它存在。`
  else if (isNetwork) out._next = nextText(failedName, alternatives, diagnosis)
  if (hint) out._hint = mergeHint(out._hint, hint)
  return out
}
