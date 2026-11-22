import { useState } from 'react'
import { Bot, Check, Copy, Link2, PlugZap, Plus, RefreshCw, Trash2, Unplug, X } from 'lucide-react'
import { api } from '@/lib/api'
import { useAsync, useReloadEvent } from '@/lib/hooks'
import { fmtDate } from '@/lib/format'
import { Button, CopyButton, EmptyState, ErrorState, Field, Input, PageHeader, Select, Skeleton, Switch, Tag } from '@/components/ui'
import { Dialog, Drawer, useConfirm, useToast } from '@/components/Overlay'
import { cn } from '@/lib/cn'

const STATUS_CN: Record<string, string> = {
  ready: '已连接', open: '已连接', connecting: '连接中', connecting_retry: '重连中', closed: '已关闭',
  stopped: '已停止', idle: '未连接', auth_failed: '鉴权失败', failed: '连接失败',
}
const statusCn = (a: any) => {
  if (!a) return '未连接'
  if (a.reason === 'auth_failed') return '鉴权失败（检查 AppID / AppSecret）'
  const s = a.status || {}
  return STATUS_CN[s.state] || (s.connected ? '已连接' : s.state || '未连接')
}
const statusTone = (a: any): 'jade' | 'amber' | 'coral' | 'neutral' => {
  const s = a?.status || {}
  if (s.connected || s.state === 'ready' || s.state === 'open') return 'jade'
  if (['connecting', 'connecting_retry'].includes(s.state)) return 'amber'
  if (['auth_failed', 'failed', 'closed'].includes(s.state) || a?.reason === 'auth_failed') return 'coral'
  return 'neutral'
}
const mdCn = (a: any) => a?.markdown === 'false' ? '纯文本' : a?.markdown === 'true' ? '总是 Markdown' : a?.status?.markdownUsable === false ? 'auto（平台未开通→纯文本）' : 'auto'

type Account = { appId: string; name?: string; sandbox?: boolean; intents?: number; markdown?: string; preferMarkdownText?: boolean; hasSecret?: boolean; secretMasked?: string; status?: any }
type Payload = { enable?: boolean; adapterReady?: boolean; accounts?: Account[]; connected?: number; total?: number }

const blank = { appId: '', appSecret: '', name: '', sandbox: false, intents: 0, markdown: 'auto', preferMarkdownText: false }

export function QQBotPage() {
  const toast = useToast()
  const confirm = useConfirm()
  const res = useAsync(() => api.get('/qqbot'), [])
  const [busy, setBusy] = useState('')
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [form, setForm] = useState({ ...blank })
  const [reveal, setReveal] = useState<Record<string, boolean>>({})
  useReloadEvent(() => void res.reload())

  const data: Payload = res.data || {}
  const accounts = data.accounts || []
  const connected = accounts.filter((a) => a.status?.connected || a.status?.state === 'ready' || a.status?.state === 'open').length
  const total = accounts.length

  const openAdd = () => { setForm({ ...blank }); setEditing(null); setFormOpen(true) }
  const openEdit = (a: Account) => {
    setForm({ appId: a.appId, appSecret: '', name: a.name || '', sandbox: !!a.sandbox, intents: Number(a.intents) || 0, markdown: a.markdown || 'auto', preferMarkdownText: !!a.preferMarkdownText })
    setEditing(a.appId); setFormOpen(true)
  }

  const save = async () => {
    if (!/^\d{4,}$/.test(form.appId.trim())) { toast('AppID 应为纯数字（QQ 开放平台 → 开发设置）', 'warn'); return }
    if (!editing && !form.appSecret.trim()) { toast('新增账号必须填 AppSecret', 'warn'); return }
    setBusy('save')
    try {
      const body = { ...form, appId: form.appId.trim(), appSecret: form.appSecret.trim(), name: form.name.trim(), intents: Number(form.intents) || 0 }
      const r = editing
        ? await api.put(`/qqbot/accounts/${encodeURIComponent(editing)}`, body)
        : await api.post('/qqbot/accounts', body)
      res.setData(r)
      toast(editing ? '账号已更新并重连' : '账号已添加，正在连接…', 'success')
      setFormOpen(false)
      window.setTimeout(() => void res.reload(), 1500)
    } catch (e: any) { toast(e?.message || '保存失败', 'error') }
    finally { setBusy('') }
  }

  const act = async (a: Account, kind: 'connect' | 'disconnect' | 'remove') => {
    if (kind === 'disconnect') {
      const ok = await confirm({ title: `断开 ${a.name || a.appId}？`, message: '断开后该机器人收不到消息，可随时重连。', confirmText: '断开连接' })
      if (!ok) return
    }
    if (kind === 'remove') {
      const ok = await confirm({ title: `删除 ${a.name || a.appId}？`, message: '将从配置删除账号并断开连接，AppSecret 一并删除，不可恢复。', confirmText: '删除账号', danger: true })
      if (!ok) return
    }
    setBusy(`${kind}:${a.appId}`)
    try {
      const r = kind === 'remove'
        ? await api.del(`/qqbot/accounts/${encodeURIComponent(a.appId)}`)
        : await api.post(`/qqbot/accounts/${encodeURIComponent(a.appId)}/${kind}`)
      res.setData(r)
      toast(kind === 'connect' ? '已发起连接' : kind === 'disconnect' ? '已断开' : '已删除账号', kind === 'remove' ? 'info' : 'success')
      window.setTimeout(() => void res.reload(), 1200)
    } catch (e: any) { toast(e?.message || '操作失败', 'error') }
    finally { setBusy('') }
  }

  const reloadAll = async () => {
    setBusy('reload')
    try {
      const r = await api.post('/qqbot/reload')
      res.setData(r)
      toast('已重连全部账号', 'success')
    } catch (e: any) { toast(e?.message || '重连失败', 'error') }
    finally { setBusy('') }
  }

  return (
    <div className="page">
      <PageHeader
        title="QQ 官方机器人账号"
        description="自实现适配器：只需 AppID + AppSecret 直连官方网关，无需机器人 QQ 号与 Token。与 Yunzai-QQBot-Plugin 二选一，否则同一条机器人会重复收发。"
        actions={(
          <>
            <Button variant="secondary" size="sm" onClick={() => void res.reload()} icon={<RefreshCw size={14} />}>刷新状态</Button>
            <Button variant="secondary" size="sm" onClick={() => void reloadAll()} loading={busy === 'reload'} icon={<PlugZap size={14} />} disabled={!data.adapterReady || !!busy}>重连全部</Button>
            <Button variant="primary" size="sm" onClick={openAdd} icon={<Plus size={14} />}>添加账号</Button>
          </>
        )}
        meta={<><span>{total} 个账号 · {connected} 已连接</span><span className="h-3 w-px bg-ink/10" /><span>被动回复窗口 5 分钟 / 最多 5 条</span></>}
      />

      {res.error && <div className="mb-4"><ErrorState message={res.error} onRetry={() => void res.reload()} /></div>}

      <section className="panel mb-5 p-5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-lagoon/7 text-lagoon"><Bot size={16} /></span>
          <div className="mr-auto">
            <h2 className="section-title">适配器状态</h2>
            <p className="text-[10.5px] text-ink-3">WebSocket 网关 + v2 REST 自实现</p>
          </div>
          <Tag tone={data.adapterReady ? 'jade' : 'neutral'}>{data.adapterReady ? '已就绪' : '未初始化'}</Tag>
          <Tag tone={data.enable === false ? 'neutral' : 'jade'}>适配器开关：{data.enable === false ? '关' : '开'}</Tag>
          <Tag tone={connected === total && total > 0 ? 'jade' : total > 0 ? 'amber' : 'neutral'}>已连接 {connected} / {total}</Tag>
        </div>
        {!data.adapterReady && (
          <p className="mt-3 rounded-lg border border-amber/20 bg-amber-soft/60 px-3 py-2 text-[11px] leading-relaxed text-amber">
            适配器尚未初始化。首次启用通常需要重启 Yunzai；账号配置会保留。
          </p>
        )}
        {data.enable === false && (
          <p className="mt-2 text-[11px] text-ink-3">适配器开关在配置中心「QQ 官方机器人」里；这里只管理账号与连接。</p>
        )}
      </section>

      <section className="panel overflow-hidden">
        <div className="flex items-center justify-between border-b border-line-soft px-5 py-4">
          <div><h2 className="section-title">账号</h2><p className="mt-0.5 text-[11px] text-ink-3">AppSecret 只显示末 4 位</p></div>
          <Button variant="secondary" size="sm" onClick={openAdd} icon={<Plus size={13} />}>添加</Button>
        </div>
        {res.loading && !res.data ? (
          <div className="space-y-2 p-4">{[0, 1].map((i) => <Skeleton key={i} className="h-24" />)}</div>
        ) : accounts.length === 0 ? (
          <EmptyState icon={<Bot />} title="还没有配置 QQ 机器人账号" action={<Button size="sm" variant="primary" onClick={openAdd} icon={<Plus size={12} />}>添加账号</Button>}>
            填 AppID 与 AppSecret 即可；也支持直接在 config.yaml 的 agent.qqBot.accounts 里配置。
          </EmptyState>
        ) : (
          <ul className="divide-y divide-line-soft">
            {accounts.map((a) => {
              const st = a.status || {}
              return (
                <li key={a.appId} className="px-5 py-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-[13px] font-semibold">{a.name || '机器人'}</span>
                        <span className="mono text-[10px] text-ink-3">· {a.appId}</span>
                        <Tag tone={statusTone(a)}>{statusCn(a)}</Tag>
                        {a.sandbox && <Tag tone="amber">沙箱</Tag>}
                        <Tag tone={a.hasSecret ? 'jade' : 'coral'}>{a.hasSecret ? '密钥已配置' : '缺 AppSecret'}</Tag>
                      </div>
                      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10.5px] text-ink-3">
                        <span>AppSecret：<span className="mono">{reveal[a.appId] ? (a.secretMasked || '—') : '••••••••'}</span>
                          <button className="ml-1 text-lagoon hover:underline" onClick={() => setReveal((r) => ({ ...r, [a.appId]: !r[a.appId] }))}>{reveal[a.appId] ? '收起' : '说明'}</button>
                        </span>
                        <span>Markdown：{mdCn(a)}</span>
                        {st.connectedAt && <span>连接于 {fmtDate(st.connectedAt)}</span>}
                        {st.sessionId && <span className="mono">session {String(st.sessionId).slice(0, 8)}…</span>}
                      </div>
                      {st.lastClose?.code && <div className="mt-1 text-[10px] text-ink-3">最近断开：code {st.lastClose.code}（{st.lastClose.reason || '—'}） · 重连 {st.reconnectAttempts ?? 0} 次</div>}
                      {st.lastError && <div className="mt-1 text-[10px] text-coral">最近错误：{st.lastError}</div>}
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {!st.connected && <Button size="sm" variant="secondary" onClick={() => void act(a, 'connect')} loading={busy === `connect:${a.appId}`} icon={<Link2 size={12} />} disabled={!data.adapterReady}>连接</Button>}
                      {st.connected && <Button size="sm" variant="secondary" onClick={() => void act(a, 'disconnect')} loading={busy === `disconnect:${a.appId}`} icon={<Unplug size={12} />}>断开</Button>}
                      <Button size="sm" variant="secondary" onClick={() => openEdit(a)}>编辑</Button>
                      <CopyButton text={a.appId} label="复制 AppID" />
                      <Button size="sm" variant="danger" onClick={() => void act(a, 'remove')} loading={busy === `remove:${a.appId}`} icon={<Trash2 size={12} />}>删除</Button>
                    </div>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </section>

      <section className="panel mt-5 p-5">
        <h2 className="section-title">排障速查</h2>
        <ul className="mt-2 grid grid-cols-1 gap-1.5 text-[11px] leading-relaxed text-ink-2 md:grid-cols-2">
          <li>· 4004 / 鉴权失败：AppID 或 AppSecret 错误，平台重置密钥后需重新填写。</li>
          <li>· 4013 / 4914：intents 权限不足，检查开放平台事件订阅。</li>
          <li>· 4008：频控；4006 / 4007 / 4009 会自动重试或重置会话。</li>
          <li>· 不要与 Yunzai-QQBot-Plugin 同时连接同一条机器人。</li>
          <li>· 官方机器人主人 ID 是 openid；先发 <span className="mono">/uid</span> 再加入 masters。</li>
          <li>· 被动回复窗口 5 分钟，最多 5 条；超出后需要用户再次触发。</li>
        </ul>
      </section>

      <Dialog
        open={formOpen}
        onClose={() => !busy && setFormOpen(false)}
        title={editing ? '编辑账号' : '添加 QQ 机器人账号'}
        description={editing ? 'AppSecret 留空表示不修改。保存后会尝试重连。' : '保存后立即尝试连接；首次启用若适配器未初始化，需要重启 Yunzai。'}
        footer={(
          <>
            <Button variant="secondary" onClick={() => setFormOpen(false)} disabled={!!busy}>取消</Button>
            <Button variant="primary" onClick={() => void save()} loading={busy === 'save'} icon={<Check size={13} />}>{editing ? '保存并重连' : '添加并连接'}</Button>
          </>
        )}
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="AppID" hint="纯数字，开放平台 → 开发设置。">
            <Input value={form.appId} disabled={!!editing} onChange={(e) => setForm((f) => ({ ...f, appId: e.target.value }))} placeholder="如 102012345" />
          </Field>
          <Field label="AppSecret" hint={editing ? '留空 = 不修改。' : '新增账号必填。'}>
            <Input type="password" value={form.appSecret} onChange={(e) => setForm((f) => ({ ...f, appSecret: e.target.value }))} placeholder={editing ? '留空=不修改' : '平台生成的密钥'} autoComplete="new-password" />
          </Field>
          <Field label="显示名称（可选）"><Input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="如 主号" /></Field>
          <Field label="Markdown 能力">
            <Select value={form.markdown} onChange={(e) => setForm((f) => ({ ...f, markdown: e.target.value }))}>
              <option value="auto">auto（推荐）</option><option value="true">true（总是 Markdown）</option><option value="false">false（纯文本）</option>
            </Select>
          </Field>
          <Field label="事件订阅位图 intents" hint="33554432 群 / 100663296 群+私聊 / 1073741825 全量。">
            <Input type="number" min={0} value={form.intents} onChange={(e) => setForm((f) => ({ ...f, intents: Number(e.target.value) }))} />
          </Field>
          <div className="flex flex-col justify-end gap-3">
            <label className="flex items-center justify-between gap-3 text-[11.5px]"><span>纯文本也走 Markdown</span><Switch checked={form.preferMarkdownText} onChange={(v) => setForm((f) => ({ ...f, preferMarkdownText: v }))} label="纯文本也走 Markdown" /></label>
            <label className="flex items-center justify-between gap-3 text-[11.5px]"><span>沙箱环境</span><Switch checked={form.sandbox} onChange={(v) => setForm((f) => ({ ...f, sandbox: v }))} label="沙箱环境" /></label>
          </div>
        </div>
      </Dialog>
    </div>
  )
}
