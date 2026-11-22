import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'motion/react'
import { CornerDownLeft, LogOut, RefreshCw, Search } from 'lucide-react'
import { ALL_NAV, NAV } from '@/data/nav'
import { cn } from '@/lib/cn'
import { useAuth } from '@/lib/auth'
import { Kbd } from '@/components/ui'

type Action = { id: string; label: string; hint?: string; icon: any; run: () => void; group: string }

export function CommandPalette({ open, onClose, onNavigate }: { open: boolean; onClose: () => void; onNavigate: (path: string) => void }) {
  const [q, setQ] = useState('')
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const prevFocus = useRef<HTMLElement | null>(null)
  const { logout } = useAuth()

  const actions = useMemo<Action[]>(() => {
    const nav = ALL_NAV.map((item) => {
      const group = NAV.find((g) => g.items.some((n) => n.id === item.id))?.name || ''
      return {
        id: `nav-${item.id}`,
        label: item.name,
        hint: item.description,
        group,
        icon: item.icon,
        run: () => onNavigate(item.path),
      }
    })
    const extras: Action[] = [
      { id: 'refresh', label: '刷新当前页', hint: '重新读取数据', group: '操作', icon: RefreshCw, run: () => { window.dispatchEvent(new CustomEvent('agents:reload-page')); onClose() } },
      { id: 'logout', label: '退出登录', hint: '清除本机令牌', group: '操作', icon: LogOut, run: () => { logout(); onClose() } },
    ]
    return [...nav, ...extras]
  }, [onNavigate, onClose, logout])

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase()
    if (!s) return actions.slice(0, 12)
    return actions.filter((a) => `${a.label} ${a.hint || ''} ${a.group}`.toLowerCase().includes(s)).slice(0, 14)
  }, [actions, q])

  useEffect(() => {
    if (open) {
      setQ('')
      setActive(0)
      prevFocus.current = document.activeElement as HTMLElement | null
      window.setTimeout(() => inputRef.current?.focus(), 30)
      const prev = document.body.style.overflow
      document.body.style.overflow = 'hidden'
      return () => { document.body.style.overflow = prev; prevFocus.current?.focus?.() }
    }
  }, [open])

  useEffect(() => { setActive(0) }, [q])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose() }
      if (e.key === 'ArrowDown') { e.preventDefault(); setActive((v) => Math.min(filtered.length - 1, v + 1)) }
      if (e.key === 'ArrowUp') { e.preventDefault(); setActive((v) => Math.max(0, v - 1)) }
      if (e.key === 'Enter') { e.preventDefault(); filtered[active]?.run() }
      if (e.key === 'Tab' && panelRef.current) {
        const items = [...panelRef.current.querySelectorAll<HTMLElement>('input, button:not([disabled]), [href]')].filter((el) => el.offsetParent !== null)
        if (!items.length) return
        const first = items[0], last = items[items.length - 1]
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, filtered, active, onClose])

  if (!open) return null
  return createPortal(
    <>
      <motion.div className="overlay z-[70]" initial={{ opacity: 0 }} animate={{ opacity: 1 }} onClick={onClose} />
      <motion.div
        ref={panelRef}
        className="fixed left-1/2 top-[12vh] z-[71] w-[min(620px,calc(100vw-28px))] -translate-x-1/2 overflow-hidden rounded-[16px] border border-white/85 bg-[linear-gradient(170deg,#fffefa,#f7f9f5)] shadow-[0_40px_100px_-40px_rgba(10,50,47,.55)]"
        role="dialog" aria-modal="true" aria-label="命令面板"
        initial={{ opacity: 0, y: -8, scale: 0.99 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
      >
        <div className="flex items-center gap-2 border-b border-line-soft px-4">
          <Search size={16} className="text-ink-3" />
          <input
            ref={inputRef}
            className="h-12 w-full bg-transparent text-[13.5px] outline-none placeholder:text-ink-4"
            placeholder="搜索页面、配置与操作…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            aria-label="搜索页面与操作"
          />
          <Kbd>ESC</Kbd>
        </div>
        <div className="max-h-[52vh] overflow-y-auto p-2">
          {filtered.length === 0 ? (
            <div className="px-4 py-10 text-center text-[12px] text-ink-3">没有匹配的页面或操作</div>
          ) : filtered.map((a, i) => {
            const Icon = a.icon
            return (
              <button
                key={a.id}
                className={cn('flex w-full items-center gap-3 rounded-[9px] px-3 py-2.5 text-left', i === active ? 'bg-lagoon-soft' : 'hover:bg-ink/4')}
                onMouseEnter={() => setActive(i)}
                onClick={a.run}
              >
                <Icon size={15} className={i === active ? 'text-lagoon' : 'text-ink-3'} />
                <span className="min-w-0 flex-1">
                  <span className="block text-[12.5px] font-medium text-ink">{a.label}</span>
                  {a.hint && <span className="block truncate text-[10.5px] text-ink-3">{a.hint}</span>}
                </span>
                <span className="text-[9.5px] tracking-[.08em] text-ink-4">{a.group}</span>
                {i === active && <CornerDownLeft size={13} className="text-lagoon" />}
              </button>
            )
          })}
        </div>
        <div className="flex items-center gap-3 border-t border-line-soft px-4 py-2 text-[9.5px] text-ink-4">
          <span><Kbd>↑</Kbd> <Kbd>↓</Kbd> 选择</span>
          <span><Kbd>↵</Kbd> 打开</span>
          <span className="ml-auto">页面与操作</span>
        </div>
      </motion.div>
    </>,
    document.body,
  )
}
