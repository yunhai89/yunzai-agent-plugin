import { useEffect, useRef, useState } from 'react'
import { Pause, Play } from 'lucide-react'

export function AudioPlayer({ src, label }: { src: string; label?: string }) {
  const ref = useRef<HTMLAudioElement>(null)
  const [playing, setPlaying] = useState(false)
  const [time, setTime] = useState(0)
  const [duration, setDuration] = useState(0)

  useEffect(() => {
    setPlaying(false); setTime(0); setDuration(0)
  }, [src])

  const toggle = async () => {
    const a = ref.current
    if (!a) return
    if (a.paused) {
      try { await a.play(); setPlaying(true) } catch { setPlaying(false) }
    } else {
      a.pause(); setPlaying(false)
    }
  }

  const mmss = (v: number) => { if (!Number.isFinite(v)) return '0:00'; const m = Math.floor(v / 60); const s = Math.floor(v % 60); return `${m}:${String(s).padStart(2, '0')}` }
  return (
    <div className="flex items-center gap-2 rounded-lg border border-line-soft bg-white/55 px-2 py-1.5">
      <audio
        ref={ref}
        src={src}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => { setPlaying(false); setTime(0) }}
        onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => setDuration(e.currentTarget.duration || 0)}
      />
      <button type="button" className="flex h-6 w-6 flex-none items-center justify-center rounded-full bg-lagoon text-white transition hover:bg-lagoon-deep" onClick={() => void toggle()} aria-label={playing ? `暂停 ${label || '音频'}` : `播放 ${label || '音频'}`}>
        {playing ? <Pause size={11} fill="currentColor" /> : <Play size={11} fill="currentColor" className="ml-0.5" />}
      </button>
      <input
        type="range" min={0} max={duration || 1} step={0.05} value={Math.min(time, duration || 1)}
        onChange={(e) => { const a = ref.current; if (a) { a.currentTime = Number(e.target.value); setTime(Number(e.target.value)) } }}
        className="min-w-0 flex-1 accent-lagoon" aria-label={`${label || '音频'} 进度`}
      />
      <span className="mono w-[72px] flex-none text-right text-[9px] tabular-nums text-ink-3">
        {mmss(time)} / {duration ? mmss(duration) : '—'}
      </span>
    </div>
  )
}
