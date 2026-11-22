import { useEffect, useMemo, useState } from 'react'
import { ExternalLink, RefreshCw, Settings2, Wrench } from 'lucide-react'
import { api } from '@/lib/api'
import { useAsync, useReloadEvent } from '@/lib/hooks'
import { Button, EmptyState, ErrorState, Field, Input, PageHeader, SearchInput, Select, Skeleton, Switch, Tag, Textarea } from '@/components/ui'
import { Dialog, Drawer, useToast } from '@/components/Overlay'
import { parseNum } from '@/lib/config'
import { safeJson } from '@/lib/format'

type FieldDef = {
  key: string; type: string; label?: string; description?: string; default?: any; secret?: boolean;
  placeholder?: string; options?: { value: string; label: string }[]; min?: number; max?: number; step?: number
}
type Pack = { name: string; info: { title?: string; description?: string; author?: string; version?: string; homepage?: string; icon?: string }; config?: FieldDef[]; values?: Record<string, any> }

export function ToolPacksPage() {
  const toast = useToast()
  const res = useAsync(() => api.get('/tool-packs'), [])
  const [q, setQ] = useState('')
  const [active, setActive] = useState<Pack | null>(null)
  const [values, setValues] = useState<Record<string, any>>({})
  const [saving, setSaving] = useState(false)
  useReloadEvent(() => void res.reload())

  const packs = (res.data || []) as Pack[]
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase()
    if (!s) return packs
    return packs.filter((p) => `${p.name} ${p.info?.title || ''} ${p.info?.description || ''}`.toLowerCase().includes(s))
  }, [packs, q])

  const defaultsOf = (p: Pack) => Object.fromEntries((p.config || []).map((f) => [f.key, p.values?.[f.key] !== undefined ? p.values[f.key] : f.default]))

  const open = (p: Pack) => {
    setActive(p)
    setValues(defaultsOf(p))
  }

  const dirty = !!active && JSON.stringify(values) !== JSON.stringify(defaultsOf(active))

  const save = async () => {
    if (!active) return
    const changes: Record<string, any> = {}
    const skipped: string[] = []
    for (const f of active.config || []) {
      const v = values[f.key]
      if (f.type === 'number') {
        const n = parseNum(v)
        if (n == null) { skipped.push(f.label || f.key); continue }
        changes[`agent.tools.${active.name}.${f.key}`] = n
      } else {
        changes[`agent.tools.${active.name}.${f.key}`] = v
      }
    }
    if (!Object.keys(changes).length) { toast('无改动', 'warn'); return }
    setSaving(true)
    try {
      await api.put('/config', { changes })
      await res.reload()
      toast(skipped.length ? `已保存；数值项保留原值：${skipped.join('、')}` : '已保存（已热加载）', skipped.length ? 'warn' : 'success')
      setActive(null)
    } catch (e: any) { toast(e?.message || '保存失败', 'error') }
    finally { setSaving(false) }
  }

  return (
    <div className="page">
      <PageHeader
        title="外置工具"
        description="tools/ 目录下自研工具（tool.config.js 约定）· 点击卡片打开配置。保存后热加载。"
        actions={<div className="w-[250px] max-w-full"><SearchInput value={q} onChange={setQ} placeholder="搜索工具 / 描述" /></div>}
        meta={<><span>{packs.length} 个工具包</span><span className="h-3 w-px bg-ink/10" /><span>配置路径 agent.tools.&lt;pack&gt;</span></>}
      />

      {res.error && <div className="mb-4"><ErrorState message={res.error} onRetry={() => void res.reload()} /></div>}

      {res.loading && !res.data ? (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-40" />)}</div>
      ) : shown.length === 0 ? (
        <div className="panel"><EmptyState icon={<Wrench />} title={q ? '没有匹配的工具包' : '未发现外置工具'}>把工具包放进插件 tools/ 目录，并提供 tool.config.js（含 info 与 config schema）。</EmptyState></div>
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {shown.map((p) => (
            <article key={p.name} className="panel flex flex-col p-4">
              <button className="flex flex-1 items-start gap-3 text-left" onClick={() => open(p)}>
                <span className="flex h-11 w-11 flex-none items-center justify-center overflow-hidden rounded-xl border border-white/70 bg-white/55 text-lagoon">
                  {p.info?.icon && /^(https?:|data:)/i.test(p.info.icon) ? <img src={p.info.icon} alt="" className="h-full w-full object-cover" /> : <Wrench size={18} />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-1.5">
                    <span className="text-[13.5px] font-semibold">{p.info?.title || p.name}</span>
                    <Tag tone="neutral">v{p.info?.version || '0.0.0'}</Tag>
                  </span>
                  <span className="mono mt-0.5 block truncate text-[9.5px] text-ink-3">{p.name}</span>
                  <span className="mt-1.5 line-clamp-2 block text-[11px] leading-relaxed text-ink-3">{p.info?.description || '（无描述）'}</span>
                  <span className="mt-1 block text-[9.5px] text-ink-4">作者：{p.info?.author || '—'} · {(p.config || []).length} 个配置项</span>
                </span>
              </button>
              <div className="mt-3 flex items-center justify-between border-t border-line-soft pt-2.5">
                <div className="flex gap-2">
                  {p.info?.homepage && <a href={p.info.homepage} target="_blank" rel="noreferrer" className="btn btn-ghost btn-sm">主页 <ExternalLink size={11} /></a>}
                </div>
                <Button size="sm" variant="secondary" onClick={() => open(p)} icon={<Settings2 size={12} />}>配置</Button>
              </div>
            </article>
          ))}
        </div>
      )}

      <Dialog
        open={!!active}
        onClose={() => !saving && setActive(null)}
        title={active ? `${active.info?.title || active.name} · 配置` : '配置'}
        description={active ? `${active.info?.description || ''}（${active.name} v${active.info?.version || '0.0.0'}）` : undefined}
        width={720}
        footer={(
          <>
            <Button variant="secondary" onClick={() => active && setValues(defaultsOf(active))} disabled={!dirty || saving}>还原</Button>
            <Button variant="primary" onClick={() => void save()} loading={saving} disabled={!dirty}>保存并热加载</Button>
          </>
        )}
      >
        {active && ((active.config || []).length === 0 ? (
          <EmptyState icon={<Wrench />} title="该工具未声明配置项">tool.config.js 的 config 为空。</EmptyState>
        ) : (
          <div className="space-y-3">
            {(active.config || []).map((f) => {
              const v = values[f.key]
              const set = (val: any) => setValues((s) => ({ ...s, [f.key]: val }))
              const label = f.label || f.key
              const hint = f.description || `agent.tools.${active.name}.${f.key}`
              if (f.type === 'boolean') return <Field key={f.key} label={label} hint={hint}><div className="pt-1"><Switch checked={!!v} onChange={set} label={label} /></div></Field>
              if (f.type === 'enum') return <Field key={f.key} label={label} hint={hint}><Select value={v ?? ''} onChange={(e) => set(e.target.value)}>{(f.options || []).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</Select></Field>
              if (f.type === 'text' || f.type === 'json') return <Field key={f.key} label={label} hint={hint}><Textarea className="mono min-h-[90px]" value={typeof v === 'string' ? v : safeJson(v)} placeholder={f.placeholder} onChange={(e) => set(e.target.value)} /></Field>
              if (f.type === 'number') return <Field key={f.key} label={label} hint={hint}><Input type="number" value={v ?? ''} min={f.min} max={f.max} step={f.step} placeholder={f.placeholder} onChange={(e) => set(e.target.value === '' ? '' : Number(e.target.value))} /></Field>
              return <Field key={f.key} label={label} hint={hint}><Input type={f.secret ? 'password' : 'text'} className="mono" value={v ?? ''} placeholder={f.placeholder} onChange={(e) => set(e.target.value)} autoComplete="off" /></Field>
            })}
          </div>
        ))}
      </Dialog>
    </div>
  )
}
