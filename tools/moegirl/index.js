/**
 * 萌娘百科外置工具包。
 *
 * 接口来源：萌娘百科移动端逆向调研（gRPC + MediaWiki 只读接口）。
 *  - 词条/帖子搜索、帖子详情、首页混合流：grpc.moegirl.org.cn（HTTP/2 + protobuf）
 *  - 全文搜索、词条正文：mobile.moegirl.org.cn/api.php（Cloudflare 对 *.php 放行）
 *
 * 工具：
 *  - moegirl__search       词条精选搜索 / MediaWiki 全文搜索
 *  - moegirl__page         词条摘要 + 纯文本正文
 *  - moegirl__post_search  社区帖子搜索
 *  - moegirl__post         帖子详情
 *  - moegirl__feed         首页混合流（词条 + 动态）
 *
 * 只读、无需登录；带 minIntervalMs 限速与短 TTL 缓存。
 * 未启用（agent.tools.moegirl.enable:false）时 factory 返回 []，零影响。
 */
import {
  defineToolPack, defineTool, param, ok, fail, getToolConfig,
} from '../../model/toolkit/index.js'
import {
  searchEntries, searchArticles, searchFullText, getPageBundle,
  getArticle, getFeed,
} from './api.js'
import { clampInt, truncate } from './format.js'

const cfg = () => getToolConfig('moegirl')

function optsOf() {
  const c = cfg()
  return {
    host: c.grpcHost,
    wikiBase: c.wikiBase,
    timeoutMs: clampInt(c.timeoutMs, 3000, 60000, 15000),
    minIntervalMs: clampInt(c.minIntervalMs, 0, 5000, 300),
    cacheTtlMs: clampInt(c.cacheTtlSeconds, 0, 3600, 120) * 1000,
    userAgent: String(c.userAgent || '').trim() || 'agents-plugin-moegirl/1.0',
  }
}

function limitOf(v, fallback, max = 20) {
  return clampInt(v, 1, max, clampInt(fallback, 1, max, 10))
}

function shortSummary(s, max = 420) {
  return truncate(String(s || '').replace(/\s+/g, ' ').trim(), max).text
}

function compactEntry(e, includeComments) {
  const out = {
    pageId: e.pageId,
    title: e.title,
    summary: shortSummary(e.summary),
    tags: (e.tags || []).slice(0, 8),
    url: e.url,
  }
  if (e.hot != null) out.hot = e.hot
  if (e.score != null) out.score = e.score
  if (includeComments) {
    const comments = (e.comments || []).slice(0, 2).map((c) => ({
      user: c.user || '',
      text: truncate(c.text, 120).text,
    }))
    if (comments.length) out.comments = comments
  }
  return out
}

function compactPost(p, maxSummary = 500) {
  return {
    id: p.id,
    author: p.author || '',
    authorId: p.authorId,
    community: p.community || '',
    topic: p.topic || '',
    summary: shortSummary(p.summary || p.contentText, maxSummary),
    likes: p.likes || '',
    commentCount: p.commentCount,
    createdAt: p.createdAt || null,
    image: p.image || '',
  }
}

// ─── search ───
const searchTool = defineTool({
  name: 'search',
  description:
    '搜索萌娘百科。mode=entry（默认）返回精选词条卡片（标题/摘要/标签/热评，无结果时自动回退全文搜索）；mode=fulltext 走 MediaWiki 全文搜索，覆盖更广但只有标题/片段；mode=both 两者合并。只做检索，需要词条正文时把准确标题交给 moegirl__page。',
  category: 'query',
  meta: { summary: '萌娘百科搜索', resultCap: 12000, capabilities: ['net', 'net.search'] },
  parameters: param.object({
    query: param.str('搜索关键词（角色名 / 作品名 / 梗 / 社区帖子关键词）'),
    mode: param.enum('搜索模式：entry 精选词条 / fulltext 全文搜索 / both 合并', ['entry', 'fulltext', 'both']),
    limit: param.int('返回条数（默认取配置 searchLimit，1-20）', { min: 1 }),
  }, ['query']),
  async execute(p) {
    const query = String(p.query || '').trim()
    if (!query) return fail('搜索关键词不能为空')
    const mode = ['entry', 'fulltext', 'both'].includes(p.mode) ? p.mode : 'entry'
    const n = limitOf(p.limit, cfg().searchLimit, 20)
    const opts = optsOf()
    const includeComments = cfg().includeComments !== false
    const out = { query, mode }
    const warnings = []

    if (mode === 'entry' || mode === 'both') {
      const r = await searchEntries(query, opts).catch((e) => {
        warnings.push(`精选搜索失败：${e?.message || e}`)
        return null
      })
      if (r) {
        out.total = r.total
        out.entries = (r.entries || []).slice(0, n).map((e) => compactEntry(e, includeComments))
        out.related = (r.related || []).slice(0, 5).map((e) => ({
          pageId: e.pageId,
          title: e.title,
          summary: shortSummary(e.summary, 200),
          url: e.url,
        }))
      }
    }
    const fallbackFulltext = mode === 'entry' && !out.entries?.length
    if (fallbackFulltext) warnings.push('精选搜索无结果，已回退全文搜索')
    if (mode === 'fulltext' || mode === 'both' || fallbackFulltext) {
      const r = await searchFullText(query, n, opts).catch((e) => {
        warnings.push(`全文搜索失败：${e?.message || e}`)
        return null
      })
      if (r) {
        out.fulltextTotal = r.total
        out.fulltext = (r.results || []).slice(0, n).map((x) => ({
          pageId: x.pageId,
          title: x.title,
          snippet: shortSummary(x.snippet, 320),
          url: x.url,
        }))
      }
    }
    if (!out.entries?.length && !out.fulltext?.length) {
      return fail(warnings.length ? `萌娘百科搜索失败：${warnings.join('；')}` : '萌娘百科没有找到结果，可换关键词或 mode=fulltext', { recoverable: true })
    }
    if (warnings.length) out.warnings = warnings
    return ok(out)
  },
})

// ─── page ───
const pageTool = defineTool({
  name: 'page',
  description:
    '获取萌娘百科词条。返回摘要、封面、标签与 MediaWiki 纯文本正文（extracts；表格/模板可能省略）。先用 moegirl__search 确认准确标题；intro=true 只取引言。maxChars 控制正文长度。',
  category: 'query',
  meta: { summary: '萌娘百科词条正文', resultCap: 32000, capabilities: ['net', 'net.fetch'] },
  parameters: param.object({
    title: param.str('词条准确标题（如 初音未来、雷电将军）'),
    intro: param.bool('只取引言（默认 false，取全文）'),
    maxChars: param.int('正文最大字符数（默认取配置 maxPageChars，1000-30000）', { min: 1000 }),
  }, ['title']),
  async execute(p) {
    const title = String(p.title || '').trim()
    if (!title) return fail('词条标题不能为空')
    const maxChars = clampInt(p.maxChars, 1000, 30000, clampInt(cfg().maxPageChars, 1000, 30000, 12000))
    try {
      const r = await getPageBundle(title, { introOnly: p.intro === true, maxChars }, optsOf())
      if (!r.extract && !r.summary) return fail(`未找到词条「${title}」或没有可读正文`, { recoverable: true })
      return ok({
        ...r,
        summary: shortSummary(r.summary, 600),
        tags: (r.tags || []).slice(0, 12),
      })
    } catch (e) {
      return fail(`萌娘百科词条获取失败：${e?.message || e}`, { recoverable: true, code: e?.code })
    }
  },
})

// ─── post_search ───
const postSearchTool = defineTool({
  name: 'post_search',
  description:
    '搜索萌娘百科社区帖子/动态（标题或正文关键词）。返回帖子 id、作者、分区、摘要、点赞/评论数；需要正文或视频链接时把 id 交给 moegirl__post。',
  category: 'query',
  meta: { summary: '萌娘百科帖子搜索', resultCap: 12000, capabilities: ['net', 'net.search'] },
  parameters: param.object({
    query: param.str('帖子关键词'),
    limit: param.int('返回条数（默认取配置 postLimit，1-20）', { min: 1 }),
  }, ['query']),
  async execute(p) {
    const query = String(p.query || '').trim()
    if (!query) return fail('搜索关键词不能为空')
    const n = limitOf(p.limit, cfg().postLimit, 20)
    try {
      const r = await searchArticles(query, n, optsOf())
      const posts = (r.posts || []).slice(0, n).map((x) => compactPost(x))
      return ok({ query, count: posts.length, posts, note: posts.length ? '用 moegirl__post 查看帖子正文/视频链接' : '没有找到帖子，可换关键词' })
    } catch (e) {
      return fail(`萌娘百科帖子搜索失败：${e?.message || e}`, { recoverable: true })
    }
  },
})

// ─── post ───
const postTool = defineTool({
  name: 'post',
  description:
    '获取萌娘百科社区帖子/动态详情：作者、分区、正文纯文本、视频/图片链接、发布时间。id 来自 moegirl__post_search 或 feed。',
  category: 'query',
  meta: { summary: '萌娘百科帖子详情', resultCap: 32000, capabilities: ['net', 'net.fetch'] },
  parameters: param.object({
    id: param.str('帖子 id（数字，可传帖子链接）'),
    maxChars: param.int('正文最大字符数（默认取配置 maxPostChars，1000-30000）', { min: 1000 }),
  }, ['id']),
  async execute(p) {
    const id = String(p.id || '').match(/\d+/)?.[0] || ''
    if (!id) return fail('帖子 id 必须是数字（可从 moegirl__post_search 获取）')
    const maxChars = clampInt(p.maxChars, 1000, 30000, clampInt(cfg().maxPostChars, 1000, 30000, 8000))
    try {
      const a = await getArticle(id, optsOf())
      const cut = truncate(a.contentText || '', maxChars)
      return ok({
        id: a.id,
        author: a.author,
        authorId: a.authorId,
        community: a.community,
        type: a.type,
        createdAt: a.createdAt,
        updatedAt: a.updatedAt,
        ipLocation: a.ipLocation,
        avatar: a.avatar,
        contentText: cut.text,
        truncated: cut.truncated,
        originalLength: cut.originalLength,
        media: (a.media || []).slice(0, 10),
        note: !a.contentText ? '该帖正文为空或仅包含暂不支持的富文本块' : undefined,
      })
    } catch (e) {
      return fail(`萌娘百科帖子获取失败：${e?.message || e}`, { recoverable: true })
    }
  },
})

// ─── feed ───
const feedTool = defineTool({
  name: 'feed',
  description:
    '获取萌娘百科首页混合流（词条卡片 + 社区动态），用于看当前热门/推荐内容。kind=entry 只看词条，moment 只看动态。每次内容随机，适合发现话题，不适合精确查询。',
  category: 'query',
  meta: { summary: '萌娘百科首页混合流', resultCap: 12000, capabilities: ['net', 'net.fetch'] },
  parameters: param.object({
    kind: param.enum('筛选：all 全部 / entry 词条 / moment 动态', ['all', 'entry', 'moment']),
    limit: param.int('返回条数（默认取配置 feedLimit，1-30）', { min: 1 }),
  }, []),
  async execute(p) {
    const kind = ['all', 'entry', 'moment'].includes(p.kind) ? p.kind : 'all'
    const n = limitOf(p.limit, cfg().feedLimit, 30)
    try {
      const r = await getFeed(optsOf())
      const cards = (r.cards || [])
        .filter((c) => kind === 'all' || c.kind === kind)
        .slice(0, n)
        .map((c) => c.kind === 'entry'
          ? {
              kind: 'entry',
              pageId: c.pageId,
              title: c.title,
              summary: shortSummary(c.summary, 300),
              tags: (c.tags || []).slice(0, 6),
              url: c.url,
            }
          : {
              kind: 'moment',
              id: c.id,
              author: c.author,
              topic: c.topic,
              contentText: truncate(c.contentText || '', 300).text,
              media: (c.media || []).slice(0, 3),
              createdAt: c.createdAt || null,
            })
      return ok({ kind, count: cards.length, cards, note: cards.length ? undefined : '本次流里没有该类型卡片，可换 kind=all 再试' })
    } catch (e) {
      return fail(`萌娘百科首页流获取失败：${e?.message || e}`, { recoverable: true })
    }
  },
})

export default defineToolPack({
  name: 'moegirl',
  description: '萌娘百科词条/全文搜索、词条正文、社区帖子搜索/详情、首页动态流（只读）',
  author: 'yunzai-agent-plugin',
  version: '1.0.0',
  factory: () => (cfg().enable === false ? [] : [
    searchTool, pageTool, postSearchTool, postTool, feedTool,
  ]),
})
