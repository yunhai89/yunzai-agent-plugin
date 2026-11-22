import { useEffect, useMemo, useState } from 'react'
import { Clock3, Plus, RefreshCw, Trash2, UserRound } from 'lucide-react'
import { api } from '@/lib/api'
import { useAsync, useReloadEvent } from '@/lib/hooks'
import { fmtAgo, num, pct } from '@/lib/format'
import { Button, EmptyState, ErrorState, Field, PageHeader, Select, Skeleton, Tag, Textarea } from '@/components/ui'
import { Dialog, Drawer, useConfirm, useToast } from '@/components/Overlay'
import { cn } from '@/lib/cn'

const FACETS: Record<string, { name: string; tone: 'lagoon' | 'jade' | 'amber' | 'coral' | 'neutral' }> = {
  identity: { name: '身份', tone: 'lagoon' }, communication: { name: '沟通风格', tone: 'jade' },
  preference: { name: '偏好', tone: 'lagoon' }, expertise: { name: '专长', tone: 'amber' },
  sensitivity: { name: '忌讳 / 雷点', tone: 'coral' }, fact: { name: '其他事实', tone: 'neutral' },
}
const SOURCE: Record<string, { name: string; tone: 'jade' | 'amber' | 'lagoon' | 'neutral' }> = {
  observed: { name: '观察', tone: 'jade' }, inferred: { name: '推断', tone: 'amber' },
  corrected: { name: '更正', tone: 'lagoon' }, manual: { name: '手动', tone: 'neutral' },
}
type Entry = {
  id: string; facet: string; claim: string; source: string; confidence: number; evidence?: string[];
  observedAt?: number; updatedAt?: number; status?: string; suspect?: boolean;
  prev?: { claim: string; confidence: number; source: string; updatedAt: number }[]
}
type Stats = { msgs?: number; chars?: number; emojis?: number; questions?: number; hours?: Record<string, number> }

export function ProfilePage() {
  const toast = useToast()
  const confirm = useConfirm()
  const base = useAsync(async () => {
    const [scopes, users] = await Promise.all([api.get('/scopes'), api.get('/profile/users')])
    return { scopes: scopes || [], users: users || [] }
  }, [])
  const [userId, setUserId] = useState('')
  const data = useAsync(() => userId ? api.get('/profile', { userId }) : Promise.resolve({ entries: [], stats: {} }), [userId])
  const [facet, setFacet] = useState('all')
  const [showSuperseded, setShowSuperseded] = useState(false)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [addOpen, setAddOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [form, setForm] = useState({ facet: 'communication', claim: '', confidence: 0.9 })

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
  useReloadEvent(() => { void base.reload(); if (userId) void data.reload() })

  const disabled = !!data.data?.disabled
  const allEntries = (data.data?.entries || []) as Entry[]
  const stats: Stats = data.data?.stats || {}
  const entries = useMemo(() => allEntries
    .filter((e) => facet === 'all' || e.facet === facet)
    .filter((e) => showSuperseded || e.status !== 'superseded')
    .slice().sort((a, b) => num(b.updatedAt) - num(a.updatedAt)), [allEntries, facet, showSuperseded])
  const activeCount = allEntries.filter((e) => e.status !== 'superseded').length
  const msgs = num(stats.msgs)
  const avg = msgs ? Math.round(num(stats.chars) / msgs) : 0
  const emojiRate = msgs ? Math.round((num(stats.emojis) / msgs) * 100) : 0
  const askRate = msgs ? Math.round((num(stats.questions) / msgs) * 100) : 0
  const topHours = Object.entries(stats.hours || {}).sort((a, b) => b[1] - a[1]).slice(0, 3)

  const add = async () => {
    if (!form.claim.trim() || !userId) return
    setBusy(true)
    try {
      await api.post(`/profile/${encodeURIComponent(userId)}`, { facet: form.facet, claim: form.claim.trim(), confidence: form.confidence })
      await data.reload()
      toast('已写入画像（已过威胁扫描）', 'success')
      setAddOpen(false)
      setForm((f) => ({ ...f, claim: '' }))
    } catch (e: any) { toast(e?.message || '写入失败', 'error') }
    finally { setBusy(false) }
  }

  const removeEntry = async (e: Entry) => {
    const ok = await confirm({ title: '移除这条画像？', message: '条目会被标记为已替换，并保留审计链；不是物理删除。', confirmText: '移除条目', danger: true })
    if (!ok) return
    try {
      await api.del(`/profile/${encodeURIComponent(userId)}/${encodeURIComponent(e.id)}`)
      await data.reload()
      toast('已移除该画像条目（保留审计链）', 'info')
    } catch (err: any) { toast(err?.message || '移除失败', 'error') }
  }

  const clearUser = async () => {
    if (!userId) return
    const ok = await confirm({ title: `清空 ${userId} 的画像？`, message: '会物理删除该用户的画像 KV 键，不可恢复。', confirmText: '清空画像', danger: true, requireText: userId })
    if (!ok) return
    try {
      await api.del(`/profile/${encodeURIComponent(userId)}`)
      await data.reload()
      toast('已清空该用户画像', 'info')
    } catch (e: any) { toast(e?.message || '清空失败', 'error') }
  }

  return (
    <div className="page">
      <PageHeader
        title="用户画像"
        description="统一用户模型 · 身份 / 沟通风格 / 偏好 / 忌讳分面 · 每条带证据、置信与来源，可纠错。"
        actions={(
          <>
            <Button variant="secondary" size="sm" onClick={() => { void base.reload(); if (userId) void data.reload() }} icon={<RefreshCw size={14} />}>刷新</Button>
            <Button variant="danger" size="sm" onClick={() => void clearUser()} disabled={!userId || disabled} icon={<Trash2 size={13} />}>清空</Button>
            <Button variant="primary" size="sm" onClick={() => setAddOpen(true)} disabled={!userId || disabled} icon={<Plus size={14} />}>写入画像</Button>
          </>
        )}
        meta={<><span>{disabled ? '画像未启用' : '人工更正优先于推断'}</span><span className="h-3 w-px bg-ink/10" /><span>删除条目保留审计链</span></>}
      />

      {(base.error || data.error) && <div className="mb-4"><ErrorState message={base.error || data.error} onRetry={() => { void base.reload(); if (userId) void data.reload() }} /></div>}

      <div className="toolbar">
        <span className="text-[11px] text-ink-3">用户</span>
        <div className="flex max-w-full flex-wrap gap-1">
          {users.length === 0 && <span className="text-[11px] text-ink-3">未发现用户</span>}
          {users.slice(0, 24).map((u) => <button key={u} className={cn('tag mono', userId === u ? 'tag-lagoon' : 'tag-neutral')} onClick={() => setUserId(u)} title={u}>{u}</button>)}
        </div>
        <span className="mx-1 hidden h-4 w-px bg-ink/10 sm:block" />
        <div className="flex flex-wrap gap-1">
          <button className={cn('tag', facet === 'all' ? 'tag-lagoon' : 'tag-neutral')} onClick={() => setFacet('all')}>全部</button>
          {Object.entries(FACETS).map(([k, v]) => <button key={k} className={cn('tag', facet === k ? 'tag-lagoon' : 'tag-neutral')} onClick={() => setFacet(k)}>{v.name}</button>)}
        </div>
        <button className={cn('tag ml-auto', showSuperseded ? 'tag-amber' : 'tag-neutral')} onClick={() => setShowSuperseded((v) => !v)}>
          <Clock3 size={11} />{showSuperseded ? '含已替换' : '隐藏已替换'}
        </button>
      </div>

      {disabled ? (
        <div className="panel"><EmptyState icon={<UserRound />} title="用户画像未启用">在配置中心 → 记忆系统打开「用户画像」后生效。</EmptyState></div>
      ) : (
        <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_290px]">
          <section className="panel overflow-hidden">
            <div className="flex items-center justify-between gap-2 border-b border-line-soft px-5 py-4">
              <div><h2 className="section-title">画像条目</h2><p className="mt-0.5 text-[11.5px] text-ink-3">{entries.length} 条 · 证据与置信度可追溯</p></div>
              <Button size="sm" variant="secondary" onClick={() => setAddOpen(true)} icon={<Plus size={12} />}>写入</Button>
            </div>
            <div className="px-5">
              {data.loading && !data.data ? (
                <div className="space-y-2 py-4">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-16" />)}</div>
              ) : entries.length === 0 ? (
                <EmptyState icon={<UserRound />} title="该筛选下暂无画像条目" action={<Button size="sm" variant="secondary" onClick={() => setAddOpen(true)} icon={<Plus size={12} />}>写入一条</Button>}>
                  继续对话会自动归纳，也可手动写入。
                </EmptyState>
              ) : (
                <ul>
                  {entries.map((e, i) => {
                    const f = FACETS[e.facet] || FACETS.fact
                    const src = SOURCE[e.source] || { name: e.source || '—', tone: 'neutral' as const }
                    const conf = Math.max(0, Math.min(1, num(e.confidence)))
                    const superseded = e.status === 'superseded'
                    return (
                      <li key={e.id} className={cn('border-b border-line-soft py-3.5 last:border-0', e.suspect && 'bg-coral-soft/20')}>
                        <div className="flex items-start gap-2.5">
                          <span className="mono mt-0.5 w-5 flex-none text-right text-[10px] text-ink-4">{i + 1}</span>
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <Tag tone={f.tone}>{f.name}</Tag>
                              <Tag tone={src.tone}>{src.name}</Tag>
                              {superseded && <Tag tone="neutral">已替换</Tag>}
                              {e.suspect && <Tag tone="coral">疑似注入</Tag>}
                            </div>
                            <p className={cn('mt-1.5 whitespace-pre-wrap text-[12.5px] leading-relaxed', superseded ? 'text-ink-3 line-through' : 'text-ink')}>{e.claim}</p>
                            <div className="mt-2 flex flex-wrap items-center gap-3 text-[10px] text-ink-3">
                              <span className="flex items-center gap-1.5"><span className="h-1 w-14 overflow-hidden rounded-full bg-ink/5"><span className="block h-full rounded-full bg-lagoon/70" style={{ width: `${conf * 100}%` }} /></span>置信 {pct(conf, 0)}</span>
                              <span>更新于 {fmtAgo(e.updatedAt)}</span>
                              {!!e.prev?.length && <button className="text-lagoon hover:underline" onClick={() => setExpanded((m) => ({ ...m, [e.id]: !m[e.id] }))}>{expanded[e.id] ? '收起历史' : `${e.prev.length} 个旧值`}</button>}
                            </div>
                            {!!e.evidence?.length && <div className="mono mt-1.5 text-[9.5px] leading-relaxed text-ink-4">证据：{e.evidence.join(' · ')}</div>}
                            {expanded[e.id] && e.prev && (
                              <div className="mt-2 space-y-1 border-t border-line-soft pt-2">
                                {e.prev.map((p, idx) => (
                                  <div key={idx} className="text-[10.5px] text-ink-3"><span className="line-through">{p.claim}</span><span className="mono ml-2 text-[9.5px]">置信 {pct(p.confidence, 0)} · {fmtAgo(p.updatedAt)}</span></div>
                                ))}
                              </div>
                            )}
                          </div>
                          <Button size="icon" variant="ghost" className="btn-sm flex-none text-ink-3 hover:text-coral" onClick={() => void removeEntry(e)} aria-label="移除条目" title="移除"><Trash2 size={13} /></Button>
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
              <div className="label">观察样本</div>
              <div className="mt-2 flex items-end gap-2"><span className="value-xl">{activeCount}</span><span className="pb-1 text-[10px] text-ink-3">条有效画像</span></div>
              <div className="mt-3 grid grid-cols-2 gap-2 border-t border-line-soft pt-3">
                <div><div className="text-[9.5px] text-ink-3">消息 / 平均长度</div><div className="mono mt-0.5 text-[12px]">{msgs} 条 · {avg} 字</div></div>
                <div><div className="text-[9.5px] text-ink-3">提问率 / 表情率</div><div className="mono mt-0.5 text-[12px]">{askRate}% / {emojiRate}%</div></div>
              </div>
            </section>
            <section className="panel p-5">
              <div className="flex items-baseline justify-between gap-3 border-b border-line-soft py-2 first:pt-0"><span className="text-[11px] text-ink-3">KV 键</span><span className="mono truncate text-[10px]">Yz:agent:profile:{userId || '—'}</span></div>
              {topHours.map(([h, n]) => <div key={h} className="flex items-baseline justify-between border-b border-line-soft py-1.5 last:border-0"><span className="mono text-[10px] text-ink-3">{h}:00</span><span className="mono text-[10px]">{n} 条</span></div>)}
              <p className="mt-3 border-t border-line-soft pt-3 text-[10.5px] leading-relaxed text-ink-3">隐式风格由统计推断，并标注「推断」。用户明确纠正时，旧条目会标记为已替换，保留审计链。</p>
            </section>
          </aside>
        </div>
      )}

      <Dialog
        open={addOpen}
        onClose={() => !busy && setAddOpen(false)}
        title="写入用户画像"
        description={`用户 ${userId || '—'} · 人工写入来源标记为「更正」`}
        footer={(
          <>
            <Button variant="secondary" onClick={() => setAddOpen(false)} disabled={busy}>取消</Button>
            <Button variant="primary" onClick={() => void add()} loading={busy} disabled={!form.claim.trim() || !userId}>写入</Button>
          </>
        )}
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="分面">
            <Select value={form.facet} onChange={(e) => setForm((f) => ({ ...f, facet: e.target.value }))}>
              {Object.entries(FACETS).map(([k, v]) => <option key={k} value={k}>{v.name}</option>)}
            </Select>
          </Field>
          <Field label={`置信度 ${(form.confidence * 100).toFixed(0)}%`}>
            <input type="range" min={0.1} max={1} step={0.05} value={form.confidence} onChange={(e) => setForm((f) => ({ ...f, confidence: Number(e.target.value) }))} className="w-full accent-lagoon" />
          </Field>
          <Field label="画像内容" className="sm:col-span-2" hint="会过威胁扫描；相似条目自动合并，旧 claim 进入历史。">
            <Textarea value={form.claim} onChange={(e) => setForm((f) => ({ ...f, claim: e.target.value }))} maxLength={200} placeholder="例如：偏好简短直接的回答，不要客套" autoFocus />
          </Field>
        </div>
      </Dialog>
    </div>
  )
}
