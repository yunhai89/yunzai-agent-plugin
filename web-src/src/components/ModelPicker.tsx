import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown, Loader2, RefreshCw } from 'lucide-react'
import { api } from '@/lib/api'
import { cn } from '@/lib/cn'

export type ProviderModel = { id: string; name?: string }
export type ModelOption = { id: string; label?: string; meta?: string; rowId?: string }

type ProviderLike = {
  id?: string
  name?: string
  protocol?: string
  preset?: string
  baseURL?: string
  apiKey?: string
}

type Item = ModelOption & { source: 'local' | 'provider' }

/** 厂商模型目录缓存：同一份厂商配置 5 分钟内复用，避免每行/每次切换都打厂商接口。 */
const CACHE_TTL_MS = 5 * 60 * 1000
const cache = new Map<string, { at: number; list: ProviderModel[] }>()

function cacheKey(p: ProviderLike): string {
  return [p.id, p.protocol, p.preset, p.baseURL, p.apiKey].map((v) => String(v ?? '')).join('\u0000')
}

function providerReady(p?: ProviderLike | null): boolean {
  return !!(p && (p.baseURL || p.preset) && p.apiKey)
}

async function fetchProviderModels(p: ProviderLike, force = false, signal?: AbortSignal): Promise<ProviderModel[]> {
  const key = cacheKey(p)
  const hit = cache.get(key)
  if (!force && hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.list
  const list = await api.get<ProviderModel[]>('/models', {
    protocol: p.protocol || 'openai',
    preset: p.preset || '',
    baseURL: p.baseURL || '',
    apiKey: p.apiKey || '',
  }, signal)
  const arr = (Array.isArray(list) ? list : [])
    .filter((m) => m && typeof m.id === 'string' && m.id)
    .map((m) => ({ id: m.id, ...(m.name ? { name: String(m.name) } : {}) }))
  cache.set(key, { at: Date.now(), list: arr })
  return arr
}

/**
 * 模型 ID 组合框：输入框本身就是下拉入口，既能手输，也能从「模型列表」已有条目
 * 或当前厂商返回的模型目录中选择。下拉永远可打开，不再用 disabled 挡住加载态。
 */
export function ModelCombobox({
  value = '',
  onChange,
  provider,
  localOptions = [],
  allowRemote = true,
  className,
  placeholder = '模型 ID（可手输或选择）',
  ariaLabel = '模型 ID',
}: {
  value?: string
  onChange: (id: string) => void
  provider?: ProviderLike | null
  localOptions?: ModelOption[]
  allowRemote?: boolean
  className?: string
  placeholder?: string
  ariaLabel?: string
}) {
  const listId = useId()
  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const suppressFocus = useRef(false)
  const requestSeq = useRef(0)
  const remoteFor = useRef('')
  const remoteTried = useRef('')
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(-1)
  // 下拉通过 portal 挂到 body：配置文件的长面板都有 overflow-hidden，内联 absolute 会被裁掉。
  // 使用文档坐标（rect + scroll），滚动时重新计算，避免 position:fixed 在 iOS 软键盘下漂移。
  const [pos, setPos] = useState<{ top: number; left: number; width: number; maxHeight: number; up: boolean } | null>(null)
  const [remoteList, setRemoteList] = useState<ProviderModel[]>([])
  const [remoteLoading, setRemoteLoading] = useState(false)
  const [remoteError, setRemoteError] = useState('')

  const ready = providerReady(provider)
  const pKey = provider ? cacheKey(provider) : ''

  useEffect(() => () => { requestSeq.current += 1 }, [])

  useEffect(() => {
    remoteFor.current = ''
    remoteTried.current = ''
    setRemoteList([])
    setRemoteError('')
    setRemoteLoading(false)
    if (!pKey) return
    const hit = cache.get(pKey)
    if (hit) {
      setRemoteList(hit.list)
      if (Date.now() - hit.at < CACHE_TTL_MS) remoteFor.current = pKey
    }
  }, [pKey])

  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node
      if (!rootRef.current?.contains(target) && !panelRef.current?.contains(target)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const updatePlacement = () => {
    const el = rootRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const vv = window.visualViewport
    const viewTop = vv?.offsetTop ?? 0
    const viewLeft = vv?.offsetLeft ?? 0
    const viewWidth = vv?.width ?? window.innerWidth
    const viewHeight = vv?.height ?? window.innerHeight
    const pad = 8
    const width = Math.max(220, Math.min(r.width, 560, viewWidth - pad * 2))
    const left = Math.min(Math.max(r.left, viewLeft + pad), viewLeft + viewWidth - width - pad)
    const spaceBelow = viewTop + viewHeight - r.bottom - pad
    const spaceAbove = r.top - viewTop - pad
    // 上下都紧张时选空间更大的一侧；maxHeight 必须服从实际空间，不能强行给下限把面板顶出视口。
    const up = spaceAbove > spaceBelow && spaceAbove >= 96
    const maxHeight = Math.max(60, Math.min(340, up ? spaceAbove : spaceBelow))
    setPos({
      top: (up ? r.top - 6 : r.bottom + 6) + window.scrollY,
      left: left + window.scrollX,
      width,
      maxHeight,
      up,
    })
  }

  useEffect(() => {
    if (!open) return
    const update = () => updatePlacement()
    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    window.visualViewport?.addEventListener('resize', update)
    window.visualViewport?.addEventListener('scroll', update)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
      window.visualViewport?.removeEventListener('resize', update)
      window.visualViewport?.removeEventListener('scroll', update)
    }
  }, [open])

  useEffect(() => {
    if (!open || active < 0) return
    listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [active, open])

  const loadProviderModels = async (force = false) => {
    if (!allowRemote || !provider || !ready) return
    const key = cacheKey(provider)
    const seq = ++requestSeq.current
    remoteTried.current = key
    setRemoteLoading(true)
    setRemoteError('')
    const ctrl = new AbortController()
    const timeoutMs = /commandcode/i.test(`${provider.preset || ''} ${provider.baseURL || ''}`) ? 65_000 : 20_000
    const timer = window.setTimeout(() => ctrl.abort(), timeoutMs)
    try {
      const list = await fetchProviderModels(provider, force, ctrl.signal)
      if (seq !== requestSeq.current) return
      remoteFor.current = key
      setRemoteList(list)
    } catch (e: any) {
      if (seq !== requestSeq.current) return
      setRemoteError(e?.name === 'AbortError' ? `拉取超时（${Math.round(timeoutMs / 1000)} 秒），可重试` : (e?.message || '拉取厂商模型失败'))
    } finally {
      window.clearTimeout(timer)
      if (seq === requestSeq.current) setRemoteLoading(false)
    }
  }

  const openMenu = (resetQuery = true) => {
    setOpen(true)
    if (resetQuery) setQuery('')
    setActive(-1)
    updatePlacement()
    if (!allowRemote || !provider || !ready) return
    const key = cacheKey(provider)
    const hit = cache.get(key)
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
      remoteFor.current = key
      setRemoteList(hit.list)
      return
    }
    if (hit) remoteTried.current = '' // 缓存过期：允许自动刷新一次
    if (remoteFor.current !== key && remoteTried.current !== key && !remoteLoading) void loadProviderModels(!!hit)
  }

  const items = useMemo<Item[]>(() => {
    const q = query.trim().toLowerCase()
    const ok = (id: string, label?: string) => !q || id.toLowerCase().includes(q) || String(label || '').toLowerCase().includes(q)
    const seen = new Set<string>()
    const local: Item[] = []
    for (const o of localOptions) {
      const id = String(o.id || '').trim()
      if (!id || seen.has(id) || !ok(id, o.label)) continue
      seen.add(id)
      local.push({ ...o, id, source: 'local' })
    }
    const remote: Item[] = []
    for (const m of remoteList) {
      const id = String(m.id || '').trim()
      if (!id || seen.has(id) || !ok(id, m.name)) continue
      seen.add(id)
      remote.push({ id, label: m.name || '', meta: provider?.name ? `${provider.name} 返回` : '厂商返回', source: 'provider' })
    }
    return [...local, ...remote]
  }, [localOptions, query, remoteList, provider?.name])

  // 打开时把当前值滚到可视区（厂商目录可能几十条），不改变用户后续的键盘选择。
  useEffect(() => {
    if (!open || active >= 0) return
    const idx = items.findIndex((it) => it.id === value)
    if (idx >= 0) setActive(idx)
  }, [open, items, value, active])

  const choose = (id: string) => {
    onChange(id)
    setOpen(false)
    setQuery('')
    setActive(-1)
    suppressFocus.current = true
    inputRef.current?.focus({ preventScroll: true })
    window.setTimeout(() => { suppressFocus.current = false }, 0)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (!open) openMenu()
      else setActive((i) => Math.min(items.length - 1, i + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (!open) openMenu()
      else setActive((i) => Math.max(0, i - 1))
    } else if (e.key === 'Enter' && open) {
      e.preventDefault()
      if (active >= 0 && items[active]) choose(items[active].id)
      else setOpen(false)
    } else if (e.key === 'Escape' && open) {
      e.preventDefault()
      setOpen(false)
    } else if (e.key === 'Tab') {
      setOpen(false)
    }
  }

  const providerName = String(provider?.name || '').trim()
  const remoteHint = !allowRemote
    ? ''
    : !provider
      ? '选择厂商后可拉取厂商模型'
      : !provider.apiKey
        ? '填好 API Key 后可拉取厂商模型'
        : remoteLoading
          ? (providerName ? `正在拉取 ${providerName} 模型…` : '正在拉取厂商模型…')
          : remoteError
            ? remoteError
            : remoteList.length
              ? `已从${providerName ? ` ${providerName} ` : '厂商'}加载 ${remoteList.length} 个模型`
              : '从厂商拉取模型目录'

  return (
    <div ref={rootRef} className={cn('relative w-full min-w-0', className)} onKeyDown={onKeyDown}>
      <div className="relative">
        <input
          ref={inputRef}
          className="input mono w-full pr-10"
          role="combobox"
          aria-label={ariaLabel}
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-haspopup="listbox"
          aria-activedescendant={open && active >= 0 ? `${listId}-${active}` : undefined}
          autoComplete="off"
          spellCheck={false}
          value={value}
          placeholder={placeholder}
          onFocus={() => {
            if (suppressFocus.current) { suppressFocus.current = false; return }
            openMenu()
          }}
          onChange={(e) => {
            const next = e.target.value
            onChange(next)
            setQuery(next)
            if (!open) openMenu(false)
            setActive(-1)
          }}
        />
        <button
          type="button"
          className="absolute right-1 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-md text-ink-3 transition hover:bg-ink/5 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lagoon/25"
          aria-label={open ? '收起模型列表' : '展开模型列表'}
          aria-expanded={open}
          onClick={() => { if (open) setOpen(false); else openMenu() }}
        >
          <ChevronDown size={15} className={cn('transition-transform', open && 'rotate-180')} />
        </button>
      </div>

      {open && pos && createPortal(
        <div
          ref={panelRef}
          style={{
            top: pos.top,
            left: pos.left,
            width: pos.width,
            maxHeight: pos.maxHeight,
            transform: pos.up ? 'translateY(-100%)' : undefined,
          }}
          className="absolute z-[80] flex flex-col overflow-hidden rounded-xl border border-line-soft bg-white shadow-[0_24px_56px_-30px_rgba(10,60,56,.45)]"
        >
          <div className="flex flex-none items-center justify-between gap-2 border-b border-line-soft px-2.5 py-1.5">
            <span className="text-[10px] font-semibold tracking-[.08em] text-ink-3">选择模型 ID</span>
            <span className="mono text-[9.5px] text-ink-3">{items.length} 个可选</span>
          </div>
          <div
            ref={listRef}
            id={listId}
            role="listbox"
            aria-label={ariaLabel}
            className="min-h-0 flex-1 overflow-y-auto p-1"
            style={{ maxHeight: Math.max(96, pos.maxHeight - 62) }}
          >
            {items.length === 0 ? (
              <div className="px-2.5 py-3 text-[11px] leading-relaxed text-ink-3">
                {query ? '没有匹配的模型，可直接回车确认手输值。' : '还没有可选的模型；先在「模型列表」登记，或从厂商拉取。'}
              </div>
            ) : items.map((it, i) => {
              const selected = value === it.id
              return (
                <button
                  key={`${it.source}:${it.id}`}
                  id={`${listId}-${i}`}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  data-idx={i}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left transition-colors',
                    i === active ? 'bg-lagoon-soft text-lagoon-deep' : 'hover:bg-white/80',
                  )}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => choose(it.id)}
                >
                  <span className="min-w-0 flex-1">
                    <span className="mono block truncate text-[12px]">{it.id}</span>
                    {(it.label || it.meta) && (
                      <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[10px] text-ink-3">
                        {it.label && <span className="truncate">{it.label}</span>}
                        {it.meta && <span className="truncate">{it.label ? '· ' : ''}{it.meta}</span>}
                      </span>
                    )}
                  </span>
                  {it.source === 'provider' && <span className="tag tag-neutral !min-h-[17px] !px-1.5 !text-[9px]">厂商</span>}
                  {selected && <Check size={13} className="flex-none text-lagoon" />}
                </button>
              )
            })}
          </div>
          {allowRemote && (
            <div className="flex-none border-t border-line-soft px-2.5 py-1.5">
              {ready ? (
                <button
                  type="button"
                  className="flex w-full items-center gap-1.5 rounded-md px-1 py-1 text-left text-[10.5px] text-ink-3 transition hover:text-lagoon"
                  onClick={() => void loadProviderModels(true)}
                  disabled={remoteLoading}
                >
                  {remoteLoading ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}
                  <span className={cn('min-w-0 flex-1 truncate', remoteError && 'text-coral')}>{remoteHint}{remoteLoading ? '' : ' · 刷新'}</span>
                </button>
              ) : (
                <p className="px-1 py-1 text-[10.5px] text-ink-3">{remoteHint}</p>
              )}
            </div>
          )}
        </div>,
        document.body,
      )}
    </div>
  )
}
