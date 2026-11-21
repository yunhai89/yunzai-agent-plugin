/** Bing 免费 HTML 搜索（零 key；中文/英文按 Accept-Language 本地化） */
import { stripHtml } from '../../agent/tools/web.js'
import { cleanText, looksRelevant } from '../mcp.js'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'

function decodeBingUrl(href) {
  let url = String(href || '').replace(/&amp;/g, '&')
  if (!/^https?:\/\/(www\.)?bing\.com\/ck\/a/i.test(url)) return url
  try {
    const u = new URL(url).searchParams.get('u')
    if (!u) return url
    const b64 = u.startsWith('a1') ? u.slice(2) : u
    const decoded = Buffer.from(b64.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
    return /^https?:\/\//i.test(decoded) ? decoded : url
  } catch { return url }
}

export function parseBingHtml(html, limit = 10) {
  const results = []
  const seen = new Set()
  const push = (title, href, snippet) => {
    const url = decodeBingUrl(href)
    if (!/^https?:\/\//i.test(url) || seen.has(url)) return
    let host = ''
    try { host = new URL(url).hostname } catch { return }
    if (/(^|\.)bing\.com$|(^|\.)microsoft\.com$|(^|\.)msn\.com$/i.test(host)) return
    const t = stripHtml(title)
    if (!t) return
    seen.add(url)
    results.push({ title: t, url, content: cleanText(stripHtml(snippet)) })
  }

  const blocks = html.match(/<li\s+class="b_algo[\s\S]*?<\/li>/gi) || []
  for (const block of blocks) {
    const link = /<h2[^>]*>[\s\S]*?<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block)
    if (!link) continue
    const snippet = /<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(block)
    push(link[2], link[1], snippet?.[1] || '')
    if (results.length >= limit) break
  }
  if (!results.length) {
    const anchor = /<a\b[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
    let m
    while ((m = anchor.exec(html)) && results.length < limit) {
      if (/(bing|microsoft|msn|live)\.com/i.test(m[1])) continue
      push(m[2], m[1], '')
    }
  }
  return results
}

export function createBingProvider({ fetcher, timeout = 15000, bingMarket = '', lang = 'zh' } = {}) {
  const f = fetcher || globalThis.fetch
  return {
    name: 'bing',
    free: true,
    available: () => true,
    async search(query, options = {}) {
      if (!f) throw new Error('Bing 缺少 fetcher')
      const params = new URLSearchParams({ q: query })
      const market = options.bingMarket || bingMarket
      if (market) params.set('mkt', market)
      const adlt = options.safe_search || options.safeSearch || 'off'
      params.set('adlt', adlt === 'strict' ? 'strict' : adlt === 'moderate' ? 'moderate' : 'off')
      const acceptLang = market === 'zh-CN' || (!market && String(lang).startsWith('zh'))
        ? 'zh-CN,zh;q=0.9,en;q=0.8'
        : 'en-US,en;q=0.9'
      const res = await f(`https://www.bing.com/search?${params}`, {
        headers: {
          'user-agent': UA,
          'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'accept-language': acceptLang,
        },
        signal: AbortSignal.timeout(timeout),
      })
      if (res.ok === false || res.status >= 400) throw new Error(`Bing HTTP ${res.status}`)
      const html = await res.text()
      if (/captcha|unusual traffic|verify you are human/i.test(html.slice(0, 4000)) && !/b_algo/i.test(html)) {
        throw new Error('Bing 返回验证码/反爬页')
      }
      const results = parseBingHtml(html, options.max_results || 10)
      const relevant = results.length ? (looksRelevant(query, results) ? results : []) : []
      return { provider: 'bing', query, answer: null, results: relevant, citations: null, raw: { bytes: html.length } }
    },
  }
}
