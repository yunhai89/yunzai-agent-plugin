import { useEffect, useMemo, useState } from 'react'
import { EyeOff, Plus, RefreshCw, Trash2, Waves } from 'lucide-react'
import { api } from '@/lib/api'
import { useAsync, useReloadEvent } from '@/lib/hooks'
import { fmtAgo, num, pct } from '@/lib/format'
import { Button, EmptyState, ErrorState, Field, Input, PageHeader, Select, Skeleton, Tag, Textarea } from '@/components/ui'
import { Dialog, Drawer, useConfirm, useToast } from '@/components/Overlay'
import { cn } from '@/lib/cn'

const LEVEL: Record<string, { name: string; desc: string; tone: 'lagoon' | 'jade' | 'amber' | 'neutral' }> = {
  L2: { name: 'L2 近期', desc: '近期上下文事实', tone: 'lagoon' },
  L3: { name: 'L3 偏好', desc: '用户偏好', tone: 'amber' },
  L4: { name: 'L4 事实', desc: '稳定事实 / 身份', tone: 'jade' },
}
const TYPES = [
  { value: 'preference', label: 'preference 偏好' }, { value: 'name', label: 'name 称呼' },
  { value: 'identity', label: 'identity 身份' }, { value: 'fact', label: 'fact 事实' },
]

type Entry = { id: string; level: string; type: string; content: string; confidence: number; createdAt?: number; updatedAt?: number; suspect?: boolean; prev?: { content: string; confidence: number; updatedAt: number }[] }

export function RecallPage() {
  const toast = useToast()
  const confirm = useConfirm()
  const base = useAsync(async () => {
    const [scopes, users] = await Promise.all([api.get('/scopes'), api.get('/recall/users')])
    return { scopes: scopes || [], users: users || [] }
  }, [])
  const [userId, setUserId] = useState('')
  const entriesRes = useAsync(() => userId ? api.get('/recall', { userId }) : Promise.resolve([]), [userId])
  const [level, setLevel] = useState('all')
  const [showSuspect, setShowSuspect] = useState(true)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [addOpen, setAddOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [form, setForm] = useState({ level: 'L3', type: 'preference', content: '', confidence: 0.8 })

  const users = useMemo(() => {
    const list: string[] = []
    const seen = new Set<string>()
    for (const u of [...(base.data?.users || []), ...(base.data?.scopes || []).map((s: any) => s.userId)]) {
      const v = String(u || '')
      if (v && !seen.has(v)) { seen.add(v); list.push(v) }
    }
    return list
  }, [base.data])

  useEffect(() => { if (!userId && users.length) setUserId(users[0]) }, [users, userId])
  useReloadEvent(() => { void base.reload(); if (userId) void entriesRes.reload() })

  const allEntries = (entriesRes.data || []) as Entry[]
  const entries = useMemo(() => allEntries
    .filter((e) => level === 'all' || e.level === level)
    .filter((e) => showSuspect || !e.suspect)
    .slice().sort((a, b) => num(b.updatedAt) - num(a.updatedAt)), [allEntries, level, showSuspect])
  const levelCounts = useMemo(() => ({ L2: allEntries.filter((e) => e.level === 'L2').length, L3: allEntries.filter((e) => e.level === 'L3').length, L4: allEntries.filter((e) => e.level === 'L4').length }), [allEntries])
  const suspectCount = allEntries.filter((e) => e.suspect).length

  const add = async () => {
    if (!form.content.trim() || !userId) return
    setBusy(true)
    try {
      await api.post(`/recall/${encodeURIComponent(userId)}`, { level: form.level, type: form.type, content: form.content.trim(), confidence: form.confidence })
      await entriesRes.reload()
      toast('已写入长期记忆（已过威胁扫描）', 'success')
      setAddOpen(false)
      setForm((f) => ({ ...f, content: '' }))
    } catch (e: any) { toast(e?.message || '写入失败', 'error') }
    finally { setBusy(false) }
  }

  const remove = async (e: Entry) => {
    const ok = await confirm({ title: '删除这条长期记忆？', message: '删除后不可恢复，召回将立即不再命中。', confirmText: '删除', danger: true })
    if (!ok) return
    try {
      await api.del(`/recall/${encodeURIComponent(userId)}/${encodeURIComponent(e.id)}`)
      await entriesRes.reload()
      toast('已删除该条长期记忆', 'info')
    } catch (err: any) { toast(err?.message || '删除失败', 'error') }
  }

  return (
    <div className="page">
      <PageHeader
        title="长期记忆"
        description="LLM 抽取沉淀 · L2/L3/L4 分层 · 超限按价值淘汰；命中注入扫描的条目召回时屏蔽，但仍保留在排查视图。"
        actions={(
          <>
            <Button variant="secondary" size="sm" onClick={() => { void base.reload(); void entriesRes.reload() }} icon={<RefreshCw size={14} />}>刷新</Button>
            <Button variant="primary" size="sm" onClick={() => setAddOpen(true)} disabled={!userId} icon={<Plus size={14} />}>写入记忆</Button>
          </>
        )}
        meta={<><span>写入会经过威胁扫描</span><span className="h-3 w-px bg-ink/10" /><span>可疑条目保留但屏蔽召回</span></>}
      />

      {(base.error || entriesRes.error) && <div className="mb-4"><ErrorState message={base.error || entriesRes.error} onRetry={() => { void base.reload(); if (userId) void entriesRes.reload() }} /></div>}

      <div className="toolbar">
        <span className="text-[11px] text-ink-3">用户</span>
        <div className="flex max-w-full flex-wrap gap-1">
          {users.length === 0 && <span className="text-[11px] text-ink-3">未发现用户</span>}
          {users.slice(0, 24).map((u) => (
            <button key={u} className={cn('tag mono', userId === u ? 'tag-lagoon' : 'tag-neutral')} onClick={() => setUserId(u)} title={u}>{u}</button>
          ))}
        </div>
        <span className="mx-1 hidden h-4 w-px bg-ink/10 sm:block" />
        <div className="segmented" role="group" aria-label="层级筛选">
          {[{ value: 'all', label: '全部' }, ...Object.entries(LEVEL).map(([value, v]) => ({ value, label: value }))].map((o) => (
            <button key={o.value} aria-pressed={level === o.value} onClick={() => setLevel(o.value)}>{o.label}</button>
          ))}
        </div>
        <button className={cn('tag ml-auto', showSuspect ? 'tag-amber' : 'tag-neutral')} onClick={() => setShowSuspect((v) => !v)}>
          <EyeOff size={11} />{showSuspect ? '含可疑条目' : '已隐藏可疑'}
        </button>
      </div>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_290px]">
        <section className="panel overflow-hidden">
          <div className="flex items-center justify-between gap-2 border-b border-line-soft px-5 py-4">
            <div>
              <h2 className="section-title">记忆条目</h2>
              <p className="mt-0.5 text-[11.5px] text-ink-3">{entries.length} 条 · 按更新时间排序</p>
            </div>
            <Button size="sm" variant="secondary" onClick={() => setAddOpen(true)} disabled={!userId} icon={<Plus size={12} />}>写入</Button>
          </div>
          <div className="px-5">
            {entriesRes.loading && !entriesRes.data ? (
              <div className="space-y-2 py-4">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-16" />)}</div>
            ) : entries.length === 0 ? (
              <EmptyState icon={<Waves />} title="该筛选下暂无记忆条目" action={<Button size="sm" variant="secondary" onClick={() => setAddOpen(true)} disabled={!userId} icon={<Plus size={12} />}>写入一条</Button>}>
                继续对话，或手动写入一条长期记忆。
              </EmptyState>
            ) : (
              <ul>
                {entries.map((e, i) => {
                  const lv = LEVEL[e.level] || LEVEL.L3
                  const conf = Math.max(0, Math.min(1, num(e.confidence)))
                  return (
                    <li key={e.id} className={cn('border-b border-line-soft py-3.5 last:border-0', e.suspect && 'bg-coral-soft/20')}>
                      <div className="flex items-start gap-2.5">
                        <span className="mono mt-0.5 w-5 flex-none text-right text-[10px] text-ink-4">{i + 1}</span>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <Tag tone={lv.tone}>{lv.name}</Tag>
                            <span className="text-[10px] text-ink-3">{e.type}</span>
                            {e.suspect && <Tag tone="coral">疑似注入</Tag>}
                          </div>
                          <p className="mt-1.5 whitespace-pre-wrap text-[12.5px] leading-relaxed text-ink">{e.content}</p>
                          <div className="mt-2 flex flex-wrap items-center gap-3 text-[10px] text-ink-3">
                            <span className="flex items-center gap-1.5"><span className="h-1 w-14 overflow-hidden rounded-full bg-ink/5"><span className="block h-full rounded-full bg-lagoon/70" style={{ width: `${conf * 100}%` }} /></span>置信 {pct(conf, 0)}</span>
                            <span>更新于 {fmtAgo(e.updatedAt)}</span>
                            {!!e.prev?.length && (
                              <button className="text-lagoon hover:underline" onClick={() => setExpanded((m) => ({ ...m, [e.id]: !m[e.id] }))}>
                                {expanded[e.id] ? '收起历史' : `${e.prev.length} 个旧值`}
                              </button>
                            )}
                          </div>
                          {expanded[e.id] && e.prev && (
                            <div className="mt-2 space-y-1.5 border-t border-line-soft pt-2">
                              {e.prev.map((p, idx) => (
                                <div key={idx} className="text-[11px] text-ink-3">
                                  <span className="line-through">{p.content}</span>
                                  <span className="mono ml-2 text-[9.5px]">置信 {pct(p.confidence, 0)} · {fmtAgo(p.updatedAt)}</span>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                        <Button size="icon" variant="ghost" className="btn-sm flex-none text-ink-3 hover:text-coral" onClick={() => void remove(e)} aria-label="删除记忆" title="删除"><Trash2 size={13} /></Button>
                      </div>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        </section>

        <aside className="space-y-4">
          <section className="panel p-5">
            <div className="label">当前用户存量</div>
            <div className="mt-2 flex items-end gap-2"><span className="value-xl">{allEntries.length}</span><span className="pb-1 text-[10px] text-ink-3">条</span></div>
            <div className="mt-3 grid grid-cols-3 gap-2 border-t border-line-soft pt-3 text-center">
              {Object.entries(levelCounts).map(([k, v]) => <div key={k}><div className="text-[9.5px] text-ink-3">{k}</div><div className="mono mt-0.5 text-[16px]">{v}</div></div>)}
            </div>
            <p className="mt-3 text-[10px] text-ink-3">上限 200 · 超限按价值淘汰</p>
          </section>
          <section className="panel p-5">
            <div className="flex items-baseline justify-between gap-3 border-b border-line-soft py-2 first:pt-0"><span className="text-[11px] text-ink-3">KV 键</span><span className="mono truncate text-[10px]">Yz:agent:mem:{userId || '—'}</span></div>
            <div className="flex items-baseline justify-between py-2"><span className="text-[11px] text-ink-3">可疑条目</span><span className={cn('mono text-[11px]', suspectCount > 0 && 'text-coral')}>{suspectCount}</span></div>
            <p className="mt-2 border-t border-line-soft pt-3 text-[10.5px] leading-relaxed text-ink-3">长期记忆由 LLM 在对话后异步抽取，也可手动写入。写入会经过威胁扫描；可疑条目召回时会被屏蔽。</p>
          </section>
        </aside>
      </div>

      <Dialog
        open={addOpen}
        onClose={() => !busy && setAddOpen(false)}
        title="写入长期记忆"
        description={`写入用户 ${userId || '—'} 的记忆库`}
        footer={(
          <>
            <Button variant="secondary" onClick={() => setAddOpen(false)} disabled={busy}>取消</Button>
            <Button variant="primary" onClick={() => void add()} loading={busy} disabled={!form.content.trim() || !userId}>写入</Button>
          </>
        )}
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="层级">
            <Select value={form.level} onChange={(e) => setForm((f) => ({ ...f, level: e.target.value }))}>
              {Object.entries(LEVEL).map(([k, v]) => <option key={k} value={k}>{k} · {v.desc}</option>)}
            </Select>
          </Field>
          <Field label="类型">
            <Select value={form.type} onChange={(e) => setForm((f) => ({ ...f, type: e.target.value }))}>
              {TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </Select>
          </Field>
          <Field label="内容" className="sm:col-span-2">
            <Textarea value={form.content} onChange={(e) => setForm((f) => ({ ...f, content: e.target.value }))} placeholder="例如：用户周五晚上有固定开黑活动" autoFocus />
          </Field>
          <Field label={`置信度 ${(form.confidence * 100).toFixed(0)}%`} className="sm:col-span-2" hint="写入会经过威胁扫描；疑似注入会降置信并屏蔽召回。">
            <input type="range" min={0.1} max={1} step={0.05} value={form.confidence} onChange={(e) => setForm((f) => ({ ...f, confidence: Number(e.target.value) }))} className="w-full accent-lagoon" />
          </Field>
        </div>
      </Dialog>
    </div>
  )
}
