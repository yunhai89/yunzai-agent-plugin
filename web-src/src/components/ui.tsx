import { cloneElement, forwardRef, isValidElement, useId, useState, type ReactElement, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react'
import { Check, ChevronDown, Copy, Loader2, Search, X } from 'lucide-react'
import { cn } from '@/lib/cn'
import { useCopy } from '@/lib/hooks'

/* ───────────────────────────── buttons ───────────────────────────── */

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger'
type Size = 'sm' | 'md' | 'lg' | 'icon'

export const Button = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant; size?: Size; loading?: boolean; icon?: ReactNode
}>(({ variant = 'secondary', size = 'md', loading, icon, className, children, disabled, ...rest }, ref) => (
  <button
    ref={ref}
    className={cn('btn', {
      'btn-primary': variant === 'primary',
      'btn-secondary': variant === 'secondary',
      'btn-ghost': variant === 'ghost',
      'btn-danger': variant === 'danger',
      'btn-sm': size === 'sm',
      'btn-lg': size === 'lg',
      'btn-icon': size === 'icon',
    }, className)}
    disabled={disabled || loading}
    {...rest}
  >
    {loading ? <Loader2 className="animate-spin" size={15} /> : icon}
    {children}
  </button>
))
Button.displayName = 'Button'

/* ───────────────────────────── status ───────────────────────────── */

export function StatusDot({ tone = 'neutral', pulse = false, label }: { tone?: 'ok' | 'warn' | 'bad' | 'neutral'; pulse?: boolean; label?: string }) {
  return (
    <span className="inline-flex items-center gap-1.5" title={label}>
      <span className={cn('status-dot', tone === 'ok' && 'ok', tone === 'warn' && 'warn', tone === 'bad' && 'bad', pulse && tone === 'ok' && 'animate-pulse')} />
      {label && <span className="text-[11.5px] text-ink-2">{label}</span>}
    </span>
  )
}

export function Tag({ tone = 'neutral', children, className }: { tone?: 'neutral' | 'jade' | 'amber' | 'coral' | 'lagoon'; children: ReactNode; className?: string }) {
  return <span className={cn('tag', `tag-${tone}`, className)}>{children}</span>
}

/* ───────────────────────────── page chrome ───────────────────────────── */

export function PageHeader({ title, description, actions, meta }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; meta?: ReactNode }) {
  return (
    <header className="page-head">
      <div className="min-w-0">
        <h1 className="page-title">{title}</h1>
        {description && <p className="page-sub">{description}</p>}
        {meta && <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11.5px] text-ink-3">{meta}</div>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </header>
  )
}

export function SectionTitle({ children, hint, action }: { children: ReactNode; hint?: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
      <div>
        <h2 className="section-title">{children}</h2>
        {hint && <p className="mt-0.5 text-[11.5px] text-ink-3">{hint}</p>}
      </div>
      {action}
    </div>
  )
}

export function EmptyState({ icon, title, children, action }: { icon?: ReactNode; title: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      {icon}
      <strong>{title}</strong>
      {children && <p>{children}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  )
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="error-box" role="alert">
      <span className="flex-1">{message}</span>
      {onRetry && <button className="font-medium underline underline-offset-2" onClick={onRetry}>重试</button>}
    </div>
  )
}

export function Spinner({ label = '加载中' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-12 text-[12px] text-ink-3" role="status">
      <Loader2 size={15} className="animate-spin" /> {label}
    </div>
  )
}

export function Skeleton({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return <div className={cn('skeleton', className)} style={style} aria-hidden="true" />
}

export function LoadingBlock({ rows = 5 }: { rows?: number }) {
  return (
    <div className="space-y-2.5 py-3" aria-label="加载中" role="status">
      {Array.from({ length: rows }).map((_, i) => <Skeleton key={i} className="h-9 w-full" style={{ opacity: 1 - i * 0.1 } as any} />)}
    </div>
  )
}

/* ───────────────────────────── form controls ───────────────────────────── */

export function Field({ label, hint, children, className, htmlFor }: { label?: ReactNode; hint?: ReactNode; children: ReactNode; className?: string; htmlFor?: string }) {
  const labelText = typeof label === 'string' ? label : undefined
  const control = labelText && !htmlFor && isValidElement(children)
    ? cloneElement(children as ReactElement<any>, {
        'aria-label': (children.props as any)['aria-label'] || labelText,
      })
    : children
  return (
    <div className={cn('field', className)}>
      {label && <label className="field-label" htmlFor={htmlFor}>{label}</label>}
      {control}
      {hint && <p className="field-hint">{hint}</p>}
    </div>
  )
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { icon?: ReactNode; suffix?: ReactNode; invalid?: boolean }>(
  ({ className, icon, suffix, invalid, ...rest }, ref) => {
    if (icon) {
      return (
        <div className="input-wrap">
          {icon}
          <input ref={ref} className={cn('input', invalid && 'border-coral/50', className)} aria-invalid={invalid || undefined} {...rest} />
          {suffix}
        </div>
      )
    }
    return <input ref={ref} className={cn('input', invalid && 'border-coral/50', className)} aria-invalid={invalid || undefined} {...rest} />
  },
)
Input.displayName = 'Input'

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(({ className, ...rest }, ref) => (
  <textarea ref={ref} className={cn('textarea', className)} {...rest} />
))
Textarea.displayName = 'Textarea'

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={cn('select', className)} {...rest}>{children}</select>
}

export function SearchInput({ value, onChange, placeholder = '搜索', className }: { value: string; onChange: (v: string) => void; placeholder?: string; className?: string }) {
  return (
    <Input
      className={className}
      type="search"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      icon={<Search />}
      aria-label={placeholder}
    />
  )
}

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled}
      data-on={checked} className={cn('switch', disabled && 'opacity-50')}
      onClick={() => onChange(!checked)}
    />
  )
}

export function Segmented<T extends string>({ value, options, onChange, ariaLabel }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; ariaLabel?: string }) {
  return (
    <div className="segmented" role="group" aria-label={ariaLabel}>
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={value === o.value} onClick={() => onChange(o.value)}>{o.label}</button>
      ))}
    </div>
  )
}

export function CopyButton({ text, label = '复制', className }: { text: string; label?: string; className?: string }) {
  const [copied, copy] = useCopy()
  return (
    <button type="button" className={cn('btn btn-ghost btn-sm', className)} onClick={() => copy(text)}>
      {copied ? <Check size={13} /> : <Copy size={13} />}{copied ? '已复制' : label}
    </button>
  )
}

export function TagEditor({ value, onChange, placeholder = '回车添加', mono, id, ariaLabel }: { value: string[]; onChange: (v: string[]) => void; placeholder?: string; mono?: boolean; id?: string; ariaLabel?: string }) {
  const [text, setText] = useState('')
  const add = () => {
    const t = text.trim()
    if (!t) return
    if (!value.includes(t)) onChange([...value, t])
    setText('')
  }
  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-[10px] border border-line bg-white/60 p-1.5 focus-within:border-lagoon/45 focus-within:ring-2 focus-within:ring-lagoon/10">
      {value.map((t, i) => (
        <span key={`${t}-${i}`} className={cn('tag tag-neutral', mono && 'mono')}>
          {t}
          <button type="button" onClick={() => onChange(value.filter((_, j) => j !== i))} aria-label={`移除 ${t}`} className="rounded p-0.5 hover:text-coral"><X size={9} /></button>
        </span>
      ))}
      <input
        id={id}
        className={cn('h-6 min-w-[110px] flex-1 bg-transparent px-1 text-[11.5px] outline-none placeholder:text-ink-4', mono && 'mono')}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); add() }
        }}
        placeholder={placeholder}
        aria-label={ariaLabel || placeholder}
      />
      <button type="button" className="rounded-md px-1.5 py-0.5 text-[10px] text-ink-3 hover:bg-white/70 hover:text-ink" onClick={add}>添加</button>
    </div>
  )
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="mono inline-flex h-5 min-w-5 items-center justify-center rounded border border-line bg-white/60 px-1 text-[10px] text-ink-3">{children}</kbd>
}

/* ───────────────────────────── collapsible ───────────────────────────── */

export function Disclosure({ summary, children, defaultOpen = false, meta }: { summary: ReactNode; children: ReactNode; defaultOpen?: boolean; meta?: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen)
  const id = useId()
  return (
    <div className="border-b border-line-soft last:border-0">
      <button type="button" className="flex w-full items-center gap-2 py-3 text-left" aria-expanded={open} aria-controls={id} onClick={() => setOpen((v) => !v)}>
        <span className="min-w-0 flex-1">{summary}</span>
        {meta}
        <ChevronDown size={15} className={cn('flex-none text-ink-3 transition-transform', open && 'rotate-180')} />
      </button>
      {open && <div id={id} className="pb-4">{children}</div>}
    </div>
  )
}

/* ───────────────────────────── misc ───────────────────────────── */

export function KeyValue({ label, children, mono }: { label: ReactNode; children: ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-line-soft py-2 last:border-0">
      <span className="text-[11.5px] text-ink-3">{label}</span>
      <span className={cn('min-w-0 text-right text-[12px] text-ink', mono && 'mono')}>{children}</span>
    </div>
  )
}

export function InlineError({ children }: { children: ReactNode }) {
  return <p className="flex items-center gap-1.5 text-[11.5px] text-coral"><X size={12} />{children}</p>
}
