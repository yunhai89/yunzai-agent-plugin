import { useEffect, useMemo, useState } from 'react'
import { Drama, RefreshCw, ShieldCheck, UsersRound } from 'lucide-react'
import { api } from '@/lib/api'
import { useAsync, useReloadEvent } from '@/lib/hooks'
import { useAgentConfig, CfgSection, CfgRow, SaveBar, Note, SubHead } from '@/lib/config'
import { Button, Input, PageHeader, Select, Switch, TagEditor, Tag, Textarea } from '@/components/ui'
import { useToast } from '@/components/Overlay'
import { cn } from '@/lib/cn'

const DEFAULTS = {
  enable: false, groups: [] as string[], shadow: true, talkValue: 0.35, debounceMs: 1200, plannerTimeoutMs: 30000,
  maxPlannerRounds: 4, contextMessages: 30, threshold: 80, cooldownSeconds: 45, presenceWindowSeconds: 300,
  maxRepliesPer10Minutes: 4, bufferCapacity: 150, bufferTtlHours: 2, idleBackoffBaseSeconds: 15,
  idleBackoffCapSeconds: 300, idleBackoffStartCount: 2, bypassPendingCount: 6, personaName: '', botId: '',
  redactSecrets: true,
  persona: { name: '', prompt: '', fromPersonaId: '' },
  planner: { model: '', temperature: 0.2, maxTokens: 800, allowedReadTools: [] as string[] },
  replyer: { model: '', temperature: 0.7, maxTokens: 500, maxChars: 500 },
  reply: { maxBubbles: 3, typingSpeed: 1, minDelayMs: 600, maxDelayMs: 3500, typos: false, allowSticker: true },
  behaviorPolicy: { topics: [] as string[], avoidTopics: [] as string[], initiative: 0.35, humor: 0.4, answerUnknownQuestions: false, interruptHumanConversation: false, maxRepliesPer10Minutes: 4 },
  safety: { privateMemoryInGroup: false, maxConcurrentGroups: 1 },
  vision: { allowPrivateHosts: false },
  knownBots: [] as string[],
  memory: { enabled: true, maxPerQuery: 5, maxPerGroup: 300, incrementalMinMessages: 20, forgetDays: 30 },
}

const SECTIONS = [
  ['hz-basic', '总开关 / 白名单'], ['hz-persona', '角色人设'], ['hz-gate', '门控 / 评分'],
  ['hz-llm', 'Planner / Replyer'], ['hz-reply', '发送编排'], ['hz-policy', '行为政策'],
  ['hz-safety', '安全 / 红线'],
] as const

const NUM = (v: any) => v === '' ? '' : Number(v)

export function HumanizePage() {
  const toast = useToast()
  const { form, field, dirty, save, reset, loading, ready } = useAgentConfig('humanize', DEFAULTS)
  const personas = useAsync(() => api.get('/personas').catch(() => []), [])
  const [saving, setSaving] = useState(false)
  const [mode, setMode] = useState<'custom' | 'library'>('custom')
  const [activeSec, setActiveSec] = useState<string>('hz-basic')
  useReloadEvent(() => void personas.reload())

  useEffect(() => { if (ready) setMode(form.persona?.fromPersonaId ? 'library' : 'custom') }, [ready])
  useEffect(() => {
    const onScroll = () => {
      let cur: string = SECTIONS[0][0]
      for (const [id] of SECTIONS) {
        const el = document.getElementById(id)
        if (el && el.getBoundingClientRect().top < 220) cur = id
      }
      setActiveSec(cur)
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  const personaList = (personas.data || []) as any[]
  const selectedPersona = personaList.find((p) => p.id === form.persona?.fromPersonaId)
  const enableWarn = form.enable && (!Array.isArray(form.groups) || form.groups.length === 0)

  const doSave = async () => {
    setSaving(true)
    try { await save({ prefix: 'agent.humanize' }) }
    catch (e: any) { toast(e?.message || '保存失败', 'error') }
    finally { setSaving(false) }
  }

  const setModeSafe = (m: 'custom' | 'library') => {
    if (m === 'library' && personaList.length === 0) { toast('人设库为空，请先到人设库新建', 'warn'); return }
    setMode(m)
    if (m === 'library') field('persona.fromPersonaId', form.persona?.fromPersonaId || personaList[0]?.id || '')
    else field('persona.fromPersonaId', '')
  }

  return (
    <div className="page">
      <PageHeader
        title="伪人模式"
        description="旁听 / 门控 / 决策 / 发送。默认关闭；开启后只对白名单群生效，shadow 模式只观察不发送。"
        actions={<Button variant="secondary" size="sm" onClick={() => void personas.reload()} icon={<RefreshCw size={14} />}>刷新人设</Button>}
        meta={<><span>{form.groups?.length || 0} 个白名单群</span><span className="h-3 w-px bg-ink/10" /><span>热加载会取消正在进行的规划</span></>}
      />

      {!ready && loading ? <div className="panel p-6 text-center text-[12px] text-ink-3">正在加载伪人配置…</div> : (
        <div className="grid grid-cols-1 gap-5 xl:grid-cols-[200px_minmax(0,1fr)]">
          <aside className="hidden xl:block">
            <nav className="panel sticky top-[76px] p-2">
              {SECTIONS.map(([id, name]) => (
                <button key={id} className={cn('mb-0.5 flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-[11px] transition', activeSec === id ? 'bg-lagoon-soft text-lagoon-deep' : 'text-ink-3 hover:bg-white/50 hover:text-ink')} onClick={() => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>
                  <span className="h-1 w-1 rounded-full bg-current opacity-60" />{name}
                </button>
              ))}
            </nav>
          </aside>

          <div className="space-y-4">
            {enableWarn && <Note tone="coral">总开关已开，但白名单为空 —— 不会在任何群生效。请在「总开关 / 白名单」添加群号。</Note>}
            <Note tone="neutral"><span className="font-medium text-ink">红线：</span>环境模式的普通文本永不发送；<span className="mono">user_private</span> 记忆绝不注入群聊。建议先 shadow 观察，再开启实际发送。</Note>

            <CfgSection id="hz-basic" title="总开关 / 白名单" description="旁听范围与运行身份" icon={<UsersRound size={15} />} defaultOpen>
              <CfgRow label="启用伪人模式" hint="关闭 = 不旁听、不规划、不发送。"><Switch checked={!!form.enable} onChange={(v) => field('enable', v)} label="启用伪人模式" /></CfgRow>
              <CfgRow label="白名单群" hint="只对列入的群生效；留空 = 不生效。" full><TagEditor value={form.groups || []} onChange={(v) => field('groups', v)} placeholder="输入群号回车" mono /></CfgRow>
              <CfgRow label="shadow 观察模式" hint="照常门控与规划，但不实际发送。建议首次开启时保持。"><Switch checked={!!form.shadow} onChange={(v) => field('shadow', v)} label="shadow 观察模式" /></CfgRow>
              <CfgRow label="机器人在群里的名字" hint="留空 = 自动从账号信息推断。"><Input value={form.personaName || ''} onChange={(e) => field('personaName', e.target.value)} placeholder="留空=自动" /></CfgRow>
              <CfgRow label="机器人自身 QQ" hint="用于识别自己的消息；留空 = 自动。"><Input className="mono" value={form.botId || ''} onChange={(e) => field('botId', e.target.value)} placeholder="留空=自动" /></CfgRow>
            </CfgSection>

            <CfgSection id="hz-persona" title="角色人设" description="使用人设库，或在本页写一张临时角色卡" icon={<Drama size={15} />}>
              <CfgRow label="人设来源" hint="人设库修改后需要回到这里重新保存。" full>
                <div className="flex flex-wrap items-center gap-2">
                  <div className="segmented"><button aria-pressed={mode === 'custom'} onClick={() => setModeSafe('custom')}>自定义角色卡</button><button aria-pressed={mode === 'library'} onClick={() => setModeSafe('library')}>从人设库选择</button></div>
                  <a href="#/personas" className="text-[11px] text-lagoon hover:underline">管理人设库</a>
                </div>
              </CfgRow>
              {mode === 'library' ? (
                <>
                  <CfgRow label="选择人设" full>
                    <Select value={form.persona?.fromPersonaId || ''} onChange={(e) => field('persona.fromPersonaId', e.target.value)}>
                      <option value="">（未选择）</option>
                      {personaList.map((p) => <option key={p.id} value={p.id}>{p.name}（{p.id}）</option>)}
                      {form.persona?.fromPersonaId && !selectedPersona && <option value={form.persona.fromPersonaId}>当前：{form.persona.fromPersonaId}（未找到）</option>}
                    </Select>
                  </CfgRow>
                  {selectedPersona ? (
                    <div className="my-3 rounded-xl border border-line-soft bg-white/40 p-3.5">
                      <div className="flex items-center gap-2"><span className="flex h-9 w-9 items-center justify-center rounded-lg border border-white/70 bg-[linear-gradient(135deg,#dcefEA,#a9d6cc)] text-[14px]">{selectedPersona.avatar || selectedPersona.name.slice(0, 1)}</span><div><div className="text-[12px] font-medium">{selectedPersona.name}</div><div className="text-[10px] text-ink-3">{selectedPersona.description || '—'}</div></div></div>
                      <div className="mt-2 flex flex-wrap gap-1">{(selectedPersona.tags || []).map((t: string) => <Tag key={t} tone="neutral">{t}</Tag>)}</div>
                      <details className="mt-2"><summary className="cursor-pointer text-[10px] text-ink-3">查看角色正文（{selectedPersona.systemPrompt?.length || 0} 字）</summary><pre className="mono mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-white/50 p-2 text-[10px]">{selectedPersona.systemPrompt}</pre></details>
                    </div>
                  ) : <Note tone="amber">选一个已存在的人设；如果没有，先到人设库新建。</Note>}
                </>
              ) : (
                <>
                  <CfgRow label="角色名" hint="留空 = 使用机器人昵称。"><Input value={form.persona?.name || ''} onChange={(e) => field('persona.name', e.target.value)} placeholder="留空=自动" /></CfgRow>
                  <CfgRow label="角色卡（角色设定正文）" hint="用自然语言描述性格、说话方式、边界；越具体越稳定。" full><Textarea className="mono min-h-[160px]" value={form.persona?.prompt || ''} onChange={(e) => field('persona.prompt', e.target.value)} placeholder="例如：你是群里的老朋友，说话短、有梗，不卖萌，不重复别人的话……" /></CfgRow>
                </>
              )}
            </CfgSection>

            <CfgSection id="hz-gate" title="门控 / 评分" description="决定什么时候该说话，以及退避与节流">
              <CfgRow label="评分阈值" hint="1–120；越高越少说话。"><Input className="w-[120px]" type="number" min={1} max={120} value={form.threshold ?? ''} onChange={(e) => field('threshold', NUM(e.target.value))} /></CfgRow>
              {([['talkValue', '主动性 talkValue', 0.05, 1, 0.05], ['debounceMs', 'debounce 安静窗（ms）', 200, 10000, 100], ['cooldownSeconds', '回复冷却（秒）', 0, 600, 1], ['presenceWindowSeconds', '在场统计窗口（秒）', 60, 86400, 60], ['maxRepliesPer10Minutes', '10 分钟最大回复数', 0, 60, 1], ['bypassPendingCount', '退避绕过门槛', 1, 100, 1], ['contextMessages', '注入消息条数', 5, 100, 1]] as const).map(([k, label, min, max, step]) => (
                <CfgRow key={k} label={label}>
                  {k === 'talkValue' ? (
                    <div className="flex items-center gap-3"><input type="range" min={min} max={max} step={step} value={Number(form[k]) || 0} onChange={(e) => field(k, Number(e.target.value))} className="w-full accent-lagoon" /><span className="mono w-10 text-right text-[11px]">{Number(form[k] || 0).toFixed(2)}</span></div>
                  ) : <Input className="w-[120px]" type="number" min={min} max={max} step={step} value={form[k] ?? ''} onChange={(e) => field(k, NUM(e.target.value))} />}
                </CfgRow>
              ))}
              <SubHead>缓冲 / 退避</SubHead>
              {([['bufferCapacity', '缓冲条数', 20, 2000, 1], ['bufferTtlHours', '缓冲 TTL（小时）', 1, 72, 1], ['idleBackoffBaseSeconds', '退避基数（秒）', 1, 300, 1], ['idleBackoffCapSeconds', '退避上限（秒）', 10, 3600, 10], ['idleBackoffStartCount', '退避起始次数', 1, 20, 1]] as const).map(([k, label, min, max, step]) => (
                <CfgRow key={k} label={label}><Input className="w-[120px]" type="number" min={min} max={max} step={step} value={form[k] ?? ''} onChange={(e) => field(k, NUM(e.target.value))} /></CfgRow>
              ))}
            </CfgSection>

            <CfgSection id="hz-llm" title="Planner / Replyer" description="模型与生成预算；模型在配置中心的功能分配里选择">
              <CfgRow label="Planner 模型" hint="在配置中心 → 功能分配里设置。"><span className="mono text-[11px] text-ink-2">{form.planner?.model || '（留空=主模型）'}</span></CfgRow>
              <CfgRow label="Planner 最大轮数"><Input className="w-[120px]" type="number" min={1} max={6} value={form.maxPlannerRounds ?? ''} onChange={(e) => field('maxPlannerRounds', NUM(e.target.value))} /></CfgRow>
              <CfgRow label="Planner 超时（ms）"><Input className="w-[140px]" type="number" min={5000} max={120000} step={1000} value={form.plannerTimeoutMs ?? ''} onChange={(e) => field('plannerTimeoutMs', NUM(e.target.value))} /></CfgRow>
              <CfgRow label="Planner 温度"><div className="flex items-center gap-3"><input type="range" min={0} max={1} step={0.05} value={Number(form.planner?.temperature) || 0} onChange={(e) => field('planner.temperature', Number(e.target.value))} className="w-full accent-lagoon" /><span className="mono w-10 text-right text-[11px]">{Number(form.planner?.temperature || 0).toFixed(2)}</span></div></CfgRow>
              <CfgRow label="Planner maxTokens"><Input className="w-[120px]" type="number" min={200} value={form.planner?.maxTokens ?? ''} onChange={(e) => field('planner.maxTokens', NUM(e.target.value))} /></CfgRow>
              <CfgRow label="Planner 只读工具白名单" full><TagEditor value={form.planner?.allowedReadTools || []} onChange={(v) => field('planner.allowedReadTools', v)} placeholder="如 memory_search / web_search" mono /></CfgRow>
              <SubHead>Replyer</SubHead>
              <CfgRow label="Replyer 模型"><span className="mono text-[11px] text-ink-2">{form.replyer?.model || '（留空=主模型）'}</span></CfgRow>
              <CfgRow label="Replyer 温度"><div className="flex items-center gap-3"><input type="range" min={0} max={1} step={0.05} value={Number(form.replyer?.temperature) || 0} onChange={(e) => field('replyer.temperature', Number(e.target.value))} className="w-full accent-lagoon" /><span className="mono w-10 text-right text-[11px]">{Number(form.replyer?.temperature || 0).toFixed(2)}</span></div></CfgRow>
              <CfgRow label="Replyer maxTokens / maxChars"><div className="flex gap-2"><Input className="w-[100px]" type="number" min={100} value={form.replyer?.maxTokens ?? ''} onChange={(e) => field('replyer.maxTokens', NUM(e.target.value))} /><Input className="w-[100px]" type="number" min={100} value={form.replyer?.maxChars ?? ''} onChange={(e) => field('replyer.maxChars', NUM(e.target.value))} /></div></CfgRow>
            </CfgSection>

            <CfgSection id="hz-reply" title="发送编排" description="气泡数量、打字节奏与尾随表情">
              <CfgRow label="单次最多气泡"><Input className="w-[120px]" type="number" min={1} max={5} value={form.reply?.maxBubbles ?? ''} onChange={(e) => field('reply.maxBubbles', NUM(e.target.value))} /></CfgRow>
              <CfgRow label="输入速度倍率"><Input className="w-[120px]" type="number" min={0.1} max={3} step={0.1} value={form.reply?.typingSpeed ?? ''} onChange={(e) => field('reply.typingSpeed', NUM(e.target.value))} /></CfgRow>
              <CfgRow label="延迟范围（ms）"><div className="flex gap-2"><Input className="w-[100px]" type="number" min={0} value={form.reply?.minDelayMs ?? ''} onChange={(e) => field('reply.minDelayMs', NUM(e.target.value))} /><Input className="w-[100px]" type="number" min={100} value={form.reply?.maxDelayMs ?? ''} onChange={(e) => field('reply.maxDelayMs', NUM(e.target.value))} /></div></CfgRow>
              <CfgRow label="尾随表情包"><Switch checked={!!form.reply?.allowSticker} onChange={(v) => field('reply.allowSticker', v)} label="尾随表情包" /></CfgRow>
              <CfgRow label="自动错字" hint="首版强制关闭；关闭更安全。" danger><Switch checked={!!form.reply?.typos} onChange={(v) => field('reply.typos', v)} label="自动错字" /></CfgRow>
            </CfgSection>

            <CfgSection id="hz-policy" title="行为政策" description="关注主题、回避主题与主动性">
              <CfgRow label="关注主题" full><TagEditor value={form.behaviorPolicy?.topics || []} onChange={(v) => field('behaviorPolicy.topics', v)} placeholder="如 游戏 / AI / 项目" /></CfgRow>
              <CfgRow label="回避主题" full><TagEditor value={form.behaviorPolicy?.avoidTopics || []} onChange={(v) => field('behaviorPolicy.avoidTopics', v)} placeholder="不接的话题" /></CfgRow>
              <CfgRow label="主动性"><div className="flex items-center gap-3"><input type="range" min={0} max={1} step={0.05} value={Number(form.behaviorPolicy?.initiative) || 0} onChange={(e) => field('behaviorPolicy.initiative', Number(e.target.value))} className="w-full accent-lagoon" /><span className="mono w-10 text-right text-[11px]">{Number(form.behaviorPolicy?.initiative || 0).toFixed(2)}</span></div></CfgRow>
              <CfgRow label="幽默倾向"><div className="flex items-center gap-3"><input type="range" min={0} max={1} step={0.05} value={Number(form.behaviorPolicy?.humor) || 0} onChange={(e) => field('behaviorPolicy.humor', Number(e.target.value))} className="w-full accent-lagoon" /><span className="mono w-10 text-right text-[11px]">{Number(form.behaviorPolicy?.humor || 0).toFixed(2)}</span></div></CfgRow>
              <CfgRow label="回答不确定问题"><Switch checked={!!form.behaviorPolicy?.answerUnknownQuestions} onChange={(v) => field('behaviorPolicy.answerUnknownQuestions', v)} label="回答不确定问题" /></CfgRow>
              <CfgRow label="打断人类对话"><Switch checked={!!form.behaviorPolicy?.interruptHumanConversation} onChange={(v) => field('behaviorPolicy.interruptHumanConversation', v)} label="打断人类对话" /></CfgRow>
              <CfgRow label="群内最大回复 / 10 分钟"><Input className="w-[120px]" type="number" min={0} max={60} value={form.behaviorPolicy?.maxRepliesPer10Minutes ?? ''} onChange={(e) => field('behaviorPolicy.maxRepliesPer10Minutes', NUM(e.target.value))} /></CfgRow>
            </CfgSection>

            <CfgSection id="hz-safety" title="安全 / 红线" description="脱敏、私聊记忆与并发上限" icon={<ShieldCheck size={15} />}>
              <CfgRow label="发送前脱敏"><Switch checked={!!form.redactSecrets} onChange={(v) => field('redactSecrets', v)} label="发送前脱敏" /></CfgRow>
              <CfgRow label="私聊记忆注入群聊" hint="红线开关，固定关闭。" danger><Switch checked={!!form.safety?.privateMemoryInGroup} onChange={() => {}} label="私聊记忆注入群聊" disabled /></CfgRow>
              <CfgRow label="同时 Planning 群数上限"><Input className="w-[120px]" type="number" min={1} max={10} value={form.safety?.maxConcurrentGroups ?? ''} onChange={(e) => field('safety.maxConcurrentGroups', NUM(e.target.value))} /></CfgRow>
              <CfgRow label="允许抓取内网图片"><Switch checked={!!form.vision?.allowPrivateHosts} onChange={(v) => field('vision.allowPrivateHosts', v)} label="允许抓取内网图片" /></CfgRow>
              <SubHead>其它 bot / 独立记忆库</SubHead>
              <CfgRow label="已知其它 bot" full><TagEditor value={form.knownBots || []} onChange={(v) => field('knownBots', v)} placeholder="QQ号" mono /></CfgRow>
              <CfgRow label="启用伪人记忆库"><Switch checked={!!form.memory?.enabled} onChange={(v) => field('memory.enabled', v)} label="启用伪人记忆库" /></CfgRow>
              <CfgRow label="单次注入条数"><Input className="w-[120px]" type="number" min={1} value={form.memory?.maxPerQuery ?? ''} onChange={(e) => field('memory.maxPerQuery', NUM(e.target.value))} /></CfgRow>
              <CfgRow label="单群容量"><Input className="w-[120px]" type="number" min={50} value={form.memory?.maxPerGroup ?? ''} onChange={(e) => field('memory.maxPerGroup', NUM(e.target.value))} /></CfgRow>
              <CfgRow label="增量整合水位"><Input className="w-[120px]" type="number" min={4} value={form.memory?.incrementalMinMessages ?? ''} onChange={(e) => field('memory.incrementalMinMessages', NUM(e.target.value))} /></CfgRow>
              <CfgRow label="超龄遗忘（天）"><Input className="w-[120px]" type="number" min={7} value={form.memory?.forgetDays ?? ''} onChange={(e) => field('memory.forgetDays', NUM(e.target.value))} /></CfgRow>
              <Note tone="neutral">运行命令：<span className="mono">#伪人状态</span> · <span className="mono">#伪人决策 [n]</span> · <span className="mono">#伪人记忆 [群号]</span>。保存热加载并取消进行中的规划。</Note>
            </CfgSection>
          </div>
        </div>
      )}

      <SaveBar dirty={dirty} onReset={reset} onSave={() => void doSave()} busy={saving} />
    </div>
  )
}
