import { useMemo, useState } from 'react'
import { Search, Sparkles } from 'lucide-react'
import { api } from '@/lib/api'
import { useAsync, useReloadEvent } from '@/lib/hooks'
import { Button, EmptyState, ErrorState, PageHeader, SearchInput, Skeleton, Tag, Textarea } from '@/components/ui'
import { Drawer } from '@/components/Overlay'
import { cn } from '@/lib/cn'

type Skill = {
  name: string; description: string; priority: number;
  when: { always?: boolean; keywords?: any[]; regex?: any[] };
  body: string
}

export function SkillsPage() {
  const res = useAsync(() => api.get('/skills'), [])
  const [q, setQ] = useState('')
  const [detail, setDetail] = useState<Skill | null>(null)
  useReloadEvent(() => void res.reload())

  const skills = (res.data || []) as Skill[]
  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase()
    if (!s) return skills
    return skills.filter((x) =>
      x.name.toLowerCase().includes(s) ||
      x.description.toLowerCase().includes(s) ||
      (x.when?.keywords || []).some((k) => String(k).toLowerCase().includes(s)),
    )
  }, [skills, q])

  const alwaysCount = skills.filter((s) => s.when?.always).length

  return (
    <div className="page">
      <PageHeader
        title="技能"
        description="skills/*.md · YAML frontmatter 描述触发条件，正文为使用说明；always=true 常驻注入。"
        actions={<div className="w-[250px] max-w-full"><SearchInput value={q} onChange={setQ} placeholder="搜索名称 / 关键词…" /></div>}
        meta={<><span>{skills.length} 个技能</span><span className="h-3 w-px bg-ink/10" /><span>{alwaysCount} 个常驻</span><span className="h-3 w-px bg-ink/10" /><span>只读，编辑 skills/*.md 后热加载</span></>}
      />

      {res.error && <div className="mb-4"><ErrorState message={res.error} onRetry={() => void res.reload()} /></div>}

      <section className="panel overflow-hidden">
        {res.loading && !res.data ? (
          <div className="space-y-2 p-4">{[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-10" />)}</div>
        ) : (
          <div className="table-wrap hidden sm:block">
            <table className="data">
              <thead><tr><th style={{ width: 210 }}>技能</th><th>描述</th><th className="num" style={{ width: 90 }}>优先级</th><th style={{ width: 100 }}>注入</th><th style={{ width: 260 }}>触发关键词</th></tr></thead>
              <tbody>
                {filtered.map((s) => (
                  <tr key={s.name} tabIndex={0} aria-label={`查看技能 ${s.name}`} className="cursor-pointer" onClick={() => setDetail(s)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setDetail(s) } }}>
                    <td><span className="mono font-medium text-lagoon">{s.name}</span></td>
                    <td className="max-w-[360px] truncate text-ink-2" title={s.description}>{s.description}</td>
                    <td className="num"><Tag tone={s.priority >= 15 ? 'amber' : 'neutral'}>P{s.priority}</Tag></td>
                    <td>{s.when?.always ? <Tag tone="jade">always</Tag> : <span className="text-[11px] text-ink-3">按需</span>}</td>
                    <td>
                      <div className="flex flex-wrap gap-1">
                        {(s.when?.keywords || []).slice(0, 6).map((k) => <span key={String(k)} className="tag tag-lagoon !min-h-[19px] !px-1.5 !text-[9.5px]">{String(k)}</span>)}
                        {(s.when?.regex || []).slice(0, 3).map((r, i) => {
                          const txt = typeof r === 'string' ? r : r?.source || null
                          return txt ? <span key={i} className="mono tag tag-neutral !min-h-[19px] !px-1.5 !text-[9.5px]">{txt}</span> : null
                        })}
                        {!(s.when?.keywords || []).length && !(s.when?.regex || []).length && <span className="text-[11px] text-ink-3">—</span>}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <ul className="divide-y divide-line-soft sm:hidden">
          {filtered.map((s) => (
            <li key={s.name}>
              <button className="w-full px-4 py-3 text-left" onClick={() => setDetail(s)}>
                <div className="flex flex-wrap items-center gap-1.5"><span className="mono text-[12px] font-medium text-lagoon">{s.name}</span><Tag tone={s.priority >= 15 ? 'amber' : 'neutral'}>P{s.priority}</Tag>{s.when?.always && <Tag tone="jade">always</Tag>}</div>
                <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-ink-2">{s.description}</p>
                <div className="mt-1.5 flex flex-wrap gap-1">{(s.when?.keywords || []).slice(0, 4).map((k) => <span key={String(k)} className="tag tag-lagoon !min-h-[18px] !px-1.5 !text-[9px]">{String(k)}</span>)}</div>
              </button>
            </li>
          ))}
        </ul>
        {!res.loading && filtered.length === 0 && (
          <EmptyState icon={<Search />} title="没有匹配的技能">{q ? `没有技能匹配「${q}」。` : 'skills/ 目录下还没有可注入的技能。'}</EmptyState>
        )}
      </section>

      <Drawer
        open={!!detail}
        onClose={() => setDetail(null)}
        title={detail?.name || '技能详情'}
        description={detail?.description}
        width={720}
        footer={<Button variant="secondary" onClick={() => setDetail(null)}>关闭</Button>}
      >
        {detail && (
          <div className="space-y-4">
            <div className="flex flex-wrap gap-1.5">
              <Tag tone="amber">P{detail.priority}</Tag>
              <Tag tone={detail.when?.always ? 'jade' : 'neutral'}>{detail.when?.always ? 'always 常驻' : '按需触发'}</Tag>
              {(detail.when?.keywords || []).map((k) => <Tag key={String(k)} tone="lagoon">{String(k)}</Tag>)}
              {(detail.when?.regex || []).map((r, i) => {
                const txt = typeof r === 'string' ? r : r?.source || null
                return txt ? <span key={i} className="mono tag tag-neutral">{txt}</span> : null
              })}
            </div>
            <section>
              <h3 className="mb-1.5 text-[11px] font-medium text-ink-2">frontmatter</h3>
              <pre className="mono overflow-auto rounded-lg border border-line-soft bg-white/40 p-3 text-[11px] leading-relaxed">{`---
name: ${detail.name}
description: "${detail.description}"
when: [${(detail.when?.keywords || []).join(', ')}]
priority: ${detail.priority}
always: ${!!detail.when?.always}
---`}</pre>
            </section>
            <section>
              <h3 className="mb-1.5 text-[11px] font-medium text-ink-2">正文（markdown）</h3>
              <pre className="mono max-h-[440px] overflow-auto whitespace-pre-wrap rounded-lg border border-line-soft bg-white/40 p-3 text-[11px] leading-relaxed">{detail.body}</pre>
            </section>
            <div className="flex items-center gap-1.5 text-[10px] text-ink-4"><Sparkles size={11} />技能内容只读；编辑 skills/*.md 后通过 reload_skills 或重启生效。</div>
          </div>
        )}
      </Drawer>
    </div>
  )
}
