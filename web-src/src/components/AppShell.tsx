import { useEffect, useMemo, useRef, useState } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { AnimatePresence, motion } from 'motion/react'
import {
  ChevronRight, Command, LogOut, Menu, RefreshCw, Search, X,
} from 'lucide-react'
import { ALL_NAV, NAV } from '@/data/nav'
import { useAuth, useSignals } from '@/lib/auth'
import { cn } from '@/lib/cn'
import { BrandMark } from '@/components/Brand'
import { Button, Kbd } from '@/components/ui'
import { useAsync, useHotkey } from '@/lib/hooks'
import { api } from '@/lib/api'
import { CommandPalette } from '@/components/CommandPalette'

function NavItems({ onNavigate }: { onNavigate?: () => void }) {
  const { approvals, suggestions } = useSignals()
  return (
    <nav className="flex-1 overflow-y-auto px-3 pb-4" aria-label="主导航">
      {NAV.map((group) => (
        <div key={group.id} className="mb-5 last:mb-0">
          <div className="mb-1.5 flex items-center gap-2 px-3 text-[10px] font-semibold tracking-[.16em] text-ink-3">
            {group.name}
            <span className="h-px flex-1 bg-ink/8" />
          </div>
          <ul className="space-y-0.5">
            {group.items.map((item) => {
              const badge = item.badge === 'approvals' ? approvals : item.badge === 'suggestions' ? suggestions : 0
              const Icon = item.icon
              return (
                <li key={item.id}>
                  <NavLink
                    to={item.path}
                    onClick={onNavigate}
                    className={({ isActive }) => cn(
                      'group relative flex min-h-9 items-center gap-2.5 rounded-[10px] px-3 text-[12.5px] transition-colors',
                      isActive ? 'text-lagoon-deep' : 'text-ink-2 hover:bg-white/45 hover:text-ink',
                    )}
                  >
                    {({ isActive }) => (
                      <>
                        {isActive && (
                          <motion.span
                            layoutId="nav-lens"
                            className="absolute inset-0 rounded-[10px] border border-white/80 bg-[linear-gradient(120deg,rgba(255,255,255,.9),rgba(228,241,238,.72))] shadow-[0_8px_22px_-18px_rgba(10,78,74,.7),inset_0_1px_0_rgba(255,255,255,.9)]"
                            transition={{ type: 'spring', stiffness: 420, damping: 38 }}
                          />
                        )}
                        <Icon size={15.5} strokeWidth={isActive ? 2 : 1.75} className={cn('relative z-10 flex-none', isActive ? 'text-lagoon' : 'text-ink-3 group-hover:text-ink-2')} />
                        <span className="relative z-10 min-w-0 flex-1 truncate">{item.name}</span>
                        {badge > 0 && (
                          <span className={cn('relative z-10 mono min-w-[18px] rounded-full px-1.5 py-px text-center text-[9.5px] leading-[15px]', item.badge === 'approvals' ? 'bg-coral text-white' : 'bg-amber-soft text-amber')}>
                            {badge > 99 ? '99+' : badge}
                          </span>
                        )}
                      </>
                    )}
                  </NavLink>
                </li>
              )
            })}
          </ul>
        </div>
      ))}
    </nav>
  )
}

function Sidebar({ onOpenPalette }: { onOpenPalette: () => void }) {
  const { logout } = useAuth()
  return (
    <aside className="glass sticky top-0 hidden h-dvh w-[248px] flex-none flex-col overflow-hidden rounded-none border-y-0 border-l-0 border-r-white/60 lg:flex" aria-label="侧边栏">
      <div className="pointer-events-none absolute -left-24 -top-24 h-64 w-64 rounded-full bg-[radial-gradient(circle,rgba(127,201,190,.24),transparent_68%)] blur-2xl" />
      <div className="relative flex items-center gap-2.5 px-5 pb-5 pt-5">
        <BrandMark size={30} />
        <div className="min-w-0">
          <div className="truncate text-[13.5px] font-semibold tracking-[-0.02em]">agents-plugin</div>
          <div className="text-[9.5px] tracking-[.16em] text-ink-3">WATER COURT CONSOLE</div>
        </div>
      </div>
      <button className="mx-3 mb-4 flex min-h-[34px] items-center gap-2 rounded-[10px] border border-white/70 bg-white/40 px-3 text-[11.5px] text-ink-3 transition hover:bg-white/65 hover:text-ink-2" onClick={onOpenPalette}>
        <Search size={14} />
        <span className="flex-1 text-left">搜索页面与操作</span>
        <Kbd><Command size={9} />K</Kbd>
      </button>
      <NavItems />
      <div className="relative border-t border-white/60 px-3 py-3">
        <button className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-[11.5px] text-ink-3 transition hover:bg-white/45 hover:text-ink-2" onClick={logout}>
          <LogOut size={14} /> 退出登录
        </button>
        <div className="mt-1 flex items-center justify-between px-3 text-[9.5px] text-ink-4">
          <span>本地优先 · 无外部依赖</span>
          <span className="mono">v{__APP_VERSION__}</span>
        </div>
      </div>
    </aside>
  )
}

function RuntimeChip() {
  const { data, loading } = useAsync(() => api.get('/config'), [])
  const cfg = data || {}
  const provider = (cfg.llmProviders || []).find((p: any) => p.id === cfg.providerId)
  const model = cfg.model || ''
  const ready = !!(model && cfg.providerId)
  return (
    <div className="hidden items-center gap-2 md:flex" title={ready ? `${provider?.name || cfg.providerId} / ${model}` : '还没有选择基础模型'}>
      <span className={cn('status-dot', ready ? 'ok' : 'warn')} />
      <div className="leading-tight">
        <div className="text-[10.5px] text-ink-3">{ready ? '运行时' : '等待配置'}</div>
        <div className="mono max-w-[180px] truncate text-[10.5px] text-ink-2">{loading ? '读取中…' : ready ? model : '未接入模型'}</div>
      </div>
    </div>
  )
}

function TopBar({ onOpenPalette, onOpenMenu }: { onOpenPalette: () => void; onOpenMenu: () => void }) {
  const loc = useLocation()
  const item = ALL_NAV.find((n) => loc.pathname.startsWith(n.path))
  const group = NAV.find((g) => g.items.some((n) => n.path === item?.path))?.name || '运行'
  const [clock, setClock] = useState(() => new Date())
  useEffect(() => {
    const t = window.setInterval(() => setClock(new Date()), 30_000)
    return () => window.clearInterval(t)
  }, [])
  const onRefresh = () => window.dispatchEvent(new CustomEvent('agents:refresh'))
  return (
    <header className="topbar glass sticky top-0 z-30 flex h-[58px] items-center gap-3 rounded-none border-x-0 border-t-0 border-b-white/60 px-4 lg:px-6">
      <button className="btn btn-ghost btn-icon btn-sm lg:hidden" onClick={onOpenMenu} aria-label="打开导航">
        <Menu size={17} />
      </button>
      <div className="flex min-w-0 items-center gap-1.5 text-[11px] text-ink-3">
        <span className="hidden sm:inline">{group}</span>
        <ChevronRight size={12} className="hidden sm:block" />
        <span className="truncate text-[12px] font-medium text-ink-2">{item?.name || '概览'}</span>
      </div>
      <button
        className="mx-auto hidden h-8 w-full max-w-[340px] items-center gap-2 rounded-[9px] border border-white/70 bg-white/35 px-3 text-[11.5px] text-ink-3 transition hover:bg-white/60 hover:text-ink-2 md:flex"
        onClick={onOpenPalette}
      >
        <Search size={13} />
        <span className="flex-1 text-left">跳到页面、搜索操作</span>
        <Kbd><Command size={9} />K</Kbd>
      </button>
      <div className="ml-auto flex items-center gap-3">
        <RuntimeChip />
        <span className="hidden h-6 w-px bg-ink/10 md:block" />
        <span className="mono hidden text-[11px] tabular-nums text-ink-3 sm:block">
          {clock.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })}
        </span>
        <Button variant="ghost" size="icon" className="btn-sm" onClick={onRefresh} aria-label="刷新当前页" title="刷新当前页">
          <RefreshCw size={14} />
        </Button>
      </div>
    </header>
  )
}

function MobileMenu({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const prev = document.body.style.overflow
    const prevFocus = document.activeElement as HTMLElement | null
    document.body.style.overflow = 'hidden'
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); return }
      if (e.key !== 'Tab' || !ref.current) return
      const items = [...ref.current.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input, [tabindex]:not([tabindex="-1"])')].filter((el) => el.offsetParent !== null)
      if (!items.length) return
      const first = items[0], last = items[items.length - 1]
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', onKey)
    window.setTimeout(() => ref.current?.querySelector<HTMLElement>('a[href], button')?.focus(), 30)
    return () => { document.body.style.overflow = prev; document.removeEventListener('keydown', onKey); prevFocus?.focus?.() }
  }, [open, onClose])
  if (!open) return null
  return (
    <>
      <motion.div className="overlay lg:hidden" initial={{ opacity: 0 }} animate={{ opacity: 1 }} onClick={onClose} />
      <motion.div
        ref={ref}
        className="fixed inset-y-0 left-0 z-[62] flex w-[min(84vw,320px)] flex-col overflow-hidden bg-paper-2 shadow-2xl lg:hidden"
        role="dialog" aria-modal="true" aria-label="导航"
        initial={{ x: -24, opacity: 0 }} animate={{ x: 0, opacity: 1 }} transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
      >
        <div className="flex items-center gap-2.5 border-b border-line-soft px-4 py-4">
          <BrandMark size={28} />
          <div className="text-[13px] font-semibold">agents-plugin</div>
          <button className="btn btn-ghost btn-icon btn-sm ml-auto" onClick={onClose} aria-label="关闭导航"><X size={16} /></button>
        </div>
        <NavItems onNavigate={onClose} />
      </motion.div>
    </>
  )
}

function MobileDock({ onOpenMenu, onOpenPalette }: { onOpenMenu: () => void; onOpenPalette: () => void }) {
  const { approvals } = useSignals()
  const items = [
    { path: '/dashboard', name: '概览', icon: ALL_NAV.find((n) => n.id === 'dashboard')!.icon },
    { path: '/confirm', name: '审批', icon: ALL_NAV.find((n) => n.id === 'confirm')!.icon, badge: approvals },
    { path: '/memory', name: '记忆', icon: ALL_NAV.find((n) => n.id === 'memory')!.icon },
    { path: '/sessions', name: '会话', icon: ALL_NAV.find((n) => n.id === 'sessions')!.icon },
  ]
  return (
    <div className="fixed inset-x-0 bottom-0 z-40 border-t border-white/70 bg-white/78 px-2 pb-[max(8px,env(safe-area-inset-bottom))] pt-1.5 backdrop-blur-xl lg:hidden">
      <div className="grid grid-cols-6 gap-0.5">
        {items.map((it) => {
          const Icon = it.icon
          return (
            <NavLink key={it.path} to={it.path} className={({ isActive }) => cn('relative flex flex-col items-center gap-0.5 rounded-lg py-1.5 text-[9.5px]', isActive ? 'text-lagoon' : 'text-ink-3')}>
              <Icon size={18} strokeWidth={2} />
              {it.name}
              {!!it.badge && <span className="mono absolute right-[22%] top-0 min-w-3 rounded-full bg-coral px-1 text-[8px] leading-3 text-white">{it.badge > 9 ? '9+' : it.badge}</span>}
            </NavLink>
          )
        })}
        <button className="flex flex-col items-center gap-0.5 rounded-lg py-1.5 text-[9.5px] text-ink-3" onClick={onOpenPalette}>
          <Search size={18} strokeWidth={2} />搜索
        </button>
        <button className="flex flex-col items-center gap-0.5 rounded-lg py-1.5 text-[9.5px] text-ink-3" onClick={onOpenMenu}>
          <Menu size={18} strokeWidth={2} />更多
        </button>
      </div>
    </div>
  )
}

export function AppShell() {
  const [palette, setPalette] = useState(false)
  const [menu, setMenu] = useState(false)
  const location = useLocation()
  const navigate = useNavigate()
  const mainRef = useRef<HTMLElement>(null)

  useHotkey('mod+k', () => setPalette(true))
  useEffect(() => {
    window.scrollTo({ top: 0 })
    window.setTimeout(() => { try { mainRef.current?.focus?.({ preventScroll: true }) } catch { /* noop */ } }, 30)
  }, [location.pathname])

  useEffect(() => {
    const onRefresh = () => window.dispatchEvent(new CustomEvent('agents:reload-page'))
    window.addEventListener('agents:refresh', onRefresh)
    return () => window.removeEventListener('agents:refresh', onRefresh)
  }, [])

  const page = ALL_NAV.find((n) => location.pathname.startsWith(n.path))
  const pageKey = page?.id || 'dashboard'
  return (
    <div className="flex min-h-dvh">
      <button type="button" onClick={() => mainRef.current?.focus()} className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[100] focus:rounded-lg focus:bg-white focus:px-4 focus:py-2 focus:text-[13px]">跳到主要内容</button>
      <Sidebar onOpenPalette={() => setPalette(true)} />
      <div className="min-w-0 flex-1">
        <TopBar onOpenPalette={() => setPalette(true)} onOpenMenu={() => setMenu(true)} />
        <main id="main" ref={mainRef} tabIndex={-1} className="outline-none">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={pageKey}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
            >
              <Outlet />
            </motion.div>
          </AnimatePresence>
        </main>
      </div>
      <MobileDock onOpenMenu={() => setMenu(true)} onOpenPalette={() => setPalette(true)} />
      <MobileMenu open={menu} onClose={() => setMenu(false)} />
      <CommandPalette
        open={palette}
        onClose={() => setPalette(false)}
        onNavigate={(path) => { setPalette(false); navigate(path) }}
      />
    </div>
  )
}
