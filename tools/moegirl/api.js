/**
 * 萌娘百科只读 API 客户端。
 *
 * 两条通道（参考移动端逆向报告）：
 *  1. gRPC `grpc.moegirl.org.cn`：词条/帖子搜索、帖子详情、首页混合流、词条摘要；
 *  2. MediaWiki `mobile.moegirl.org.cn/api.php`：全文搜索 + 词条纯文本正文
 *     （Cloudflare 对 *.php 放行）。
 *
 * 所有函数只读、无登录态、带 300ms 级限速与短 TTL 缓存。
 * 注意：MediaWiki / gRPC 都可能在响应体发完后不主动关连接，这里用静默窗口收尾。
 */
import http from 'node:http'
import https from 'node:https'
import zlib from 'node:zlib'
import { callOk, decode, all, one, s, num, textOf, strOrMsg, isText, tryMsg, wire } from './grpc.js'
import {
  asText, deltaToText, deltaMedia, stripHtml, truncate,
  isoTime, formatPageUrl, clampInt, uniqueBy,
} from './format.js'

const DEFAULTS = {
  host: 'grpc.moegirl.org.cn',
  wikiBase: 'https://mobile.moegirl.org.cn',
  timeoutMs: 15000,
  minIntervalMs: 300,
  cacheTtlMs: 120000,
  userAgent: 'agents-plugin-moegirl/1.0',
}

export class MoegirlError extends Error {
  constructor(message, code = 'moegirl_error', extra = {}) {
    super(message)
    this.name = 'MoegirlError'
    this.code = code
    Object.assign(this, extra)
  }
}

function normalizeOpts(o = {}) {
  let wikiBase = String(o.wikiBase || DEFAULTS.wikiBase).trim().replace(/\/+$/, '')
  if (wikiBase && !/^https?:\/\//i.test(wikiBase)) wikiBase = 'https://' + wikiBase
  return {
    host: String(o.host || DEFAULTS.host).replace(/^https?:\/\//i, '').replace(/\/.*$/, '') || DEFAULTS.host,
    wikiBase: wikiBase || DEFAULTS.wikiBase,
    timeoutMs: clampInt(o.timeoutMs, 3000, 60000, DEFAULTS.timeoutMs),
    minIntervalMs: clampInt(o.minIntervalMs, 0, 5000, DEFAULTS.minIntervalMs),
    cacheTtlMs: clampInt(o.cacheTtlMs, 0, 3600000, DEFAULTS.cacheTtlMs),
    userAgent: String(o.userAgent || '').trim() || DEFAULTS.userAgent,
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 全局启动间隔：即使并发调用，也把实际发起时间串行化并保持 minIntervalMs
let _gate = Promise.resolve()
let _lastStart = 0
function rateLimit(minIntervalMs) {
  const wait = _gate.then(async () => {
    const delay = Math.max(0, _lastStart + minIntervalMs - Date.now())
    if (delay) await sleep(delay)
    _lastStart = Date.now()
  })
  _gate = wait.catch(() => {})
  return wait
}

// 短 TTL 缓存（存 Promise，失败立即删除）
const _cache = new Map()
function cached(key, ttlMs, fn) {
  if (!ttlMs) return Promise.resolve().then(fn)
  const hit = _cache.get(key)
  if (hit && Date.now() - hit.at < ttlMs) return hit.value
  const value = Promise.resolve().then(fn)
  _cache.set(key, { at: Date.now(), value })
  if (_cache.size > 200) {
    const first = _cache.keys().next().value
    _cache.delete(first)
  }
  value.catch(() => _cache.delete(key))
  return value
}

/** 清空进程内缓存（测试/诊断用） */
export function clearCache() { _cache.clear() }

async function grpc(method, payload, opts) {
  const o = normalizeOpts(opts)
  await rateLimit(o.minIntervalMs)
  const args = { host: o.host, timeoutMs: o.timeoutMs, userAgent: o.userAgent }
  try {
    return await callOk(method, payload, args)
  } catch (e) {
    // 网关偶发连接重置；非业务 grpc-status 错误时重试一次
    if (e?.status !== undefined || e?.name === 'GrpcError') throw e
    await sleep(400)
    return callOk(method, payload, args)
  }
}

/* ────────────────────────── gRPC 业务解析 ────────────────────────── */

export async function searchEntries(query, opts = {}) {
  const q = asText(query)
  if (!q) throw new MoegirlError('搜索关键词不能为空', 'bad_query')
  const o = normalizeOpts(opts)
  return cached(`entry|${o.host}|${q}`, o.cacheTtlMs, async () => {
    const buf = await grpc('/moegirl.moepad.MoepadService/SearchEntry', wire.encString(1, q), o)
    const top = decode(buf)
    const entries = all(top, 1).map(decode).map((e) => {
      const comments = [
        ...all(e, 15).map(decode).map((c) => ({
          text: textOf(one(c, 1)) || '',
          user: s(c, 2) || '',
          userId: s(c, 6) || '',
        })),
        ...all(e, 9).filter((v) => Buffer.isBuffer(v)).map((v) => {
          const m = tryMsg(v)
          return m ? null : { text: v.toString('utf8'), user: '', userId: '' }
        }).filter(Boolean),
      ].filter((c) => c.text)
      return {
        pageId: num(e, 1),
        title: s(e, 3) || '',
        image: s(e, 2) || '',
        summary: textOf(one(e, 4)) || '',
        tags: all(e, 5).filter((v) => Buffer.isBuffer(v)).map((v) => v.toString('utf8')).filter(Boolean),
        url: s(e, 6) || '',
        score: num(e, 7),
        hot: num(e, 8),
        comments: uniqueBy(comments, (c) => `${c.user}|${c.text}`),
      }
    }).filter((e) => e.title)
    const related = all(top, 3).map(decode).map((e) => ({
      pageId: num(e, 1),
      title: s(e, 2) || '',
      summary: textOf(one(e, 3)) || '',
      url: s(e, 4) || '',
    })).filter((e) => e.title)
    return { query: q, total: num(top, 2), entries, related }
  })
}

export async function searchArticles(query, pageSize = 10, opts = {}) {
  const q = asText(query)
  if (!q) throw new MoegirlError('搜索关键词不能为空', 'bad_query')
  const n = clampInt(pageSize, 1, 20, 10)
  const o = normalizeOpts(opts)
  return cached(`posts|${o.host}|${q}|${n}`, o.cacheTtlMs, async () => {
    const buf = await grpc(
      '/moegirl.moepad.MoepadCommunityService/SearchArticles',
      Buffer.concat([wire.encString(1, q), wire.encVarint(3, n)]),
      o,
    )
    const top = decode(buf)
    const posts = all(top, 1).map(decode).map((p) => {
      const rawContent = strOrMsg(one(p, 2)) || ''
      const contentText = deltaToText(rawContent)
      const summary = textOf(one(p, 4)) || contentText
      return {
        id: s(p, 1) || '',
        author: strOrMsg(one(p, 6)) || '',
        authorId: num(p, 5),
        avatar: s(p, 7) || '',
        community: strOrMsg(one(p, 8)) || '',
        topic: s(p, 11) || '',
        summary,
        contentText,
        image: s(p, 3) || '',
        likes: s(p, 10) || '',
        commentCount: num(p, 14),
        createdAt: (() => {
          const ts = one(p, 13)
          if (!ts || !Buffer.isBuffer(ts)) return null
          try { return isoTime(num(decode(ts), 1) * 1000) } catch { return null }
        })(),
      }
    }).filter((p) => p.id)
    return { query: q, posts }
  })
}

/** 首页混合流（词条 + 动态卡片） */
export async function getFeed(opts = {}) {
  const o = normalizeOpts(opts)
  return cached(`feed|${o.host}`, o.cacheTtlMs, async () => {
    const buf = await grpc('/moegirl.moepad.MoepadService/GetMixedFeedData', wire.encVarint(1, 1), o)
    const top = decode(buf)
    const isDelta = (v) => Buffer.isBuffer(v) && /^\s*\[/.test(v.toString('utf8')) && v.toString('utf8').includes('insert')
    const looksLikeMoment = (f) => f.some((x) => x.field === 7 && isDelta(x.value)) ||
      f.some((x) => x.field === 19 && Buffer.isBuffer(x.value) && /\|/.test(x.value.toString('utf8')))
    const looksLikeEntry = (f) => {
      const url = f.find((x) => x.field === 6 && Buffer.isBuffer(x.value))
      return !!(url && /moegirl\.org\.cn/.test(url.value.toString('utf8')) && f.some((x) => x.field === 3))
    }
    const tsOf = (v) => {
      if (!Buffer.isBuffer(v)) return null
      try { return isoTime(num(decode(v), 1) * 1000) } catch { return null }
    }
    const found = []
    const walk = (sub, depth = 0) => {
      if (depth > 8) return
      const f = decode(sub)
      if (looksLikeMoment(f)) { found.push({ kind: 'moment', f }); return }
      if (looksLikeEntry(f)) { found.push({ kind: 'entry', f }); return }
      for (const x of f) {
        if (x.wire === 2 && Buffer.isBuffer(x.value) && x.value.length > 2) {
          try { walk(x.value, depth + 1) } catch { /* noop */ }
        }
      }
    }
    for (const card of all(top, 1)) {
      if (!Buffer.isBuffer(card)) continue
      try { walk(card) } catch { /* noop */ }
    }
    const cards = []
    const seen = new Set()
    for (const { kind, f } of found) {
      if (kind === 'moment') {
        const raw = one(f, 7)
        const delta = (() => {
          if (!isDelta(raw)) return null
          try { return JSON.parse(raw.toString('utf8')) } catch { return null }
        })()
        const id = strOrMsg(one(f, 1)) || (num(f, 1) != null ? String(num(f, 1)) : '')
        if (!id || seen.has('m' + id)) continue
        seen.add('m' + id)
        cards.push({
          kind: 'moment',
          id,
          author: strOrMsg(one(f, 5)) || strOrMsg(one(f, 23)) || '',
          authorId: num(f, 6),
          topic: strOrMsg(one(f, 25)) || '',
          image: strOrMsg(one(f, 20)) || '',
          avatar: strOrMsg(one(f, 30)) || '',
          contentText: deltaToText(delta),
          media: deltaMedia(delta),
          createdAt: tsOf(one(f, 14)) || tsOf(one(f, 15)),
          ipLocation: strOrMsg(one(f, 19)) || '',
        })
      } else {
        const pageId = num(f, 1)
        if (!pageId || seen.has('e' + pageId)) continue
        seen.add('e' + pageId)
        cards.push({
          kind: 'entry',
          pageId,
          title: strOrMsg(one(f, 3)) || '',
          summary: textOf(one(f, 4)) || '',
          image: strOrMsg(one(f, 2)) || '',
          url: strOrMsg(one(f, 6)) || '',
          tags: all(f, 5).filter(isText).map((v) => v.toString('utf8')),
          commentCount: num(f, 10),
        })
      }
    }
    return { cards }
  })
}

export async function getPageInfo(title, opts = {}) {
  const t = asText(title)
  if (!t) throw new MoegirlError('词条名不能为空', 'bad_title')
  const o = normalizeOpts(opts)
  return cached(`pageinfo|${o.host}|${t}`, o.cacheTtlMs, async () => {
    const buf = await grpc('/moegirl.moepad.MoepadService/GetPageInfo', wire.encString(1, t), o)
    const top = decode(buf)
    const wrapped = one(top, 1)
    const e = Buffer.isBuffer(wrapped) && !isText(wrapped) ? decode(wrapped) : top
    return {
      pageId: num(e, 1),
      title: s(e, 3) || t,
      summary: textOf(one(e, 4)) || '',
      image: s(e, 2) || '',
      tags: all(e, 5).filter((v) => Buffer.isBuffer(v)).map((v) => v.toString('utf8')).filter(Boolean),
      url: s(e, 6) || formatPageUrl(o.wikiBase, t),
    }
  })
}

export async function getArticle(articleId, opts = {}) {
  const id = String(articleId ?? '').match(/\d+/)?.[0] || ''
  if (!id) throw new MoegirlError('帖子 id 必须是数字', 'bad_article_id')
  const o = normalizeOpts(opts)
  return cached(`article|${o.host}|${id}`, o.cacheTtlMs, async () => {
    const buf = await grpc(
      '/moegirl.moepad.MoepadCommunityService/GetArticleByIdWithUserInfo',
      wire.encString(2, id),
      o,
    )
    const top = decode(buf)
    let a = one(top, 1) ? decode(one(top, 1)) : []
    for (let guard = 0; guard < 3; guard++) {
      const child = one(a, 1)
      if (Buffer.isBuffer(child) && !isText(child)) a = decode(child)
      else break
    }
    const rawDelta = s(a, 7) || ''
    let delta = null
    try { delta = rawDelta ? JSON.parse(rawDelta) : null } catch { delta = null }
    return {
      id: s(a, 1) || id,
      shortId: s(a, 4) || '',
      author: s(a, 5) || '',
      authorId: num(a, 6),
      contentText: deltaToText(delta || rawDelta),
      media: deltaMedia(delta || rawDelta),
      type: num(a, 8),
      createdAt: one(a, 14) && Buffer.isBuffer(one(a, 14)) ? (() => { try { return isoTime(num(decode(one(a, 14)), 1) * 1000) } catch { return null } })() : null,
      updatedAt: one(a, 15) && Buffer.isBuffer(one(a, 15)) ? (() => { try { return isoTime(num(decode(one(a, 15)), 1) * 1000) } catch { return null } })() : null,
      ipLocation: s(a, 19) || '',
      community: s(a, 25) || '',
      avatar: s(a, 30) || '',
    }
  })
}

/* ────────────────────────── MediaWiki API ────────────────────────── */

function wikiUrl(base, params) {
  const root = String(base || DEFAULTS.wikiBase).replace(/\/+$/, '')
  const u = new URL('/api.php', root + '/')
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) u.searchParams.set(k, String(v))
  }
  return u.toString()
}

function decodeBody(body, encoding) {
  const enc = String(encoding || '').toLowerCase()
  if (!enc || enc === 'identity') return body
  try {
    if (enc.includes('gzip')) return zlib.gunzipSync(body)
    if (enc.includes('br')) return zlib.brotliDecompressSync(body)
    if (enc.includes('deflate')) return zlib.inflateSync(body)
    if (enc.includes('zstd') && typeof zlib.zstdDecompressSync === 'function') return zlib.zstdDecompressSync(body)
  } catch (e) {
    throw new MoegirlError(`响应解压失败：${e?.message || e}`, 'decode_error')
  }
  return body
}

/** 读取文本响应：服务端不关连接时，最后一块数据后静默 quietMs 收尾 */
function httpText(url, opts = {}) {
  const { timeoutMs = DEFAULTS.timeoutMs, userAgent = DEFAULTS.userAgent, quietMs = 1500 } = opts
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('http:') ? http : https
    let done = false
    let hardTimer
    let quietTimer
    const chunks = []
    const req = lib.get(url, {
      headers: {
        'user-agent': userAgent,
        'accept': 'application/json, text/plain, */*',
        'accept-language': 'zh-CN,zh;q=0.9',
        'accept-encoding': 'identity',
      },
    }, (res) => {
      const finish = (err) => {
        if (done) return
        done = true
        clearTimeout(hardTimer)
        if (quietTimer) clearTimeout(quietTimer)
        try { req.destroy() } catch { /* noop */ }
        if (err) return reject(err)
        try {
          const body = decodeBody(Buffer.concat(chunks), res.headers['content-encoding'])
          resolve({ status: res.statusCode || 0, headers: res.headers, body })
        } catch (e) { reject(e) }
      }
      hardTimer = setTimeout(() => finish(new MoegirlError('萌娘百科请求超时', 'timeout')), timeoutMs)
      res.on('data', (c) => {
        chunks.push(c)
        if (quietTimer) clearTimeout(quietTimer)
        quietTimer = setTimeout(() => finish(), quietMs)
      })
      res.on('end', () => finish())
      res.on('error', (e) => finish(new MoegirlError(`萌娘百科响应错误：${e?.message || e}`, 'http_error')))
    })
    req.on('error', (e) => {
      if (done) return
      done = true
      clearTimeout(hardTimer)
      if (quietTimer) clearTimeout(quietTimer)
      reject(new MoegirlError(`萌娘百科请求失败：${e?.message || e}`, 'network_error'))
    })
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')))
  })
}

async function wikiJson(url, opts = {}) {
  const o = normalizeOpts(opts)
  await rateLimit(o.minIntervalMs)
  let lastErr = null
  for (let attempt = 0; attempt < 2; attempt++) {
    let r
    try {
      r = await httpText(url, { timeoutMs: o.timeoutMs, userAgent: o.userAgent, quietMs: attempt ? 2500 : 1500 })
    } catch (e) {
      lastErr = e
      if (attempt === 0) { await sleep(400); continue }
      throw e
    }
    if (!r.status || r.status < 200 || r.status >= 300) {
      throw new MoegirlError(`萌娘百科 API HTTP ${r.status || '?'}`, 'wiki_http', { status: r.status })
    }
    const raw = r.body.toString('utf8')
    try {
      const json = JSON.parse(raw)
      if (json?.error) throw new MoegirlError(`萌娘百科 API：${json.error.info || json.error.code || '未知错误'}`, 'wiki_api')
      return json
    } catch (e) {
      lastErr = e
      if (e instanceof MoegirlError) throw e
      // 服务端不关连接时可能读到半截 JSON；静默窗口加大后再试一次
      if (attempt === 0) continue
    }
  }
  throw new MoegirlError(`萌娘百科 API 响应解析失败：${lastErr?.message || lastErr}`, 'wiki_json')
}

function pageFromQuery(json) {
  const pages = json?.query?.pages
  if (Array.isArray(pages)) return pages[0] || null
  if (pages && typeof pages === 'object') return Object.values(pages)[0] || null
  return null
}

/** 词条纯文本正文（MediaWiki extracts；表格/模板可能省略） */
export async function getPageExtract(title, { introOnly = false, maxChars = 12000 } = {}, opts = {}) {
  const t = asText(title)
  if (!t) throw new MoegirlError('词条名不能为空', 'bad_title')
  const o = normalizeOpts(opts)
  const max = clampInt(maxChars, 1000, 30000, 12000)
  const key = `extract|${o.wikiBase}|${t}|${introOnly ? 1 : 0}|${max}`
  return cached(key, o.cacheTtlMs, async () => {
    const url = wikiUrl(o.wikiBase, {
      action: 'query',
      prop: 'extracts',
      explaintext: 1,
      exlimit: 1,
      redirects: 1,
      ...(introOnly ? { exintro: 1 } : {}),
      titles: t,
      format: 'json',
      formatversion: 2,
    })
    const json = await wikiJson(url, o)
    const page = pageFromQuery(json)
    if (!page) throw new MoegirlError(`未找到词条「${t}」`, 'page_missing')
    if (page.missing !== undefined || page.invalid !== undefined) {
      throw new MoegirlError(`未找到词条「${t}」`, 'page_missing')
    }
    const actualTitle = asText(page.title) || t
    const raw = asText(page.extract)
    const cut = truncate(raw, max)
    return {
      pageId: page.pageid,
      title: actualTitle,
      extract: cut.text,
      truncated: cut.truncated,
      originalLength: cut.originalLength,
      introOnly: !!introOnly,
      url: formatPageUrl(o.wikiBase, actualTitle),
    }
  })
}

/** MediaWiki 全文搜索（覆盖比 gRPC 精选结果更广） */
export async function searchFullText(query, limit = 10, opts = {}) {
  const q = asText(query)
  if (!q) throw new MoegirlError('搜索关键词不能为空', 'bad_query')
  const n = clampInt(limit, 1, 20, 10)
  const o = normalizeOpts(opts)
  return cached(`fulltext|${o.wikiBase}|${q}|${n}`, o.cacheTtlMs, async () => {
    const url = wikiUrl(o.wikiBase, {
      action: 'query',
      list: 'search',
      srsearch: q,
      srlimit: n,
      srprop: 'snippet|titlesnippet',
      srinfo: 'totalhits',
      format: 'json',
      formatversion: 2,
    })
    const json = await wikiJson(url, o)
    const results = (json?.query?.search || []).map((r) => ({
      pageId: r.pageid,
      title: asText(r.title),
      snippet: stripHtml(r.snippet || ''),
      url: formatPageUrl(o.wikiBase, r.title),
    })).filter((r) => r.title)
    return {
      query: q,
      total: json?.query?.searchinfo?.totalhits ?? results.length,
      results,
    }
  })
}

/**
 * 词条聚合：gRPC 摘要/封面/标签 + MediaWiki 正文。
 * 任一通道失败时保留另一通道结果，并在 warnings 里说明。
 */
export async function getPageBundle(title, { introOnly = false, maxChars = 12000 } = {}, opts = {}) {
  const t = asText(title)
  if (!t) throw new MoegirlError('词条名不能为空', 'bad_title')
  const o = normalizeOpts(opts)
  const [infoR, extractR] = await Promise.allSettled([
    getPageInfo(t, o),
    getPageExtract(t, { introOnly, maxChars }, o),
  ])
  const info = infoR.status === 'fulfilled' ? infoR.value : null
  const extract = extractR.status === 'fulfilled' ? extractR.value : null
  if (!info && !extract) {
    const e = extractR.status === 'rejected' ? extractR.reason : infoR.reason
    throw e instanceof Error ? e : new MoegirlError(`未找到词条「${t}」`, 'page_missing')
  }
  const warnings = []
  if (infoR.status === 'rejected') warnings.push(`摘要/标签获取失败：${infoR.reason?.message || infoR.reason}`)
  if (extractR.status === 'rejected') warnings.push(`正文获取失败：${extractR.reason?.message || extractR.reason}`)
  else if (extract && !extract.extract) warnings.push('正文为空（页面可能只有模板/表格，或 extracts 未返回内容）')
  const actualTitle = extract?.title || info?.title || t
  return {
    title: actualTitle,
    pageId: extract?.pageId ?? info?.pageId,
    summary: info?.summary || extract?.extract?.slice(0, 300) || '',
    image: info?.image || '',
    tags: info?.tags || [],
    url: info?.url || extract?.url || formatPageUrl(o.wikiBase, actualTitle),
    extract: extract?.extract || '',
    truncated: extract?.truncated || false,
    originalLength: extract?.originalLength ?? 0,
    introOnly: !!introOnly,
    warnings,
  }
}

export { normalizeOpts }
