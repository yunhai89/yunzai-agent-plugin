import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import {
  ArrowUpRight, Check, ChevronRight, CircleAlert, Drama, Eraser, FlaskConical,
  Lightbulb, RefreshCw, ShieldCheck, Sparkles, Waves, Wrench,
} from 'lucide-react'
import { api } from '@/lib/api'
import { useAsync, useInterval } from '@/lib/hooks'
import { fmtAgo, fmtNum, num, pct } from '@/lib/format'
import { Button, EmptyState, ErrorState, PageHeader, SectionTitle, Segmented, Skeleton, Tag } from '@/components/ui'
import { Waterline } from '@/components/Charts'
import { useConfirm, useToast } from '@/components/Overlay'
import { cn } from '@/lib/cn'
import { useSignals } from '@/lib/auth'

type WindowKey = '1h' | '24h' | '7d' | 'new' | 'all'
const WINDOWS: { value: WindowKey; label: string }[] = [
  { value: '1h', label: '1 小时' }, { value: '24h', label: '24 小时' }, { value: '7d', label: '7 日' }, { value: 'new', label: '部署后' }, { value: 'all', label: '全部' },
]
const WINDOW_LABEL: Record<WindowKey, string> = { '1h': '近 1 小时', '24h': '近 24 小时', '7d': '近 7 日', new: '部署后', all: '全部时间' }

function fmtDay(v: any): string {
  const s = String(v ?? '')
  const m = s.match(/(\d{4})-(\d{2})-(\d{2})/)
  if (m) return `${m[2]}-${m[3]}`
  return s || '—'
}

function Reading({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'coral' | 'amber' | 'jade' }) {
  return (
    <div className="min-w-0 px-4 py-3 sm:flex-1 sm:px-5">
      <div className="text-[10.5px] text-ink-3">{label}</div>
      <div className={cn('mono mt-1 text-[19px] font-medium tracking-[-0.03em]', tone === 'coral' && 'text-coral', tone === 'amber' && 'text-amber', tone === 'jade' && 'text-lagoon')}>{value}</div>
      {sub && <div className="mt-0.5 truncate text-[10.5px] text-ink-3">{sub}</div>}
    </div>
  )
}

export function DashboardPage() {
  const toast = useToast()
  const confirm = useConfirm()
  const navigate = useNavigate()
  const { refresh: refreshSignals, approvals, suggestions } = useSignals()
  const [win, setWin] = useState<WindowKey>('7d')
  const [busyId, setBusyId] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const [lastAt, setLastAt] = useState(Date.now())

  const overview = useAsync(() => api.get('/overview', { window: win }), [win])
  const config = useAsync(() => api.get('/config'), [])
  const confirms = useAsync(() => api.get('/confirm'), [])
  const adoptions = useAsync(() => api.get('/persona-adoptions', { status: 'pending' }), [])
  const sugg = useAsync(() => api.get('/suggestions', { status: 'pending' }), [])

  const M = overview.data || {}
  const cfg = config.data || {}
  const provider = (cfg.llmProviders || []).find((p: any) => p.id === cfg.providerId)
  const ready = !!(cfg.model && cfg.providerId)

  const tokenPoints = useMemo(() => (M.tokenTrend || []).map((d: any) => ({
    label: fmtDay(d.day),
    value: num(d.input) + num(d.output),
    meta: `输入 ${fmtNum(d.input)} · 输出 ${fmtNum(d.output)}${d.cacheRead ? ` · 缓存 ${fmtNum(d.cacheRead)}` : ''}`,
  })), [M.tokenTrend])

  const requestPoints = useMemo(() => (M.requestTrend || []).map((d: any) => ({ label: fmtDay(d.day), value: num(d.count) })), [M.requestTrend])
  const totalTokens = num(M.totalTokens) || tokenPoints.reduce((s: number, d: any) => s + d.value, 0)
  const totalRequests = num(M.totalRequests) || requestPoints.reduce((s: number, d: any) => s + d.value, 0)
  const success = M.toolSuccessRate != null ? M.toolSuccessRate : (M.toolOk != null && M.toolFail != null && M.toolOk + M.toolFail > 0 ? M.toolOk / (M.toolOk + M.toolFail) : null)
  const cache = M.cache || {}
  const cacheRate = cache.tokenHitRate != null ? cache.tokenHitRate : (cache.requestHitRate ?? null)

  const pending = useMemo(() => {
    const items: any[] = []
    for (const c of (confirms.data || [])) items.push({
      key: `c-${c.id}`, kind: 'confirm', id: c.id, args: c.args,
      title: `工具确认 · ${c.tool}`, sub: `${c.ctx?.user || '—'}${c.ctx?.gid ? ` · 群 ${c.ctx.gid}` : ' · 私聊'} · ${c.ctx?.reason || '需二次确认'}`,
      at: c.createdAt, tone: 'coral' as const, icon: ShieldCheck, action: '批准执行',
    })
    for (const a of (adoptions.data || [])) items.push({
      key: `a-${a.id}`, kind: 'persona', id: a.id,
      title: `人设采纳 · ${a.personaName || a.personaId}`, sub: `${a.via === 'qq' ? 'QQ' : 'Web'} 提交 · ${a.by || '—'} · ${fmtAgo(a.createdAt)}`,
      at: a.createdAt, tone: 'amber' as const, icon: Drama, action: '批准采纳',
    })
    for (const s of (sugg.data || [])) items.push({
      key: `s-${s.id}`, kind: 'suggestion', id: s.id,
      title: `进化建议 · ${s.title || s.kind || '改进项'}`, sub: String(s.summary || '').slice(0, 80) || '待审改进项',
      at: s.createdAt, tone: 'lagoon' as const, icon: Lightbulb, action: '去处理',
    })
    return items.sort((a, b) => num(b.at) - num(a.at))
  }, [confirms.data, adoptions.data, sugg.data])

  const loadAll = useCallback(async (notify = false) => {
    setRefreshing(true)
    const results = await Promise.all([overview.reload(), config.reload(), confirms.reload(), adoptions.reload(), sugg.reload()])
    await refreshSignals()
    setLastAt(Date.now())
    setRefreshing(false)
    if (notify) {
      if (results.some((r) => r === null)) toast('部分数据读取失败，请检查后端服务', 'warn')
      else toast('概览已刷新', 'success')
    }
  }, [overview.reload, config.reload, confirms.reload, adoptions.reload, sugg.reload, refreshSignals, toast])

  useEffect(() => {
    const onReload = () => { void loadAll(false) }
    window.addEventListener('agents:reload-page', onReload)
    return () => window.removeEventListener('agents:reload-page', onReload)
  }, [loadAll])

  useInterval(() => {
    if (document.visibilityState === 'visible') void overview.reload()
  }, 60_000)

  const decide = async (item: any) => {
    if (item.kind === 'suggestion') { navigate('/suggestions'); return }
    const ok = await confirm({
      title: item.kind === 'confirm' ? `批准 ${item.title}？` : `采纳 ${item.title}？`,
      message: item.kind === 'confirm'
        ? <div><p>工具将在批准后继续执行。请确认参数与事由来自可信对话。</p><pre className="mono mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded-lg bg-ink/5 p-2 text-[10px]">{JSON.stringify(item.args ?? {}, null, 2)}</pre></div>
        : <span>批准后资料会写入身份层；请先到审批门核对草稿。</span>,
      confirmText: item.kind === 'confirm' ? '批准执行' : '批准采纳',
      danger: item.kind === 'confirm',
    })
    if (!ok) return
    setBusyId(item.key)
    try {
      if (item.kind === 'confirm') await api.post(`/confirm/${item.id}/decide`, { approve: true })
      else if (item.kind === 'persona') await api.post(`/persona-adoptions/${item.id}/approve`, {})
      toast(`已处理：${item.title}`, 'success')
      await loadAll(false)
    } catch (e: any) {
      toast(e?.message || '操作失败', 'error')
    } finally { setBusyId('') }
  }

  const clearCache = async () => {
    const ok = await confirm({
      title: '清空 Token 缓存统计',
      message: '将清空 Redis 日统计与 devLog 会话日志，命中率与趋势从零累计；记忆、人设、配置不受影响。',
      confirmText: '清空统计',
      danger: true,
      requireText: '清空统计',
    })
    if (!ok) return
    try {
      const r = await api.post('/cache/clear', {})
      toast(`已清空：日统计 ${r?.kvRemoved ?? 0} 天 · 日志 ${r?.logsRemoved ?? 0} 个文件`, 'success')
      await overview.reload()
    } catch (e: any) { toast(e?.message || '清空失败', 'error') }
  }

  const error = overview.error || config.error
  const loading = overview.loading && !overview.data

  return (
    <div className="page">
      <PageHeader
        title="概览"
        description="先看健康与开销，再看需要你处理的事。所有数字都来自当前运行时的真实聚合。"
        actions={(
          <>
            <Segmented value={win} options={WINDOWS} onChange={(v) => setWin(v)} ariaLabel="统计时间窗" />
            <Button variant="secondary" size="sm" onClick={() => void loadAll(true)} disabled={refreshing} icon={<RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} />}>
              {refreshing ? '刷新中' : '刷新'}
            </Button>
          </>
        )}
        meta={(
          <>
            <span>更新于 {new Date(lastAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })}</span>
            <span className="h-3 w-px bg-ink/10" />
            <span>{M.statsSource === 'kv' ? '按 Redis 日统计（本地时区）' : '按 devLog 聚合（过渡）'}</span>
            <span className="h-3 w-px bg-ink/10" />
            <span>{WINDOW_LABEL[win]}</span>
          </>
        )}
      />

      {error && <div className="mb-4"><ErrorState message={error} onRetry={() => void loadAll(false)} /></div>}

      {!ready && !config.loading && (
        <div className="mb-5 flex flex-wrap items-center gap-3 rounded-[14px] border border-amber/20 bg-[linear-gradient(100deg,rgba(248,238,218,.85),rgba(255,255,255,.55))] px-4 py-3">
          <span className="flex h-8 w-8 items-center justify-center rounded-full bg-amber/10 text-amber"><CircleAlert size={16} /></span>
          <div className="min-w-0 flex-1">
            <div className="text-[12.5px] font-medium text-ink">还没有接入基础模型</div>
            <div className="text-[11px] text-ink-2">运行时可以启动，但对话不可用。先添加厂商与模型，再选中基础模型。</div>
          </div>
          <Link to="/config" className="btn btn-primary btn-sm">去配置 <ArrowUpRight size={13} /></Link>
        </div>
      )}

      <div className="grid grid-cols-1 gap-5 xl:items-start xl:grid-cols-[minmax(0,1.62fr)_minmax(320px,0.9fr)]">
        <section className="panel overflow-hidden" aria-labelledby="waterline-title">
          <div className="flex flex-wrap items-start justify-between gap-3 px-5 pb-1 pt-5">
            <div>
              <div className="flex items-center gap-2">
                <Waves size={16} className="text-lagoon" />
                <h2 id="waterline-title" className="section-title">运行水位</h2>
                {loading && <Skeleton className="h-3 w-14" />}
              </div>
              <p className="mt-1 text-[11.5px] text-ink-3">
                {WINDOW_LABEL[win]} Token 用量
                {M.tokenTrend?.length ? ` · ${M.tokenTrend.length} 个记录日` : ''}
              </p>
            </div>
            <div className="flex items-baseline gap-2">
              <span className="mono text-[25px] font-semibold tracking-[-0.04em]">{loading ? '—' : fmtNum(totalTokens)}</span>
              <span className="text-[10.5px] text-ink-3">tokens</span>
            </div>
          </div>
          <div className="px-2 pb-1 pt-1">
            {loading ? <Skeleton className="mx-3 h-[250px]" /> : (
              <Waterline
                data={tokenPoints}
                height={262}
                ariaLabel={`${WINDOW_LABEL[win]} Token 用量趋势`}
                format={(v) => fmtNum(v)}
              />
            )}
          </div>
          <div className="mx-5 mb-4 flex flex-wrap items-center justify-between gap-2 border-t border-line-soft pt-3 text-[10.5px] text-ink-3">
            <span className="inline-flex items-center gap-1.5"><span className="h-1.5 w-4 rounded-full bg-[linear-gradient(90deg,#1f8a70,#0a4e4a)]" />输入 + 输出 Token</span>
            <span>{M.tokenTrend?.length ? `${fmtDay(M.tokenTrend[0]?.day)} 至 ${fmtDay(M.tokenTrend[M.tokenTrend.length - 1]?.day)}` : '暂无趋势数据'}</span>
          </div>
          <div className="grid grid-cols-2 divide-x divide-y divide-line-soft border-t border-line sm:flex sm:flex-nowrap sm:divide-y-0">
            <Reading label="请求" value={loading ? '—' : fmtNum(totalRequests)} sub={`${WINDOW_LABEL[win]}对话轮次`} />
            <Reading label="工具调用" value={loading ? '—' : fmtNum(M.totalToolCalls)} sub={M.toolSuccessRate != null ? `成功率 ${pct(M.toolSuccessRate)}` : '尚未观测到成功率'} />
            <Reading label="缓存命中" value={loading ? '—' : cacheRate != null ? pct(cacheRate) : '—'} sub={cacheRate == null ? '暂无观测' : '输入 Token 命中率'} tone={cacheRate != null && cacheRate < 0.2 ? 'amber' : 'jade'} />
            <Reading label="异常" value={loading ? '—' : M.toolFail != null ? fmtNum(M.toolFail) : '—'} sub={M.toolOk != null ? `成功 ${fmtNum(M.toolOk)} 次` : '尚未统计'} tone={M.toolFail > 0 ? 'coral' : undefined} />
          </div>
        </section>

        <section className="panel flex min-h-[300px] flex-col overflow-hidden xl:max-h-[520px]" aria-labelledby="attention-title">
          <div className="flex items-center justify-between gap-2 px-5 pb-2 pt-5">
            <div>
              <div className="flex items-center gap-2">
                <ShieldCheck size={15} className="text-vermilion" />
                <h2 id="attention-title" className="section-title">需要你</h2>
                {pending.length > 0 && <Tag tone="coral">{pending.length}</Tag>}
              </div>
              <p className="mt-1 text-[11.5px] text-ink-3">审批、采纳与建议，按到达时间排序</p>
            </div>
            <Link to="/confirm" className="btn btn-ghost btn-sm">审批门 <ChevronRight size={13} /></Link>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
            {confirms.loading || adoptions.loading || sugg.loading ? (
              <div className="space-y-2 p-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-14" />)}</div>
            ) : pending.length === 0 ? (
              <EmptyState icon={<Check size={20} />} title="队列已清空">
                没有等待批准的工具体调用、人设采纳或进化建议。新的高危操作会出现在这里。
              </EmptyState>
            ) : (
              <ul className="space-y-1">
                {pending.slice(0, 3).map((item) => {
                  const Icon = item.icon
                  return (
                    <li key={item.key} className="group rounded-[11px] px-3 py-2.5 transition hover:bg-white/45">
                      <div className="flex items-start gap-2.5">
                        <span className={cn('mt-0.5 flex h-7 w-7 flex-none items-center justify-center rounded-lg',
                          item.kind === 'confirm' && 'bg-coral/8 text-coral',
                          item.kind === 'persona' && 'bg-amber/8 text-amber',
                          item.kind === 'suggestion' && 'bg-lagoon/8 text-lagoon')}>
                          <Icon size={14} />
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-[12px] font-medium text-ink">{item.title}</div>
                          <div className="mt-0.5 line-clamp-2 text-[10.5px] leading-snug text-ink-3">{item.sub}</div>
                          <div className="mt-1.5 flex items-center gap-2">
                            <button className="btn btn-secondary btn-sm h-6 min-h-6 px-2 text-[10.5px]" disabled={busyId === item.key} onClick={() => void decide(item)}>
                              {busyId === item.key ? '处理中…' : item.action}
                            </button>
                            <Link to={item.kind === 'confirm' ? '/confirm' : item.kind === 'persona' ? '/personas' : '/suggestions'} className="text-[10px] text-ink-3 underline-offset-2 hover:text-ink-2 hover:underline">查看</Link>
                          </div>
                        </div>
                      </div>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
          <div className="flex items-center justify-between border-t border-line-soft px-5 py-2.5 text-[10.5px] text-ink-3">
            <span>工具 {confirms.data?.length || 0} · 人设 {adoptions.data?.length || 0} · 建议 {sugg.data?.length || 0}{pending.length > 3 ? ` · 还有 ${pending.length - 3} 项` : ''}</span>
            <Link to="/suggestions" className="inline-flex items-center gap-1 hover:text-ink-2">全部 <ChevronRight size={11} /></Link>
          </div>
        </section>
      </div>

      <div className="mt-5 grid grid-cols-1 gap-5 xl:items-start xl:grid-cols-[minmax(0,1.62fr)_minmax(320px,0.9fr)]">
        <div className="space-y-5">
        <section className="panel p-5" aria-labelledby="tools-title">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="flex items-center gap-2"><Wrench size={15} className="text-lagoon" /><h2 id="tools-title" className="section-title">工具水位</h2></div>
              <p className="mt-1 text-[11.5px] text-ink-3">调用次数最高的工具 · {WINDOW_LABEL[win]}</p>
            </div>
            <Link to="/toolpacks" className="btn btn-ghost btn-sm">外置工具 <ChevronRight size={13} /></Link>
          </div>
          <div className="mt-4 space-y-2.5">
            {(M.toolTop || []).length === 0 ? (
              <EmptyState title="还没有工具调用记录">等运行时产生工具调用后，这里会按调用量排序。</EmptyState>
            ) : (M.toolTop || []).slice(0, 6).map((t: any, i: number) => {
              const max = Math.max(1, ...(M.toolTop || []).map((x: any) => num(x.count)))
              return (
                <div key={t.name || i} className="grid grid-cols-[minmax(100px,1.1fr)_minmax(0,2fr)_54px] items-center gap-3">
                  <div className="truncate text-[11.5px] text-ink-2" title={t.name}>{t.name || '未命名工具'}</div>
                  <div className="h-2 overflow-hidden rounded-full bg-ink/5">
                    <div className="h-full rounded-full bg-[linear-gradient(90deg,#7cc7ba,#0f6b65)]" style={{ width: `${Math.max(2, (num(t.count) / max) * 100)}%` }} />
                  </div>
                  <div className="mono text-right text-[10.5px] text-ink-3">{fmtNum(t.count)}</div>
                </div>
              )
            })}
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-line-soft pt-3 text-[10.5px] text-ink-3">
            <span>总调用 <span className="mono text-ink-2">{fmtNum(M.totalToolCalls)}</span></span>
            <span>成功率 <span className="mono text-ink-2">{success != null ? pct(success) : '暂无'}</span></span>
            <button className="ml-auto inline-flex items-center gap-1 text-ink-3 hover:text-coral" onClick={() => void clearCache()}><Eraser size={11} /> 清空缓存统计</button>
          </div>
        </section>

        <section className="panel p-5" aria-labelledby="perception-title">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="flex items-center gap-2"><Waves size={15} className="text-lagoon" /><h2 id="perception-title" className="section-title">群情境</h2></div>
              <p className="mt-1 text-[11.5px] text-ink-3">{(M.perceptions || []).length} 个群在观察范围 · 入群与最近活跃</p>
            </div>
            <Link to="/groupworld" className="btn btn-ghost btn-sm">群聊小世界 <ChevronRight size={13} /></Link>
          </div>
          {(M.perceptions || []).length === 0 ? (
            <p className="mt-3 rounded-lg border border-dashed border-line px-3 py-4 text-center text-[11px] text-ink-3">暂无群感知数据。Bot 入群并产生互动后会出现在这里。</p>
          ) : (
            <ul className="mt-3 divide-y divide-line-soft">
              {(M.perceptions || []).slice(0, 5).map((p: any) => {
                const last = num(p.lastActive?.at)
                const stale = last > 0 && Date.now() - last > 6 * 3600e3
                return (
                  <li key={p.groupId} className="flex items-center justify-between gap-3 py-2.5">
                    <div className="min-w-0">
                      <div className="mono text-[11px] text-ink">群 {p.groupId}</div>
                      <div className="mt-0.5 text-[10px] text-ink-3">入群 {fmtAgo(p.met?.at)}</div>
                    </div>
                    <Tag tone={stale ? 'amber' : 'jade'}>{stale ? `久离 ${fmtAgo(last)}` : `活跃 ${fmtAgo(last)}`}</Tag>
                  </li>
                )
              })}
            </ul>
          )}
        </section>
        </div>

        <section className="panel p-5" aria-labelledby="runtime-title">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="flex items-center gap-2"><Sparkles size={15} className="text-lagoon" /><h2 id="runtime-title" className="section-title">运行时</h2></div>
              <p className="mt-1 text-[11.5px] text-ink-3">当前生效配置的真实镜像</p>
            </div>
            <Link to="/config" className="btn btn-ghost btn-sm">配置中心 <ChevronRight size={13} /></Link>
          </div>
          <dl className="mt-3">
            {[
              ['厂商', provider?.name || cfg.providerId || '未配置'],
              ['模型', cfg.model || '未配置'],
              ['协议', ({ openai: 'OpenAI', anthropic: 'Anthropic', gemini: 'Gemini' } as any)[cfg.protocol] || cfg.protocol || '—'],
              ['触发', ({ at: '@ 提及', command: `触发词 ${cfg.triggerCommand || ''}`, both: '提及 / 触发词' } as any)[cfg.trigger] || cfg.trigger || '—'],
              ['声明式记忆', cfg.memory?.enable ? '开启' : '关闭'],
              ['终端沙箱', cfg.sandbox?.mode || 'off'],
              ['活跃会话', fmtNum(M.counts?.conversations)],
              ['记忆 scope', fmtNum(M.counts?.scopes)],
              ['群情境', fmtNum(M.perceptions?.length)],
            ].map(([k, v]) => (
              <div key={k as string} className="flex items-baseline justify-between gap-4 border-b border-line-soft py-2 last:border-0">
                <dt className="text-[11.5px] text-ink-3">{k}</dt>
                <dd className={cn('mono min-w-0 truncate text-right text-[11.5px] text-ink', (v === '未配置' || v === '关闭') && 'text-ink-3')}>{v}</dd>
              </div>
            ))}
          </dl>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {[
              ['声明式记忆', !!cfg.memory?.enable],
              ['威胁扫描', !!cfg.memory?.threatScan],
              ['后台自评审', !!cfg.selfReview?.enable],
              ['多模态', !!cfg.media?.enable],
              ['视觉子模型', !!cfg.vision?.enable],
            ].map(([name, on]) => (
              <Tag key={name as string} tone={on ? 'jade' : 'neutral'}>{name as string} · {on ? '开' : '关'}</Tag>
            ))}
          </div>
        </section>
      </div>

      <div className="mt-5 flex flex-wrap items-center justify-between gap-3 text-[10.5px] text-ink-3">
        <span>待处理：审批 {approvals} · 建议 {suggestions}</span>
        <span className="inline-flex items-center gap-1"><FlaskConical size={11} /> 数据来源：{M.statsSource === 'kv' ? 'Redis 日统计' : 'devLog 聚合'} · 缓存 60 秒</span>
      </div>
    </div>
  )
}
