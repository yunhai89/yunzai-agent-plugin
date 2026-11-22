import { cloneElement, isValidElement, useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { api } from '@/lib/api'
import { useAsync } from '@/lib/hooks'
import { useToast } from '@/components/Overlay'
import { Button } from '@/components/ui'
import { RotateCcw, Save } from 'lucide-react'
import { cn } from '@/lib/cn'

export function deepClone<T>(v: T): T {
  if (typeof structuredClone === 'function') {
    try { return structuredClone(v) } catch { /* fall through */ }
  }
  return JSON.parse(JSON.stringify(v))
}

export function isPlainObject(v: unknown): v is Record<string, any> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

export function deepMerge<T = any>(base: any, patch: any): T {
  if (!isPlainObject(base) || !isPlainObject(patch)) return (patch === undefined ? deepClone(base) : deepClone(patch)) as T
  const out: any = deepClone(base)
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue
    if (isPlainObject(v) && isPlainObject(out[k])) out[k] = deepMerge(out[k], v)
    else out[k] = deepClone(v)
  }
  return out as T
}

export function getPath(obj: any, path: string): any {
  if (!path) return obj
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj)
}

export function setPathImmutable<T>(obj: T, path: string, value: any): T {
  const keys = path.split('.')
  const root: any = Array.isArray(obj) ? [...(obj as any)] : { ...(obj as any) }
  let cur: any = root
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i]
    const next = cur[k]
    cur[k] = Array.isArray(next) ? [...next] : isPlainObject(next) ? { ...next } : {}
    cur = cur[k]
  }
  cur[keys[keys.length - 1]] = value
  return root as T
}

export function removePathImmutable<T>(obj: T, path: string): T {
  const keys = path.split('.')
  const root: any = Array.isArray(obj) ? [...(obj as any)] : { ...(obj as any) }
  let cur: any = root
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i]
    const next = cur[k]
    cur[k] = Array.isArray(next) ? [...next] : isPlainObject(next) ? { ...next } : {}
    cur = cur[k]
  }
  delete cur[keys[keys.length - 1]]
  return root as T
}

/** Parse an input that represents a number; '' means unset. */
export function parseNum(v: unknown): number | null {
  if (v === '' || v === null || v === undefined) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

export type DiffOptions = {
  /** Numeric inputs cleared to empty become null instead of being skipped. */
  nullClearedNumbers?: boolean
  /** Subtree paths compared as a single value (e.g. mcp.servers). */
  wholePaths?: string[]
  /** Skip keys/prefixes entirely. */
  skipPaths?: string[]
}

export function diffPaths(orig: any, next: any, prefix = '', options: DiffOptions = {}): Record<string, any> {
  const out: Record<string, any> = {}
  const whole = new Set(options.wholePaths || [])
  const skip = options.skipPaths || []
  const walk = (a: any, b: any, path: string) => {
    if (skip.some((s) => path === s || path.startsWith(s + '.'))) return
    if (whole.has(path)) {
      if (JSON.stringify(a) !== JSON.stringify(b)) out[prefix ? `${prefix}.${path}` : path] = deepClone(b)
      return
    }
    if (isPlainObject(a) && isPlainObject(b)) {
      const keys = new Set([...Object.keys(a), ...Object.keys(b)])
      for (const k of keys) walk(a[k], b[k], path ? `${path}.${k}` : k)
      return
    }
    if (Array.isArray(a) && Array.isArray(b)) {
      if (JSON.stringify(a) !== JSON.stringify(b)) out[prefix ? `${prefix}.${path}` : path] = deepClone(b)
      return
    }
    if (typeof a === 'number') {
      if (b === '' && options.nullClearedNumbers) {
        out[prefix ? `${prefix}.${path}` : path] = null
        return
      }
      if (b === '' || b === null || b === undefined) return
      const n = Number(b)
      if (!Number.isFinite(n)) return
      if (n !== a) out[prefix ? `${prefix}.${path}` : path] = n
      return
    }
    if (b === '' && typeof a !== 'string') return
    if (JSON.stringify(a) !== JSON.stringify(b)) out[prefix ? `${prefix}.${path}` : path] = deepClone(b)
  }
  walk(orig ?? {}, next ?? {}, '')
  return out
}

/** Config form over GET /api/config; subtree is relative to `agent`. */
export function useAgentConfig<T extends Record<string, any>>(subtree: string | null, defaults: T) {
  const toast = useToast()
  const res = useAsync(() => api.get('/config'), [])
  const [form, setForm] = useState<T>(() => deepClone(defaults))
  const [orig, setOrig] = useState<T>(() => deepClone(defaults))
  const [ready, setReady] = useState(false)
  const loadedRef = useRef(false)

  useEffect(() => {
    if (!res.data || loadedRef.current) return
    const src = subtree ? res.data?.[subtree] : res.data
    const merged = deepMerge(defaults, src || {})
    setForm(merged)
    setOrig(deepClone(merged))
    setReady(true)
    loadedRef.current = true
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [res.data])

  const dirty = useMemo(() => JSON.stringify(form) !== JSON.stringify(orig), [form, orig])

  const field = useCallback((path: string, value: any) => {
    setForm((f) => setPathImmutable(f, path, value))
  }, [])

  const refresh = useCallback(async () => {
    const fresh = await api.get('/config')
    const src = subtree ? fresh?.[subtree] : fresh
    const merged = deepMerge(defaults, src || {})
    setForm(merged)
    setOrig(deepClone(merged))
    res.setData(fresh)
    setReady(true)
    loadedRef.current = true
    return fresh
  }, [subtree, defaults, res])

  const reset = useCallback(() => {
    setForm(deepClone(orig))
    toast('已还原为当前生效配置', 'info')
  }, [orig, toast])

  const save = useCallback(async (opts: { prefix?: string; message?: string; wholePaths?: string[]; extra?: Record<string, any> } = {}) => {
    const prefix = opts.prefix ?? (subtree ? `agent.${subtree}` : 'agent')
    const changes = diffPaths(orig, form, prefix, { nullClearedNumbers: true, wholePaths: opts.wholePaths })
    Object.assign(changes, opts.extra || {})
    if (!Object.keys(changes).length) {
      toast('无改动', 'warn')
      return false
    }
    await api.put('/config', { changes })
    const fresh = await api.get('/config')
    const src = subtree ? fresh?.[subtree] : fresh
    const merged = deepMerge(defaults, src || {})
    setForm(merged)
    setOrig(deepClone(merged))
    res.setData(fresh)
    toast(opts.message || '已保存（已热加载）', 'success')
    return true
  }, [orig, form, subtree, defaults, toast, res])

  return { form, setForm, field, orig, setOrig, dirty, ready, loading: res.loading, error: res.error, reload: res.reload, refresh, reset, save, raw: res.data }
}

export function SaveBar({ dirty, onReset, onSave, busy, label = '保存（热加载）' }: { dirty: boolean; onReset: () => void; onSave: () => void; busy?: boolean; label?: string }) {
  if (!dirty) return null
  return (
    <div className="fixed bottom-[calc(72px+env(safe-area-inset-bottom))] left-1/2 z-50 flex w-[min(560px,calc(100vw-24px))] -translate-x-1/2 items-center gap-3 rounded-[14px] border border-white/80 bg-white/90 px-3 py-2.5 shadow-[0_24px_60px_-28px_rgba(10,60,56,.5)] backdrop-blur-xl lg:bottom-6">
      <span className="relative ml-1 flex h-2 w-2 flex-none">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-vermilion/60" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-vermilion" />
      </span>
      <span className="min-w-0 flex-1 text-[11.5px] text-ink-2">有未保存的修改</span>
      <Button variant="ghost" size="sm" onClick={onReset} disabled={busy} icon={<RotateCcw size={13} />}>还原</Button>
      <Button variant="primary" size="sm" onClick={onSave} loading={busy} icon={<Save size={13} />}>{label}</Button>
    </div>
  )
}

/** Config row: label/hint on the left, control on the right. */
export function CfgRow({ label, hint, children, full, danger, htmlFor, path, highlight }: { label: React.ReactNode; hint?: React.ReactNode; children: React.ReactNode; full?: boolean; danger?: boolean; htmlFor?: string; path?: string; highlight?: boolean }) {
  const labelText = typeof label === 'string' ? label : undefined
  const control = labelText && !htmlFor && isValidElement(children)
    ? cloneElement(children as ReactElement<any>, { 'aria-label': (children.props as any)['aria-label'] || labelText })
    : children
  return (
    <div className={full ? 'sm:col-span-2' : ''} data-cf-row="1" data-cf-name={typeof label === 'string' ? label : undefined} data-cf-desc={typeof hint === 'string' ? hint : undefined} data-cf-path={path}>
      <div className={cn('flex flex-col gap-1.5 border-b border-line-soft py-3.5 last:border-0 sm:flex-row sm:items-start sm:justify-between sm:gap-8', highlight && 'rounded-md bg-amber-soft/50 px-2')}>
        <div className="min-w-0 sm:max-w-[54%]">
          <label htmlFor={htmlFor} className="flex flex-wrap items-center gap-1.5 text-[12.5px] font-medium text-ink">
            {label}
            {danger && <span className="tag tag-coral !min-h-[17px] !px-1.5 !text-[9px]">高危</span>}
          </label>
          {hint && <p className="mt-1 text-[11px] leading-relaxed text-ink-3">{hint}</p>}
        </div>
        <div className="w-full min-w-0 sm:max-w-[46%] sm:shrink-0">{control}</div>
      </div>
    </div>
  )
}

export function CfgSection({ id, title, description, children, defaultOpen = false, icon, open: controlledOpen, onToggle }: { id: string; title: string; description?: string; children: React.ReactNode; defaultOpen?: boolean; icon?: React.ReactNode; open?: boolean; onToggle?: () => void }) {
  const [innerOpen, setInnerOpen] = useState(defaultOpen)
  const open = controlledOpen ?? innerOpen
  const toggle = () => { if (onToggle) onToggle(); else setInnerOpen((v) => !v) }
  return (
    <section id={id} className="panel scroll-mt-24 overflow-hidden">
      <button type="button" className="flex w-full items-center gap-3 px-5 py-4 text-left" aria-expanded={open} onClick={toggle}>
        {icon && <span className="flex h-8 w-8 flex-none items-center justify-center rounded-lg bg-lagoon/7 text-lagoon">{icon}</span>}
        <span className="min-w-0 flex-1">
          <span className="block text-[13.5px] font-semibold tracking-[-0.01em]">{title}</span>
          {description && <span className="mt-0.5 block text-[11px] leading-relaxed text-ink-3">{description}</span>}
        </span>
        <span className="text-[10px] text-ink-3">{open ? '收起' : '展开'}</span>
      </button>
      {open && <div className="border-t border-line-soft px-5 py-1.5">{children}</div>}
    </section>
  )
}

export function SubHead({ children, hint }: { children: React.ReactNode; hint?: React.ReactNode }) {
  return (
    <div className="mb-2 mt-5 flex items-baseline justify-between gap-3 border-b border-line-soft pb-1.5 first:mt-0">
      <h3 className="text-[11px] font-semibold tracking-[.06em] text-ink-3">{children}</h3>
      {hint && <span className="text-[10px] text-ink-4">{hint}</span>}
    </div>
  )
}

export function Note({ tone = 'neutral', children }: { tone?: 'neutral' | 'amber' | 'coral' | 'lagoon'; children: React.ReactNode }) {
  return (
    <div className={[
      'rounded-[10px] border px-3 py-2 text-[11.5px] leading-relaxed',
      tone === 'amber' ? 'border-amber/20 bg-amber-soft/70 text-amber' : '',
      tone === 'coral' ? 'border-coral/20 bg-coral-soft/70 text-coral' : '',
      tone === 'lagoon' ? 'border-lagoon/15 bg-lagoon-soft/60 text-lagoon-deep' : '',
      tone === 'neutral' ? 'border-line-soft bg-white/45 text-ink-2' : '',
    ].join(' ')}>{children}</div>
  )
}
