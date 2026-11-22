import { useEffect, useMemo, useState } from 'react'
import { CalendarClock, Check, Clock3, MessageSquare, Plus, RefreshCw, Trash2, UsersRound } from 'lucide-react'
import { api } from '@/lib/api'
import { useAsync, useReloadEvent } from '@/lib/hooks'
import { fmtDate, fmtUntil } from '@/lib/format'
import { Button, EmptyState, ErrorState, Field, Input, PageHeader, Segmented, Select, Textarea } from '@/components/ui'
import { Dialog, Drawer, useConfirm, useToast } from '@/components/Overlay'

type Job = {
  id: string; type?: 'task' | 'reminder'; message?: string; prompt?: string; at?: number; cron?: string;
  groupId?: string | null; selfId?: string; createdAt?: number
}

export function SchedulePage() {
  const toast = useToast()
  const confirm = useConfirm()
  const config = useAsync(() => api.get('/config'), [])
  const jobsRes = useAsync(() => api.get('/schedule'), [])
  const [now, setNow] = useState(Date.now())
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [tick, setTick] = useState(0)
  const [form, setForm] = useState({ type: 'reminder' as 'reminder' | 'task', message: '', groupId: '', inHours: 2, when: '', prompt: '' })

  useEffect(() => {
    const t = window.setInterval(() => { setNow(Date.now()); setTick((n) => n + 1) }, 1000)
    return () => window.clearInterval(t)
  }, [])
  useReloadEvent(() => void jobsRes.reload())

  const ownerId = String(config.data?.masters?.[0] ?? '').trim()
  const jobs = useMemo(() => {
    void tick
    return ((jobsRes.data || []) as Job[]).slice().sort((a, b) => {
      if (a.type === 'task' && b.type !== 'task') return -1
      if (a.type !== 'task' && b.type === 'task') return 1
      if (a.type === 'task') return Number(a.createdAt || 0) - Number(b.createdAt || 0)
      return Number(a.at || 0) - Number(b.at || 0)
    })
  }, [jobsRes.data, tick])
  const nextJob = useMemo(() => jobs.filter((j) => j.type !== 'task' && Number(j.at) > now).sort((a, b) => Number(a.at) - Number(b.at))[0] || null, [jobs, now])
  const taskCount = jobs.filter((j) => j.type === 'task').length
  const reminderCount = jobs.length - taskCount

  const create = async () => {
    if (!ownerId) { toast('未取到主人 QQ（配置中心 · 主人列表为空），无法创建任务', 'warn'); return }
    const body: any = { userId: ownerId, groupId: form.groupId.trim() || null }
    if (form.type === 'task') {
      if (!form.when.trim() || !form.prompt.trim()) { toast('任务链需要时间 + 任务描述', 'warn'); return }
      Object.assign(body, { type: 'task', when: form.when.trim(), prompt: form.prompt.trim() })
    } else {
      const hours = Number(form.inHours)
      if (!form.message.trim()) { toast('请填写提醒内容', 'warn'); return }
      if (!Number.isFinite(hours) || hours <= 0) { toast('「N 小时后触发」需填大于 0 的数字', 'warn'); return }
      Object.assign(body, { message: form.message.trim(), at: Date.now() + hours * 3600e3 })
    }
    setBusy(true)
    try {
      await api.post('/schedule', body)
      await jobsRes.reload()
      setOpen(false)
      setForm((f) => ({ ...f, message: '', prompt: '', when: '' }))
      toast(form.type === 'task' ? '定时任务已创建（到点运行 Agent + 发结果）' : '提醒已创建', 'success')
    } catch (e: any) { toast(e?.message || '创建失败', 'error') }
    finally { setBusy(false) }
  }

  const remove = async (j: Job) => {
    const ok = await confirm({
      title: '取消这个定时任务？',
      message: <span>将删除 <b>{j.type === 'task' ? j.prompt || '周期任务' : j.message || '提醒'}</b>。取消后不可恢复。</span>,
      confirmText: '取消任务', danger: true,
    })
    if (!ok) return
    try {
      await api.del(`/schedule/${encodeURIComponent(j.id)}`)
      await jobsRes.reload()
      toast('已取消该任务', 'info')
    } catch (e: any) { toast(e?.message || '取消失败', 'error') }
  }

  return (
    <div className="page">
      <PageHeader
        title="定时任务"
        description="一次性提醒到点发送消息；cron 任务链到点运行 Agent 并发送结果。时间支持自然语言：每天 8 点、每 2 小时、工作日 9 点。"
        actions={(
          <>
            <Button variant="secondary" size="sm" onClick={() => void jobsRes.reload()} icon={<RefreshCw size={14} />}>刷新</Button>
            <Button variant="primary" size="sm" onClick={() => setOpen(true)} icon={<Plus size={14} />} disabled={!ownerId}>新建任务</Button>
          </>
        )}
        meta={<><span>归属 {ownerId || '未取到主人 QQ'}</span><span className="h-3 w-px bg-ink/10" /><span>服务器本地时区</span></>}
      />

      {jobsRes.error && <div className="mb-4"><ErrorState message={jobsRes.error} onRetry={() => void jobsRes.reload()} /></div>}
      {!ownerId && !config.loading && (
        <div className="mb-4 rounded-xl border border-amber/20 bg-amber-soft/70 px-4 py-3 text-[11.5px] text-amber">
          配置中心的主人列表为空。没有真实主人 QQ 时无法创建任务，避免到点投递失败。
        </div>
      )}

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_320px]">
        <section className="panel" aria-labelledby="schedule-title">
          <div className="flex items-center justify-between border-b border-line-soft px-5 py-4">
            <div>
              <h2 id="schedule-title" className="section-title">时间线</h2>
              <p className="mt-0.5 text-[11.5px] text-ink-3">任务链排在前，其余按触发时间</p>
            </div>
            <Button variant="secondary" size="sm" onClick={() => setOpen(true)} icon={<Plus size={13} />} disabled={!ownerId}>新建</Button>
          </div>
          {jobsRes.loading && !jobsRes.data ? (
            <div className="space-y-2 p-5">{[0, 1, 2].map((i) => <div key={i} className="skeleton h-20" />)}</div>
          ) : jobs.length === 0 ? (
            <EmptyState icon={<CalendarClock />} title="还没有定时任务" action={<Button size="sm" variant="primary" onClick={() => setOpen(true)} disabled={!ownerId}>新建提醒</Button>}>
              新建一条提醒，或让 Agent 定时执行一串动作。
            </EmptyState>
          ) : (
            <ul className="divide-y divide-line-soft px-5">
              {jobs.map((j) => (
                <li key={j.id} className="grid grid-cols-[84px_1px_minmax(0,1fr)_auto] items-start gap-3 py-4">
                  <div className="pt-0.5">
                    <div className="mono text-[12px] font-medium text-lagoon">{j.type === 'task' ? '周期' : fmtUntil(j.at)}</div>
                    <div className="mono mt-1 text-[9.5px] leading-relaxed text-ink-3">{j.type === 'task' ? j.cron : fmtDate(j.at)}</div>
                  </div>
                  <div className="h-full min-h-12 bg-line-soft" />
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="tag tag-lagoon">{j.type === 'task' ? '任务链' : j.groupId ? <><UsersRound size={11} />群 {j.groupId}</> : <><MessageSquare size={11} />私聊</>}</span>
                      <span className="mono text-[10px] text-ink-3">#{j.id}</span>
                    </div>
                    <p className="mt-1.5 line-clamp-2 text-[12px] leading-relaxed text-ink">{j.type === 'task' ? j.prompt : j.message}</p>
                    <div className="mt-1.5 flex flex-wrap gap-3 text-[10px] text-ink-3">
                      <span>bot {j.selfId || '—'}</span>
                      <span>{j.type === 'task' ? '到点运行 Agent' : '到点发送消息'}</span>
                    </div>
                  </div>
                  <Button size="icon" variant="ghost" className="btn-sm text-ink-3 hover:text-coral" onClick={() => void remove(j)} aria-label="取消任务" title="取消任务"><Trash2 size={14} /></Button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <aside className="space-y-4">
          <section className="panel p-5">
            <div className="label">下一件事</div>
            <div className="mt-2 text-[22px] font-semibold tracking-[-0.03em] text-lagoon">{nextJob ? fmtUntil(nextJob.at) : '—'}</div>
            <p className="mt-1 line-clamp-2 text-[11px] text-ink-3">{nextJob ? nextJob.message : '没有待触发的提醒'}</p>
            <div className="mt-4 grid grid-cols-2 gap-3 border-t border-line-soft pt-3">
              <div><div className="text-[10px] text-ink-3">全部安排</div><div className="mono mt-0.5 text-[19px]">{jobs.length}</div></div>
              <div><div className="text-[10px] text-ink-3">任务链 / 提醒</div><div className="mono mt-0.5 text-[19px]">{taskCount} / {reminderCount}</div></div>
            </div>
          </section>
          <section className="panel p-5 text-[11.5px] leading-relaxed text-ink-2">
            <div className="mb-2 flex items-center gap-2 text-[12px] font-medium text-ink"><Clock3 size={14} className="text-lagoon" />执行方式</div>
            <p>任务链到点会运行完整 Agent，再发送结果；一次性提醒只发送静态文本。取消后不可恢复。</p>
          </section>
        </aside>
      </div>

      <Dialog
        open={open}
        onClose={() => !busy && setOpen(false)}
        title="新建定时任务"
        description="时间按服务器本地时区解释。"
        footer={(
          <>
            <Button variant="secondary" onClick={() => setOpen(false)} disabled={busy}>取消</Button>
            <Button variant="primary" onClick={() => void create()} loading={busy} icon={<Check size={13} />} disabled={!ownerId}>创建</Button>
          </>
        )}
      >
        <div className="space-y-4">
          <Segmented
            value={form.type}
            options={[{ value: 'reminder', label: '一次性提醒' }, { value: 'task', label: 'cron 重复任务' }]}
            onChange={(v) => setForm((f) => ({ ...f, type: v }))}
            ariaLabel="任务类型"
          />
          <Field label="目标群（留空为私聊）" hint="群任务会发送到该群；留空则发到主人私聊。">
            <Input value={form.groupId} onChange={(e) => setForm((f) => ({ ...f, groupId: e.target.value }))} placeholder="群号" />
          </Field>
          {form.type === 'task' ? (
            <>
              <Field label="时间（自然语言）" hint="例如：每天 8 点 / 每 2 小时 / 工作日 9 点 / 每周一 8:30">
                <Input value={form.when} onChange={(e) => setForm((f) => ({ ...f, when: e.target.value }))} placeholder="每天 8 点" />
              </Field>
              <Field label="任务描述">
                <Textarea value={form.prompt} onChange={(e) => setForm((f) => ({ ...f, prompt: e.target.value }))} placeholder="例如：搜索今日 AI 资讯，总结 5 条" />
              </Field>
            </>
          ) : (
            <>
              <Field label="提醒内容">
                <Textarea value={form.message} onChange={(e) => setForm((f) => ({ ...f, message: e.target.value }))} placeholder="到点发送的文本" />
              </Field>
              <Field label="多少小时后触发" hint="必须大于 0；留空或 0 会立即触发，因此会被拒绝。">
                <Input type="number" min={1} value={form.inHours} onChange={(e) => setForm((f) => ({ ...f, inHours: Number(e.target.value) }))} />
              </Field>
            </>
          )}
          <p className="text-[10.5px] text-ink-3">归属：<span className="mono">{ownerId || '未取到主人 QQ'}</span></p>
        </div>
      </Dialog>
    </div>
  )
}
