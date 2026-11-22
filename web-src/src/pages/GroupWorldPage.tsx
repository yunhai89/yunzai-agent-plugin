import { useEffect, useMemo, useState } from 'react'
import { Database, Globe2, RefreshCw, UsersRound } from 'lucide-react'
import { api } from '@/lib/api'
import { useAsync } from '@/lib/hooks'
import { useAgentConfig, CfgSection, CfgRow, SaveBar, Note, SubHead } from '@/lib/config'
import { Button, EmptyState, ErrorState, Input, PageHeader, Select, Skeleton, Switch, Tag, TagEditor } from '@/components/ui'
import { Dialog, Drawer, useToast } from '@/components/Overlay'
import { fmtDate, num, pct } from '@/lib/format'
import { cn } from '@/lib/cn'

const DEFAULTS = {
  enabled: false, groups: [] as string[], online: false,
  ingestion: { rawMessageRetentionDays: 30, segmentIdleSeconds: 300, segmentMaxMessages: 100, ignoreCommandMessages: true, topicShiftEnabled: true, topicShiftWindow: 6, topicShiftSimThreshold: 0.06 },
  analysis: { schedule: '7 * * * *', minSegmentMessages: 4, maxSegmentsPerRun: 50, modelProfile: '', maxDailyCallsPerGroup: 100, retryCount: 1, maxTokens: 1200, episodeMergeSim: 0.85 },
  profiles: { hotActiveDays30d: 10, warmMessageCount30d: 5, minOnlineConfidence: 0.55, maxTraitsPerUser: 5, traitMergeSimThreshold: 0.82 },
  graph: { activeEdgeDays: 90, maxNeighborsPerUser: 40, weeklyCommunityDetection: true, minCommunitySize: 3 },
  retrieval: { plannerTokenBudget: 800, replyerTokenBudget: 500, maxEpisodes: 3, maxRelationships: 5, cacheTtlSeconds: 60 },
  privacy: { allowUserOptOut: true, allowUserInspect: true, allowUserCorrect: true, blockSensitiveInference: true },
}
const TIER: Record<string, { name: string; tone: 'lagoon' | 'amber' | 'neutral' }> = {
  hot: { name: '常驻', tone: 'lagoon' }, warm: { name: '偶尔', tone: 'amber' }, cold: { name: '潜水', tone: 'neutral' }, archived: { name: '已离开', tone: 'neutral' },
}
const NUM = (v: any) => v === '' ? '' : Number(v)

export function GroupWorldPage() {
  const toast = useToast()
  const { form, field, dirty, save, reset, ready } = useAgentConfig('groupWorld', DEFAULTS)
  const [tab, setTab] = useState<'config' | 'data'>('config')
  const [saving, setSaving] = useState(false)
  const [gid, setGid] = useState('')
  const [sub, setSub] = useState<'members' | 'episodes' | 'communities'>('members')
  const [detail, setDetail] = useState<any>(null)
  const dataGroups = (form.groups || []).map(String)

  const stats = useAsync(() => gid ? api.get('/groupworld/stats', { groupId: gid }) : Promise.resolve(null), [gid])
  const members = useAsync(() => gid ? api.get('/groupworld/members', { groupId: gid, limit: 300 }) : Promise.resolve([]), [gid])
  const episodes = useAsync(() => gid ? api.get('/groupworld/episodes', { groupId: gid }) : Promise.resolve([]), [gid])
  const communities = useAsync(() => gid ? api.get('/groupworld/communities', { groupId: gid }) : Promise.resolve([]), [gid])

  useEffect(() => { if (!gid && dataGroups.length) setGid(dataGroups[0]) }, [dataGroups, gid])
  useEffect(() => { if (tab === 'data' && !gid && dataGroups.length) setGid(dataGroups[0]) }, [tab])

  const doSave = async () => {
    setSaving(true)
    try { await save({ prefix: 'agent.groupWorld' }) }
    catch (e: any) { toast(e?.message || '保存失败', 'error') }
    finally { setSaving(false) }
  }
  const reloadData = () => { void stats.reload(); void members.reload(); void episodes.reload(); void communities.reload() }
  const openProfile = async (userId: string) => {
    try { setDetail(await api.get('/groupworld/profile', { groupId: gid, userId })) }
    catch (e: any) { toast(e?.message || '读取画像失败', 'error') }
  }

  const memberList = (members.data || []) as any[]
  const episodeList = (episodes.data || []) as any[]
  const communityList = (communities.data || []) as any[]
  const stat = stats.data
  const dataError = stats.error || members.error || episodes.error || communities.error

  return (
    <div className="page">
      <PageHeader
        title="群聊小世界"
        description="群聊社会记忆层：画像 / 关系 / 事件 / 圈子。默认只观测，不开在线注入；数据按群隔离。"
        actions={(
          <div className="segmented" role="group" aria-label="视图">
            <button aria-pressed={tab === 'config'} onClick={() => setTab('config')}>配置</button>
            <button aria-pressed={tab === 'data'} onClick={() => setTab('data')}>数据浏览</button>
          </div>
        )}
        meta={<><span>{dataGroups.length} 个白名单群</span><span className="h-3 w-px bg-ink/10" /><span>在线注入默认关闭</span></>}
      />

      {tab === 'config' ? (
        <div className="space-y-4">
          <Note tone="neutral">观察优先：先把群加入白名单，积累数据；确认质量后再开「在线注入」。总开关关闭时不会摄入任何消息。</Note>
          {form.enabled && dataGroups.length === 0 && <Note tone="coral">总开关已开，但白名单为空 —— 不会在任何群生效。</Note>}
          {form.online && !form.enabled && <Note tone="coral">online 已开但总开关未开 —— 在线注入不会生效。</Note>}

          <CfgSection id="gw-main" title="总开关 / 白名单" icon={<Globe2 size={15} />} defaultOpen>
            <CfgRow label="启用 GroupWorld"><Switch checked={!!form.enabled} onChange={(v) => field('enabled', v)} label="启用 GroupWorld" /></CfgRow>
            <CfgRow label="在线注入 Planner / Replyer" hint="默认关：开=注入伪人决策与回复；关=仅观测。" danger><Switch checked={!!form.online} onChange={(v) => field('online', v)} label="在线注入" /></CfgRow>
            <CfgRow label="白名单群" full><TagEditor value={form.groups || []} onChange={(v) => field('groups', v)} placeholder="群号回车" mono /></CfgRow>
          </CfgSection>

          <CfgSection id="gw-ingest" title="摄入 / 会话切片" icon={<Database size={15} />}>
            <CfgRow label="原始消息保留（天）"><Input className="w-[120px]" type="number" min={1} max={365} value={form.ingestion?.rawMessageRetentionDays ?? ''} onChange={(e) => field('ingestion.rawMessageRetentionDays', NUM(e.target.value))} /></CfgRow>
            <CfgRow label="切片静默阈值（秒）"><Input className="w-[120px]" type="number" min={60} max={1800} value={form.ingestion?.segmentIdleSeconds ?? ''} onChange={(e) => field('ingestion.segmentIdleSeconds', NUM(e.target.value))} /></CfgRow>
            <CfgRow label="单片段最大消息数"><Input className="w-[120px]" type="number" min={20} max={200} value={form.ingestion?.segmentMaxMessages ?? ''} onChange={(e) => field('ingestion.segmentMaxMessages', NUM(e.target.value))} /></CfgRow>
            <CfgRow label="忽略 # 指令消息"><Switch checked={!!form.ingestion?.ignoreCommandMessages} onChange={(v) => field('ingestion.ignoreCommandMessages', v)} label="忽略命令消息" /></CfgRow>
            <CfgRow label="主题漂移切分"><Switch checked={!!form.ingestion?.topicShiftEnabled} onChange={(v) => field('ingestion.topicShiftEnabled', v)} label="主题漂移切分" /></CfgRow>
            <CfgRow label="漂移比较近窗"><Input className="w-[120px]" type="number" min={2} max={30} value={form.ingestion?.topicShiftWindow ?? ''} onChange={(e) => field('ingestion.topicShiftWindow', NUM(e.target.value))} /></CfgRow>
            <CfgRow label="漂移相似度阈值"><Input className="w-[120px]" type="number" min={0} max={0.5} step={0.01} value={form.ingestion?.topicShiftSimThreshold ?? ''} onChange={(e) => field('ingestion.topicShiftSimThreshold', NUM(e.target.value))} /></CfgRow>
          </CfgSection>

          <CfgSection id="gw-analysis" title="分析 / 预算">
            <CfgRow label="分析 cron"><Input className="mono w-[180px]" value={form.analysis?.schedule || ''} onChange={(e) => field('analysis.schedule', e.target.value)} placeholder="7 * * * *" /></CfgRow>
            <CfgRow label="片段最小有效消息数"><Input className="w-[120px]" type="number" min={1} max={50} value={form.analysis?.minSegmentMessages ?? ''} onChange={(e) => field('analysis.minSegmentMessages', NUM(e.target.value))} /></CfgRow>
            <CfgRow label="每轮最多片段数"><Input className="w-[120px]" type="number" min={1} max={500} value={form.analysis?.maxSegmentsPerRun ?? ''} onChange={(e) => field('analysis.maxSegmentsPerRun', NUM(e.target.value))} /></CfgRow>
            <CfgRow label="分析模型"><span className="mono text-[11px] text-ink-2">{form.analysis?.modelProfile || '（留空=主模型）'}</span></CfgRow>
            <CfgRow label="每群每日调用预算"><Input className="w-[120px]" type="number" min={0} max={10000} value={form.analysis?.maxDailyCallsPerGroup ?? ''} onChange={(e) => field('analysis.maxDailyCallsPerGroup', NUM(e.target.value))} /></CfgRow>
            <CfgRow label="非法 JSON 重试次数"><Input className="w-[120px]" type="number" min={0} max={5} value={form.analysis?.retryCount ?? ''} onChange={(e) => field('analysis.retryCount', NUM(e.target.value))} /></CfgRow>
            <CfgRow label="maxTokens"><Input className="w-[120px]" type="number" min={256} value={form.analysis?.maxTokens ?? ''} onChange={(e) => field('analysis.maxTokens', NUM(e.target.value))} /></CfgRow>
            <CfgRow label="事件语义去重阈值"><Input className="w-[120px]" type="number" min={0.5} max={1} step={0.01} value={form.analysis?.episodeMergeSim ?? ''} onChange={(e) => field('analysis.episodeMergeSim', NUM(e.target.value))} /></CfgRow>
          </CfgSection>

          <CfgSection id="gw-graph" title="画像 / 关系图" icon={<UsersRound size={15} />}>
            <CfgRow label="hot 活跃天数（30d）"><Input className="w-[120px]" type="number" min={1} max={30} value={form.profiles?.hotActiveDays30d ?? ''} onChange={(e) => field('profiles.hotActiveDays30d', NUM(e.target.value))} /></CfgRow>
            <CfgRow label="warm 发言数（30d）"><Input className="w-[120px]" type="number" min={1} value={form.profiles?.warmMessageCount30d ?? ''} onChange={(e) => field('profiles.warmMessageCount30d', NUM(e.target.value))} /></CfgRow>
            <CfgRow label="在线最低置信度" danger><Input className="w-[120px]" type="number" min={0.55} max={0.99} step={0.01} value={form.profiles?.minOnlineConfidence ?? ''} onChange={(e) => field('profiles.minOnlineConfidence', NUM(e.target.value))} /></CfgRow>
            <CfgRow label="每成员画像上限"><Input className="w-[120px]" type="number" min={1} max={20} value={form.profiles?.maxTraitsPerUser ?? ''} onChange={(e) => field('profiles.maxTraitsPerUser', NUM(e.target.value))} /></CfgRow>
            <CfgRow label="近义特征合并阈值"><Input className="w-[120px]" type="number" min={0.5} max={1} step={0.01} value={form.profiles?.traitMergeSimThreshold ?? ''} onChange={(e) => field('profiles.traitMergeSimThreshold', NUM(e.target.value))} /></CfgRow>
            <CfgRow label="关系边活跃窗口（天）"><Input className="w-[120px]" type="number" min={7} max={365} value={form.graph?.activeEdgeDays ?? ''} onChange={(e) => field('graph.activeEdgeDays', NUM(e.target.value))} /></CfgRow>
            <CfgRow label="每成员一跳关系上限"><Input className="w-[120px]" type="number" min={0} max={200} value={form.graph?.maxNeighborsPerUser ?? ''} onChange={(e) => field('graph.maxNeighborsPerUser', NUM(e.target.value))} /></CfgRow>
            <CfgRow label="每周小圈子识别"><Switch checked={!!form.graph?.weeklyCommunityDetection} onChange={(v) => field('graph.weeklyCommunityDetection', v)} label="每周小圈子识别" /></CfgRow>
            <CfgRow label="最小圈子人数"><Input className="w-[120px]" type="number" min={2} max={20} value={form.graph?.minCommunitySize ?? ''} onChange={(e) => field('graph.minCommunitySize', NUM(e.target.value))} /></CfgRow>
          </CfgSection>

          <CfgSection id="gw-privacy" title="在线检索 / 隐私">
            <SubHead>在线检索预算</SubHead>
            {([['retrieval.plannerTokenBudget', 'Planner token 预算', 100], ['retrieval.replyerTokenBudget', 'Replyer token 预算', 100], ['retrieval.maxEpisodes', '在线返回旧事上限', 0], ['retrieval.maxRelationships', '在线返回关系上限', 0]] as const).map(([k, label, min]) => (
              <CfgRow key={k} label={label}><Input className="w-[120px]" type="number" min={min} value={(form as any)?.[k.split('.')[0]]?.[k.split('.')[1]] ?? ''} onChange={(e) => field(k, NUM(e.target.value))} /></CfgRow>
            ))}
            <CfgRow label="允许查看画像"><Switch checked={!!form.privacy?.allowUserInspect} onChange={(v) => field('privacy.allowUserInspect', v)} label="允许查看画像" /></CfgRow>
            <CfgRow label="允许纠正画像"><Switch checked={!!form.privacy?.allowUserCorrect} onChange={(v) => field('privacy.allowUserCorrect', v)} label="允许纠正画像" /></CfgRow>
            <CfgRow label="允许退出建模"><Switch checked={!!form.privacy?.allowUserOptOut} onChange={(v) => field('privacy.allowUserOptOut', v)} label="允许退出建模" /></CfgRow>
            <CfgRow label="拦截敏感推断" danger><Switch checked={!!form.privacy?.blockSensitiveInference} onChange={(v) => field('privacy.blockSensitiveInference', v)} label="拦截敏感推断" /></CfgRow>
          </CfgSection>
        </div>
      ) : (
        <div>
          {dataGroups.length === 0 ? <Note tone="amber">白名单为空 —— 先在「配置」加入群号并保存，才会有数据。</Note> : (
            <>
              <div className="toolbar">
                <Select value={gid} onChange={(e) => setGid(e.target.value)} aria-label="群" className="w-[180px]">{dataGroups.map((g) => <option key={g} value={g}>群 {g}</option>)}</Select>
                <Button variant="secondary" size="sm" onClick={reloadData} icon={<RefreshCw size={13} />}>刷新</Button>
                {stat?.ready === false && <Tag tone="coral">GroupWorld 未就绪（sqlite3 未装？）</Tag>}
              </div>
              {dataError && <div className="mb-3"><ErrorState message={dataError} onRetry={reloadData} /></div>}
              {stat && stat.ready !== false && (
                <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
                  {[
                    ['成员', stat.members, `hot ${stat.hotMembers ?? 0}`], ['特征', stat.traits, ''], ['关系边', stat.edges, ''],
                    ['事件 / 群梗', stat.episodes, ''], ['小圈子', stat.communities, ''], ['今日调用', stat.cursor?.daily_calls_today ?? 0, `待分析 ${stat.pendingSegments ?? 0}`],
                  ].map(([k, v, s]) => (
                    <div key={String(k)} className="panel px-4 py-3"><div className="text-[10px] text-ink-3">{k}</div><div className="mono mt-1 text-[20px] font-medium">{v ?? 0}</div>{s && <div className="text-[9.5px] text-ink-3">{s}</div>}</div>
                  ))}
                </div>
              )}
              <div className="mb-3 flex flex-wrap gap-1.5">
                {[{ k: 'members', label: `成员 (${memberList.length})` }, { k: 'episodes', label: `事件 / 群梗 (${episodeList.length})` }, { k: 'communities', label: `小圈子 (${communityList.length})` }].map((o) => (
                  <button key={o.k} className={cn('tag', sub === o.k ? 'tag-lagoon' : 'tag-neutral')} onClick={() => setSub(o.k as any)}>{o.label}</button>
                ))}
              </div>
              <section className="panel overflow-hidden">
                {sub === 'members' && (
                  <div className="table-wrap">
                    <table className="data">
                      <thead><tr><th>昵称</th><th>分层</th><th className="num">30 天</th><th className="num">活跃天</th><th>最后发言</th><th style={{ width: 70 }} /></tr></thead>
                      <tbody>{memberList.length === 0 ? <tr><td colSpan={6} className="py-8 text-center text-[11px] text-ink-3">{members.loading ? '加载中…' : members.error ? `成员读取失败：${members.error}` : '暂无成员数据（需开启并在该群有对话积累）'}</td></tr> : memberList.map((m) => (
                        <tr key={m.user_id}>
                          <td><div className="text-[11.5px]">{m.current_nickname || m.user_id}</div><div className="mono text-[9px] text-ink-3">{String(m.user_id).slice(-8)}</div></td>
                          <td><Tag tone={TIER[m.activity_tier]?.tone || 'neutral'}>{TIER[m.activity_tier]?.name || m.activity_tier || '—'}</Tag></td>
                          <td className="num">{m.message_count_30d ?? 0}</td>
                          <td className="num">{m.active_days_30d ?? 0}</td>
                          <td className="text-[10px] text-ink-3">{m.last_spoke_at ? fmtDate(m.last_spoke_at) : '—'}</td>
                          <td><button className="text-[10px] text-lagoon hover:underline" onClick={() => void openProfile(m.user_id)}>画像</button></td>
                        </tr>
                      ))}</tbody>
                    </table>
                  </div>
                )}
                {sub === 'episodes' && (episodes.loading ? <div className="p-5 text-center text-[11px] text-ink-3">加载中…</div> : episodes.error ? <div className="p-5 text-[11px] text-coral">读取事件失败：{episodes.error}</div> : episodeList.length === 0 ? <EmptyState icon={<Globe2 />} title="暂无事件 / 群梗">由小时分析从对话中抽取。</EmptyState> : (
                  <ul className="divide-y divide-line-soft px-5">{episodeList.map((e) => (
                    <li key={e.id} className="py-3.5">
                      <div className="flex flex-wrap items-center gap-1.5"><Tag tone="lagoon">{e.episode_type || '事件'}</Tag><span className="text-[12px] font-medium">{e.title || '—'}</span><span className="text-[10px] text-ink-3">重要度 {pct(e.importance, 0)} · 可信 {pct(e.confidence, 0)}</span></div>
                      <p className="mt-1 text-[11px] leading-relaxed text-ink-2">{e.summary || '—'}</p>
                      <div className="mt-1 text-[9.5px] text-ink-4">{fmtDate(e.occurred_at)} · 参与 {(e.participant_ids || []).length} 人</div>
                    </li>
                  ))}</ul>
                ))}
                {sub === 'communities' && (communities.loading ? <div className="p-5 text-center text-[11px] text-ink-3">加载中…</div> : communities.error ? <div className="p-5 text-[11px] text-coral">读取小圈子失败：{communities.error}</div> : communityList.length === 0 ? <EmptyState icon={<Globe2 />} title="暂无小圈子">每周聚类自动产出；需要开启每周识别并有足够互动。</EmptyState> : (
                  <ul className="divide-y divide-line-soft px-5">{communityList.map((c) => (
                    <li key={c.id} className="py-3.5">
                      <div className="flex flex-wrap items-center gap-1.5"><Tag tone="amber">{(c.member_ids || []).length} 人圈</Tag><span className="mono text-[9.5px] text-ink-3">{c.algorithm || '—'}</span><span className="text-[10px] text-ink-3">可信 {pct(c.confidence, 0)}</span></div>
                      <p className="mt-1 text-[11px] leading-relaxed text-ink-2">{c.summary || '—'}</p>
                      <div className="mt-1 flex flex-wrap gap-1">{(c.topic_tags || []).map((t: string) => <Tag key={t} tone="neutral">{t}</Tag>)}</div>
                    </li>
                  ))}</ul>
                ))}
              </section>
            </>
          )}
        </div>
      )}

      <SaveBar dirty={dirty} onReset={reset} onSave={() => void doSave()} busy={saving} />

      <Drawer open={!!detail} onClose={() => setDetail(null)} title="成员画像" width={620} footer={<Button variant="secondary" onClick={() => setDetail(null)}>关闭</Button>}>
        {detail && (
          <div className="space-y-4">
            <div className="rounded-lg border border-line-soft bg-white/40 p-3">
              <div className="text-[12px] font-medium">{detail.profile?.current_nickname || detail.profile?.user_id}</div>
              <div className="mt-0.5 text-[10px] text-ink-3">分层 {TIER[detail.profile?.activity_tier]?.name || '—'} · 30 天 {detail.profile?.message_count_30d ?? 0} 条 / {detail.profile?.active_days_30d ?? 0} 天</div>
            </div>
            <section><h3 className="mb-2 text-[11px] font-medium">画像特征（{(detail.traits || []).length}）</h3>{(detail.traits || []).length === 0 ? <p className="text-[11px] text-ink-3">暂无特征。</p> : <div className="space-y-2">{(detail.traits || []).map((t: any) => (
              <div key={t.id} className="rounded-lg border border-line-soft bg-white/35 p-2.5">
                <div className="flex flex-wrap items-center gap-1.5"><Tag tone="lagoon">{t.trait_type || '特征'}</Tag><Tag tone="neutral">{t.source_type || t.source || '—'}</Tag><span className="text-[9.5px] text-ink-3">可信 {pct(t.confidence, 0)} · 证据 {t.evidence_count ?? (detail.evidByTrait?.[t.id] || []).length}</span></div>
                <p className="mt-1 text-[11px] text-ink-2">{t.trait_value ?? t.value ?? '—'}</p>
                {!!(detail.evidByTrait?.[t.id] || []).length && <details className="mt-1"><summary className="cursor-pointer text-[9.5px] text-ink-3">证据</summary>{(detail.evidByTrait[t.id] || []).map((ev: any, i: number) => <p key={i} className="mt-1 text-[10px] text-ink-3">· {ev.evidence_text} <span className="mono">[#{ev.message_id}]</span></p>)}</details>}
              </div>
            ))}</div>}</section>
            <section><h3 className="mb-2 text-[11px] font-medium">与机器人的主观关系</h3>{(detail.botRels || []).length === 0 ? <p className="text-[11px] text-ink-3">暂无。</p> : (detail.botRels || []).map((r: any, i: number) => <p key={i} className="text-[11px] text-ink-2">bot {r.bot_id}：熟悉 {pct(r.familiarity, 0)} · 好感 {pct(r.affinity, 0)} · 信任 {pct(r.trust, 0)} · 互动 {r.interaction_count ?? 0} 次{r.interaction_style ? ` · ${r.interaction_style}` : ''}</p>)}</section>
            <section><h3 className="mb-2 text-[11px] font-medium">一跳关系（{(detail.edges || []).length}）</h3>{(detail.edges || []).length === 0 ? <p className="text-[11px] text-ink-3">暂无。</p> : (detail.edges || []).map((e: any, i: number) => <p key={i} className="text-[11px] text-ink-2">{e.from_user_id} → {e.to_user_id} · 强度 {pct(e.interaction_strength ?? e.weight, 0)}（回复 {e.reply_count_30d ?? e.reply_count ?? 0} / @ {e.mention_count_30d ?? e.mention_count ?? 0}）{e.inferred_relation ? ` · ${e.inferred_relation}` : ''}</p>)}</section>
          </div>
        )}
      </Drawer>
    </div>
  )
}
