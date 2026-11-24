/**
 * 静态资源版本化：给 index.html 里本地资源 URL（assets/、vendor/）追加 `?v=<版本>`。
 *
 * 目的：面板发版后浏览器仍可能命中旧 JS 缓存（部分客户端不按 max-age=0 重新校验），
 * 导致「服务端已修、页面仍旧」（如 suggestions.js 旧版渲染报错整页空白）。加版本查询串后，
 * 版本一变 URL 就变，浏览器必取新文件；同版本内仍可正常 304 复用。
 */
const LOCAL_RE = /(\s(?:src|href)=")((?:\.\/|\/)?(?:assets|vendor)\/[^"]+)(")/g

/** 收集 module script 的 src：这些 URL 不能加查询串（见 versionAssetUrls 注释）。 */
function moduleScriptSrcs(html) {
  const out = new Set()
  String(html ?? '').replace(/<script\b[^>]*>/gi, (tag) => {
    if (!/type\s*=\s*["']module["']/i.test(tag)) return tag
    const m = /\ssrc\s*=\s*(["'])(.*?)\1/i.exec(tag)
    if (m) out.add(m[2])
    return tag
  })
  return out
}

/**
 * 给本地资源 URL 追加 ?v=version（幂等：已带 ?v= 的不重复追加；version 为空则原样返回）。
 *
 * ⚠️ module script 的 URL **不能**加查询串：Vite 产物里的动态 import 用的是不带 `?v`
 * 的 chunk 路径；入口带 `?v` 会把同一个入口模块加载成两份（两份 React），
 * 懒加载页面触发 Invalid hook call / 整页空白。Vite 文件名本身带内容 hash，可直接做缓存失效；
 * CSS、经典 script、vendor 仍保留版本查询串。
 */
export function versionAssetUrls(html, version) {
  const v = String(version ?? '').trim()
  const source = String(html ?? '')
  if (!v) return source
  const moduleSrcs = moduleScriptSrcs(source)
  return source.replace(LOCAL_RE, (m, pre, url, post) => {
    if (moduleSrcs.has(url)) return m
    if (/[?&]v=/.test(url)) return m
    return `${pre}${url}${url.includes('?') ? '&' : '?'}v=${encodeURIComponent(v)}${post}`
  })
}
