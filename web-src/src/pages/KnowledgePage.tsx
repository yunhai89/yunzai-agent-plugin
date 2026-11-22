import { useState } from 'react'
import { Database, FileText, Globe2, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { api } from '@/lib/api'
import { useAsync, useReloadEvent } from '@/lib/hooks'
import { fmtDate } from '@/lib/format'
import { Button, EmptyState, ErrorState, Field, Input, PageHeader, Skeleton, Tag, Textarea } from '@/components/ui'
import { useConfirm, useToast } from '@/components/Overlay'

type Doc = { id: string; title?: string; source?: string; url?: string; createdAt?: number; chunkCount?: number; refreshCron?: string | null; lastCrawled?: number }

export function KnowledgePage() {
  const toast = useToast()
  const confirm = useConfirm()
  const res = useAsync(() => api.get('/kb'), [])
  const [title, setTitle] = useState('')
  const [text, setText] = useState('')
  const [url, setUrl] = useState('')
  const [urlTitle, setUrlTitle] = useState('')
  const [busy, setBusy] = useState('')
  useReloadEvent(() => void res.reload())

  const docs = (res.data || []) as Doc[]

  const addText = async () => {
    if (!text.trim()) { toast('请粘贴要入库的文本', 'warn'); return }
    setBusy('text')
    try {
      const r = await api.post('/kb', { title: title.trim(), text })
      toast(`已入库 ${r.id}：${r.chunkCount} 块${r.embedded ? '（已向量化）' : '（未配 embedding，关键词检索）'}`, 'success')
      setTitle(''); setText('')
      await res.reload()
    } catch (e: any) { toast(e?.message || '入库失败', 'error') }
    finally { setBusy('') }
  }

  const addUrl = async () => {
    if (!url.trim()) { toast('请输入网址', 'warn'); return }
    setBusy('url')
    try {
      const r = await api.post('/kb/url', { url: url.trim(), title: urlTitle.trim() })
      toast(`已抓取入库 ${r.id}：${r.title || url}（${r.chunkCount} 块${r.via ? `，via ${r.via}` : ''}）`, 'success')
      setUrl(''); setUrlTitle('')
      await res.reload()
    } catch (e: any) { toast(e?.message || '抓取入库失败', 'error') }
    finally { setBusy('') }
  }

  const refreshDoc = async (d: Doc) => {
    setBusy(`refresh:${d.id}`)
    try {
      const r = await api.post(`/kb/${encodeURIComponent(d.id)}/refresh`, {})
      toast(`已刷新 ${d.id}：${r.chunkCount} 块${r.via ? `（via ${r.via}）` : ''}`, 'success')
      await res.reload()
    } catch (e: any) { toast(e?.message || '刷新失败', 'error') }
    finally { setBusy('') }
  }

  const removeDoc = async (d: Doc) => {
    const ok = await confirm({
      title: '删除知识库文档',
      message: <span>将删除文档 <b>{d.id}</b> 及其全部向量块，检索立即不再命中。此操作不可恢复。</span>,
      confirmText: '删除文档', danger: true,
    })
    if (!ok) return
    try {
      await api.del(`/kb/${encodeURIComponent(d.id)}`)
      toast('已删除', 'info')
      await res.reload()
    } catch (e: any) { toast(e?.message || '删除失败', 'error') }
  }

  const rebuild = async () => {
    const ok = await confirm({ title: '重建知识库索引？', message: '会重新分块并向量化全部文档，耗时取决于文档量。', confirmText: '重建索引' })
    if (!ok) return
    setBusy('rebuild')
    try {
      const r = await api.post('/kb/rebuild', {})
      toast(`已重建 ${r.rebuilt ?? 0} 块`, 'success')
    } catch (e: any) { toast(e?.message || '重建失败', 'error') }
    finally { await res.reload(); setBusy('') }
  }

  return (
    <div className="page">
      <PageHeader
        title="知识库"
        description="全局共享文档库 · chunk + embedding 向量化 · 对话时 Agent 调 kb_search 检索（RAG）；支持网页 URL 入库。"
        actions={<Button variant="secondary" size="sm" onClick={() => void rebuild()} loading={busy === 'rebuild'} icon={<RefreshCw size={14} />} disabled={!!busy}>重建索引</Button>}
        meta={<><span>{docs.length} 篇文档</span><span className="h-3 w-px bg-ink/10" /><span>定时刷新用 #知识库定时 &lt;id&gt;</span></>}
      />

      {res.error && <div className="mb-4"><ErrorState message={res.error} onRetry={() => void res.reload()} /></div>}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <section className="panel p-5">
          <div className="flex items-center gap-2"><span className="flex h-8 w-8 items-center justify-center rounded-lg bg-lagoon/7 text-lagoon"><Globe2 size={16} /></span><div><h2 className="section-title">添加网页 URL</h2><p className="text-[10.5px] text-ink-3">自动抓取正文 → 分块入库</p></div></div>
          <div className="mt-4 space-y-3">
            <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/article" aria-label="网页 URL" />
            <Input value={urlTitle} onChange={(e) => setUrlTitle(e.target.value)} placeholder="标题（可选，留空用页面标题）" aria-label="网页标题" />
            <div className="flex items-center justify-between gap-2">
              <p className="text-[10px] leading-relaxed text-ink-3">需要配置中心开启网页抓取；抓取失败会回退纯 HTTP。</p>
              <Button size="sm" variant="primary" onClick={() => void addUrl()} loading={busy === 'url'} disabled={!url.trim() || !!busy} icon={<Globe2 size={12} />}>抓取入库</Button>
            </div>
          </div>
        </section>

        <section className="panel p-5">
          <div className="flex items-center gap-2"><span className="flex h-8 w-8 items-center justify-center rounded-lg bg-jade/7 text-jade"><FileText size={16} /></span><div><h2 className="section-title">添加文档</h2><p className="text-[10.5px] text-ink-3">粘贴文本 · 长文自动分块向量化</p></div></div>
          <div className="mt-4 space-y-3">
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="标题（可选，留空自动命名）" aria-label="文档标题" />
            <Textarea value={text} onChange={(e) => setText(e.target.value)} placeholder="粘贴文档全文（FAQ / 资料 / 设定等）" className="mono min-h-[88px]" aria-label="文档内容" />
            <div className="flex items-center justify-between gap-2">
              <p className="text-[10px] text-ink-3">人工文档来源标记为 manual。</p>
              <Button size="sm" variant="primary" onClick={() => void addText()} loading={busy === 'text'} disabled={!text.trim() || !!busy} icon={<Plus size={12} />}>入库</Button>
            </div>
          </div>
        </section>
      </div>

      <section className="panel mt-5 overflow-hidden">
        <div className="flex items-center justify-between gap-2 border-b border-line-soft px-5 py-4">
          <div className="flex items-center gap-2"><Database size={15} className="text-lagoon" /><div><h2 className="section-title">已入库文档</h2><p className="text-[10.5px] text-ink-3">{docs.length} 篇 · 网页 / 文本</p></div></div>
          <Button variant="ghost" size="sm" onClick={() => void res.reload()} icon={<RefreshCw size={13} />}>刷新</Button>
        </div>
        {res.loading && !res.data ? (
          <div className="space-y-2 p-4">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-12" />)}</div>
        ) : docs.length === 0 ? (
          <EmptyState icon={<Database />} title="暂无文档">上方粘贴文本或添加 URL，或在 QQ 发 #知识库添加 命令。</EmptyState>
        ) : (
          <div className="table-wrap hidden sm:block">
            <table className="data">
              <thead><tr><th>标题</th><th style={{ width: 120 }}>ID</th><th className="num" style={{ width: 70 }}>分块</th><th style={{ width: 170 }}>定时 / 刷新</th><th style={{ width: 90 }} className="num">操作</th></tr></thead>
              <tbody>
                {docs.map((d) => (
                  <tr key={d.id}>
                    <td>
                      <div className="flex items-start gap-2">
                        {d.url ? <Globe2 size={13} className="mt-0.5 flex-none text-lagoon" /> : <FileText size={13} className="mt-0.5 flex-none text-ink-3" />}
                        <div className="min-w-0">
                          <div className="truncate font-medium" title={d.title || d.id}>{d.title || d.id}</div>
                          {d.url && <div className="mono mt-0.5 break-all text-[9.5px] text-ink-3">{d.url}</div>}
                        </div>
                      </div>
                    </td>
                    <td><span className="mono text-[10px] text-ink-3">{d.id}</span></td>
                    <td className="num"><Tag tone="neutral">{d.chunkCount ?? 0}</Tag></td>
                    <td>
                      <div className="text-[10px] text-ink-3">{d.refreshCron ? <span className="inline-flex items-center gap-1"><RefreshCw size={9} />{d.refreshCron}</span> : '—'}</div>
                      {d.lastCrawled && <div className="mt-0.5 text-[9px] text-ink-4">抓取 {fmtDate(d.lastCrawled)}</div>}
                    </td>
                    <td>
                      <div className="flex justify-end gap-0.5">
                        {d.url && <Button size="icon" variant="ghost" className="btn-sm" onClick={() => void refreshDoc(d)} disabled={!!busy} aria-label="刷新最新内容" title="刷新最新内容"><RefreshCw size={12} className={busy === `refresh:${d.id}` ? 'animate-spin' : ''} /></Button>}
                        <Button size="icon" variant="ghost" className="btn-sm hover:text-coral" onClick={() => void removeDoc(d)} aria-label="删除文档" title="删除文档"><Trash2 size={12} /></Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {docs.length > 0 && (
          <ul className="divide-y divide-line-soft sm:hidden">
            {docs.map((d) => (
              <li key={d.id} className="px-4 py-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5 text-[11.5px] font-medium">{d.url ? <Globe2 size={12} className="flex-none text-lagoon" /> : <FileText size={12} className="flex-none text-ink-3" />}<span className="truncate">{d.title || d.id}</span></div>
                    {d.url && <p className="mono mt-0.5 break-all text-[9px] text-ink-3">{d.url}</p>}
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-[9.5px] text-ink-3"><span className="mono">{d.id}</span><Tag tone="neutral">{d.chunkCount ?? 0} 块</Tag>{d.refreshCron && <span>{d.refreshCron}</span>}</div>
                  </div>
                  <div className="flex flex-none gap-0.5">
                    {d.url && <Button size="icon" variant="ghost" className="btn-sm" onClick={() => void refreshDoc(d)} disabled={!!busy} aria-label="刷新最新内容"><RefreshCw size={12} className={busy === `refresh:${d.id}` ? 'animate-spin' : ''} /></Button>}
                    <Button size="icon" variant="ghost" className="btn-sm hover:text-coral" onClick={() => void removeDoc(d)} aria-label="删除文档"><Trash2 size={12} /></Button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
