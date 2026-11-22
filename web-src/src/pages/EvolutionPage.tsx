import { useMemo, useState } from 'react'
import { Check, FlaskConical, RefreshCw, RotateCcw, Search, ShieldAlert, Trash2 } from 'lucide-react'
import { api } from '@/lib/api'
import { useAsync, useReloadEvent } from '@/lib/hooks'
import { fmtAgo, num, pct, safeJson } from '@/lib/format'
import { Button, EmptyState, ErrorState, PageHeader, Skeleton, Tag } from '@/components/ui'
import { Drawer, useConfirm, useToast } from '@/components/Overlay'
import { cn } from '@/lib/cn'

const STATUS: Record<string, { name: string; tone: 'neutral' | 'amber' | 'jade' | 'coral' | 'lagoon' }> = {
  draft: { name: '草稿', tone: 'neutral' }, verified: { name: '待采纳', tone: 'amber' },
  stable: { name: '已上线', tone: 'jade' }, rejected: { name: '已拒绝', tone: 'coral' },
  deprecated: { name: '已淘汰', tone: 'neutral' }, quarantined: { name: '隔离', tone: 'coral' },
}

type ToolVersion = {
  id: string; tool_id?: string; name?: string; semver?: string; status: string; active?: boolean;
  description?: string; sideEffects?: string[]; tests_count?: number; category?: string;
  provenanceKind?: string; generator_model?: string; namespace?: string
}

export function EvolutionPage() {
  const toast = useToast()
  const confirm = useConfirm()
  const res = useAsync(async () => {
    const [tools, metrics, health] = await Promise.all([
      api.get('/tevo/tools'),
      api.get('/tevo/metrics').catch(() => null),
      api.get('/tevo/health').catch(() => []),
    ])
    return { tools: (tools || []) as ToolVersion[], metrics, health: Array.isArray(health) ? health : [] }
  }, [])
  const [filter, setFilter] = useState('')
  const [detail, setDetail] = useState<any>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [busy, setBusy] = useState('')

  useReloadEvent(() => void res.reload())

  const tools = res.data?.tools || []
  const metrics = res.data?.metrics
  const health = res.data?.health || []
  const stats = useMemo(() => {
    const out: Record<string, number> = {}
    for (const t of tools) out[t.status] = (out[t.status] || 0) + 1
    return out
  }, [tools])
  const filtered = filter ? tools.filter((t) => t.status === filter) : tools

  const loadDetail = async (t: ToolVersion) => {
    setDetail({ ...t, _loading: true }); setDetailLoading(true)
    try { setDetail(await api.get(`/tevo/tools/${encodeURIComponent(t.id)}`)) }
    catch (e: any) { toast(e?.message || '读取详情失败', 'error'); setDetail(null) }
    finally { setDetailLoading(false) }
  }

  const act = async (t: ToolVersion, kind: 'approve' | 'decommission' | 'rollback') => {
    const name = `${t.name || t.tool_id}@${t.semver || '?'}`
    const ok = await confirm({
      title: kind === 'approve' ? `采纳 ${name}？` : kind === 'rollback' ? `把 ${name} 设为当前？` : `淘汰 ${name}？`,
      message: kind === 'approve'
        ? '将把这版 LLM 生成的源码注入工具注册表，Agent 可立即调用。请先在详情里核对验证证据、测试与源码。'
        : kind === 'rollback'
          ? '会把该 stable 版本切换为当前注入版本，替换现在 active 的版本。'
          : '该版本会停止注入；若还有其它 stable 版本，运行时可能回滚到它。',
      confirmText: kind === 'approve' ? '采纳上线' : kind === 'rollback' ? '设为当前' : '淘汰版本',
      danger: kind === 'decommission',
    })
    if (!ok) return
    setBusy(t.id)
    try {
      const r = await api.post(`/tevo/tools/${encodeURIComponent(t.id)}/${kind}`)
      toast(kind === 'approve' ? '已采纳并注入，Agent 可调用' : kind === 'decommission' ? (r?.msg || '已淘汰') : (r?.msg || '已设为当前上线版本'), kind === 'decommission' ? 'info' : 'success')
      await res.reload()
      if (detail?.id === t.id) setDetail(null)
    } catch (e: any) { toast(e?.message || '操作失败', 'error') }
    finally { setBusy('') }
  }

  return (
    <div className="page">
      <PageHeader
        title="工具进化"
        description="候选生成（LLM + AST）→ 验证（沙箱）→ 审批 → 版本。在 QQ 对 bot 发 #进化工具 <能力描述> 生成候选。"
        actions={<Button variant="secondary" size="sm" onClick={() => void res.reload()} icon={<RefreshCw size={14} />}>刷新</Button>}
        meta={<><span>{tools.length} 个版本</span><span className="h-3 w-px bg-ink/10" /><span>采纳前可审阅源码与验证证据</span></>}
      />

      {res.error && <div className="mb-4"><ErrorState message={res.error} onRetry={() => void res.reload()} /></div>}

      {metrics && (
        <div className="panel mb-4 flex flex-wrap items-center gap-2 px-4 py-3">
          <Tag tone="jade">active {metrics.activeStable ?? 0}</Tag>
          <Tag tone="neutral">stable {metrics.stable ?? 0}</Tag>
          <Tag tone="neutral">版本 {metrics.totalVersions ?? 0}</Tag>
          <Tag tone="lagoon">调用 {metrics.invocations ?? 0}</Tag>
          <Tag tone={num(metrics.invocationFailRate) > 0.2 ? 'coral' : 'neutral'}>失败率 {pct(metrics.invocationFailRate, 0)}</Tag>
          <Tag tone="neutral">复用率 {pct(metrics.reuseRate, 0)}</Tag>
        </div>
      )}

      {health.length > 0 && (
        <div className="mb-4 rounded-xl border border-amber/20 bg-amber-soft/60 px-4 py-3">
          <div className="flex items-center gap-2 text-[11.5px] font-medium text-amber"><ShieldAlert size={13} /> 健康告警</div>
          <div className="mt-1.5 space-y-1">
            {health.map((h: any) => (
              <div key={h.versionId} className="text-[11px] text-ink-2">
                <span className="mono">{h.toolName}@{h.semver}</span> 失败率 {pct(h.failRate, 0)}（{h.failed}/{h.total}）· {(h.topErrors || []).join(', ')}
                <span className="ml-1 text-ink-3">→ #进化工具 修复 {h.toolName} &lt;描述&gt;</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="mb-3 flex flex-wrap gap-1">
        {[
          { key: '', label: `全部 ${tools.length}` },
          { key: 'verified', label: `待采纳 ${stats.verified || 0}` },
          { key: 'stable', label: `已上线 ${stats.stable || 0}` },
          { key: 'rejected', label: `已拒绝 ${stats.rejected || 0}` },
        ].map((f) => (
          <button key={f.key} className={cn('tag', filter === f.key ? 'tag-lagoon' : 'tag-neutral')} onClick={() => setFilter(f.key)}>{f.label}</button>
        ))}
      </div>

      <section className="panel overflow-hidden">
        {res.loading && !res.data ? (
          <div className="space-y-2 p-4">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-20" />)}</div>
        ) : filtered.length === 0 ? (
          <EmptyState icon={<FlaskConical />} title="暂无进化工具版本">在 QQ 对 bot 发 <span className="mono">#进化工具 &lt;能力描述&gt;</span> 生成候选。</EmptyState>
        ) : (
          <ul className="divide-y divide-line-soft">
            {filtered.map((v) => {
              const st = STATUS[v.status] || STATUS.draft
              return (
                <li key={v.id} className="flex flex-wrap items-start gap-3 px-4 py-3.5 transition hover:bg-white/35">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Tag tone={st.tone}>{st.name}</Tag>
                      <span className="mono text-[12.5px] font-medium text-ink">{v.name || v.tool_id}</span>
                      <span className="mono text-[10.5px] text-ink-3">v{v.semver}</span>
                      {v.active && <Tag tone="jade">当前上线</Tag>}
                    </div>
                    <p className="mt-1 line-clamp-1 text-[11.5px] text-ink-2">{v.description || '（无描述）'}</p>
                    <div className="mono mt-1 line-clamp-1 text-[9.5px] text-ink-4">
                      id {v.id} · 权限 {(v.sideEffects || []).join('/') || '—'} · 测试 {v.tests_count ?? 0} · 类别 {v.category || '—'} · 来源 {v.provenanceKind || '—'} · 模型 {v.generator_model || '—'}
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    <Button size="sm" variant="secondary" onClick={() => void loadDetail(v)} icon={<Search size={12} />}>详情</Button>
                    {v.status === 'verified' && <Button size="sm" variant="primary" onClick={() => void act(v, 'approve')} loading={busy === v.id} icon={<Check size={12} />}>采纳上线</Button>}
                    {v.status === 'stable' && <Button size="sm" variant="secondary" onClick={() => void act(v, 'rollback')} loading={busy === v.id} icon={<RotateCcw size={12} />}>设为当前</Button>}
                    {v.status === 'stable' && <Button size="sm" variant="danger" onClick={() => void act(v, 'decommission')} loading={busy === v.id} icon={<Trash2 size={12} />}>淘汰</Button>}
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </section>

      <Drawer
        open={!!detail}
        onClose={() => !detailLoading && setDetail(null)}
        title={detail ? `${detail.name || detail.tool_id || '版本'} v${detail.semver || '?'}` : '版本详情'}
        description={detail?.manifest?.description || detail?.description || '（无描述）'}
        width={820}
        footer={<Button variant="secondary" onClick={() => setDetail(null)} disabled={detailLoading}>关闭</Button>}
      >
        {detail && (
          <div className="space-y-4">
            <div className="flex flex-wrap gap-1.5">
              <Tag tone={(STATUS[detail.status] || STATUS.draft).tone}>{(STATUS[detail.status] || STATUS.draft).name}</Tag>
              <Tag tone="neutral">{detail.namespace || '—'}</Tag>
              <Tag tone="neutral">{detail.category || '—'}</Tag>
              <Tag tone="neutral">权限 {(detail.manifest?.permissions?.sideEffects || detail.sideEffects || []).join('/') || '—'}</Tag>
              {detail.active && <Tag tone="jade">当前上线</Tag>}
            </div>
            <div className="mono space-y-0.5 text-[10px] leading-relaxed text-ink-3">
              <div>id: {detail.id}</div>
              <div>内容哈希: {detail.contentHash || '—'} · 源码哈希: {detail.sourceHash || '—'}</div>
              <div>验证器: {detail.verifiedVerifier || '—'} · 父版本: {detail.parentVersionId || '—'} · 生成模型: {detail.generatorModel || '—'}</div>
            </div>
            <section>
              <h3 className="mb-1.5 text-[11px] font-medium text-ink-2">验证证据</h3>
              <pre className="mono max-h-44 overflow-auto whitespace-pre-wrap rounded-lg border border-line-soft bg-white/40 p-3 text-[10.5px] leading-relaxed">{safeJson(detail.evidence || {})}</pre>
            </section>
            <section>
              <h3 className="mb-1.5 text-[11px] font-medium text-ink-2">测试用例（{(detail.tests || []).length}）</h3>
              <pre className="mono max-h-52 overflow-auto whitespace-pre-wrap rounded-lg border border-line-soft bg-white/40 p-3 text-[10.5px] leading-relaxed">{safeJson(detail.tests || [])}</pre>
            </section>
            <section>
              <h3 className="mb-1.5 text-[11px] font-medium text-ink-2">源码</h3>
              <pre className="mono max-h-[420px] overflow-auto whitespace-pre-wrap rounded-lg border border-line-soft bg-white/40 p-3 text-[10.5px] leading-relaxed">{detail.source || '（内置工具无制品源码）'}</pre>
            </section>
            <div className="text-[10px] text-ink-4">更新于 {fmtAgo(detail.created_at || detail.createdAt)}</div>
          </div>
        )}
      </Drawer>
    </div>
  )
}
