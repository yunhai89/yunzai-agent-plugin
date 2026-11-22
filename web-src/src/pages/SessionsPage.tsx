import { useEffect, useMemo, useState } from 'react'
import { Bot, ChevronRight, MessagesSquare, UserRound, Wrench } from 'lucide-react'
import { api } from '@/lib/api'
import { useAsync, useReloadEvent } from '@/lib/hooks'
import { fmtAgo, safeJson } from '@/lib/format'
import { EmptyState, ErrorState, PageHeader, SearchInput, Skeleton, Tag } from '@/components/ui'
import { cn } from '@/lib/cn'

type Conv = { id: string; title?: string; count?: number; preview?: string; updatedAt?: number; scopeUserId?: string; scopeGroupId?: string | null }
type Msg = { role: string; content?: any; reasoning?: string; name?: string; tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[] }

function text(v: any): string {
  if (v == null) return ''
  if (typeof v === 'string') return v
  return safeJson(v)
}

export function SessionsPage() {
  const convs = useAsync(() => api.get('/conversations'), [])
  const [activeId, setActiveId] = useState('')
  const [q, setQ] = useState('')

  const list = (convs.data || []) as Conv[]
  useEffect(() => {
    if (!activeId && list.length) setActiveId(list[0].id)
    if (activeId && !list.some((c) => c.id === activeId) && list.length) setActiveId(list[0].id)
  }, [list, activeId])
  const conv = list.find((c) => c.id === activeId)
  const session = useAsync(() => {
    if (!conv) return Promise.resolve({ key: '', messages: [] })
    return api.get('/sessions', { convId: conv.id, userId: conv.scopeUserId, groupId: conv.scopeGroupId || 'private' })
  }, [conv?.id])

  useReloadEvent(() => { void convs.reload(); if (activeId) void session.reload() })

  const shown = useMemo(() => {
    const s = q.trim().toLowerCase()
    if (!s) return list
    return list.filter((c) => `${c.title || ''} ${c.preview || ''} ${c.scopeUserId || ''}`.toLowerCase().includes(s))
  }, [list, q])

  const messages = (session.data?.messages || []) as Msg[]

  return (
    <div className="page">
      <PageHeader
        title="会话回放"
        description="对话列表与消息历史。推理过程与工具调用可以展开查看；这里是只读回放，不会继续对话。"
        meta={<><span>{list.length} 个会话</span><span className="h-3 w-px bg-ink/10" /><span>按更新时间排序</span></>}
      />

      {(convs.error || session.error) && <div className="mb-4"><ErrorState message={convs.error || session.error} onRetry={() => { void convs.reload(); if (activeId) void session.reload() }} /></div>}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[320px_minmax(0,1fr)]">
        <section className="panel flex max-h-[calc(100dvh-190px)] flex-col overflow-hidden xl:sticky xl:top-[76px]">
          <div className="border-b border-line-soft px-4 py-3">
            <div className="mb-2 flex items-center gap-2"><MessagesSquare size={15} className="text-lagoon" /><span className="section-title">对话列表</span></div>
            <SearchInput value={q} onChange={setQ} placeholder="搜索标题 / 用户" />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {convs.loading && !convs.data ? <div className="space-y-2 p-2">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-16" />)}</div>
              : shown.length === 0 ? <EmptyState icon={<MessagesSquare />} title={q ? '没有匹配的会话' : '暂无对话'}>产生一次对话后会出现在这里。</EmptyState>
                : shown.map((c) => (
                  <button key={c.id} className={cn('mb-1 w-full rounded-[10px] px-3 py-2.5 text-left transition', activeId === c.id ? 'bg-white/75 shadow-[0_6px_18px_-16px_rgba(10,60,56,.6)]' : 'hover:bg-white/40')} onClick={() => setActiveId(c.id)}>
                    <div className="flex items-start justify-between gap-2"><span className="line-clamp-1 text-[12px] font-medium">{c.title || '未命名会话'}</span>{c.count ? <Tag tone="lagoon">{c.count}</Tag> : null}</div>
                    <p className="mt-0.5 line-clamp-1 text-[10.5px] text-ink-3">{c.preview || '—'}</p>
                    <div className="mt-1 flex items-center justify-between gap-2 text-[9.5px] text-ink-4">
                      <span>更新 {fmtAgo(c.updatedAt)}</span>
                      <span className="mono">{c.scopeGroupId ? `群 ${c.scopeGroupId}` : '私聊'}</span>
                    </div>
                  </button>
                ))}
          </div>
        </section>

        <section className="panel flex min-h-[480px] flex-col overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line-soft px-5 py-3.5">
            <div className="min-w-0">
              <h2 className="truncate text-[13.5px] font-semibold">{conv?.title || '会话回放'}</h2>
              <div className="mono mt-0.5 truncate text-[9.5px] text-ink-3">{session.data?.key || conv?.id || '—'}</div>
            </div>
            {session.data?.scopeUserId && <Tag tone="lagoon"><UserRound size={10} />{session.data.scopeUserId}</Tag>}
          </div>
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
            {session.loading && !session.data ? <div className="space-y-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-20" />)}</div>
              : messages.length === 0 ? <EmptyState icon={<MessagesSquare />} title="该对话暂无消息记录">选择左侧其它会话，或等运行时产生对话。</EmptyState>
                : messages.map((m, i) => {
                  if (m.role === 'system') {
                    return <div key={i} className="rounded-lg border border-line-soft bg-white/35 px-3 py-2 text-[11px] leading-relaxed text-ink-2"><b className="mr-1.5 text-[9.5px] tracking-[.06em] text-ink-3">SYSTEM</b>{text(m.content)}</div>
                  }
                  if (m.role === 'user') {
                    return (
                      <div key={i} className="flex items-start justify-end gap-2.5">
                        <div className="max-w-[86%] rounded-2xl rounded-tr-sm border border-amber/15 bg-amber-soft/55 px-3.5 py-2.5 text-[12.5px] leading-relaxed whitespace-pre-wrap">{text(m.content)}</div>
                        <span className="flex h-7 w-7 flex-none items-center justify-center rounded-full border border-white/70 bg-[linear-gradient(135deg,#f3ead8,#dfc9a3)] text-[10px] font-medium">我</span>
                      </div>
                    )
                  }
                  if (m.role === 'tool') {
                    return (
                      <div key={i} className="flex items-start gap-2.5">
                        <span className="flex h-7 w-7 flex-none items-center justify-center rounded-full border border-white/70 bg-[linear-gradient(135deg,#e5f3ed,#b9dfd3)] text-jade"><Wrench size={13} /></span>
                        <div className="min-w-0 max-w-[86%] rounded-2xl rounded-tl-sm border border-line-soft bg-white/45 px-3.5 py-2.5 text-[11px] leading-relaxed">
                          <div className="mono mb-1 text-[9.5px] font-medium text-ink-3">{m.name || 'tool'} →</div>
                          <div className="whitespace-pre-wrap break-words">{text(m.content)}</div>
                        </div>
                      </div>
                    )
                  }
                  if (m.role === 'assistant') {
                    return (
                      <div key={i} className="flex items-start gap-2.5">
                        <span className="flex h-7 w-7 flex-none items-center justify-center rounded-full border border-white/70 bg-[linear-gradient(135deg,#dcefEA,#a9d6cc)] text-lagoon"><Bot size={14} /></span>
                        <div className="min-w-0 max-w-[86%] space-y-2">
                          <div className="rounded-2xl rounded-tl-sm border border-white/70 bg-white/55 px-3.5 py-2.5 text-[12.5px] leading-relaxed whitespace-pre-wrap">{m.content ? text(m.content) : <span className="text-ink-3">（无文本，仅工具调用）</span>}</div>
                          {m.reasoning && (
                            <details className="rounded-lg border border-line-soft bg-white/35 px-3 py-2">
                              <summary className="cursor-pointer text-[10px] text-ink-3">推理过程</summary>
                              <pre className="mono mt-1.5 max-h-64 overflow-auto whitespace-pre-wrap text-[10.5px] leading-relaxed text-ink-2">{m.reasoning}</pre>
                            </details>
                          )}
                          {(m.tool_calls || []).map((tc, j) => (
                            <details key={tc.id || j} className="rounded-lg border border-line-soft bg-white/35 px-3 py-2">
                              <summary className="flex cursor-pointer items-center gap-1.5 text-[10px] text-ink-3"><ChevronRight size={11} />{tc.function?.name || 'tool_call'}</summary>
                              <pre className="mono mt-1.5 max-h-64 overflow-auto whitespace-pre-wrap text-[10.5px] leading-relaxed text-ink-2">{(() => { try { return JSON.stringify(JSON.parse(tc.function?.arguments || '{}'), null, 2) } catch { return tc.function?.arguments || '' } })()}</pre>
                            </details>
                          ))}
                        </div>
                      </div>
                    )
                  }
                  return null
                })}
          </div>
        </section>
      </div>
    </div>
  )
}
