import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'motion/react'
import { AlertTriangle, Check, Info, X } from 'lucide-react'
import { cn } from '@/lib/cn'

/* ───────────────────────────── toasts ───────────────────────────── */

type ToastTone = 'success' | 'error' | 'info' | 'warn'
type ToastItem = { id: number; message: string; tone: ToastTone }
type ToastFn = (message: string, tone?: ToastTone) => void

const ToastContext = createContext<ToastFn>(() => {})
export const useToast = () => useContext(ToastContext)

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([])
  const seq = useRef(1)
  const toast = useCallback<ToastFn>((message, tone = 'info') => {
    const id = seq.current++
    setItems((xs) => [...xs.slice(-3), { id, message: String(message || ''), tone }])
    window.setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), 4200)
  }, [])
  return (
    <ToastContext.Provider value={toast}>
      {children}
      {createPortal(
        <div className="pointer-events-none fixed right-4 top-4 z-[90] flex w-[min(380px,calc(100vw-32px))] flex-col gap-2" aria-live="polite" aria-atomic="false">
          <AnimatePresence initial={false}>
            {items.map((t) => (
              <motion.div
                key={t.id}
                initial={{ opacity: 0, y: -8, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -6, scale: 0.98 }}
                transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
                className="pointer-events-auto flex items-start gap-2.5 rounded-xl border border-white/80 bg-white/90 px-3.5 py-2.5 text-[12.5px] text-ink shadow-[0_18px_44px_-28px_rgba(10,60,56,.5)] backdrop-blur-xl"
                role={t.tone === 'error' ? 'alert' : 'status'}
              >
                <span className={cn('mt-0.5 flex h-4 w-4 flex-none items-center justify-center rounded-full',
                  t.tone === 'success' && 'bg-jade/10 text-jade',
                  t.tone === 'error' && 'bg-coral/10 text-coral',
                  t.tone === 'warn' && 'bg-amber/10 text-amber',
                  t.tone === 'info' && 'bg-lagoon/10 text-lagoon')}>
                  {t.tone === 'success' ? <Check size={11} strokeWidth={2.6} /> : t.tone === 'error' || t.tone === 'warn' ? <AlertTriangle size={11} strokeWidth={2.4} /> : <Info size={11} strokeWidth={2.4} />}
                </span>
                <span className="min-w-0 flex-1 leading-relaxed break-words">{t.message}</span>
                <button className="mt-0.5 rounded p-0.5 text-ink-3 hover:text-ink" onClick={() => setItems((xs) => xs.filter((x) => x.id !== t.id))} aria-label="关闭提示">
                  <X size={12} />
                </button>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>,
        document.body,
      )}
    </ToastContext.Provider>
  )
}

/* ───────────────────────────── confirm ───────────────────────────── */

export type ConfirmOptions = {
  title: string
  message?: ReactNode
  confirmText?: string
  cancelText?: string
  danger?: boolean
  requireText?: string
}

type ConfirmFn = (opts: ConfirmOptions) => Promise<boolean>
const ConfirmContext = createContext<ConfirmFn>(async () => false)
export const useConfirm = () => useContext(ConfirmContext)

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<{ opts: ConfirmOptions; resolve: (v: boolean) => void } | null>(null)
  const [typed, setTyped] = useState('')
  const confirm = useCallback<ConfirmFn>((opts) => new Promise<boolean>((resolve) => {
    setTyped('')
    setState({ opts, resolve })
  }), [])
  const close = (v: boolean) => {
    if (!state) return
    state.resolve(v)
    setState(null)
  }
  const can = !state?.opts.requireText || typed.trim() === state.opts.requireText

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <Dialog
        open={!!state}
        onClose={() => close(false)}
        title={state?.opts.title || '确认操作'}
        description={typeof state?.opts.message === 'string' ? state.opts.message : undefined}
        width={520}
        footer={(
          <>
            <button className="btn btn-secondary" onClick={() => close(false)}>{state?.opts.cancelText || '取消'}</button>
            <button className={cn('btn', state?.opts.danger ? 'btn-danger' : 'btn-primary')} disabled={!can} onClick={() => close(true)}>
              {state?.opts.confirmText || '确认'}
            </button>
          </>
        )}
      >
        {state && typeof state.opts.message !== 'string' && (
          <div className="text-[13px] leading-relaxed text-ink-2">{state.opts.message}</div>
        )}
        {state?.opts.requireText && (
          <label className="mt-4 block">
            <span className="field-hint mb-1.5 block">输入 <span className="mono text-ink">{state.opts.requireText}</span> 以继续</span>
            <input className="input" value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus aria-label="确认文本" />
          </label>
        )}
        {state?.opts.danger && !state.opts.requireText && (
          <p className="mt-4 flex items-center gap-2 rounded-lg bg-coral/5 px-3 py-2 text-[12px] text-coral">
            <AlertTriangle size={14} /> 此操作不可撤销，请确认影响范围。
          </p>
        )}
      </Dialog>
    </ConfirmContext.Provider>
  )
}

/* ───────────────────────────── dialog / drawer ───────────────────────────── */

function useOverlay(open: boolean, onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const prev = document.activeElement as HTMLElement | null
    const body = document.body
    const old = body.style.overflow
    body.style.overflow = 'hidden'
    const t = window.setTimeout(() => {
      const first = ref.current?.querySelector<HTMLElement>('input:not([type=hidden]), textarea, select, button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])')
      ;(first || ref.current)?.focus?.()
    }, 30)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose() }
      if (e.key !== 'Tab' || !ref.current) return
      const items = [...ref.current.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])')]
        .filter((el) => el.offsetParent !== null || el === document.activeElement)
      if (!items.length) return
      const first = items[0], last = items[items.length - 1]
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      window.clearTimeout(t)
      document.removeEventListener('keydown', onKey)
      body.style.overflow = old
      prev?.focus?.()
    }
  }, [open, onClose])
  return ref
}

export function Dialog({
  open, onClose, title, description, children, footer, width = 560, className,
}: {
  open: boolean; onClose: () => void; title: ReactNode; description?: ReactNode;
  children: ReactNode; footer?: ReactNode; width?: number; className?: string
}) {
  const ref = useOverlay(open, onClose)
  const id = useId()
  if (!open) return null
  return createPortal(
    <>
      <motion.div className="overlay" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} />
      <motion.div
        ref={ref}
        className={cn('dialog', className)}
        style={{ width: `min(${width}px, calc(100vw - 32px))` }}
        role="dialog" aria-modal="true" aria-labelledby={id} tabIndex={-1}
        initial={{ opacity: 0, y: 12, scale: 0.985 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 8, scale: 0.99 }}
        transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
      >
        <div className="dialog-head">
          <div className="min-w-0">
            <h2 id={id} className="text-[16px] font-semibold tracking-[-0.02em]">{title}</h2>
            {description && <p className="mt-1 text-[12.5px] leading-relaxed text-ink-2">{description}</p>}
          </div>
          <button className="btn btn-ghost btn-icon btn-sm -mr-1 -mt-1" onClick={onClose} aria-label="关闭"><X size={16} /></button>
        </div>
        <div className="dialog-body">{children}</div>
        {footer && <div className="dialog-foot">{footer}</div>}
      </motion.div>
    </>,
    document.body,
  )
}

export function Drawer({
  open, onClose, title, description, children, footer, width = 560,
}: {
  open: boolean; onClose: () => void; title: ReactNode; description?: ReactNode;
  children: ReactNode; footer?: ReactNode; width?: number
}) {
  const ref = useOverlay(open, onClose)
  const id = useId()
  if (!open) return null
  return createPortal(
    <>
      <motion.div className="overlay" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} />
      <motion.aside
        ref={ref}
        className="drawer"
        style={{ width: `min(${width}px, 100vw)` }}
        role="dialog" aria-modal="true" aria-labelledby={id} tabIndex={-1}
        initial={{ x: 32, opacity: 0 }} animate={{ x: 0, opacity: 1 }} exit={{ x: 24, opacity: 0 }}
        transition={{ duration: 0.24, ease: [0.16, 1, 0.3, 1] }}
      >
        <div className="dialog-head border-b border-line-soft">
          <div className="min-w-0">
            <h2 id={id} className="text-[16px] font-semibold tracking-[-0.02em]">{title}</h2>
            {description && <p className="mt-1 text-[12.5px] leading-relaxed text-ink-2">{description}</p>}
          </div>
          <button className="btn btn-ghost btn-icon btn-sm -mr-1 -mt-1" onClick={onClose} aria-label="关闭"><X size={16} /></button>
        </div>
        <div className="flex-1 overflow-auto px-5 py-4">{children}</div>
        {footer && <div className="dialog-foot">{footer}</div>}
      </motion.aside>
    </>,
    document.body,
  )
}
