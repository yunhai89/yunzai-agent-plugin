import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { AlertTriangle, CheckCircle2, ChevronRight, ListChecks, PlayCircle, RefreshCw, RotateCcw, XCircle } from 'lucide-react'
import { api } from '@/lib/api'
import { useAsync, useReloadEvent } from '@/lib/hooks'
import { fmtDate, fmtNum } from '@/lib/format'
import { Button, EmptyState, ErrorState, PageHeader, Select, Skeleton, Tag } from '@/components/ui'
import { Drawer, useConfirm, useToast } from '@/components/Overlay'
import { cn } from '@/lib/cn'

const PHASES = ['', 'running', 'paused', 'waiting_input', 'interrupted', 'completed', 'failed', 'cancelled'] as const
const PHASE_CN: Record<string, string> = {
  running: '运行中', paused: '已暂停', waiting_input: '等待输入', interrupted: '已中断',
  completed: '已完成', failed: '失败', cancelled: '已取消', queued: '排队中',
}
const PHASE_TONE: Record<string, 'jade' | 'amber' | 'coral' | 'lagoon' | 'neutral'> = {
  completed: 'jade', running: 'lagoon', paused: 'amber', waiting_input: 'amber',
  interrupted: 'amber', queued: 'neutral', failed: 'coral', cancelled: 'coral',
}
const terminal = (p: string) => ['completed', 'failed', 'cancelled'].includes(p)

type Task = {
  taskId: string; phase: string; updatedAt: number; stopReason?: string; completion?: string;
  revision?: number; scopeKey?: string; sessionCursor?: string
}
type Plan = {
  counts: { reuse: number; retry: number; reconcile: number; block: number };
  steps: { name?: string; callId?: string; action: string; reason: string }[];
  hasBlocking?: boolean; autoResumable?: boolean
}

export function TasksPage() {
  const toast = useToast()
  const confirm = useConfirm()
  const [phase, setPhase] = useState('')
  const list = useAsync(() => api.get('/tasks', { ...(phase ? { phase } : {}), limit: 100 }), [phase])
  const [detail, setDetail] = useState<Task | null>(null)
  const [events, setEvents] = useState<any[]>([])
  const [plan, setPlan] = useState<Plan | null>(null)
  const [busy, setBusy] = useState('')
  const [detailBusy, setDetailBusy] = useState(false)

  useReloadEvent(() => void list.reload())

  const data = list.data || { enabled: false, tasks: [] }
  const tasks = (data.tasks || []) as Task[]
  const counts = useMemo(() => {
    const out: Record<string, number> = {}
    for (const t of tasks) out[t.phase] = (out[t.phase] || 0) + 1
    return out
  }, [tasks])

  const open = async (t: Task) => {
    setDetail(t); setEvents([]); setPlan(null); setDetailBusy(true)
    try {
      const d = await api.get(`/tasks/${encodeURIComponent(t.taskId)}`)
      setDetail(d.task || t)
      setEvents(d.events || [])
    } catch (e: any) { toast(e?.message || '读取任务失败', 'error') }
    finally { setDetailBusy(false) }
  }

  const loadPlan = async () => {
    if (!detail) return
    setDetailBusy(true)
    try { setPlan(await api.get(`/tasks/${encodeURIComponent(detail.taskId)}/recovery`)) }
    catch (e: any) { toast(e?.message || '推导恢复计划失败', 'error') }
    finally { setDetailBusy(false) }
  }

  const act = async (kind: 'cancel' | 'resume') => {
    if (!detail) return
    if (kind === 'cancel') {
      const ok = await confirm({ title: '取消这个任务？', message: '任务将停在当前边界；已产生的副作用不会被撤回。', confirmText: '取消任务', danger: true })
      if (!ok) return
    }
    setBusy(kind)
    try {
      await api.post(`/tasks/${encodeURIComponent(detail.taskId)}/${kind}`)
      toast(kind === 'cancel' ? '已取消任务' : '已恢复检查点（不自动重放副作用）', 'info')
      setDetail(null)
      await list.reload()
    } catch (e: any) { toast(e?.message || '操作失败', 'error') }
    finally { setBusy('') }
  }

  return (
    <div className="page">
      <PageHeader
        title="任务账本"
        description="可恢复任务的阶段、事件与检查点。恢复只取回检查点，不自动重放副作用。"
        actions={(
          <>
            <Select value={phase} onChange={(e) => setPhase(e.target.value)} aria-label="阶段筛选" className="w-[150px]">
              {PHASES.map((p) => <option key={p} value={p}>{p ? (PHASE_CN[p] || p) : '全部阶段'}</option>)}
            </Select>
            <Button variant="secondary" size="sm" onClick={() => void list.reload()} icon={<RefreshCw size={14} />}>刷新</Button>
          </>
        )}
        meta={<><span>最多显示 100 条</span><span className="h-3 w-px bg-ink/10" /><span>任务库开关：配置中心 · 任务账本</span></>}
      />

      {list.error && <div className="mb-4"><ErrorState message={list.error} onRetry={() => void list.reload()} /></div>}

      {!data.enabled && !list.loading && !list.error ? (
        <div className="panel">
          <EmptyState
            icon={<ListChecks />}
            title="任务账本未启用"
            action={<Link to="/config" className="btn btn-primary btn-sm">去配置中心开启</Link>}
          >
            开启 <span className="mono">taskStore.enable</span> 后，任务会在关键边界落盘为可恢复记录。
          </EmptyState>
        </div>
      ) : list.error && !list.data ? null : (
        <>
          <div className="mb-4 flex flex-wrap gap-1.5">
            <button className={cn('tag', phase === '' ? 'tag-lagoon' : 'tag-neutral')} onClick={() => setPhase('')}>全部 {tasks.length}</button>
            {Object.entries(counts).map(([p, n]) => (
              <button key={p} className={cn('tag', phase === p ? 'tag-lagoon' : 'tag-neutral')} onClick={() => setPhase(p)}>
                {PHASE_CN[p] || p} {n}
              </button>
            ))}
          </div>

          {list.loading && !list.data ? (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">{[0, 1, 2, 3, 4, 5].map((i) => <Skeleton key={i} className="h-36" />)}</div>
          ) : tasks.length === 0 ? (
            <div className="panel"><EmptyState icon={<ListChecks />} title="暂无任务记录">开启后，复杂任务会在关键边界写入账本。</EmptyState></div>
          ) : (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
              {tasks.map((t) => (
                <button key={t.taskId} className="panel group p-4 text-left transition hover:-translate-y-0.5 hover:shadow-[0_28px_60px_-42px_rgba(10,78,74,.5)]" onClick={() => void open(t)}>
                  <div className="flex items-center justify-between gap-2">
                    <Tag tone={PHASE_TONE[t.phase] || 'neutral'}>{PHASE_CN[t.phase] || t.phase || '—'}</Tag>
                    <span className="mono text-[10px] text-ink-3">{fmtDate(t.updatedAt)}</span>
                  </div>
                  <div className="mono mt-3 break-all text-[10.5px] leading-relaxed text-ink-2">{t.taskId}</div>
                  <div className="mt-2 text-[11px] leading-relaxed text-ink-3">
                    {t.stopReason ? `停止：${t.stopReason}` : `completion：${t.completion || '—'}`} · 回合 {t.revision ?? 0}
                  </div>
                  <div className="mt-2 flex items-center justify-between gap-2">
                    <span className="mono truncate text-[10px] text-ink-4">{t.scopeKey || '—'}</span>
                    <ChevronRight size={14} className="text-ink-4 transition group-hover:translate-x-0.5 group-hover:text-lagoon" />
                  </div>
                </button>
              ))}
            </div>
          )}
        </>
      )}

      <Drawer
        open={!!detail}
        onClose={() => setDetail(null)}
        title={detail ? `任务 ${detail.taskId.slice(0, 12)}${detail.taskId.length > 12 ? '…' : ''}` : '任务详情'}
        description={detail ? `${PHASE_CN[detail.phase] || detail.phase} · ${detail.stopReason || detail.completion || '—'}` : undefined}
        width={640}
        footer={detail ? (
          <>
            <Button variant="secondary" onClick={() => setDetail(null)}>关闭</Button>
            {!terminal(detail.phase) && <Button variant="secondary" onClick={() => void act('resume')} loading={busy === 'resume'} icon={<RotateCcw size={13} />}>恢复检查点</Button>}
            {!terminal(detail.phase) && <Button variant="danger" onClick={() => void act('cancel')} loading={busy === 'cancel'} icon={<XCircle size={13} />}>取消任务</Button>}
          </>
        ) : null}
      >
        {detail && (
          <div className="space-y-5">
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <div className="rounded-lg border border-line-soft bg-white/40 px-3 py-2">
                <div className="text-[10px] text-ink-3">Scope</div>
                <div className="mono mt-0.5 break-all text-[11px]">{detail.scopeKey || '—'}</div>
              </div>
              <div className="rounded-lg border border-line-soft bg-white/40 px-3 py-2">
                <div className="text-[10px] text-ink-3">会话游标</div>
                <div className="mono mt-0.5 break-all text-[11px]">{detail.sessionCursor || '—'}</div>
              </div>
            </div>

            <section>
              <div className="mb-2 flex items-center justify-between">
                <h3 className="text-[12px] font-medium">事件 <span className="mono text-ink-3">{events.length}</span></h3>
                {detailBusy && <span className="text-[10px] text-ink-3">读取中…</span>}
              </div>
              {events.length === 0 ? (
                <p className="rounded-lg border border-line-soft bg-white/35 px-3 py-4 text-center text-[11px] text-ink-3">暂无事件</p>
              ) : (
                <ol className="max-h-[280px] space-y-0 overflow-auto rounded-lg border border-line-soft">
                  {events.map((e) => (
                    <li key={e.seq} className="flex items-start gap-2 border-b border-line-soft px-3 py-2 text-[11px] last:border-0">
                      <span className="mono flex-none text-ink-3">#{e.seq}</span>
                      <span className="min-w-0 flex-1">
                        <span className="font-medium">{e.kind}</span>
                        {e.callId && <span className="mono ml-1 text-ink-3">({e.callId})</span>}
                        {e.phase && <span className="text-ink-3"> → {e.phase}</span>}
                      </span>
                    </li>
                  ))}
                </ol>
              )}
            </section>

            <section>
              <div className="mb-2 flex items-center justify-between">
                <h3 className="text-[12px] font-medium">恢复计划</h3>
                {!plan && <Button size="sm" variant="secondary" onClick={() => void loadPlan()} loading={detailBusy} icon={<PlayCircle size={12} />}>推导恢复计划</Button>}
              </div>
              {plan ? (
                <div className="rounded-lg border border-line-soft bg-white/40 p-3">
                  <div className="flex flex-wrap gap-1.5 text-[10px]">
                    <Tag tone="neutral">复用 {plan.counts.reuse}</Tag>
                    <Tag tone="neutral">可重试 {plan.counts.retry}</Tag>
                    <Tag tone="amber">需核实 {plan.counts.reconcile}</Tag>
                    <Tag tone="coral">阻断 {plan.counts.block}</Tag>
                  </div>
                  <div className="mt-2 space-y-1">
                    {plan.steps.map((s, i) => (
                      <div key={i} className="text-[11px] text-ink-2">
                        <span className="mono text-ink">{s.name || s.callId}</span> → {s.action}
                        <span className="text-ink-3">（{s.reason}）</span>
                      </div>
                    ))}
                  </div>
                  {plan.hasBlocking ? (
                    <p className="mt-2 flex items-center gap-1.5 text-[10.5px] text-coral"><AlertTriangle size={12} />存在未知写副作用，请先核实外部状态。</p>
                  ) : plan.autoResumable ? (
                    <p className="mt-2 flex items-center gap-1.5 text-[10.5px] text-jade"><CheckCircle2 size={12} />全部为可安全重放的只读 / 未开始步骤。</p>
                  ) : null}
                </div>
              ) : (
                <p className="rounded-lg border border-dashed border-line px-3 py-4 text-center text-[11px] text-ink-3">尚未推导。恢复计划只读，不会执行。</p>
              )}
            </section>

            <div className="flex items-center justify-between text-[10px] text-ink-4">
              <span>事件回合 {detail.revision ?? 0}</span>
              <span>更新 {fmtDate(detail.updatedAt)}</span>
            </div>
          </div>
        )}
      </Drawer>
    </div>
  )
}
