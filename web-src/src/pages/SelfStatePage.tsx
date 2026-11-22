import { useEffect, useMemo, useState } from 'react'
import { Brain, RefreshCw, Snowflake, Trash2 } from 'lucide-react'
import { api } from '@/lib/api'
import { useAsync, useReloadEvent } from '@/lib/hooks'
import { fmtDate, num, pct } from '@/lib/format'
import { Button, EmptyState, ErrorState, PageHeader, Select, Skeleton, Tag } from '@/components/ui'
import { useConfirm, useToast } from '@/components/Overlay'
import { cn } from '@/lib/cn'

const MOOD_ZH: Record<string, string> = { positive: '不错', neutral: '平稳', slightly_negative: '有点低落', negative: '明显低落' }
const EMO_ZH: Record<string, string> = {
  amusement: '好笑', joy: '高兴', pride: '自豪', gratitude: '感激', relief: '释然', curiosity: '好奇',
  annoyance: '烦躁', anger: '生气', hurt: '受伤', sadness: '难过', embarrassment: '尴尬', loneliness: '孤独',
  disappointment: '失望', anxiety: '不安', resentment: '怨气',
}
const CONCERN_ZH: Record<string, string> = {
  unresolved_disrespect: '未解决的不尊重', unresolved_exclusion: '被排斥感', unresolved_rejection: '被拒绝',
  unappreciated_help: '帮助被轻视', ignored_pattern: '被冷落模式',
}

export function SelfStatePage() {
  const toast = useToast()
  const confirm = useConfirm()
  const config = useAsync(() => api.get('/config'), [])
  const groups = useMemo(() => {
    const arr = (v: any) => Array.isArray(v) ? v : []
    const own = arr(config.data?.selfState?.groups)
    const gw = arr(config.data?.groupWorld?.groups)
    const hz = arr(config.data?.humanize?.groups)
    const src = own.length ? own : gw.length ? gw : hz
    return src.map(String)
  }, [config.data])
  const disabled = config.data?.selfState?.enabled === false
  const [gid, setGid] = useState('')
  const [tab, setTab] = useState<'state' | 'relations'>('state')
  const overview = useAsync(() => gid ? api.get('/selfstate/overview', { groupId: gid }) : Promise.resolve(null), [gid])
  const relations = useAsync(() => gid ? api.get('/selfstate/relations', { groupId: gid }) : Promise.resolve([]), [gid])
  const [busy, setBusy] = useState('')

  useEffect(() => { if (!gid && groups.length) setGid(groups[0]) }, [groups, gid])
  useReloadEvent(() => { if (gid) { void overview.reload(); void relations.reload() } })

  const ov = overview.data
  const state = ov?.state
  const mood = num(state?.valence) >= 0.15 ? 'positive' : num(state?.valence) > -0.15 ? 'neutral' : num(state?.valence) > -0.45 ? 'slightly_negative' : 'negative'
  const emotions = (ov?.emotions || []) as any[]
  const expectations = (ov?.expectations || []) as any[]
  const concerns = (ov?.concerns || []) as any[]
  const reflections = (ov?.reflections || []) as any[]
  const rels = (relations.data || []) as any[]

  const act = async (kind: 'reset' | 'freeze' | 'clear', userId?: string) => {
    if (!gid) return
    if (kind === 'reset') {
      const ok = await confirm({ title: '重置本群自我状态？', message: '会清空本群的心境、情绪、期待与心事，不可恢复。', confirmText: '重置状态', danger: true })
      if (!ok) return
    }
    if (kind === 'clear') {
      const ok = await confirm({ title: '清除该成员的情感残留？', message: '只清空好感 / 受伤 / 怨气等情感列，不动熟悉度与信任。', confirmText: '清除残留', danger: true })
      if (!ok) return
    }
    setBusy(kind + (userId || ''))
    try {
      if (kind === 'reset') await api.post('/selfstate/reset', { groupId: gid })
      else if (kind === 'freeze') await api.post('/selfstate/freeze', { groupId: gid, frozen: !state?.expression_frozen })
      else await api.post('/selfstate/clear-member', { groupId: gid, userId })
      toast(kind === 'reset' ? '已重置本群自我状态' : kind === 'freeze' ? (state?.expression_frozen ? '已解冻情绪外显' : '已冻结情绪外显') : '已清除成员情感残留', 'info')
      await Promise.all([overview.reload(), relations.reload()])
    } catch (e: any) { toast(e?.message || '操作失败', 'error') }
    finally { setBusy('') }
  }

  return (
    <div className="page">
      <PageHeader
        title="自我状态"
        description="自我认知与情绪的调试视图：心境 / 情绪 / 期待 / 心事。Shadow 开关与阈值在配置中心 → 自我状态。"
        actions={(
          <>
            <Select value={gid} onChange={(e) => setGid(e.target.value)} aria-label="群" className="w-[180px]">
              {groups.length === 0 && <option value="">无白名单群</option>}
              {groups.map((g: string) => <option key={g} value={g}>群 {g}</option>)}
            </Select>
            <Button variant="secondary" size="sm" onClick={() => { void overview.reload(); void relations.reload() }} icon={<RefreshCw size={14} />} disabled={!gid}>刷新</Button>
          </>
        )}
        meta={ov ? <><span>{ov.enabled ? '已启用' : '未启用'}</span><span className="h-3 w-px bg-ink/10" /><span>shadow={String(!!ov.shadowMode)}</span>{state?.expression_frozen && <><span className="h-3 w-px bg-ink/10" /><span className="text-amber">外显已冻结</span></>}</> : undefined}
      />

      {(config.error || overview.error || relations.error) && <div className="mb-4"><ErrorState message={config.error || overview.error || relations.error} onRetry={() => { void overview.reload(); void relations.reload() }} /></div>}

      {disabled && !config.loading ? (
        <div className="panel"><EmptyState icon={<Brain />} title="SelfState 未启用" action={<a href="#/config" className="btn btn-primary btn-sm">去配置中心</a>}>打开「自我状态」后，这里才会显示心境、情绪、期待与心事。</EmptyState></div>
      ) : groups.length === 0 && !config.loading ? (
        <div className="panel"><EmptyState icon={<Brain />} title="还没有可观察的群" action={<a href="#/humanize" className="btn btn-primary btn-sm">去伪人模式</a>}>SelfState 使用自我状态白名单；为空时回落到群聊小世界 / 伪人白名单。先在对应页面加入群。</EmptyState></div>
      ) : (
        <>
          <div className="toolbar">
            <div className="segmented" role="group" aria-label="视图">
              <button aria-pressed={tab === 'state'} onClick={() => setTab('state')}>状态概览</button>
              <button aria-pressed={tab === 'relations'} onClick={() => setTab('relations')}>关系情感</button>
            </div>
          </div>

          {tab === 'state' ? (
            !gid ? <div className="panel"><EmptyState icon={<Brain />} title="选择一个群">从右上角选择要观察的群。</EmptyState></div>
              : overview.loading && !ov ? <div className="grid grid-cols-1 gap-3 md:grid-cols-2">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-28" />)}</div>
                : !ov ? <div className="panel"><EmptyState icon={<Brain />} title="暂无状态">该群还没有自我状态记录。</EmptyState></div>
                  : (
                    <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
                      <div className="space-y-4">
                        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                          {[
                            ['总体心境', MOOD_ZH[mood]], ['精力', pct(ov.state?.energy, 0)], ['社交安心感', pct(ov.state?.social_security, 0)], ['状态版本', `v${ov.state?.state_version ?? '—'}`],
                          ].map(([k, v]) => (
                            <div key={k} className="panel px-4 py-3">
                              <div className="text-[10px] text-ink-3">{k}</div>
                              <div className="mt-1 text-[18px] font-semibold tracking-[-0.02em]">{v}</div>
                            </div>
                          ))}
                        </div>

                        <section className="panel p-5">
                          <h2 className="section-title">活跃情绪（{emotions.length}）</h2>
                          <div className="mt-3 space-y-2.5">
                            {emotions.length === 0 ? <p className="text-[11px] text-ink-3">暂无活跃情绪。</p> : emotions.map((e: any) => (
                              <div key={e.id} className="grid grid-cols-[90px_minmax(0,1fr)_110px] items-center gap-3">
                                <Tag tone="lagoon">{EMO_ZH[e.emotion_type] || e.emotion_type}</Tag>
                                <div className="h-1.5 overflow-hidden rounded-full bg-ink/5"><div className="h-full rounded-full bg-[linear-gradient(90deg,#7cc7ba,#0f6b65)]" style={{ width: `${Math.min(100, num(e.intensity) * 100)}%` }} /></div>
                                <span className="mono text-right text-[10px] text-ink-3">{pct(e.intensity, 0)} · {e.cause?.event_type?.replace(/_/g, ' ') || '衰减中'}</span>
                              </div>
                            ))}
                          </div>
                        </section>

                        <section className="panel p-5">
                          <h2 className="section-title">管理</h2>
                          <div className="mt-3 flex flex-wrap gap-2">
                            <Button size="sm" variant="danger" onClick={() => void act('reset')} loading={busy === 'reset'} icon={<Trash2 size={12} />}>重置本群状态</Button>
                            <Button size="sm" variant="secondary" onClick={() => void act('freeze')} loading={busy === 'freeze'} icon={<Snowflake size={12} />}>{state?.expression_frozen ? '解冻情绪外显' : '冻结情绪外显'}</Button>
                          </div>
                          <p className="mt-3 text-[10.5px] leading-relaxed text-ink-3">shadow 开关在配置中心 → 自我状态。误判标记与单事件重评在日志时间线的 ss_event 详情。</p>
                        </section>
                      </div>

                      <aside className="space-y-4">
                        <section className="panel p-5">
                          <h2 className="section-title">未解决期待（{expectations.length}）</h2>
                          <div className="mt-2 space-y-1.5">
                            {expectations.length === 0 ? <p className="text-[11px] text-ink-3">暂无待回应期待。</p> : expectations.slice(0, 5).map((e: any) => (
                              <div key={e.id} className="text-[11px] text-ink-2">· {e.expectation_type || '期待'} → {e.target_user_id || '任何人'} <span className="text-ink-3">· {e.expires_at ? fmtDate(e.expires_at) : '—'} 到期</span></div>
                            ))}
                          </div>
                        </section>
                        <section className="panel p-5">
                          <h2 className="section-title">未解决心事（{concerns.length}）</h2>
                          <div className="mt-2 space-y-1.5">
                            {concerns.length === 0 ? <p className="text-[11px] text-ink-3">暂无未决心事。</p> : concerns.slice(0, 5).map((c: any) => (
                              <div key={c.id} className="text-[11px] text-ink-2">· <b>{CONCERN_ZH[c.concern_type] || c.concern_type}</b> → {c.target_user_id || '—'}：{String(c.summary || '').slice(0, 48)}</div>
                            ))}
                          </div>
                        </section>
                        <section className="panel p-5">
                          <h2 className="section-title">最近反思（{reflections.length}）</h2>
                          <div className="mt-2 space-y-1.5">
                            {reflections.length === 0 ? <p className="text-[11px] text-ink-3">暂无反思叙事。</p> : reflections.slice(0, 3).map((r: any) => <div key={r.id} className="text-[11px] text-ink-2">· {String(r.summary || '').slice(0, 70)}</div>)}
                          </div>
                        </section>
                      </aside>
                    </div>
                  )
          ) : (
            <section className="panel overflow-hidden">
              <div className="flex items-center justify-between gap-2 border-b border-line-soft px-5 py-4">
                <div><h2 className="section-title">关系情感</h2><p className="mt-0.5 text-[10.5px] text-ink-3">管理员调试视图，不向普通群友公开</p></div>
                <span className="text-[10px] text-ink-3">{rels.length} 个成员</span>
              </div>
              {relations.loading && !relations.data ? <div className="space-y-2 p-4">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-10" />)}</div>
                : rels.length === 0 ? <EmptyState icon={<Brain />} title="暂无关系情感数据">需要开启 SelfState 并有互动积累。</EmptyState>
                  : (
                    <div className="table-wrap">
                      <table className="data">
                        <thead><tr><th>成员</th><th className="num">好感</th><th className="num">感激</th><th className="num">受伤</th><th className="num">怨气</th><th className="num">失望</th><th className="num">戒备</th><th className="num">未决</th><th style={{ width: 80 }} /></tr></thead>
                        <tbody>
                          {rels.map((r) => (
                            <tr key={r.user_id}>
                              <td><span className="mono text-[10.5px]">{r.user_id}</span></td>
                              <td className="num">{pct(r.affinity, 0)}</td>
                              <td className="num">{pct(r.gratitude, 0)}</td>
                              <td className="num">{pct(r.hurt, 0)}</td>
                              <td className="num">{num(r.resentment) > 0.3 ? <Tag tone="coral">{pct(r.resentment, 0)}</Tag> : pct(r.resentment, 0)}</td>
                              <td className="num">{pct(r.disappointment, 0)}</td>
                              <td className="num">{pct(r.guardedness, 0)}</td>
                              <td className="num">{r.unresolved_event_count ?? 0}</td>
                              <td><button className="text-[10px] text-lagoon hover:underline" onClick={() => void act('clear', r.user_id)}>清除残留</button></td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
            </section>
          )}
        </>
      )}
    </div>
  )
}
