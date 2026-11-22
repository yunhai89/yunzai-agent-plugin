import { lazy, Suspense } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import { Loader2 } from 'lucide-react'
import { AppShell } from '@/components/AppShell'
import { LoginGate } from '@/components/LoginGate'
import { useAuth, SignalsProvider } from '@/lib/auth'
import { BrandMark } from '@/components/Brand'
const DashboardPage = lazy(() => import('@/pages/DashboardPage').then((m) => ({ default: m.DashboardPage })))
const ConfirmPage = lazy(() => import('@/pages/ConfirmPage').then((m) => ({ default: m.ConfirmPage })))
const TasksPage = lazy(() => import('@/pages/TasksPage').then((m) => ({ default: m.TasksPage })))
const SchedulePage = lazy(() => import('@/pages/SchedulePage').then((m) => ({ default: m.SchedulePage })))
const SuggestionsPage = lazy(() => import('@/pages/SuggestionsPage').then((m) => ({ default: m.SuggestionsPage })))
const EvolutionPage = lazy(() => import('@/pages/EvolutionPage').then((m) => ({ default: m.EvolutionPage })))
const MemoryPage = lazy(() => import('@/pages/MemoryPage').then((m) => ({ default: m.MemoryPage })))
const RecallPage = lazy(() => import('@/pages/RecallPage').then((m) => ({ default: m.RecallPage })))
const ProfilePage = lazy(() => import('@/pages/ProfilePage').then((m) => ({ default: m.ProfilePage })))
const PersonasPage = lazy(() => import('@/pages/PersonasPage').then((m) => ({ default: m.PersonasPage })))
const SkillsPage = lazy(() => import('@/pages/SkillsPage').then((m) => ({ default: m.SkillsPage })))
const KnowledgePage = lazy(() => import('@/pages/KnowledgePage').then((m) => ({ default: m.KnowledgePage })))
const SessionsPage = lazy(() => import('@/pages/SessionsPage').then((m) => ({ default: m.SessionsPage })))
const LogsPage = lazy(() => import('@/pages/LogsPage').then((m) => ({ default: m.LogsPage })))
const ConfigPage = lazy(() => import('@/pages/ConfigPage').then((m) => ({ default: m.ConfigPage })))
const QQBotPage = lazy(() => import('@/pages/QQBotPage').then((m) => ({ default: m.QQBotPage })))
const ToolPacksPage = lazy(() => import('@/pages/ToolPacksPage').then((m) => ({ default: m.ToolPacksPage })))
const TTSPage = lazy(() => import('@/pages/TTSPage').then((m) => ({ default: m.TTSPage })))
const HumanizePage = lazy(() => import('@/pages/HumanizePage').then((m) => ({ default: m.HumanizePage })))
const GroupWorldPage = lazy(() => import('@/pages/GroupWorldPage').then((m) => ({ default: m.GroupWorldPage })))
const SelfStatePage = lazy(() => import('@/pages/SelfStatePage').then((m) => ({ default: m.SelfStatePage })))
const StickerPage = lazy(() => import('@/pages/StickerPage').then((m) => ({ default: m.StickerPage })))

export function App() {
  const { authed, checking } = useAuth()

  if (!authed) {
    return checking ? <BootSplash /> : <LoginGate />
  }
  if (checking) return <BootSplash />

  return (
    <SignalsProvider>
      <Suspense fallback={<RouteFallback />}>
      <Routes>
        <Route element={<AppShell />}>
          <Route path="/" element={<Navigate to="/dashboard" replace />} />
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/confirm" element={<ConfirmPage />} />
          <Route path="/tasks" element={<TasksPage />} />
          <Route path="/schedule" element={<SchedulePage />} />
          <Route path="/suggestions" element={<SuggestionsPage />} />
          <Route path="/evolution" element={<EvolutionPage />} />
          <Route path="/memory" element={<MemoryPage />} />
          <Route path="/recall" element={<RecallPage />} />
          <Route path="/profile" element={<ProfilePage />} />
          <Route path="/personas" element={<PersonasPage />} />
          <Route path="/skills" element={<SkillsPage />} />
          <Route path="/kb" element={<KnowledgePage />} />
          <Route path="/sessions" element={<SessionsPage />} />
          <Route path="/logs" element={<LogsPage />} />
          <Route path="/config" element={<ConfigPage />} />
          <Route path="/qqbot" element={<QQBotPage />} />
          <Route path="/toolpacks" element={<ToolPacksPage />} />
          <Route path="/tts" element={<TTSPage />} />
          <Route path="/humanize" element={<HumanizePage />} />
          <Route path="/groupworld" element={<GroupWorldPage />} />
          <Route path="/selfstate" element={<SelfStatePage />} />
          <Route path="/sticker" element={<StickerPage />} />
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Route>
      </Routes>
      </Suspense>
    </SignalsProvider>
  )
}

function RouteFallback() {
  return (
    <div className="page" role="status" aria-label="正在加载页面">
      <div className="skeleton mb-3 h-8 w-40" />
      <div className="skeleton mb-6 h-4 w-80 max-w-full" />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div className="skeleton h-64" /><div className="skeleton h-64" />
      </div>
    </div>
  )
}

function BootSplash() {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-4">
      <BrandMark size={44} />
      <div className="flex items-center gap-2 text-[12px] text-ink-3"><Loader2 size={14} className="animate-spin" /> 正在验证控制台令牌…</div>
    </div>
  )
}
