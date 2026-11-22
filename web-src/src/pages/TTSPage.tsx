import { useEffect, useMemo, useRef, useState } from 'react'
import { AudioLines, Check, Plus, RefreshCw, Trash2, Upload, Volume2 } from 'lucide-react'
import { api, getToken } from '@/lib/api'
import { useAsync, useReloadEvent } from '@/lib/hooks'
import { fmtDate } from '@/lib/format'
import { Button, EmptyState, ErrorState, Field, Input, PageHeader, Select, Skeleton, Switch, Tag } from '@/components/ui'
import { Dialog, Drawer, useConfirm, useToast } from '@/components/Overlay'
import { AudioPlayer } from '@/components/AudioPlayer'
import { cn } from '@/lib/cn'

const I_DEFAULTS = {
  endpoint: '', lang: 'ZH', timeoutMs: 300000, voice: '', emotionMode: 'same', emotionRef: '', emotionWeight: 0.65,
  autoEmotion: true, tier: 'pro', segmentGapMs: 300, maxSegmentChars: 140, model: '', judgeTimeoutMs: 300000,
  durationFactor: 1, maxTextTokensPerSegment: 100,
}
const EMOTIONS = [
  ['happy', '高兴'], ['angry', '愤怒'], ['sad', '悲伤'], ['afraid', '害怕'],
  ['disgusted', '厌恶'], ['melancholic', '忧郁'], ['surprised', '惊讶'], ['calm', '平静'],
] as const

type FieldDef = { key: string; label: string; type: string; min?: number; max?: number; step?: number; options?: [string, string][]; placeholder?: string; desc?: string }
type Ref = { id: string; name: string; kind: string; ext?: string; size?: number; createdAt?: number }

export function TTSPage() {
  const toast = useToast()
  const confirm = useConfirm()
  const res = useAsync(() => api.get('/tts'), [])
  const [busy, setBusy] = useState('')
  const [modal, setModal] = useState<{ open: boolean; provider: any }>({ open: false, provider: null })
  const [form, setForm] = useState<any>({})
  const [test, setTest] = useState<any>(null)
  const [upload, setUpload] = useState({ name: '', kind: 'voice', file: null as File | null })
  const fileRef = useRef<HTMLInputElement>(null)
  useReloadEvent(() => void res.reload())

  const data = res.data || {}
  const providers = (data.providers || []) as any[]
  const refs = (data.refs || []) as Ref[]
  const voiceRefs = refs.filter((r) => r.kind !== 'emotion')
  const emoRefs = refs.filter((r) => r.kind === 'emotion')

  const saveField = async (changes: any, msg: string) => {
    setBusy(Object.keys(changes).join(','))
    try { await api.put('/tts/config', { changes }); await res.reload(); toast(msg, 'success') }
    catch (e: any) { toast(e?.message || '保存失败', 'error') }
    finally { setBusy('') }
  }

  const openProvider = (p: any) => {
    const base = p.id === 'indextts' ? { ...I_DEFAULTS, ...(data.indextts || {}) } : { ...(data[p.id] || {}) }
    setForm(base)
    setTest(null)
    setModal({ open: true, provider: p })
  }
  const close = () => setModal({ open: false, provider: null })

  const fields = (provider: any): FieldDef[] => {
    if (provider?.id === 'indextts') return [
      { key: 'endpoint', label: '接口地址', type: 'text', placeholder: 'http://127.0.0.1:7860', desc: 'IndexTTS 2.5 服务地址' },
      { key: 'lang', label: '语言', type: 'select', options: [['ZH', '中文'], ['EN', '英语'], ['JA', '日语'], ['AR', '阿拉伯语'], ['ES', '西班牙语']] },
      { key: 'voice', label: '默认音色参考', type: 'select', options: [['', '（最新上传）'], ...voiceRefs.map((r) => [r.name, r.name] as [string, string])] },
      { key: 'emotionMode', label: '默认情绪模式', type: 'select', options: [['same', 'Same as voice（沿用）'], ['audio', 'Use emotion audio（情绪参考）'], ['vector', 'Use emotion vectors（情绪向量）']] },
      { key: 'emotionRef', label: '默认情绪参考', type: 'select', options: [['', '（未指定）'], ...emoRefs.map((r) => [r.name, r.name] as [string, string])] },
      { key: 'emotionWeight', label: '情绪影响强度', type: 'number', min: 0, max: 1, step: 0.05 },
      { key: 'autoEmotion', label: 'LLM 自动调节', type: 'switch' },
      { key: 'tier', label: '档位', type: 'select', options: [['pro', 'pro · 整段一套情绪'], ['max', 'max · 按需拆分逐段情绪']] },
      { key: 'timeoutMs', label: '超时（毫秒）', type: 'number', min: 10000, step: 10000 },
      { key: 'durationFactor', label: '语速 / 时长系数', type: 'number', min: 0.5, max: 2, step: 0.1 },
      { key: 'segmentGapMs', label: 'max 档段间静音（ms）', type: 'number', min: 0, max: 2000, step: 50 },
      { key: 'maxSegmentChars', label: 'max 档单段字数', type: 'number', min: 20, max: 500 },
      { key: 'judgeTimeoutMs', label: '情绪判定超时（ms）', type: 'number', min: 3000, step: 1000 },
    ]
    return (provider?.fields || []) as FieldDef[]
  }

  const diff = useMemo(() => {
    const base = modal.provider?.id === 'indextts' ? data.indextts : data[modal.provider?.id]
    const out: Record<string, any> = {}
    if (!modal.provider) return out
    for (const [k, v] of Object.entries(form)) {
      const prev = base?.[k]
      const nv = v === '' ? null : v
      if (typeof prev === 'number' || typeof nv === 'number') {
        if (nv === null) continue
        if (Number(nv) !== Number(prev)) out[k] = Number(nv)
      } else if (Array.isArray(v) || (v && typeof v === 'object')) {
        if (JSON.stringify(v) !== JSON.stringify(prev)) out[k] = v
      } else if (nv !== undefined && nv !== prev) out[k] = nv
    }
    return out
  }, [form, modal.provider, data])

  const saveProvider = async () => {
    if (!modal.provider) return
    if (!Object.keys(diff).length) { toast('无改动', 'warn'); return }
    setBusy('modal')
    try {
      const changes = modal.provider.id === 'indextts' ? diff : { ...diff }
      await api.put('/tts/config', { changes: Object.fromEntries(Object.entries(changes).map(([k, v]) => [`${modal.provider.id}.${k}`, v])) })
      await res.reload()
      toast('已保存（已热加载）', 'success')
      close()
    } catch (e: any) { toast(e?.message || '保存失败', 'error') }
    finally { setBusy('') }
  }

  const testConnection = async () => {
    if (!modal.provider) return
    setBusy('test'); setTest(null)
    try {
      const body = modal.provider.id === 'indextts' ? { endpoint: form.endpoint } : { provider: modal.provider.id, ...form }
      const r = await api.post('/tts/test', body)
      setTest({ ok: true, ...r })
    } catch (e: any) { setTest({ ok: false, message: e?.message || '测试失败' }) }
    finally { setBusy('') }
  }

  const uploadRef = async () => {
    if (!upload.file || !upload.name.trim()) { toast('请选择音频并命名', 'warn'); return }
    setBusy('upload')
    try {
      const qs = new URLSearchParams({ name: upload.name.trim(), kind: upload.kind, filename: upload.file.name })
      await api.postRaw(`/tts/refs?${qs.toString()}`, upload.file)
      await res.reload()
      setUpload({ name: '', kind: 'voice', file: null })
      if (fileRef.current) fileRef.current.value = ''
      toast('参考音频已上传', 'success')
    } catch (e: any) { toast(e?.message || '上传失败', 'error') }
    finally { setBusy('') }
  }

  const removeRef = async (r: Ref) => {
    const ok = await confirm({ title: '删除参考音频？', message: `将删除「${r.name}」及其索引，引用它的音色会回退。`, confirmText: '删除音频', danger: true })
    if (!ok) return
    try { await api.del(`/tts/refs/${encodeURIComponent(r.id)}`); await res.reload(); toast('已删除', 'info') }
    catch (e: any) { toast(e?.message || '删除失败', 'error') }
  }

  return (
    <div className="page">
      <PageHeader
        title="语音合成"
        description="TTS 服务配置 + 参考音频库。默认关闭；只对选中且配置完整的服务发起外发请求。"
        actions={<Button variant="secondary" size="sm" onClick={() => void res.reload()} icon={<RefreshCw size={14} />}>刷新</Button>}
        meta={<><span>默认服务商 {data.provider || '—'}</span><span className="h-3 w-px bg-ink/10" /><span>{refs.length} 条参考音频</span></>}
      />

      {res.error && <div className="mb-4"><ErrorState message={res.error} onRetry={() => void res.reload()} /></div>}
      {res.loading && !res.data ? <div className="space-y-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-28" />)}</div> : (
        <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
          <div className="space-y-4">
            <section className="panel p-5">
              <h2 className="section-title">总开关 / 默认服务</h2>
              <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2">
                <label className="flex items-center justify-between gap-3 border-b border-line-soft py-2.5 text-[12px]"><span>启用语音合成</span><Switch checked={!!data.enable} onChange={(v) => void saveField({ enable: v }, v ? '已启用 TTS' : '已关闭 TTS')} label="启用语音合成" /></label>
                <label className="flex items-center justify-between gap-3 border-b border-line-soft py-2.5 text-[12px]"><span>自动语音回复</span><Switch checked={!!data.autoReply} onChange={(v) => void saveField({ autoReply: v }, v ? '已开启自动语音回复' : '已关闭自动语音回复')} label="自动语音回复" /></label>
                <label className="flex items-center justify-between gap-3 border-b border-line-soft py-2.5 text-[12px]"><span>高清语音</span><Switch checked={!!data.hdVoice} onChange={(v) => void saveField({ hdVoice: v }, v ? '已开启高清语音' : '已关闭高清语音')} label="高清语音" /></label>
                <div className="border-b border-line-soft py-2.5">
                  <div className="mb-1 text-[11px] text-ink-3">默认服务商</div>
                  <Select value={data.provider || 'indextts'} disabled={providers.length < 2} onChange={(e) => void saveField({ provider: e.target.value }, '已切换默认服务商')}>
                    {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </Select>
                </div>
                <Field label="自动语音字数上限" hint="0–5000；0 = 不限。"><Input type="number" min={0} max={5000} step={50} defaultValue={data.replyMaxChars ?? 300} onBlur={(e) => { const v = Number(e.target.value); if (!Number.isFinite(v)) { toast('需填 0-5000 的数字', 'warn'); return } void saveField({ replyMaxChars: Math.max(0, Math.min(5000, v)) }, '已保存自动语音字数上限') }} /></Field>
                <Field label="情绪判定模型" hint="留空 = utilityModel → 主模型。"><Input className="mono" defaultValue={data.judgeModel || ''} onBlur={(e) => void saveField({ judgeModel: e.target.value.trim() }, '已保存情绪判定模型')} placeholder="留空=utilityModel→主模型" /></Field>
                <Field label="情绪判定超时（ms）" hint="1000–600000。"><Input type="number" min={1000} max={600000} step={1000} defaultValue={data.judgeTimeoutMs || 300000} onBlur={(e) => { const v = Number(e.target.value); if (!Number.isFinite(v)) { toast('需填 1000-600000 的数字', 'warn'); return } void saveField({ judgeTimeoutMs: Math.max(1000, Math.min(600000, v)) }, '已保存情绪判定超时') }} /></Field>
              </div>
            </section>

            <section>
              <h2 className="mb-2 section-title">服务商</h2>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                {providers.map((p) => (
                  <button key={p.id} className={cn('panel p-4 text-left transition hover:-translate-y-0.5', data.provider === p.id && 'ring-1 ring-lagoon/30')} onClick={() => openProvider(p)}>
                    <div className="flex items-start gap-2.5">
                      <span className="flex h-9 w-9 flex-none items-center justify-center rounded-lg bg-lagoon/7 text-lagoon"><AudioLines size={16} /></span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5"><span className="text-[12.5px] font-semibold">{p.name}</span><Tag tone={p.configured ? 'jade' : 'coral'}>{p.configured ? '已配置' : '未配置'}</Tag></div>
                        <p className="mt-1 text-[10.5px] leading-relaxed text-ink-3">{p.desc || '—'}</p>
                        {!!p.missing?.length && <p className="mt-1 text-[9.5px] text-coral">缺少：{p.missing.join('、')}</p>}
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            </section>
          </div>

          <aside className="panel p-5">
            <div className="flex items-center justify-between"><h2 className="section-title">参考音频库</h2><span className="text-[10px] text-ink-3">{refs.length} 条</span></div>
            <p className="mt-1 text-[10px] leading-relaxed text-ink-3">建议 6–12 秒单人清晰录音；情绪参考可来自其他说话人。</p>
            <div className="mt-3 space-y-2">
              <Input value={upload.name} onChange={(e) => setUpload((u) => ({ ...u, name: e.target.value }))} placeholder="命名（如 芙宁娜）" />
              <div className="flex gap-2">
                <Select value={upload.kind} onChange={(e) => setUpload((u) => ({ ...u, kind: e.target.value }))} className="w-[130px]"><option value="voice">voice 音色</option><option value="emotion">emotion 情绪</option></Select>
                <input ref={fileRef} type="file" accept="audio/*,.wav,.mp3,.m4a,.ogg,.flac" className="min-w-0 flex-1 text-[10px] text-ink-3 file:mr-2 file:rounded-md file:border file:border-line file:bg-white/60 file:px-2 file:py-1 file:text-[10px]" onChange={(e) => setUpload((u) => ({ ...u, file: e.target.files?.[0] || null }))} />
              </div>
              <Button size="sm" variant="secondary" className="w-full" onClick={() => void uploadRef()} loading={busy === 'upload'} icon={<Upload size={12} />}>上传参考音频</Button>
            </div>
            <div className="mt-4 max-h-[430px] space-y-2 overflow-y-auto">
              {refs.length === 0 ? <p className="rounded-lg border border-dashed border-line px-3 py-4 text-center text-[10.5px] text-ink-3">还没有参考音频。</p> : refs.map((r) => (
                <div key={r.id} className="rounded-lg border border-line-soft bg-white/40 p-2.5">
                  <div className="flex items-center justify-between gap-2"><span className="min-w-0 truncate text-[11px] font-medium">{r.name}</span><div className="flex items-center gap-1"><Tag tone={r.kind === 'emotion' ? 'amber' : 'lagoon'}>{r.kind}</Tag><Button size="icon" variant="ghost" className="btn-sm hover:text-coral" onClick={() => void removeRef(r)} aria-label="删除音频"><Trash2 size={11} /></Button></div></div>
                  <div className="mt-1.5"><AudioPlayer src={`/api/tts/refs/${encodeURIComponent(r.id)}/audio?token=${encodeURIComponent(getToken())}`} label={r.name} /></div>
                  <div className="mono mt-1 text-[9px] text-ink-4">{r.ext || ''} · {Math.round((r.size || 0) / 1024)} KB · {fmtDate(r.createdAt, false)}</div>
                </div>
              ))}
            </div>
          </aside>
        </div>
      )}

      <Dialog
        open={modal.open}
        onClose={close}
        title={modal.provider ? `${modal.provider.name} · 配置` : '配置'}
        description={modal.provider?.desc}
        width={760}
        footer={(
          <>
            <Button variant="secondary" onClick={() => void testConnection()} loading={busy === 'test'} icon={<Volume2 size={13} />}>测试连接</Button>
            <div className="flex-1" />
            <Button variant="secondary" onClick={close}>取消</Button>
            <Button variant="primary" onClick={() => void saveProvider()} loading={busy === 'modal'} disabled={!Object.keys(diff).length} icon={<Check size={13} />}>保存（热加载）</Button>
          </>
        )}
      >
        {modal.provider && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {test && <div className={cn('sm:col-span-2 rounded-lg border px-3 py-2 text-[11px]', test.ok ? 'border-jade/20 bg-jade-soft/60 text-jade' : 'border-coral/20 bg-coral-soft/60 text-coral')}>{test.ok ? `连接成功${test.fnIndex != null ? ` · fn_index=${test.fnIndex}` : ''}${test.tookMs != null ? ` · ${test.tookMs}ms` : ''}` : test.message}</div>}
            {modal.provider.id === 'indextts' && (
              <div className="sm:col-span-2">
                <h3 className="mb-1.5 text-[11px] font-medium text-ink-2">参考音频</h3>
                <p className="text-[10px] leading-relaxed text-ink-3">在右侧音色库上传；这里选择默认音色与情绪模式。向量参数（8 维）在配置文件中维护。</p>
              </div>
            )}
            {fields(modal.provider).map((f) => {
              const v = form[f.key]
              const set = (val: any) => setForm((s: any) => ({ ...s, [f.key]: val }))
              if (f.type === 'switch') return <Field key={f.key} label={f.label} hint={f.desc}><div className="pt-1"><Switch checked={!!v} onChange={set} label={f.label} /></div></Field>
              if (f.type === 'select') return <Field key={f.key} label={f.label} hint={f.desc}><Select value={v ?? ''} onChange={(e) => set(e.target.value)}>{(f.options || []).map((o) => <option key={o[0]} value={o[0]}>{o[1]}</option>)}</Select></Field>
              if (f.type === 'number') return <Field key={f.key} label={f.label} hint={f.desc}><Input type="number" value={v ?? ''} min={f.min} max={f.max} step={f.step} onChange={(e) => set(e.target.value === '' ? '' : Number(e.target.value))} /></Field>
              if (f.type === 'secret') return <Field key={f.key} label={f.label} hint={f.desc}><Input type="password" className="mono" value={v ?? ''} placeholder={f.placeholder} onChange={(e) => set(e.target.value)} autoComplete="new-password" /></Field>
              return <Field key={f.key} label={f.label} hint={f.desc}><Input className={f.type === 'text' ? 'mono' : ''} value={v ?? ''} placeholder={f.placeholder} onChange={(e) => set(e.target.value)} /></Field>
            })}
            {modal.provider.id === 'indextts' && form.emotionMode === 'vector' && (
              <div className="sm:col-span-2 rounded-lg border border-line-soft bg-white/35 p-3">
                <div className="text-[10.5px] font-medium text-ink-2">情绪向量</div>
                <div className="mt-2 space-y-1.5">{EMOTIONS.map(([key, label], i) => { const val = Number(form.vector?.[i] || 0); return (
                  <div key={key} className="grid grid-cols-[60px_1fr_38px] items-center gap-2">
                    <span className="text-[10px] text-ink-3">{label}</span>
                    <input type="range" min={0} max={1.2} step={0.05} value={val} onChange={(e) => { const vec = Array.isArray(form.vector) ? [...form.vector] : Array(8).fill(0); vec[i] = Number(e.target.value); setForm((s: any) => ({ ...s, vector: vec })) }} className="accent-lagoon" />
                    <span className="mono text-right text-[9px]">{val.toFixed(2)}</span>
                  </div>
                ) })}</div>
              </div>
            )}
          </div>
        )}
      </Dialog>
    </div>
  )
}
