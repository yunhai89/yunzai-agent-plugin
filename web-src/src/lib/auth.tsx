import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { api, getToken, setToken, takeUrlToken } from '@/lib/api'

type AuthState = {
  authed: boolean
  checking: boolean
  login: (raw: string) => Promise<void>
  logout: () => void
}

const AuthContext = createContext<AuthState>({
  authed: false, checking: true, login: async () => {}, logout: () => {},
})

export const useAuth = () => useContext(AuthContext)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [initialAuthed] = useState(() => { takeUrlToken(); return !!getToken() })
  const [authed, setAuthed] = useState(initialAuthed)
  const [checking, setChecking] = useState(initialAuthed)
  const verifiedRef = useRef(false)

  useEffect(() => {
    if (getToken()) setAuthed(true)
  }, [])

  useEffect(() => {
    if (!authed) { setChecking(false); return }
    if (verifiedRef.current) { setChecking(false); return }
    let alive = true
    setChecking(true)
    api.get('/config')
      .then(() => { if (alive) setChecking(false) })
      .catch(() => { if (alive) { setAuthed(false); setChecking(false) } })
    return () => { alive = false }
  }, [authed])

  useEffect(() => {
    const onNeed = () => setAuthed(false)
    window.addEventListener('agents:need-login', onNeed)
    return () => window.removeEventListener('agents:need-login', onNeed)
  }, [])

  const login = useCallback(async (raw: string) => {
    const tk = setToken(raw)
    if (!tk) {
      setToken('')
      throw new Error('令牌格式不正确：请粘贴完整登录地址或其中 16–128 位的令牌。')
    }
    setChecking(true)
    try {
      await api.get('/config')
      verifiedRef.current = true
      setAuthed(true)
    } catch (e) {
      setToken('')
      setAuthed(false)
      throw e
    } finally {
      setChecking(false)
    }
  }, [])

  const logout = useCallback(() => {
    setToken('')
    setAuthed(false)
    setChecking(false)
  }, [])

  const value = useMemo(() => ({ authed, checking, login, logout }), [authed, checking, login, logout])
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

type Signals = {
  approvals: number
  suggestions: number
  refresh: () => Promise<void>
}

const SignalsContext = createContext<Signals>({ approvals: 0, suggestions: 0, refresh: async () => {} })
export const useSignals = () => useContext(SignalsContext)

export function SignalsProvider({ children }: { children: ReactNode }) {
  const [approvals, setApprovals] = useState(0)
  const [suggestions, setSuggestions] = useState(0)

  const refresh = useCallback(async () => {
    const [confirms, adoptions, sugg] = await Promise.allSettled([
      api.get('/confirm'),
      api.get('/persona-adoptions', { status: 'pending' }),
      api.get('/suggestions', { status: 'pending' }),
    ])
    const c = confirms.status === 'fulfilled' && Array.isArray(confirms.value) ? confirms.value.length : 0
    const a = adoptions.status === 'fulfilled' && Array.isArray(adoptions.value) ? adoptions.value.length : 0
    const s = sugg.status === 'fulfilled' && Array.isArray(sugg.value) ? sugg.value.length : 0
    setApprovals(c + a)
    setSuggestions(s)
  }, [])

  useEffect(() => {
    void refresh()
    const t = window.setInterval(() => { void refresh() }, 60_000)
    return () => window.clearInterval(t)
  }, [refresh])

  const value = useMemo(() => ({ approvals, suggestions, refresh }), [approvals, suggestions, refresh])
  return <SignalsContext.Provider value={value}>{children}</SignalsContext.Provider>
}
