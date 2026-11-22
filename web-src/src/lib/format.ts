export const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

export function num(v: unknown, fallback = 0): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

/** Compact number: 1.2k, 3.4M. No rounding lies: value 0 is "0". */
export function fmtNum(v: unknown): string {
  if (v === null || v === undefined || v === '') return '—'
  const n = num(v, NaN)
  if (!Number.isFinite(n)) return '—'
  const abs = Math.abs(n)
  if (abs >= 1e9) return trim(n / 1e9) + 'B'
  if (abs >= 1e6) return trim(n / 1e6) + 'M'
  if (abs >= 1e4) return trim(n / 1e3) + 'k'
  if (abs >= 1000) return n.toLocaleString('zh-CN')
  return String(Math.round(n * 100) / 100)
}

function trim(n: number): string {
  const abs = Math.abs(n)
  return n.toFixed(abs >= 100 ? 0 : abs >= 10 ? 1 : 1).replace(/\.0$/, '')
}

export function fmtInt(v: unknown): string {
  if (v === null || v === undefined || v === '') return '—'
  const n = num(v, NaN)
  return Number.isFinite(n) ? n.toLocaleString('zh-CN') : '—'
}

export function pct(v: unknown, digits = 1): string {
  if (v === null || v === undefined || v === '') return '—'
  const n = num(v, NaN)
  return Number.isFinite(n) ? (n * 100).toFixed(digits) + '%' : '—'
}

export function pct100(v: unknown, digits = 0): string {
  if (v === null || v === undefined || v === '') return '—'
  const n = num(v, NaN)
  return Number.isFinite(n) ? n.toFixed(digits) + '%' : '—'
}

export function fmtDate(v: unknown, withTime = true): string {
  if (!v) return '—'
  const d = new Date(v as any)
  if (Number.isNaN(d.getTime())) return String(v)
  const p = (n: number) => String(n).padStart(2, '0')
  const date = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
  return withTime ? `${date} ${p(d.getHours())}:${p(d.getMinutes())}` : date
}

export function fmtTime(v: unknown): string {
  if (!v) return '—'
  const d = new Date(v as any)
  if (Number.isNaN(d.getTime())) return String(v)
  return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
}

export function fmtAgo(v: unknown): string {
  if (!v) return '—'
  const t = typeof v === 'number' ? v : new Date(v as any).getTime()
  if (!Number.isFinite(t)) return '—'
  const diff = Date.now() - t
  if (diff < 0) return '刚刚'
  const s = Math.floor(diff / 1000)
  if (s < 60) return `${s} 秒前`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} 分钟前`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} 小时前`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d} 天前`
  return fmtDate(t, false)
}

export function fmtDuration(ms: unknown): string {
  const n = num(ms, NaN)
  if (!Number.isFinite(n) || n < 0) return '—'
  if (n < 1000) return `${Math.round(n)} ms`
  if (n < 60_000) return `${(n / 1000).toFixed(1)} s`
  const m = Math.floor(n / 60_000)
  const s = Math.round((n % 60_000) / 1000)
  return s ? `${m} 分 ${s} 秒` : `${m} 分`
}

export function fmtUntil(ts: unknown): string {
  const t = typeof ts === 'number' ? ts : new Date(ts as any).getTime()
  if (!Number.isFinite(t)) return '—'
  const diff = t - Date.now()
  if (diff <= 0) return '已到期'
  const s = Math.ceil(diff / 1000)
  if (s < 60) return `${s} 秒后`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} 分钟后`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} 小时 ${m % 60} 分后`
  const d = Math.floor(h / 24)
  return `${d} 天 ${h % 24} 小时后`
}

export function truncate(s: unknown, n = 120): string {
  const str = String(s ?? '')
  return str.length > n ? str.slice(0, n) + '…' : str
}

export function safeJson(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'string') return v
  try { return JSON.stringify(v, null, 2) } catch { return String(v) }
}

export function parseJson<T = any>(s: string): T | null {
  try { return JSON.parse(s) as T } catch { return null }
}

export function statusTone(s: unknown): 'jade' | 'amber' | 'coral' | 'neutral' | 'lagoon' {
  const v = String(s ?? '').toLowerCase()
  if (['ok', 'success', 'done', 'verified', 'active', 'online', 'approved', 'passed', 'enabled', 'healthy', 'connected', 'running'].includes(v)) return 'jade'
  if (['warn', 'warning', 'pending', 'degraded', 'draft', 'paused', 'queued', 'unknown'].includes(v)) return 'amber'
  if (['fail', 'failed', 'error', 'critical', 'offline', 'rejected', 'disabled', 'cancelled', 'decommissioned', 'timeout'].includes(v)) return 'coral'
  if (['info', 'new', 'ready'].includes(v)) return 'lagoon'
  return 'neutral'
}

export const statusLabel: Record<string, string> = {
  ok: '正常', success: '成功', done: '完成', verified: '已验证', active: '启用', online: '在线',
  approved: '已批准', passed: '通过', enabled: '开启', healthy: '健康', connected: '已连接', running: '运行中',
  warn: '注意', warning: '注意', pending: '待处理', degraded: '降级', draft: '草稿', paused: '暂停', queued: '排队中', unknown: '未知',
  fail: '失败', failed: '失败', error: '错误', critical: '严重', offline: '离线', rejected: '已拒绝', disabled: '关闭',
  cancelled: '已取消', decommissioned: '已淘汰', timeout: '超时', new: '新建', ready: '就绪',
}

export function labelStatus(s: unknown): string {
  const v = String(s ?? '').toLowerCase()
  return statusLabel[v] || String(s ?? '—')
}

export function shortId(s: unknown, n = 8): string {
  const str = String(s ?? '')
  if (!str) return '—'
  return str.length > n ? str.slice(0, n) + '…' : str
}
