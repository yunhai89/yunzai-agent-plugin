import { useEffect, useMemo, useState } from 'react'
import { AlertCircle, ChevronDown, Clock3, ScrollText, Search } from 'lucide-react'
import { api } from '@/lib/api'
import { useAsync, useReloadEvent } from '@/lib/hooks'
import { fmtAgo, fmtNum, fmtTime, num } from '@/lib/format'
import { Button, EmptyState, ErrorState, Field, Input, PageHeader, Select, Skeleton, Tag } from '@/components/ui'
import { cn } from '@/lib/cn'

const EVENT_CN: Record<string, string> = {
  trigger: '收到消息', media: '媒体解析', input: '输入归一化', run_start: 'Agent 启动', turn: 'LLM 往返',
  tool: '工具调用', tool_discovery: '工具发现', reflect: '自检回环', recall_extract: '记忆抽取', run_end: 'Agent 结束',
  reply: '回复投递', error: '异常', skill: '技能匹配', gate_decision: '门控决策', planner_start: 'Planner 启动',
  planner_round: 'Planner 轮次', planner_action: 'Planner 动作', planner_interrupted: '规划中断', planner_stale: '旧代丢弃',
  shadow_reply: 'shadow 回复', delivery: '发送投递', wait: '等待', ignore: '沉默', cooldown_block: '冷却拦截',
  backoff_delay: '退避延迟', gw_ingest: 'GW 摄入', gw_segment: 'GW 分段', gw_analyze: 'GW 分析', gw_trait: 'GW 特征',
  gw_retrieve: 'GW 检索', gw_maint: 'GW 维护', gw_community: 'GW 圈子', gw_privacy: 'GW 隐私', ss_event: 'SS 事件',
  ss_appraise: 'SS 评价', ss_emotion: 'SS 情绪', ss_expectation: 'SS 期待', ss_concern: 'SS 心事', ss_reflection: 'SS 反思',
  ss_maint: 'SS 维护', ss_project: 'SS 投影', ss_privacy: 'SS 控制', diagram: '示意图', jev: 'Jev 判断',
  sandbox: 'E2B 沙箱', thinking_auto: '思考判档', finalize_start: '收尾开始', finalize_end: '收尾完成',
  governor_stop: '循环终止', cache_compact: '上下文压缩', deadline: '预算到点', context_resolved: '上下文预算',
}

function uIn(u: any) { return num(u?.input ?? u?.prompt_tokens ?? u?.input_tokens) }
function uOut(u: any) { return num(u?.output ?? u?.completion_tokens ?? u?.output_tokens) }
function uTotal(u: any) { return num(u?.total ?? u?.total_tokens) || uIn(u) + uOut(u) }

function summary(e: any): string {
  const ev = e?.event
  switch (ev) {
    case 'trigger': return `“${String(e.text || '').slice(0, 80)}” · ${e.isGroup ? `群 ${e.gid}` : '私聊'} · ${e.inputLen ?? 0} 字`
    case 'media': return `${e.files?.length || 0} 个附件${e.files?.length ? '：' + e.files.map((f: any) => f.name).join(', ') : ''}`
    case 'input': return `${e.inputKind || '?'} · vision=${e.caps?.vision} file=${e.caps?.file}`
    case 'run_start': return `${e.model || '?'} · 常驻工具 ${e.toolsSent ?? '?'} 个 ≈${e.toolsTokensEst ?? '?'} tok · maxTurns=${e.maxTurns ?? '?'}`
    case 'turn': return `第 ${e.turn ?? '?'} 轮 · finish=${e.finish || '?'} · ${uIn(e.usage)}+${uOut(e.usage)} tok · ${e.ms ?? '?'}ms`
    case 'tool': return `${e.name || '?'} · ${e.success ? '成功' : '失败'}${e.errorClass ? ' ' + e.errorClass : ''} · ${e.duration ?? e.ms ?? '?'}ms${e.summary ? ' · ' + String(e.summary).slice(0, 80) : ''}`
    case 'run_end': return `${e.turns ?? '?'} 轮 · stop=${e.stopReason || '?'} · 总 ${uTotal(e.usage)} tok · ${e.totalMs ?? '?'}ms`
    case 'reply': return `${e.mode === 'image' ? '图片' : '文本'}模式 · ${e.delivered ? '已送达' : '未送达'} · ${e.replyLen ?? e.body?.length ?? 0} 字`
    case 'error': return String(e.error || '未知错误')
    case 'skill': return `技能匹配 ${e.matched?.length || 0} 个 · 输入「${String(e.input || '').slice(0, 24)}」`
    case 'gate_decision': return `门控 分${e.finalScore ?? '?'}/${e.threshold ?? '?'} ${e.shouldPlan ? '→进 Planner' : '→沉默'} · 批 ${e.batchSize ?? '?'} 条`
    case 'planner_round': return `第 ${e.round ?? '?'} 轮 · ${e.contentLen ?? '?'} 字 · 工具[${(e.toolCalls || []).join(',')}]`
    case 'planner_action': return `${e.action?.type || '?'}${e.action?.target ? ' · 目标#' + String(e.action.target).slice(-6) : ''}${e.action?.reason ? ' · ' + e.action.reason : ''}`
    case 'gw_ingest': return `摄入${e.isNew ? '新' : '重复'} · ${e.msgType || '?'}${e.reply ? ' · 回复' : ''} · ${e.ms ?? '?'}ms`
    case 'gw_analyze': return e.skipped ? `跳过（${e.skipped} · ${e.used ?? '?'}/${e.max ?? '?'}）` : `分析 ${e.analyzed ?? '?'}/${e.pending ?? '?'}${e.failed ? ' · 失败 ' + e.failed : ''}`
    case 'ss_event': return `${e.type || '?'} by ${e.actor || '?'} · 可信 ${e.conf ?? '?'}`
    case 'ss_emotion': return `${e.eventType || '?'} → ${String(e.impulses || '').slice(0, 60)} · base ${e.base ?? '?'}`
    case 'jev': return `${e.kind || 'jev'}${e.confidence != null ? ` conf=${Number(e.confidence).toFixed(2)}` : ''}${e.fallback ? ' · 回退' : ''}${e.ms != null ? ` · ${e.ms}ms` : ''}`
    case 'sandbox': return `exit=${e.exitCode ?? '-'}${e.timedOut ? ' · 超时' : ''}${e.duration != null ? ` · ${e.duration}ms` : ''} $ ${String(e.command || '').slice(0, 50)}`
    case 'thinking_auto': return `depth=${e.depth ?? '?'} by=${e.source ?? '?'} budget=${e.budget ?? '?'}${e.confidence != null ? ` conf=${Number(e.confidence).toFixed(2)}` : ''}`
    case 'finalize_end': return e.ok === false ? `收尾失败：${e.error || ''}` : `收尾完成（${e.via || '?'}）· ${e.contentLen ?? '?'} 字`
    case 'delivery': return e.sent ? `已发 ${e.count || 0} 段` : `未发${e.cancelReason ? ' · ' + e.cancelReason : ''}`
    case 'ignore': return `沉默${e.reason ? ' · ' + e.reason : ''}`
    default: return ''
  }
}

export function LogsPage() {
  const [draft, setDraft] = useState({ from: '', to: '', event: '', q: '' })
  const [applied, setApplied] = useState({ from: '', to: '', event: '', q: '' })
  const filesRes = useAsync(() => api.get('/logs/files', {
    ...(applied.from ? { from: applied.from } : {}),
    ...(applied.to ? { to: applied.to } : {}),
    ...(applied.event ? { event: applied.event } : {}),
    ...(applied.q ? { q: applied.q } : {}),
  }), [applied])
  const files = (filesRes.data?.items || []) as { file: string; label: string }[]
  const total = num(filesRes.data?.total)
  const [file, setFile] = useState('')
  const evRes = useAsync(() => file ? api.get('/logs', { file }) : Promise.resolve({ events: [] }), [file])
  const [traceId, setTraceId] = useState('')
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  useReloadEvent(() => { void filesRes.reload(); if (file) void evRes.reload() })

  useEffect(() => { if (files.length && !files.some((f) => f.file === file)) setFile(files[0].file) }, [files, file])

  const traces = useMemo(() => {
    const map = new Map<string, any[]>()
    for (const e of (evRes.data?.events || [])) {
      const k = e.traceId || 'no-trace'
      if (!map.has(k)) map.set(k, [])
      map.get(k)!.push(e)
    }
    return [...map.entries()].map(([id, events]) => {
      const runEnd = events.find((e) => e.event === 'run_end')
      return {
        id, events,
        time: events[0]?.time,
        hasError: events.some((e) => e.event === 'error'),
        turns: runEnd?.turns ?? '—', totalMs: runEnd?.totalMs, usage: runEnd?.usage,
      }
    })
  }, [evRes.data])

  useEffect(() => { if (traces.length && !traces.some((t) => t.id === traceId)) setTraceId(traces[0].id) }, [traces, traceId])
  const trace = traces.find((t) => t.id === traceId)
  const events = trace?.events || []

  const query = () => setApplied({ from: draft.from, to: draft.to, event: draft.event, q: draft.q.trim() })
  const reset = () => { const empty = { from: '', to: '', event: '', q: '' }; setDraft(empty); setApplied(empty) }

  return (
    <div className="page">
      <PageHeader
        title="日志时间线"
        description="devLog 全链路 · traceId 串联。按文件与事件筛选，展开查看真实请求、工具结果与子系统事件。"
        meta={<><span>命中 {fmtNum(total)} 条文件</span><span className="h-3 w-px bg-ink/10" /><span>默认显示最新 10 个文件</span></>}
      />

      {(filesRes.error || evRes.error) && <div className="mb-4"><ErrorState message={filesRes.error || evRes.error} onRetry={() => { void filesRes.reload(); if (file) void evRes.reload() }} /></div>}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[310px_minmax(0,1fr)]">
        <aside className="panel flex max-h-[calc(100dvh-170px)] flex-col overflow-hidden xl:sticky xl:top-[76px]">
          <div className="border-b border-line-soft px-4 py-3">
            <div className="flex items-center gap-2"><ScrollText size={15} className="text-lagoon" /><span className="section-title">会话日志文件</span></div>
            <p className="mt-0.5 text-[10px] text-ink-3">data/logs/ · 敏感度：高</p>
            <div className="mt-3 space-y-2">
              <div className="grid grid-cols-2 gap-2">
                <Input type="date" value={draft.from} onChange={(e) => setDraft((d) => ({ ...d, from: e.target.value }))} aria-label="起始日期" />
                <Input type="date" value={draft.to} onChange={(e) => setDraft((d) => ({ ...d, to: e.target.value }))} aria-label="结束日期" />
              </div>
              <Select value={draft.event} onChange={(e) => setDraft((d) => ({ ...d, event: e.target.value }))} aria-label="事件类型">
                <option value="">全部事件</option>
                {Object.entries(EVENT_CN).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </Select>
              <Input icon={<Search size={14} />} value={draft.q} onChange={(e) => setDraft((d) => ({ ...d, q: e.target.value }))} placeholder="关键词（时间 / 报错 / 工具名）" aria-label="日志关键词" onKeyDown={(e) => { if (e.key === 'Enter') query() }} />
              <div className="flex gap-2">
                <Button size="sm" variant="primary" onClick={query} icon={<Search size={12} />}>查询</Button>
                <Button size="sm" variant="ghost" onClick={reset}>重置</Button>
              </div>
              <p className="text-[9.5px] text-ink-3">命中 {fmtNum(total)} 条 · 当前显示 {files.length} 条</p>
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {filesRes.loading && !filesRes.data ? <div className="space-y-2 p-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-14" />)}</div>
              : files.length === 0 ? <EmptyState icon={<ScrollText />} title="暂无日志文件">产生对话后，devLog 会写入 data/logs/。</EmptyState>
                : files.map((f) => (
                  <button key={f.file} className={cn('mb-1 w-full rounded-lg px-3 py-2 text-left transition', file === f.file ? 'bg-white/75' : 'hover:bg-white/40')} onClick={() => { setFile(f.file); setExpanded({}) }}>
                    <div className="text-[11.5px] font-medium">{f.label}</div>
                    <div className="mono mt-0.5 truncate text-[9px] text-ink-3">{f.file}</div>
                  </button>
                ))}
          </div>
        </aside>

        <section className="panel flex min-h-[520px] flex-col overflow-hidden">
          <div className="border-b border-line-soft px-4 py-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="section-title">请求链路（traceId）</h2>
                <p className="mono mt-0.5 truncate text-[9.5px] text-ink-3">{trace?.id || '选择一条链路'}</p>
              </div>
              <span className="text-[10px] text-ink-3">{traces.length} 条链路</span>
            </div>
            <div className="mt-2 flex gap-1.5 overflow-x-auto pb-1">
              {traces.map((t) => (
                <button key={t.id} className={cn('flex flex-none items-center gap-1.5 rounded-lg border px-2 py-1.5 text-[10px]', traceId === t.id ? 'border-lagoon/25 bg-lagoon-soft/70 text-lagoon-deep' : 'border-line-soft bg-white/35 text-ink-3 hover:bg-white/60')} onClick={() => setTraceId(t.id)}>
                  {t.hasError ? <AlertCircle size={11} className="text-coral" /> : <Clock3 size={11} />}
                  <span className="mono">{fmtTime(t.time).slice(0, 8)}</span>
                  <span>{t.turns} 轮 · {t.totalMs ? `${(t.totalMs / 1000).toFixed(1)}s` : '—'}</span>
                  {t.usage && <span className="mono">{fmtNum(uTotal(t.usage))} tok</span>}
                </button>
              ))}
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {evRes.loading && !evRes.data ? <div className="space-y-2 p-4">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-12" />)}</div>
              : events.length === 0 ? <EmptyState icon={<ScrollText />} title="请选择一条链路">{file ? '该文件还没有事件记录。' : '先选择一个日志文件。'}</EmptyState>
                : events.map((e, i) => {
                  const key = `${file}:${traceId}:${i}`
                  const open = !!expanded[key]
                  const label = EVENT_CN[e.event] || e.event || '其他'
                  const sum = summary(e)
                  return (
                    <div key={key} className="border-b border-line-soft last:border-0">
                      <button className="flex w-full items-start gap-2.5 px-4 py-2.5 text-left transition hover:bg-white/35" onClick={() => setExpanded((m) => ({ ...m, [key]: !m[key] }))} aria-expanded={open}>
                        <span className={cn('mt-1 h-2 w-2 flex-none rounded-full', e.event === 'error' ? 'bg-coral' : e.event === 'tool' ? 'bg-amber' : 'bg-lagoon')} />
                        <span className="min-w-0 flex-1">
                          <span className="flex flex-wrap items-center gap-1.5">
                            <span className="mono rounded bg-white/55 px-1.5 py-0.5 text-[9px] text-ink-3">{e.event || '—'}</span>
                            <span className="text-[11.5px] font-medium">{label}</span>
                            <span className="text-[10px] text-ink-3">{sum}</span>
                          </span>
                        </span>
                        <span className="mono flex-none text-[9px] text-ink-4">{fmtTime(e.time)}</span>
                        <ChevronDown size={12} className={cn('mt-0.5 flex-none text-ink-4 transition', open && 'rotate-180')} />
                      </button>
                      {open && (
                        <div className="px-4 pb-3 pl-11">
                          {e.event === 'turn' && e.usage && (
                            <div className="mb-2 rounded-md border border-line-soft bg-white/35 px-2.5 py-2 text-[10px] text-ink-2">
                              prompt 缓存命中 <span className="mono">{num(e.usage?.cacheRead ?? e.usage?.prompt_cache_hit_tokens)}/{uIn(e.usage)}</span>
                            </div>
                          )}
                          <pre className="mono max-h-80 overflow-auto whitespace-pre-wrap rounded-lg border border-line-soft bg-white/40 p-2.5 text-[10px] leading-relaxed text-ink-2">{JSON.stringify(e, null, 2)}</pre>
                        </div>
                      )}
                    </div>
                  )
                })}
          </div>
        </section>
      </div>
    </div>
  )
}
