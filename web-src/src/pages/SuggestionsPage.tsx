import { useMemo, useState } from 'react'
import { Check, ChevronDown, Lightbulb, RefreshCw, Sparkles, X } from 'lucide-react'
import { api } from '@/lib/api'
import { useAsync, useReloadEvent } from '@/lib/hooks'
import { fmtAgo, fmtNum, num, safeJson } from '@/lib/format'
import { Button, EmptyState, ErrorState, Field, PageHeader, Skeleton, Tag, Textarea } from '@/components/ui'
import { Dialog, Drawer, useConfirm, useToast } from '@/components/Overlay'
import { useSignals } from '@/lib/auth'
import { cn } from '@/lib/cn'

const KIND: Record<string, { name: string; tone: 'amber' | 'lagoon' | 'coral' | 'neutral' | 'jade' }> = {
  memory: { name: '记忆', tone: 'amber' }, skill: { name: '技能', tone: 'lagoon' },
  prompt: { name: 'Prompt', tone: 'jade' }, tool: { name: '工具', tone: 'neutral' },
}
const ACTION: Record<string, string> = { add: '新增', remove: '删除', replace: '替换', update: '更新', create: '创建' }
const STATUS: Record<string, { name: string; tone: 'jade' | 'amber' | 'coral' | 'neutral' }> = {
  pending: { name: '待审', tone: 'amber' }, applied: { name: '已应用', tone: 'jade' }, apply_failed: { name: '应用失败', tone: 'coral' },
}

type Suggestion = {
  id: string; kind: string; action: string; target: string; payload: any; newPayload?: any;
  confidence?: number; status: string; scopeId?: string; ts?: number; error?: string
}

export function SuggestionsPage() {
  const toast = useToast()
  const confirm = useConfirm()
  const { refresh: refreshSignals } = useSignals()
  const list = useAsync(() => api.get('/suggestions'), [])
  const [status, setStatus] = useState('all')
  const [kind, setKind] = useState('all')
  const [selected, setSelected] = useState<Suggestion | null>(null)
  const [userText, setUserText] = useState('')
  const [busy, setBusy] = useState('')

  useReloadEvent(() => void list.reload())

  const items = useMemo(() => {
    return ((list.data || []) as Suggestion[])
      .filter((s) => status === 'all' || s.status === status)
      .filter((s) => kind === 'all' || s.kind === kind)
      .slice().sort((a, b) => num(b.ts) - num(a.ts))
  }, [list.data, status, kind])
  const pendingCount = ((list.data || []) as Suggestion[]).filter((s) => s.status === 'pending').length

  const apply = async (s: Suggestion, text?: string) => {
    setBusy(s.id)
    try {
      await api.post(`/suggestions/${encodeURIComponent(s.id)}/apply`, text ? { userText: text } : undefined)
      toast(`建议 ${s.id} 已应用`, 'success')
      setSelected(null)
      setUserText('')
      await Promise.all([list.reload(), refreshSignals()])
    } catch (e: any) { toast(e?.message || '应用失败', 'error'); await list.reload().catch(() => {}); await refreshSignals() }
    finally { setBusy('') }
  }

  const reject = async (s: Suggestion) => {
    const ok = await confirm({ title: '驳回这条建议？', message: '建议文件会被删除；已应用的改动不会回滚。', confirmText: '驳回', danger: true })
    if (!ok) return
    setBusy(s.id)
    try {
      await api.del(`/suggestions/${encodeURIComponent(s.id)}`)
      toast(`建议 ${s.id} 已驳回`, 'info')
      await Promise.all([list.reload(), refreshSignals()])
    } catch (e: any) { toast(e?.message || '驳回失败', 'error') }
    finally { setBusy('') }
  }

  const beginApply = (s: Suggestion) => {
    setSelected(s)
    setUserText('')
  }

  return (
    <div className="page">
      <PageHeader
        title="进化建议"
        description="自评审产出的待审改进项。采纳后写入记忆、提示或技能；驳回会删除建议文件。"
        actions={<Button variant="secondary" size="sm" onClick={() => void list.reload()} icon={<RefreshCw size={14} />}>刷新</Button>}
        meta={<><span>待审 {pendingCount} 条</span><span className="h-3 w-px bg-ink/10" /><span>应用前可展开原文</span></>}
      />

      {list.error && <div className="mb-4"><ErrorState message={list.error} onRetry={() => void list.reload()} /></div>}

      <div className="panel mb-4 flex flex-wrap items-center justify-between gap-3 px-4 py-3">
        <div className="flex items-center gap-2 text-[12px] text-ink-2">
          <Lightbulb size={15} className="text-amber" />
          <span>建议队列</span>
          <span className="text-[10.5px] text-ink-3">memory 类可自动应用，prompt / skill 默认落盘待人工把关</span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex flex-wrap gap-1">
            {[{ value: 'all', label: '全部' }, ...Object.entries(STATUS).map(([value, v]) => ({ value, label: v.name }))].map((o) => (
              <button key={o.value} className={cn('tag', status === o.value ? 'tag-lagoon' : 'tag-neutral')} onClick={() => setStatus(o.value)}>{o.label}</button>
            ))}
          </div>
          <span className="hidden h-4 w-px bg-ink/10 sm:block" />
          <div className="flex flex-wrap gap-1">
            {[{ value: 'all', label: '全部类' }, ...Object.entries(KIND).map(([value, v]) => ({ value, label: v.name }))].map((o) => (
              <button key={o.value} className={cn('tag', kind === o.value ? 'tag-lagoon' : 'tag-neutral')} onClick={() => setKind(o.value)}>{o.label}</button>
            ))}
          </div>
        </div>
      </div>

      {list.loading && !list.data ? (
        <div className="space-y-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-32" />)}</div>
      ) : items.length === 0 ? (
        <div className="panel"><EmptyState icon={<Sparkles />} title="该筛选下暂无建议">每 N 轮对话后台自评审会产出改进项，可在配置中心的「自进化」里调整。</EmptyState></div>
      ) : (
        <div className="space-y-3">
          {items.map((s) => {
            const k = KIND[s.kind] || { name: s.kind || '?', tone: 'neutral' as const }
            const st = STATUS[s.status] || { name: s.status || '?', tone: 'neutral' as const }
            const conf = Math.max(0, Math.min(1, num(s.confidence)))
            return (
              <article key={s.id} className="panel p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Tag tone={k.tone}>{k.name}</Tag>
                    <Tag tone="neutral">{ACTION[s.action] || s.action || '—'}</Tag>
                    <span className="mono rounded bg-white/55 px-1.5 py-0.5 text-[10px] text-ink-2">target: {s.target}</span>
                    <Tag tone={st.tone}>{st.name}</Tag>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="h-1.5 w-20 overflow-hidden rounded-full bg-ink/5">
                      <div className={cn('h-full rounded-full', conf > 0.85 ? 'bg-jade' : conf > 0.65 ? 'bg-lagoon' : 'bg-amber')} style={{ width: `${conf * 100}%` }} />
                    </div>
                    <span className="mono text-[10px] text-ink-3">置信 {(conf * 100).toFixed(0)}%</span>
                  </div>
                </div>

                {s.action === 'replace' && s.newPayload != null ? (
                  <div className="mt-3 grid grid-cols-1 gap-2 md:grid-cols-2">
                    <div className="min-w-0 rounded-lg border border-coral/15 bg-coral-soft/35 p-2.5">
                      <div className="mb-1 text-[9.5px] tracking-[.06em] text-coral">旧值</div>
                      <pre className="mono max-h-48 overflow-auto whitespace-pre-wrap text-[10.5px] leading-relaxed text-ink-2">{safeJson(s.payload)}</pre>
                    </div>
                    <div className="min-w-0 rounded-lg border border-jade/20 bg-jade-soft/35 p-2.5">
                      <div className="mb-1 text-[9.5px] tracking-[.06em] text-jade">新值</div>
                      <pre className="mono max-h-48 overflow-auto whitespace-pre-wrap text-[10.5px] leading-relaxed text-ink-2">{safeJson(s.newPayload)}</pre>
                    </div>
                  </div>
                ) : (
                  <details className="mt-3">
                    <summary className="flex cursor-pointer select-none items-center gap-1.5 text-[10.5px] text-ink-3 hover:text-ink-2">查看内容 <ChevronDown size={11} /></summary>
                    <pre className="mono mt-1.5 max-h-56 overflow-auto whitespace-pre-wrap rounded-lg border border-line-soft bg-white/40 p-2.5 text-[10.5px] leading-relaxed text-ink-2">{safeJson(s.payload)}</pre>
                  </details>
                )}

                <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-line-soft pt-2.5">
                  <div className="min-w-0 text-[10px] text-ink-3">
                    <span className="mono">{s.id}</span> · scope <span className="mono">{s.scopeId || '—'}</span> · {fmtAgo(s.ts)}
                    {s.error && <span className="text-coral"> · {s.error}</span>}
                  </div>
                  {s.status === 'pending' && (
                    <div className="flex gap-2">
                      <Button size="sm" variant="danger" disabled={busy === s.id} onClick={() => void reject(s)} icon={<X size={12} />}>驳回</Button>
                      <Button size="sm" variant="primary" disabled={busy === s.id} onClick={() => beginApply(s)} loading={busy === s.id} icon={<Check size={12} />}>应用</Button>
                    </div>
                  )}
                </div>
              </article>
            )
          })}
        </div>
      )}

      <Dialog
        open={!!selected}
        onClose={() => !busy && setSelected(null)}
        title={selected ? `应用${KIND[selected.kind]?.name || selected.kind}建议` : '应用建议'}
        description={selected?.kind === 'memory' ? '这条建议会写入长期记忆。若建议带有证据，建议补充用户原话，便于审计。' : '应用后会写入对应的记忆、提示或技能。请先核对下方内容。'}
        footer={(
          <>
            <Button variant="secondary" onClick={() => setSelected(null)} disabled={!!busy}>取消</Button>
            <Button variant="primary" onClick={() => selected && void apply(selected, userText.trim() || undefined)} loading={!!busy} icon={<Check size={13} />}>确认应用</Button>
          </>
        )}
      >
        <div className="space-y-3">
          <div className="rounded-lg border border-line-soft bg-white/40 p-3">
            <div className="text-[10px] text-ink-3">建议内容</div>
            <pre className="mono mt-1 max-h-56 overflow-auto whitespace-pre-wrap text-[11px] leading-relaxed">{safeJson(selected?.payload)}</pre>
          </div>
          {selected?.kind === 'memory' && <Field label="用户原话（可选）" hint="带证据的记忆建议最好补充；留空则由后端按原逻辑处理。">
            <Textarea value={userText} onChange={(e) => setUserText(e.target.value)} placeholder="粘贴用户说过的话，作为写入口径" />
          </Field>}
        </div>
      </Dialog>
    </div>
  )
}
