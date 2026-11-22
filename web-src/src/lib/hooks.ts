import { useCallback, useEffect, useRef, useState } from 'react'

export type AsyncState<T> = {
  data: T | null
  error: string
  loading: boolean
  reload: () => Promise<T | null>
  setData: React.Dispatch<React.SetStateAction<T | null>>
}

export function useAsync<T>(fn: () => Promise<T>, deps: unknown[], options: { immediate?: boolean } = {}): AsyncState<T> {
  const immediate = options.immediate !== false
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(immediate)
  const seq = useRef(0)
  const fnRef = useRef(fn)
  fnRef.current = fn

  const reload = useCallback(async () => {
    const run = ++seq.current
    setLoading(true)
    setError('')
    try {
      const d = await fnRef.current()
      if (run === seq.current) {
        setData(d)
        setLoading(false)
      }
      return d
    } catch (e: any) {
      if (run === seq.current) {
        setError(e?.message || String(e))
        setLoading(false)
      }
      return null
    }
  }, [])

  useEffect(() => {
    if (!immediate) return
    void reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)

  return { data, error, loading, reload, setData }
}

export function useDebounced<T>(value: T, delay = 250): T {
  const [v, setV] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setV(value), delay)
    return () => clearTimeout(t)
  }, [value, delay])
  return v
}

export function useCopy(): [boolean, (text: string) => Promise<boolean>] {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const copy = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => setCopied(false), 1600)
      return true
    } catch {
      try {
        const ta = document.createElement('textarea')
        ta.value = text
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        document.execCommand('copy')
        ta.remove()
        setCopied(true)
        if (timer.current) clearTimeout(timer.current)
        timer.current = setTimeout(() => setCopied(false), 1600)
        return true
      } catch { return false }
    }
  }, [])
  return [copied, copy]
}

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches)
  useEffect(() => {
    const mq = window.matchMedia(query)
    const on = () => setMatches(mq.matches)
    on()
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [query])
  return matches
}

export function useInterval(fn: () => void, ms: number | null) {
  const ref = useRef(fn)
  ref.current = fn
  useEffect(() => {
    if (!ms) return
    const t = setInterval(() => ref.current(), ms)
    return () => clearInterval(t)
  }, [ms])
}

export function useDocumentTitle(title: string) {
  useEffect(() => {
    document.title = title ? `${title} · agents-plugin` : 'agents-plugin · 运行控制台'
  }, [title])
}

export function useHotkey(combo: string, handler: (e: KeyboardEvent) => void) {
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const parts = combo.toLowerCase().split('+')
      const key = parts[parts.length - 1]
      const meta = parts.includes('mod') ? (e.metaKey || e.ctrlKey) : true
      const shift = parts.includes('shift') ? e.shiftKey : true
      if (meta && shift && e.key.toLowerCase() === key) {
        e.preventDefault()
        handler(e)
      }
    }
    window.addEventListener('keydown', on)
    return () => window.removeEventListener('keydown', on)
  }, [combo, handler])
}

/** Re-run a loader when the shell's refresh button fires. */
export function useReloadEvent(fn: () => void) {
  const ref = useRef(fn)
  ref.current = fn
  useEffect(() => {
    const on = () => ref.current()
    window.addEventListener('agents:reload-page', on)
    return () => window.removeEventListener('agents:reload-page', on)
  }, [])
}
