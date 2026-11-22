import { useEffect, useMemo, useState } from 'react'
import { BookOpenText, Pencil, Plus, Trash2 } from 'lucide-react'
import { api } from '@/lib/api'
import { useAsync, useReloadEvent } from '@/lib/hooks'
import { fmtNum, num } from '@/lib/format'
import { Button, EmptyState, ErrorState, Field, PageHeader, Select, Skeleton, Textarea } from '@/components/ui'
import { Dialog, Drawer, useConfirm, useToast } from '@/components/Overlay'
import { cn } from '@/lib/cn'

type Scope = { scopeId: string; type: string; label: string; userId?: string; groupId?: string | null }
type MemFile = { usedChars: number; limitChars: number; entries: string[] }

function CapacityRing({ pct }: { pct: number }) {
  const r = 34
  const c = 2 * Math.PI * r
  return (
    <div className="relative flex h-[92px] w-[92px] items-center justify-center">
      <svg width="92" height="92" viewBox="0 0 84 84" className="-rotate-90" aria-hidden="true">
        <circle cx="42" cy="42" r={r} fill="none" stroke="rgb(22 49 46 / .08)" strokeWidth="7" />
        <circle cx="42" cy="42" r={r} fill="none" strokeLinecap="round" strokeWidth="7"
          stroke={pct > 85 ? '#b13c2e' : pct > 60 ? '#9a620e' : '#1f8a70'}
          strokeDasharray={c} strokeDashoffset={c * (1 - Math.min(1, pct / 100))}
          style={{ transition: 'stroke-dashoffset .5s cubic-bezier(.16,1,.3,1)' }} />
      </svg>
      <div className="absolute text-center">
        <div className="mono text-[16px] font-semibold">{pct}%</div>
        <div className="text-[8.5px] text-ink-3">容量</div>
      </div>
    </div>
  )
}

export function MemoryPage() {
  const toast = useToast()
  const confirm = useConfirm()
  const scopes = useAsync(() => api.get('/scopes'), [])
  const [scopeId, setScopeId] = useState('')
  const [tab, setTab] = useState<'memory' | 'user'>('memory')
  const mem = useAsync(() => scopeId ? api.get('/memories', { scopeId }) : Promise.resolve(null), [scopeId])
  const [dialog, setDialog] = useState<{ open: boolean; idx: number; text: string }>({ open: false, idx: -1, text: '' })
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!scopeId && scopes.data?.length) setScopeId(scopes.data[0].scopeId)
  }, [scopes.data, scopeId])
  useReloadEvent(() => { void scopes.reload(); if (scopeId) void mem.reload() })

  const scopeList = (scopes.data || []) as Scope[]
  const scope = scopeList.find((s) => s.scopeId === scopeId)
  const data: MemFile = mem.data?.[tab] || { usedChars: 0, limitChars: 0, entries: [] }
  const entries = data.entries || []
  const pct = num(data.limitChars) > 0 ? Math.round((num(data.usedChars) / num(data.limitChars)) * 100) : 0
  const fileName = tab === 'memory' ? 'MEMORY.md' : 'USER.md'
  const headerLine = `${tab === 'memory' ? 'MEMORY (your personal notes)' : 'USER (what you know about the user)'} [${pct}% — ${fmtNum(data.usedChars)}/${fmtNum(data.limitChars)} chars]`
  const canEdit = !!scopeId

  const openAdd = () => canEdit && setDialog({ open: true, idx: -1, text: '' })
  const openEdit = (i: number) => setDialog({ open: true, idx: i, text: entries[i] })

  const save = async () => {
    const text = dialog.text.trim()
    if (!text) return
    const next = [...entries]
    if (dialog.idx >= 0) next[dialog.idx] = text
    else next.push(text)
    setSaving(true)
    try {
      await api.put(`/memories/${encodeURIComponent(scopeId)}/${tab}`, { entries: next })
      await mem.reload()
      toast(dialog.idx >= 0 ? '已更新条目' : '已添加记忆条目', 'success')
      setDialog({ open: false, idx: -1, text: '' })
    } catch (e: any) {
      toast(e?.message || '保存失败', 'error')
    } finally { setSaving(false) }
  }

  const remove = async (i: number) => {
    const ok = await confirm({ title: '删除这条记忆？', message: '保存后会直接改写对应的 Markdown 文件。', confirmText: '删除条目', danger: true })
    if (!ok) return
    const next = entries.filter((_, j) => j !== i)
    try {
      await api.put(`/memories/${encodeURIComponent(scopeId)}/${tab}`, { entries: next })
      await mem.reload()
      toast('已删除条目', 'info')
    } catch (e: any) { toast(e?.message || '删除失败', 'error') }
  }

  const shownLabel = scope?.label || scopeId || '未选择 scope'

  return (
    <div className="page">
      <PageHeader
        title="声明式记忆"
        description="MEMORY.md / USER.md · 按 scope 隔离。私聊 u_qq，群隔离 g群_uqq，群共享 g群；同一用户在不同群是独立数据集。"
        actions={<Button variant="primary" size="sm" disabled={!canEdit} onClick={openAdd} icon={<Plus size={14} />}>新增条目</Button>}
        meta={<><span>文件即真相</span><span className="h-3 w-px bg-ink/10" /><span>保存后立即写回 Markdown</span></>}
      />

      {(scopes.error || mem.error) && <div className="mb-4"><ErrorState message={scopes.error || mem.error} onRetry={() => { void scopes.reload(); if (scopeId) void mem.reload() }} /></div>}

      <div className="toolbar">
        <Select value={scopeId} onChange={(e) => setScopeId(e.target.value)} aria-label="数据隔离维度" className="w-[280px] max-w-full">
          {scopeList.length === 0 && <option value="">未发现 scope</option>}
          {scopeList.map((s) => <option key={s.scopeId} value={s.scopeId}>{s.label}</option>)}
        </Select>
        <div className="segmented" role="group" aria-label="记忆文件">
          <button aria-pressed={tab === 'memory'} onClick={() => setTab('memory')}>MEMORY.md</button>
          <button aria-pressed={tab === 'user'} onClick={() => setTab('user')}>USER.md</button>
        </div>
        <span className="mono ml-auto hidden text-[10px] text-ink-3 sm:inline">data/memories/{scopeId || '—'}/{fileName}</span>
      </div>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_290px]">
        <section className="panel" aria-labelledby="memory-file-title">
          <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line-soft px-5 py-4">
            <div className="min-w-0">
              <h2 id="memory-file-title" className="mono text-[13px] font-semibold">{fileName}</h2>
              <p className="mono mt-1 break-all text-[10px] text-ink-3">{headerLine}</p>
            </div>
            <Button size="sm" variant="secondary" onClick={openAdd} disabled={!canEdit} icon={<Plus size={12} />}>新增</Button>
          </div>
          <div className="px-5">
            {mem.loading && !mem.data ? (
              <div className="space-y-2 py-4">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-12" />)}</div>
            ) : entries.length === 0 ? (
              <EmptyState icon={<BookOpenText />} title="此 scope 暂无记忆" action={<Button size="sm" variant="secondary" onClick={openAdd} disabled={!canEdit} icon={<Plus size={12} />}>手动新增</Button>}>
                Agent 会在对话中自动沉淀，也可手动新增一条。
              </EmptyState>
            ) : (
              <ul>
                {entries.map((entry, i) => (
                  <li key={`${i}-${entry.slice(0, 12)}`} className="group flex items-start gap-3 border-b border-line-soft py-3.5 last:border-0">
                    <span className="mono mt-0.5 w-5 flex-none text-right text-[10px] text-ink-4">{i + 1}</span>
                    <p className="min-w-0 flex-1 whitespace-pre-wrap text-[12.5px] leading-relaxed text-ink">{entry}</p>
                    <div className="flex flex-none gap-0.5 opacity-60 transition group-hover:opacity-100">
                      <Button size="icon" variant="ghost" className="btn-sm" onClick={() => openEdit(i)} aria-label="编辑" title="编辑"><Pencil size={13} /></Button>
                      <Button size="icon" variant="ghost" className="btn-sm hover:text-coral" onClick={() => void remove(i)} aria-label="删除" title="删除"><Trash2 size={13} /></Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>

        <aside className="space-y-4">
          <section className="panel p-5">
            <div className="label">容量</div>
            <p className="mt-1 truncate text-[11px] text-ink-3">{shownLabel}</p>
            <div className="mt-4 flex items-center gap-4">
              <CapacityRing pct={pct} />
              <div className="min-w-0">
                <div className="mono text-[19px] font-medium">{fmtNum(data.usedChars)}<span className="text-[11px] text-ink-3"> / {fmtNum(data.limitChars)}</span></div>
                <div className="mt-0.5 text-[10px] text-ink-3">chars</div>
                <div className="mt-2 text-[10px] text-ink-3">{entries.length} 条 bullet 条目</div>
              </div>
            </div>
            <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-ink/5">
              <div className={cn('h-full rounded-full transition-[width]', pct > 85 ? 'bg-coral' : pct > 60 ? 'bg-amber' : 'bg-jade')} style={{ width: `${Math.min(100, pct)}%` }} />
            </div>
          </section>
          <section className="panel p-5">
            <div className="flex items-baseline justify-between border-b border-line-soft py-2 first:pt-0"><span className="text-[11px] text-ink-3">文件</span><span className="mono text-[11px]">{fileName}</span></div>
            <div className="flex items-baseline justify-between border-b border-line-soft py-2"><span className="text-[11px] text-ink-3">条目</span><span className="mono text-[11px]">{entries.length}</span></div>
            <div className="flex items-baseline justify-between gap-3 py-2"><span className="text-[11px] text-ink-3">Scope</span><span className="mono truncate text-[11px]">{scopeId || '—'}</span></div>
            <p className="mt-3 border-t border-line-soft pt-3 text-[10.5px] leading-relaxed text-ink-3">文件即真相。Agent 在对话里可以 add / replace / remove；你也可以直接编辑 data/memories/ 下的 Markdown。超过上限会保存失败。</p>
          </section>
        </aside>
      </div>

      <Dialog
        open={dialog.open}
        onClose={() => !saving && setDialog((d) => ({ ...d, open: false }))}
        title={dialog.idx >= 0 ? `编辑条目 #${dialog.idx + 1}` : '新增记忆条目'}
        description={`写入 ${shownLabel} 的 ${fileName}`}
        footer={(
          <>
            <Button variant="secondary" onClick={() => setDialog((d) => ({ ...d, open: false }))} disabled={saving}>取消</Button>
            <Button variant="primary" onClick={() => void save()} loading={saving} disabled={!dialog.text.trim()}>保存</Button>
          </>
        )}
      >
        <Field label="条目内容（一条 bullet）" hint={`当前容量 ${fmtNum(data.usedChars)} / ${fmtNum(data.limitChars)} 字符；超限会保存失败。`}>
          <Textarea value={dialog.text} onChange={(e) => setDialog((d) => ({ ...d, text: e.target.value }))} maxLength={500} placeholder="例如：用户偏好简洁回答" autoFocus />
        </Field>
      </Dialog>
    </div>
  )
}
