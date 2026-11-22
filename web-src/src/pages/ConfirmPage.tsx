import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Check, Clock3, Drama, ShieldCheck, Terminal, UserRound, X } from 'lucide-react'
import { api } from '@/lib/api'
import { useAsync, useReloadEvent } from '@/lib/hooks'
import { fmtAgo, fmtNum } from '@/lib/format'
import { useConfirm, useToast } from '@/components/Overlay'
import { useSignals } from '@/lib/auth'
import { Button, EmptyState, ErrorState, PageHeader, Skeleton, Tag } from '@/components/ui'
import { cn } from '@/lib/cn'

type ToolConfirm = {
  id: string; tool: string; args: any; createdAt: number;
  ctx?: { user?: string; userId?: string; gid?: string | null; reason?: string | null } | null
}
type Adoption = {
  id: string; personaId: string; personaName?: string; status: string; by?: string; via?: string; createdAt: number;
  snapshot?: { summary?: string; facts?: string; sourceCount?: number; rawNotesLen?: number }
}

const DANGER_TOOLS = new Set(['send_like', 'stagehand', 'stagehand_act'])

function Ring({ remain, total }: { remain: number; total: number }) {
  const pct = total > 0 ? Math.max(0, Math.min(1, remain / total)) : 0
  const r = 19
  const c = 2 * Math.PI * r
  return (
    <div className="relative flex h-[52px] w-[52px] flex-none items-center justify-center">
      <svg width="52" height="52" viewBox="0 0 46 46" className="-rotate-90" aria-hidden="true">
        <circle cx="23" cy="23" r={r} fill="none" stroke="rgb(22 49 46 / .08)" strokeWidth="4" />
        <circle
          cx="23" cy="23" r={r} fill="none" strokeLinecap="round" strokeWidth="4"
          stroke={pct > 0.4 ? '#0f6b65' : '#b13c2e'}
          strokeDasharray={c} strokeDashoffset={c * (1 - pct)}
          style={{ transition: 'stroke-dashoffset 1s linear, stroke .4s' }}
        />
      </svg>
      <span className="mono absolute text-[11px] font-medium tabular-nums">{Math.ceil(remain / 1000)}</span>
    </div>
  )
}

function ToolRow({ item, timeout, onDecide, busy }: { item: ToolConfirm; timeout: number; onDecide: (ok: boolean) => void; busy: boolean }) {
  const remain = Math.max(0, timeout - (Date.now() - item.createdAt))
  const danger = DANGER_TOOLS.has(item.tool)
  return (
    <article className="grid grid-cols-[52px_minmax(0,1fr)] gap-3 border-b border-line-soft py-4 last:border-0 sm:grid-cols-[52px_minmax(0,1fr)_auto] sm:items-start">
      <Ring remain={remain} total={timeout} />
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-1.5">
          <Tag tone={danger ? 'coral' : 'lagoon'}>{danger && <ShieldCheck size={11} />}{item.tool}</Tag>
          <span className="mono text-[10.5px] text-ink-3">#{item.id}</span>
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10.5px] text-ink-3">
          <span className="inline-flex items-center gap-1"><UserRound size={11} />{item.ctx?.user || '未知'}</span>
          <span>{item.ctx?.gid ? `群 ${item.ctx.gid}` : '私聊'}</span>
          <span className="inline-flex items-center gap-1"><Clock3 size={11} />{fmtAgo(item.createdAt)}发起</span>
        </div>
        {item.ctx?.reason && <p className="mt-1.5 text-[11.5px] text-ink-2">事由：{item.ctx.reason}</p>}
        <details className="group mt-2">
          <summary className="cursor-pointer select-none text-[10.5px] text-ink-3 hover:text-ink-2">调用参数</summary>
          <pre className="mono mt-1.5 max-h-52 overflow-auto rounded-lg border border-line-soft bg-white/45 p-2.5 text-[10.5px] leading-relaxed text-ink-2">{JSON.stringify(item.args ?? {}, null, 2)}</pre>
        </details>
      </div>
      <div className="col-span-2 flex gap-2 sm:col-span-1 sm:flex-col">
        <Button size="sm" variant="danger" disabled={busy} onClick={() => onDecide(false)} icon={<X size={12} />}>拒绝</Button>
        <Button size="sm" variant="primary" disabled={busy} onClick={() => onDecide(true)} icon={<Check size={12} />}>批准</Button>
      </div>
    </article>
  )
}

export function ConfirmPage() {
  const toast = useToast()
  const confirm = useConfirm()
  const { refresh: refreshSignals } = useSignals()
  const config = useAsync(() => api.get('/config'), [])
  const confirms = useAsync(() => api.get('/confirm'), [])
  const adoptions = useAsync(() => api.get('/persona-adoptions', { status: 'pending' }), [])
  const [busy, setBusy] = useState('')
  const [, setTick] = useState(0)
  const disposed = useRef(false)

  useEffect(() => {
    disposed.current = false
    const clock = window.setInterval(() => setTick((n) => n + 1), 1000)
    const poll = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return
      void confirms.reload(); void adoptions.reload()
    }, 5000)
    return () => { disposed.current = true; window.clearInterval(clock); window.clearInterval(poll) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useReloadEvent(() => { void confirms.reload(); void adoptions.reload() })

  const timeout = (Number(config.data?.confirmTimeout) || 300) * 1000
  const tools = (confirms.data || []) as ToolConfirm[]
  const pendingAdoptions = (adoptions.data || []).filter((a: Adoption) => a.status === 'pending') as Adoption[]
  const total = tools.length + pendingAdoptions.length
  const error = confirms.error || adoptions.error

  const decide = async (item: ToolConfirm, ok: boolean) => {
    if (ok) {
      const yes = await confirm({
        title: ok ? '批准这次工具调用？' : '拒绝这次工具调用？',
        message: <span>工具 <b>{item.tool}</b> 将在批准后继续执行。请确认参数与事由来自可信对话。</span>,
        confirmText: '批准执行',
      })
      if (!yes) return
    }
    setBusy(item.id)
    try {
      await api.post(`/confirm/${encodeURIComponent(item.id)}/decide`, { approve: ok })
      toast(ok ? `已批准 ${item.tool}` : `已拒绝 ${item.tool}`, ok ? 'success' : 'info')
      await Promise.all([confirms.reload(), refreshSignals()])
    } catch (e: any) {
      toast(e?.message || '操作失败', 'error')
    } finally { setBusy('') }
  }

  const decideAdopt = async (item: Adoption, ok: boolean) => {
    setBusy(item.id)
    try {
      const r = await api.post(`/persona-adoptions/${encodeURIComponent(item.id)}/${ok ? 'approve' : 'reject'}`, {})
      const name = item.personaName || item.personaId
      toast(ok
        ? (r?.ingestError ? `已采纳「${name}」（长尾入库提示：${r.ingestError}）` : `已采纳「${name}」`)
        : `已驳回「${name}」的采纳请求（草稿保留）`, ok ? 'success' : 'info')
      await Promise.all([adoptions.reload(), refreshSignals()])
    } catch (e: any) {
      toast(e?.message || '操作失败', 'error')
    } finally { setBusy('') }
  }

  return (
    <div className="page">
      <PageHeader
        title="审批门"
        description="高风险工具在真正执行前停在这里；人设资料的采纳也会进入待审队列。批准后立即生效。"
        actions={<Button variant="secondary" size="sm" onClick={() => { void confirms.reload(); void adoptions.reload() }}>刷新队列</Button>}
        meta={(
          <>
            <span>工具确认只存内存，重启即清空</span>
            <span className="h-3 w-px bg-ink/10" />
            <span>超时 {Math.round(timeout / 1000)} 秒 · 到点自动拒绝</span>
          </>
        )}
      />

      {error && <div className="mb-4"><ErrorState message={error} onRetry={() => { void confirms.reload(); void adoptions.reload() }} /></div>}

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_300px]">
        <div className="space-y-5">
          <section className="panel" aria-labelledby="tool-confirm-title">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line-soft px-5 py-4">
              <div>
                <h2 id="tool-confirm-title" className="section-title">工具确认</h2>
                <p className="mt-0.5 text-[11.5px] text-ink-3">需二次确认的工具调用 · 按到达时间</p>
              </div>
              <Tag tone={tools.length ? 'coral' : 'jade'}>{tools.length ? `${tools.length} 条待审` : '已清空'}</Tag>
            </div>
            <div className="px-5">
              {confirms.loading && !confirms.data ? (
                <div className="space-y-3 py-4">{[0, 1].map((i) => <Skeleton key={i} className="h-24" />)}</div>
              ) : tools.length === 0 ? (
                <EmptyState icon={<ShieldCheck />} title="没有待确认的工具调用">
                  高风险工具发起时会出现在这里。终端命令在 E2B 沙箱内执行，不走这条队列。
                </EmptyState>
              ) : tools.map((item) => (
                <ToolRow key={item.id} item={item} timeout={timeout} busy={busy === item.id} onDecide={(ok) => void decide(item, ok)} />
              ))}
            </div>
          </section>

          {pendingAdoptions.length > 0 && (
            <section className="panel" aria-labelledby="adoption-title">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line-soft px-5 py-4">
                <div>
                  <h2 id="adoption-title" className="section-title">人设资料采纳</h2>
                  <p className="mt-0.5 text-[11.5px] text-ink-3">批准后草稿才会从 draft 变为 active，并注入身份层</p>
                </div>
                <Tag tone="lagoon">{pendingAdoptions.length} 条</Tag>
              </div>
              <div className="px-5">
                {pendingAdoptions.map((a) => (
                  <article key={a.id} className="border-b border-line-soft py-4 last:border-0">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Tag tone="lagoon"><Drama size={11} />{a.personaName || a.personaId}</Tag>
                      <span className="mono text-[10.5px] text-ink-3">#{a.id}</span>
                      <span className="text-[10.5px] text-ink-3">{a.via === 'qq' ? 'QQ 提交' : 'Web 提交'}</span>
                    </div>
                    {a.snapshot?.summary && <p className="mt-2 text-[12px] leading-relaxed text-ink-2">{a.snapshot.summary}</p>}
                    {a.snapshot?.facts && (
                      <details className="mt-2">
                        <summary className="cursor-pointer text-[10.5px] text-ink-3">核实事实</summary>
                        <pre className="mono mt-1.5 max-h-44 overflow-auto whitespace-pre-wrap rounded-lg border border-line-soft bg-white/45 p-2.5 text-[10.5px] text-ink-2">{a.snapshot.facts}</pre>
                      </details>
                    )}
                    <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                      <span className="text-[10.5px] text-ink-3">{a.by || '—'} · {fmtAgo(a.createdAt)} · 出处 {a.snapshot?.sourceCount || 0} 条 · 长尾 {a.snapshot?.rawNotesLen || 0} 字</span>
                      <div className="flex gap-2">
                        <Button size="sm" variant="secondary" disabled={busy === a.id} onClick={() => void decideAdopt(a, false)} icon={<X size={12} />}>驳回</Button>
                        <Button size="sm" variant="primary" disabled={busy === a.id} onClick={() => void decideAdopt(a, true)} icon={<Check size={12} />}>采纳</Button>
                      </div>
                    </div>
                  </article>
                ))}
              </div>
            </section>
          )}
        </div>

        <aside className="space-y-4">
          <section className="panel p-5">
            <div className="label">全部待审</div>
            <div className="mt-2 flex items-end gap-2">
              <span className="value-xl">{fmtNum(total)}</span>
              <span className="pb-1 text-[11px] text-ink-3">项</span>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-3 border-t border-line-soft pt-3">
              <div>
                <div className="text-[10.5px] text-ink-3">工具确认</div>
                <div className="mono mt-0.5 text-[18px] font-medium">{tools.length}</div>
              </div>
              <div>
                <div className="text-[10.5px] text-ink-3">人设采纳</div>
                <div className="mono mt-0.5 text-[18px] font-medium">{pendingAdoptions.length}</div>
              </div>
            </div>
          </section>
          <section className="panel p-5 text-[11.5px] leading-relaxed text-ink-2">
            <div className="mb-2 flex items-center gap-2 text-[12px] font-medium text-ink"><Terminal size={14} className="text-lagoon" />队列规则</div>
            <p>工具确认只保存在内存里，进程重启即清空。人设采纳会持久保存，批准后草稿才会生效。</p>
            <Link to="/personas" className="mt-3 inline-flex items-center gap-1 text-[11px] text-lagoon hover:underline">去人设库查看资料 <Check size={11} /></Link>
          </section>
        </aside>
      </div>
    </div>
  )
}
