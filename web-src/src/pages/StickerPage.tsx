import { useState } from 'react'
import { Image, RefreshCw, Smile } from 'lucide-react'
import { api } from '@/lib/api'
import { useAsync, useReloadEvent } from '@/lib/hooks'
import { useAgentConfig, CfgRow, SaveBar } from '@/lib/config'
import { Button, EmptyState, ErrorState, PageHeader, Select, Skeleton, Switch, TagEditor, Tag, LoadingBlock } from '@/components/ui'
import { useToast } from '@/components/Overlay'
import { safeJson } from '@/lib/format'

const DEFAULTS = {
  enable: false, maxPerReply: 2, cooldown: 300, sendRate: 0.25, antiConsecutive: true,
  groupOnly: false, listTopN: 30, autoDiscover: false, discoverGroups: [] as string[],
  maxDiscovered: 200, discoverMaxSizeMB: 5, sendStickerTool: true,
}
const NUM = (v: any) => v === '' ? '' : Number(v)

export function StickerPage() {
  const toast = useToast()
  const { form, field, dirty, save, reset, loading, error, refresh } = useAgentConfig('sticker', DEFAULTS)
  const lib = useAsync(() => api.get('/sticker'), [])
  const [saving, setSaving] = useState(false)
  useReloadEvent(() => { void lib.reload(); void refresh() })

  const doSave = async () => {
    setSaving(true)
    try { await save({ prefix: 'agent.sticker' }); await lib.reload() }
    catch (e: any) { toast(e?.message || '保存失败', 'error') }
    finally { setSaving(false) }
  }

  return (
    <div className="page">
      <PageHeader
        title="表情包"
        description="配置 + 库概览 · 发送策略 / 自动发现。表情包默认关闭；开启只影响群聊里的自动贴图。"
        actions={<Button variant="secondary" size="sm" onClick={() => { void lib.reload(); void refresh() }} icon={<RefreshCw size={14} />}>刷新</Button>}
        meta={<><span>只读展示库容量</span><span className="h-3 w-px bg-ink/10" /><span>#表情包状态 / #表情包开启</span></>}
      />

      {(error || lib.error) && <div className="mb-4"><ErrorState message={error || lib.error} onRetry={() => { void refresh(); void lib.reload() }} /></div>}
      {loading && !form.enable && <div className="panel p-5"><LoadingBlock rows={4} /></div>}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="space-y-4">
          <section className="panel p-5">
            <h2 className="section-title">基础 / 总开关</h2>
            <p className="mt-0.5 text-[11px] leading-relaxed text-ink-3">只通过自动发现入库（MaiBot 式：收集群图 → 视觉分类打标），不扫描本地目录。</p>
            <div className="mt-2">
              <CfgRow label="启用表情包" hint="关闭 = 零影响；群聊里不会主动贴图。"><Switch checked={!!form.enable} onChange={(v) => field('enable', v)} label="启用表情包" /></CfgRow>
              <CfgRow label="清单注入上限" hint="注入到系统提示里的表情包条目上限（5–200）。"><input className="input w-[120px]" type="number" min={5} max={200} value={form.listTopN ?? ''} onChange={(e) => field('listTopN', NUM(e.target.value))} /></CfgRow>
              <CfgRow label="仅群聊启用" hint="私聊里不贴表情包。"><Switch checked={!!form.groupOnly} onChange={(v) => field('groupOnly', v)} label="仅群聊启用" /></CfgRow>
            </div>
          </section>

          <section className="panel p-5">
            <h2 className="section-title">发送策略</h2>
            <div className="mt-2">
              <CfgRow label="单条最多贴图数" hint="1–5 张。"><input className="input w-[120px]" type="number" min={1} max={5} value={form.maxPerReply ?? ''} onChange={(e) => field('maxPerReply', NUM(e.target.value))} /></CfgRow>
              <CfgRow label="带图冷却（秒）" hint="0–3600 秒。"><input className="input w-[120px]" type="number" min={0} max={3600} value={form.cooldown ?? ''} onChange={(e) => field('cooldown', NUM(e.target.value))} /></CfgRow>
              <CfgRow label="带图概率" hint="0–1；当前值在右侧显示。">
                <div className="flex items-center gap-3">
                  <input type="range" min={0} max={1} step={0.05} value={Number(form.sendRate) || 0} onChange={(e) => field('sendRate', Number(e.target.value))} className="w-full accent-lagoon" />
                  <span className="mono w-10 text-right text-[11px]">{Number(form.sendRate || 0).toFixed(2)}</span>
                </div>
              </CfgRow>
              <CfgRow label="防连发" hint="同一表情不连续发送。"><Switch checked={!!form.antiConsecutive} onChange={(v) => field('antiConsecutive', v)} label="防连发" /></CfgRow>
              <CfgRow label="send_sticker 工具" hint="允许 Agent 主动调用表情包工具。"><Switch checked={!!form.sendStickerTool} onChange={(v) => field('sendStickerTool', v)} label="send_sticker 工具" /></CfgRow>
            </div>
          </section>

          <section className="panel p-5">
            <h2 className="section-title">自动发现</h2>
            <div className="mt-2">
              <CfgRow label="自动发现" hint="开启后从采集群收集图片并分类入库。"><Switch checked={!!form.autoDiscover} onChange={(v) => field('autoDiscover', v)} label="自动发现" /></CfgRow>
              <CfgRow label="采集群白名单" hint="留空 = 不采集任何群。" full>
                <TagEditor value={Array.isArray(form.discoverGroups) ? form.discoverGroups.map(String) : []} onChange={(v) => field('discoverGroups', v)} placeholder="群号回车" mono />
              </CfgRow>
              <CfgRow label="采集上限" hint="10–2000 张。"><input className="input w-[120px]" type="number" min={10} max={2000} value={form.maxDiscovered ?? ''} onChange={(e) => field('maxDiscovered', NUM(e.target.value))} /></CfgRow>
              <CfgRow label="单张大小上限（MB）" hint="0–50 MB；0 = 不限制。"><input className="input w-[120px]" type="number" min={0} max={50} value={form.discoverMaxSizeMB ?? ''} onChange={(e) => field('discoverMaxSizeMB', NUM(e.target.value))} /></CfgRow>
            </div>
          </section>
        </div>

        <aside className="space-y-4">
          <section className="panel p-5">
            <div className="flex items-start justify-between gap-2">
              <div><h2 className="section-title">表情包库</h2><p className="mt-0.5 text-[10.5px] text-ink-3">只读统计</p></div>
              <Button size="sm" variant="ghost" onClick={() => void lib.reload()} disabled={lib.loading} icon={<RefreshCw size={12} />}>刷新</Button>
            </div>
            {lib.loading && !lib.data ? <div className="mt-3 space-y-2"><Skeleton className="h-5" /><Skeleton className="h-5" /></div>
              : lib.data ? (
                <div className="mt-3">
                  <Tag tone={lib.data.enabled ? 'jade' : 'neutral'}>{lib.data.enabled ? '已启用' : '未启用'}</Tag>
                  <div className="mt-3 grid grid-cols-2 gap-3 border-t border-line-soft pt-3">
                    <div><div className="text-[10px] text-ink-3">入库总数</div><div className="mono mt-0.5 text-[20px]">{lib.data.total ?? 0}</div></div>
                    <div><div className="text-[10px] text-ink-3">自动采集</div><div className="mono mt-0.5 text-[20px]">{lib.data.discovered ?? 0}</div></div>
                  </div>
                </div>
              ) : <p className="mt-3 text-[11px] text-ink-3">点刷新加载库数据。</p>}
          </section>
          <section className="panel p-5 text-[10.5px] leading-relaxed text-ink-3">
            <div className="mb-2 flex items-center gap-2 text-[12px] font-medium text-ink"><Image size={14} className="text-lagoon" />口径</div>
            <p>表情包工具只在群聊里生效。自动发现关闭时不会扫描、不会入库。视觉分类失败会跳过，不阻塞对话。</p>
          </section>
        </aside>
      </div>

      <SaveBar dirty={dirty} onReset={reset} onSave={() => void doSave()} busy={saving} />
    </div>
  )
}
