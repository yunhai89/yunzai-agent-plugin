import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, Drama, FileUp, Lock, Pencil, Plus, RefreshCw, Search, Sparkles, Trash2, Upload, X } from 'lucide-react'
import { api } from '@/lib/api'
import { useAsync, useReloadEvent } from '@/lib/hooks'
import { fmtAgo, fmtDate } from '@/lib/format'
import { Button, EmptyState, ErrorState, Field, Input, PageHeader, Skeleton, Tag, Textarea } from '@/components/ui'
import { Dialog, Drawer, useConfirm, useToast } from '@/components/Overlay'
import { useSignals } from '@/lib/auth'
import { cn } from '@/lib/cn'

type Persona = {
  id: string; name: string; description?: string; tags?: string[]; avatar?: string; greeting?: string;
  systemPrompt: string; card?: any; builtin?: boolean; creator?: string | null; createdAt?: number
}
type Lore = {
  id: string; status: string; summary?: string; facts?: string; sources?: { title?: string; ref?: string; type?: string }[];
  refreshCron?: string | null; draft?: Lore; updatedAt?: number
}
type FileSel = { filename: string; content: string } | null

const AVA = [
  'bg-[linear-gradient(135deg,#dcefEA,#a9d6cc)]',
  'bg-[linear-gradient(135deg,#f3ead8,#dfc9a3)]',
  'bg-[linear-gradient(135deg,#e5e9f2,#b9c5da)]',
  'bg-[linear-gradient(135deg,#f6e5df,#e7b8aa)]',
  'bg-[linear-gradient(135deg,#e9e6f0,#c6bede)]',
]

function cardStats(card: any) {
  if (!card || typeof card !== 'object') return null
  const spec = card.spec || 'character-card'
  const aliases = (card.identity?.aliases || []).slice(0, 6).filter(Boolean)
  const titles = (card.identity?.titles || []).slice(0, 4).filter(Boolean)
  const identityLine = [card.identity?.path?.join(' / '), card.identity?.element, card.identity?.faction].filter(Boolean).join(' · ')
  const count = (v: any) => Array.isArray(v) ? v.length : v && typeof v === 'object' ? Object.keys(v).length : 0
  return {
    spec,
    nameEn: card.meta?.name_en, version: card.meta?.version, base: card.meta?.base,
    aliases, titles, identityLine, summary: card.persona?.summary,
    keywords: (card.persona?.keywords || []).slice(0, 8),
    rules: count(card.behavior_rules), taboos: count(card.voice?.taboos),
    relationships: Object.keys(card.relationships || {}).slice(0, 8),
    timeline: count(card.lore?.timeline), examples: count(card.example_dialogues),
  }
}

const blankForm = (): Persona => ({
  id: '', name: '', description: '', tags: [], avatar: '新', greeting: '', systemPrompt: '',
  card: null, builtin: false, creator: '', createdAt: Date.now(),
})

export function PersonasPage() {
  const toast = useToast()
  const confirm = useConfirm()
  const { refresh: refreshSignals } = useSignals()
  const personasRes = useAsync(() => api.get('/personas'), [])
  const loreRes = useAsync(() => api.get('/persona-lore').catch(() => []), [])
  const personas = (personasRes.data || []) as Persona[]
  const loreMap = useMemo(() => Object.fromEntries(((loreRes.data || []) as Lore[]).map((l) => [l.id, l])), [loreRes.data])

  const [detailId, setDetailId] = useState('')
  const detail = personas.find((p) => p.id === detailId) || null
  const lore = detail ? loreMap[detail.id] : undefined
  const loreView = lore ? (lore.draft || lore) : null
  const lorePending = !!lore?.draft
  const [busy, setBusy] = useState('')

  const [editor, setEditor] = useState<{ open: boolean; idx: number; form: Persona }>({ open: false, idx: -1, form: blankForm() })
  const [tagInput, setTagInput] = useState('')
  const [importOpen, setImportOpen] = useState(false)
  const [personaFile, setPersonaFile] = useState<FileSel>(null)
  const [cardFile, setCardFile] = useState<FileSel>(null)
  const [overwrite, setOverwrite] = useState(false)
  const [importError, setImportError] = useState('')
  const [importBusy, setImportBusy] = useState(false)
  const [q, setQ] = useState('')
  const personaInput = useRef<HTMLInputElement>(null)

  useReloadEvent(() => { void personasRes.reload(); void loreRes.reload() })

  const shown = useMemo(() => {
    const s = q.trim().toLowerCase()
    if (!s) return personas
    return personas.filter((p) => `${p.name} ${p.description || ''} ${(p.tags || []).join(' ')}`.toLowerCase().includes(s))
  }, [personas, q])

  const openCreate = () => {
    setTagInput('')
    setEditor({ open: true, idx: -1, form: blankForm() })
  }
  const openEdit = (p: Persona) => {
    if (p.builtin) { toast('内置人设为代码常量，只读不可改', 'warn'); return }
    setTagInput('')
    setEditor({ open: true, idx: personas.findIndex((x) => x.id === p.id), form: JSON.parse(JSON.stringify(p)) })
  }

  const addTag = () => {
    const t = tagInput.trim()
    if (!t) return
    setEditor((e) => {
      const tags = e.form.tags || []
      if (tags.length >= 8 || tags.includes(t)) return e
      return { ...e, form: { ...e.form, tags: [...tags, t] } }
    })
    setTagInput('')
  }

  const savePersona = async () => {
    const f = editor.form
    if (!f.name.trim() || !f.systemPrompt.trim()) { toast('名称与 systemPrompt 必填', 'warn'); return }
    setBusy('save')
    try {
      if (editor.idx < 0) await api.post('/personas', { ...f, name: f.name.trim() })
      else await api.put(`/personas/${encodeURIComponent(f.id)}`, { ...f, name: f.name.trim() })
      await personasRes.reload()
      toast(`人设「${f.name.trim()}」已${editor.idx < 0 ? '创建' : '更新'}`, 'success')
      setEditor((e) => ({ ...e, open: false }))
    } catch (e: any) {
      toast(e?.message?.includes('内置') ? '内置人设只读' : e?.message || '保存失败', 'error')
    } finally { setBusy('') }
  }

  const removePersona = async (p: Persona) => {
    if (p.builtin) { toast('内置人设不可删除', 'warn'); return }
    const ok = await confirm({ title: `删除人设「${p.name}」？`, message: '只删除人设 JSON；对应的资料与待审采纳不会级联清理。', confirmText: '删除人设', danger: true })
    if (!ok) return
    try {
      await api.del(`/personas/${encodeURIComponent(p.id)}`)
      await personasRes.reload()
      if (detailId === p.id) setDetailId('')
      toast(`已删除人设「${p.name}」`, 'info')
    } catch (e: any) { toast(e?.message?.includes('内置') ? '内置人设只读' : e?.message || '删除失败', 'error') }
  }

  const completeLore = async (p: Persona) => {
    setBusy('complete')
    try {
      await api.post(`/persona-lore/${encodeURIComponent(p.id)}/complete`, {})
      await loreRes.reload()
      toast(`已为「${p.name}」生成补齐草稿，预览后提交采纳`, 'success')
    } catch (e: any) { toast(e?.message || '补齐失败', 'error') }
    finally { setBusy('') }
  }

  const adoptLore = async (p: Persona) => {
    setBusy('adopt')
    try {
      const r = await api.post('/persona-adoptions', { personaId: p.id })
      await refreshSignals()
      toast(r?.duplicated
        ? `「${p.name}」已有待审采纳，已刷新为最新草稿，请在审批门批准`
        : `已提交「${p.name}」资料采纳审批，请在审批门批准后生效`, 'success')
    } catch (e: any) { toast(e?.message || '提交采纳审批失败', 'error') }
    finally { setBusy('') }
  }

  const discardLore = async (p: Persona) => {
    const ok = await confirm({ title: '丢弃人设资料？', message: lorePending ? '只丢弃待审草稿，已生效资料保留。' : '会删除该人设已经生效的资料。', confirmText: '丢弃', danger: true })
    if (!ok) return
    const wasDraft = lorePending
    setBusy('discard')
    try {
      await api.del(`/persona-lore/${encodeURIComponent(p.id)}`)
      await loreRes.reload()
      toast(wasDraft ? '已丢弃待审草稿（生效资料保留）' : '已丢弃人设资料', 'info')
    } catch (e: any) { toast(e?.message || '丢弃失败', 'error') }
    finally { setBusy('') }
  }

  const readFile = async (file: File | undefined, kind: 'persona' | 'card') => {
    if (!file) return
    const ext = file.name.split('.').pop()?.toLowerCase()
    if (kind === 'persona' && ext !== 'txt' && ext !== 'md') {
      setImportError('人设文件只支持 .txt / .md')
      if (personaInput.current) personaInput.current.value = ''
      return
    }
    if (kind === 'card' && ext !== 'json') {
      setImportError('角色卡片只支持 .json')
      return
    }
    setImportError('')
    const val = { filename: file.name, content: await file.text() }
    if (kind === 'persona') setPersonaFile(val); else setCardFile(val)
  }

  const doImport = async () => {
    if (!personaFile && !cardFile) { toast('请先选择 .txt/.md 人设文件或 .json 角色卡片', 'warn'); return }
    setImportBusy(true); setImportError('')
    try {
      const r = await api.post('/personas/import', {
        overwrite,
        ...(personaFile ? { personaFile } : {}),
        ...(cardFile ? { cardFile } : {}),
      })
      await personasRes.reload()
      setImportOpen(false); setPersonaFile(null); setCardFile(null); setOverwrite(false)
      toast(`${r.created ? '已导入' : '已更新'}「${r.persona.name}」${r.persona.card ? '（含角色卡片）' : ''}`, 'success')
      for (const w of (r.warnings || []).slice(0, 3)) toast(w, 'warn')
    } catch (e: any) {
      setImportError(e?.message || '导入失败')
      toast(e?.message || '导入失败', 'error')
    } finally { setImportBusy(false) }
  }

  const cs = detail ? cardStats(detail.card) : null
  const avIdx = detail ? Math.max(0, personas.findIndex((p) => p.id === detail.id)) % AVA.length : 0

  return (
    <div className="page">
      <PageHeader
        title="人设库"
        description="内置为代码常量（只读）· 自定义为 data/personas/<id>.json · 支持 .txt / .md / 角色卡片导入 · 资料采纳须经审批门批准后生效。"
        actions={(
          <>
            <Button variant="secondary" size="sm" onClick={() => { setImportOpen(true); setImportError('') }} icon={<FileUp size={14} />}>导入</Button>
            <Button variant="primary" size="sm" onClick={openCreate} icon={<Plus size={14} />}>新建人设</Button>
          </>
        )}
        meta={<><span>{personas.length} 个人设</span><span className="h-3 w-px bg-ink/10" /><span>{personas.filter((p) => p.builtin).length} 个内置</span></>}
      />

      {(personasRes.error || loreRes.error) && <div className="mb-4"><ErrorState message={personasRes.error || loreRes.error} onRetry={() => { void personasRes.reload(); void loreRes.reload() }} /></div>}

      <div className="toolbar">
        <div className="w-[260px] max-w-full"><Input icon={<Search size={14} />} value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索名称 / 描述 / 标签" aria-label="搜索人设" /></div>
        <span className="text-[10.5px] text-ink-3">{shown.length} / {personas.length}</span>
        <Button variant="ghost" size="sm" className="ml-auto" onClick={() => { void personasRes.reload(); void loreRes.reload() }} icon={<RefreshCw size={13} />}>刷新</Button>
      </div>

      {personasRes.loading && !personasRes.data ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">{[0, 1, 2, 3, 4, 5].map((i) => <Skeleton key={i} className="h-48" />)}</div>
      ) : shown.length === 0 ? (
        <div className="panel"><EmptyState icon={<Drama />} title={q ? '没有匹配的人设' : '还没有人设'} action={<Button size="sm" variant="primary" onClick={openCreate} icon={<Plus size={12} />}>新建人设</Button>}>内置人设会随插件提供；也可以导入角色卡。</EmptyState></div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {shown.map((p, i) => {
            const l = loreMap[p.id]
            return (
              <article key={p.id} className="panel group flex flex-col p-4 transition hover:-translate-y-0.5 hover:shadow-[0_28px_60px_-42px_rgba(10,78,74,.45)]">
                <button className="flex flex-1 items-start gap-3 text-left" onClick={() => setDetailId(p.id)}>
                  <span className={cn('flex h-12 w-12 flex-none items-center justify-center rounded-xl border border-white/70 text-[18px] font-medium text-lagoon-deep shadow-inner', AVA[i % AVA.length])}>{p.avatar || p.name.slice(0, 1)}</span>
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-1">
                      <span className="truncate text-[14px] font-semibold tracking-[-0.015em]">{p.name}</span>
                      {p.builtin ? <Tag tone="neutral"><Lock size={9} />内置</Tag> : <Tag tone="lagoon">自定义</Tag>}
                      {p.card && <Tag tone="amber">角色卡</Tag>}
                      {!!l?.draft ? <Tag tone="amber">待审草稿</Tag> : l?.status === 'active' ? <Tag tone="jade">资料已启用</Tag> : l ? <Tag tone="neutral">资料草稿</Tag> : null}
                    </span>
                    <span className="mt-1 line-clamp-2 block text-[11px] leading-relaxed text-ink-3">{p.description || '（无描述）'}</span>
                    <span className="mt-2 flex flex-wrap gap-1">{(p.tags || []).slice(0, 4).map((t) => <span key={t} className="tag tag-neutral !min-h-[18px] !px-1.5 !text-[9px]">{t}</span>)}</span>
                  </span>
                </button>
                <div className="mt-3 flex items-center justify-between border-t border-line-soft pt-2.5">
                  <span className="text-[9.5px] text-ink-4">{p.createdAt ? `${fmtAgo(p.createdAt)}创建` : '—'}</span>
                  <div className="flex gap-0.5 opacity-70 transition group-hover:opacity-100">
                    <Button size="icon" variant="ghost" className="btn-sm" onClick={() => openEdit(p)} aria-label={p.builtin ? '内置只读' : '编辑'} title={p.builtin ? '内置只读' : '编辑'}><Pencil size={12} /></Button>
                    {!p.builtin && <Button size="icon" variant="ghost" className="btn-sm hover:text-coral" onClick={() => void removePersona(p)} aria-label="删除人设" title="删除人设"><Trash2 size={12} /></Button>}
                  </div>
                </div>
              </article>
            )
          })}
        </div>
      )}

      <Drawer
        open={!!detail}
        onClose={() => setDetailId('')}
        title={detail?.name || '人设详情'}
        description={detail?.description}
        width={760}
        footer={<Button variant="secondary" onClick={() => setDetailId('')}>关闭</Button>}
      >
        {detail && (
          <div className="space-y-5">
            <div className="flex items-start gap-3">
              <span className={cn('flex h-16 w-16 flex-none items-center justify-center rounded-2xl border border-white/70 text-[24px] font-medium text-lagoon-deep', AVA[avIdx])}>{detail.avatar || detail.name.slice(0, 1)}</span>
              <div className="min-w-0">
                <div className="flex flex-wrap gap-1">
                  {detail.builtin ? <Tag tone="neutral">内置（代码常量）</Tag> : <Tag tone="lagoon">自定义 .json</Tag>}
                  {detail.card && <Tag tone="amber">角色卡片</Tag>}
                  {(detail.tags || []).map((t) => <Tag key={t} tone="neutral">{t}</Tag>)}
                </div>
                <p className="mt-1.5 text-[11.5px] leading-relaxed text-ink-2">{detail.description || '（无描述）'}</p>
              </div>
            </div>

            {detail.greeting && (
              <section>
                <h3 className="mb-1.5 text-[11px] font-medium text-ink-2">开场白 greeting</h3>
                <p className="rounded-xl rounded-tl-sm border border-white/70 bg-white/55 px-3.5 py-2.5 text-[12.5px] leading-relaxed">{detail.greeting}</p>
              </section>
            )}

            <section>
              <h3 className="mb-1.5 text-[11px] font-medium text-ink-2">systemPrompt（基础）</h3>
              <pre className="mono max-h-64 overflow-auto whitespace-pre-wrap rounded-lg border border-line-soft bg-white/40 p-3 text-[10.5px] leading-relaxed text-ink-2">{detail.systemPrompt}</pre>
            </section>

            {cs && (
              <section className="rounded-xl border border-line-soft bg-white/35 p-3.5">
                <div className="mb-2 flex items-center gap-2"><h3 className="text-[11px] font-medium text-ink-2">角色卡片</h3><Tag tone="amber">{cs.spec}</Tag></div>
                <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-[11px]">
                  <div><dt className="text-ink-3">英文名</dt><dd>{cs.nameEn || '—'}</dd></div>
                  <div><dt className="text-ink-3">版本</dt><dd>{cs.version || '—'}</dd></div>
                  <div><dt className="text-ink-3">所属</dt><dd>{cs.base || '—'}</dd></div>
                  <div className="col-span-2"><dt className="text-ink-3">身份</dt><dd>{cs.identityLine || '—'}</dd></div>
                </dl>
                {!!cs.aliases.length && <div className="mt-2 flex flex-wrap gap-1">{cs.aliases.map((a: string) => <Tag key={a} tone="neutral">{a}</Tag>)}</div>}
                {cs.summary && <p className="mt-2 text-[11.5px] leading-relaxed text-ink-2">{cs.summary}</p>}
                <div className="mt-2 flex flex-wrap gap-1.5 text-[9.5px] text-ink-3">
                  <span>行为规则 {cs.rules}</span><span>表达禁忌 {cs.taboos}</span><span>关系 {cs.relationships.length}</span><span>时间线 {cs.timeline}</span><span>示例对话 {cs.examples}</span>
                </div>
                {!!cs.keywords.length && <div className="mt-2 flex flex-wrap gap-1">{cs.keywords.map((k: string) => <Tag key={k} tone="lagoon">{k}</Tag>)}</div>}
              </section>
            )}

            <section className="border-t border-line-soft pt-4">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-[11px] font-medium text-ink-2">角色设定资料（已核实事实）</h3>
                <div className="flex flex-wrap gap-1.5">
                  <Button size="sm" variant="secondary" onClick={() => void completeLore(detail)} loading={busy === 'complete'} icon={<Search size={12} />}>{busy === 'complete' ? '检索中…' : lore ? '重取' : '补齐'}</Button>
                  {loreView && (lorePending || loreView.status !== 'active') && <Button size="sm" variant="primary" onClick={() => void adoptLore(detail)} loading={busy === 'adopt'} icon={<Check size={12} />}>提交采纳</Button>}
                  {loreView && <Button size="sm" variant="danger" onClick={() => void discardLore(detail)} loading={busy === 'discard'} icon={<Trash2 size={12} />}>丢弃</Button>}
                </div>
              </div>
              {!lore ? (
                <p className="rounded-lg border border-dashed border-line px-3 py-4 text-center text-[11px] leading-relaxed text-ink-3">暂无资料。点「补齐」让 Agent 检索角色设定并生成草稿（也可在群里发 #人设补齐 &lt;id&gt;）。</p>
              ) : loreView ? (
                <div className="rounded-xl border border-line-soft bg-white/35 p-3.5">
                  <div className="flex flex-wrap items-center gap-1.5">
                    {lorePending ? <Tag tone="amber">待采纳草稿</Tag> : loreView.status === 'active' ? <Tag tone="jade">已生效</Tag> : <Tag tone="amber">草稿（未生效）</Tag>}
                    {lore?.refreshCron && <Tag tone="lagoon">定时：{lore.refreshCron}</Tag>}
                  </div>
                  {loreView.summary && <p className="mt-2 text-[11.5px] leading-relaxed text-ink-2">{loreView.summary}</p>}
                  <h4 className="mt-3 text-[10px] text-ink-3">事实</h4>
                  <pre className="mono mt-1 max-h-56 overflow-auto whitespace-pre-wrap rounded-lg border border-line-soft bg-white/45 p-2.5 text-[10.5px] leading-relaxed">{loreView.facts || '（无）'}</pre>
                  {!!loreView.sources?.length && (
                    <>
                      <h4 className="mt-3 text-[10px] text-ink-3">出处</h4>
                      <ol className="mt-1 space-y-1">
                        {loreView.sources.map((s, i) => <li key={i} className="text-[10.5px] text-ink-2">[{i + 1}] {s.title || s.ref || '—'}{s.title && s.ref ? `（${s.ref}）` : ''}</li>)}
                      </ol>
                    </>
                  )}
                </div>
              ) : null}
            </section>

            <div className="text-[9.5px] text-ink-4">id: {detail.id} · creator: {detail.creator || '—'} · {fmtDate(detail.createdAt)}</div>
          </div>
        )}
      </Drawer>

      <Dialog
        open={editor.open}
        onClose={() => !busy && setEditor((e) => ({ ...e, open: false }))}
        title={editor.idx < 0 ? '新建人设' : `编辑人设 · ${editor.form.name}`}
        width={720}
        footer={(
          <>
            <Button variant="secondary" onClick={() => setEditor((e) => ({ ...e, open: false }))} disabled={!!busy}>取消</Button>
            <Button variant="primary" onClick={() => void savePersona()} loading={busy === 'save'}>保存</Button>
          </>
        )}
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="名称"><Input value={editor.form.name} onChange={(e) => setEditor((s) => ({ ...s, form: { ...s.form, name: e.target.value } }))} placeholder="人设名称" /></Field>
          <Field label="头像 emoji"><Input value={editor.form.avatar} maxLength={4} onChange={(e) => setEditor((s) => ({ ...s, form: { ...s.form, avatar: e.target.value } }))} placeholder="新" /></Field>
          <Field label="一句话描述" className="sm:col-span-2"><Input value={editor.form.description || ''} onChange={(e) => setEditor((s) => ({ ...s, form: { ...s.form, description: e.target.value } }))} /></Field>
          <Field label="标签（≤8，回车添加）" className="sm:col-span-2">
            <div className="flex flex-wrap items-center gap-1.5">
              {(editor.form.tags || []).map((t, i) => (
                <span key={`${t}-${i}`} className="tag tag-neutral">{t}<button onClick={() => setEditor((s) => ({ ...s, form: { ...s.form, tags: (s.form.tags || []).filter((_, j) => j !== i) } }))} aria-label={`移除 ${t}`}><X size={10} /></button></span>
              ))}
              <input className="input h-8 w-[120px] py-1 text-[11px]" value={tagInput} onChange={(e) => setTagInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addTag() } }} placeholder="回车添加" />
              <Button size="sm" variant="ghost" onClick={addTag} icon={<Plus size={11} />}>添加</Button>
            </div>
          </Field>
          <Field label="开场白" className="sm:col-span-2"><Input value={editor.form.greeting || ''} onChange={(e) => setEditor((s) => ({ ...s, form: { ...s.form, greeting: e.target.value } }))} /></Field>
          <Field label="systemPrompt（≤20000 字）" className="sm:col-span-2" hint={editor.form.card ? `已关联 ${editor.form.card.spec || 'character-card'}；编辑正文不会删除卡片。` : undefined}>
            <Textarea value={editor.form.systemPrompt} maxLength={20000} onChange={(e) => setEditor((s) => ({ ...s, form: { ...s.form, systemPrompt: e.target.value } }))} className="min-h-[180px]" />
          </Field>
        </div>
      </Dialog>

      <Dialog
        open={importOpen}
        onClose={() => !importBusy && setImportOpen(false)}
        title="导入人设"
        description="至少选择人设正文或角色卡片之一；同时选择时正文优先，卡片补全结构化设定。"
        width={680}
        footer={(
          <>
            <Button variant="secondary" onClick={() => setImportOpen(false)} disabled={importBusy}>取消</Button>
            <Button variant="primary" onClick={() => void doImport()} loading={importBusy} disabled={!personaFile && !cardFile} icon={<Upload size={13} />}>{importBusy ? '导入中…' : '导入'}</Button>
          </>
        )}
      >
        <div className="space-y-4">
          <Field label="人设正文 · .txt / .md（可选）" hint="正文作为 systemPrompt；Markdown 支持简单 frontmatter 与首个 # 标题作为名称。">
            <input ref={personaInput} type="file" accept=".txt,.md,text/plain,text/markdown" className="block w-full text-[11px] text-ink-2 file:mr-3 file:rounded-lg file:border file:border-line file:bg-white/60 file:px-3 file:py-1.5 file:text-[11px]" onChange={(e) => void readFile(e.target.files?.[0], 'persona')} />
            {personaFile && <p className="mt-1 text-[10px] text-ink-3">已选：{personaFile.filename}（{personaFile.content.length} 字）</p>}
          </Field>
          <Field label="角色卡片 · .json（可选）" hint="支持 aha-character-card/1.x；保留在 persona.card 字段。">
            <input type="file" accept=".json,application/json" className="block w-full text-[11px] text-ink-2 file:mr-3 file:rounded-lg file:border file:border-line file:bg-white/60 file:px-3 file:py-1.5 file:text-[11px]" onChange={(e) => void readFile(e.target.files?.[0], 'card')} />
            {cardFile && <p className="mt-1 text-[10px] text-ink-3">已选：{cardFile.filename}（{cardFile.content.length} 字）</p>}
          </Field>
          <label className="flex items-start gap-2 text-[11.5px] text-ink-2">
            <input type="checkbox" checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} className="mt-0.5 accent-lagoon" />
            <span>同名覆盖已有自定义人设<span className="block text-[10px] text-ink-3">内置人设不会被覆盖；不勾选时遇到同名会提示。</span></span>
          </label>
          {importError && <ErrorState message={importError} />}
        </div>
      </Dialog>
    </div>
  )
}
