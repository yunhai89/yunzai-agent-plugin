import { useEffect, useMemo, useRef, useState } from 'react'
import { motion } from 'motion/react'
import { cn } from '@/lib/cn'
import { fmtNum, num } from '@/lib/format'

type Point = { label: string; value: number; meta?: string }

function useWidth() {
  const ref = useRef<HTMLDivElement>(null)
  const [w, setW] = useState(720)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) => {
      const width = Math.round(entry.contentRect.width)
      if (width > 0) setW(width)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, w] as const
}

function niceMax(v: number) {
  if (!v || v <= 0) return 1
  const p = Math.pow(10, Math.floor(Math.log10(v)))
  const n = v / p
  return (n <= 1 ? 1 : n <= 1.5 ? 1.5 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p
}

function smoothPath(points: [number, number][]) {
  if (!points.length) return ''
  if (points.length === 1) return `M${points[0][0]} ${points[0][1]}`
  const d: string[] = [`M${points[0][0].toFixed(2)} ${points[0][1].toFixed(2)}`]
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] || points[i]
    const p1 = points[i]
    const p2 = points[i + 1]
    const p3 = points[i + 2] || p2
    const c1x = p1[0] + (p2[0] - p0[0]) / 6
    const c1y = p1[1] + (p2[1] - p0[1]) / 6
    const c2x = p2[0] - (p3[0] - p1[0]) / 6
    const c2y = p2[1] - (p3[1] - p1[1]) / 6
    d.push(`C${c1x.toFixed(2)} ${c1y.toFixed(2)} ${c2x.toFixed(2)} ${c2y.toFixed(2)} ${p2[0].toFixed(2)} ${p2[1].toFixed(2)}`)
  }
  return d.join(' ')
}

export function Waterline({
  data, height = 290, format = fmtNum, ariaLabel = '趋势图', className, showArea = true,
}: {
  data: Point[]; height?: number; format?: (v: number) => string; ariaLabel?: string; className?: string; showArea?: boolean
}) {
  const [ref, width] = useWidth()
  const [active, setActive] = useState<number | null>(null)
  const H = height
  const P = { l: 42, r: 16, t: 18, b: 30 }
  const plotW = Math.max(10, width - P.l - P.r)
  const plotH = H - P.t - P.b
  const max = niceMax(Math.max(0, ...data.map((d) => num(d.value))))
  const n = data.length
  const x = (i: number) => P.l + (n > 1 ? (i * plotW) / (n - 1) : plotW / 2)
  const y = (v: number) => P.t + plotH * (1 - Math.min(1, Math.max(0, v / max)))
  const pts = useMemo(() => data.map((d, i) => [x(i), y(d.value)] as [number, number]), [data, width, height, max])
  const line = useMemo(() => smoothPath(pts), [pts])
  const area = pts.length
    ? `${line} L${pts[pts.length - 1][0].toFixed(1)} ${(P.t + plotH).toFixed(1)} L${pts[0][0].toFixed(1)} ${(P.t + plotH).toFixed(1)} Z`
    : ''
  const ticks = [0, 0.25, 0.5, 0.75, 1]
  const xLabels = useMemo(() => {
    if (!n) return []
    if (n <= 4) return data.map((d, i) => ({ i, label: d.label }))
    if (width < 520 || n > 8) return [0, Math.floor((n - 1) / 2), n - 1].map((i) => ({ i, label: data[i].label }))
    return data.map((d, i) => ({ i, label: d.label }))
  }, [data, n, width])
  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const px = ((e.clientX - rect.left) / rect.width) * width
    const i = Math.round(((px - P.l) / plotW) * (n - 1))
    setActive(Math.max(0, Math.min(n - 1, i)))
  }
  const activePoint = active != null ? data[active] : null
  const activeX = active != null ? x(active) : 0
  const activeY = active != null ? y(num(activePoint?.value)) : 0

  return (
    <div ref={ref} className={cn('relative w-full select-none', className)}>
      <svg
        viewBox={`0 0 ${width} ${H}`} width="100%" height={H} role="img" aria-label={ariaLabel}
        tabIndex={0}
        onMouseMove={onMove}
        onMouseLeave={() => setActive(null)}
        onFocus={() => setActive((v) => v ?? data.length - 1)}
        onBlur={() => setActive(null)}
        onKeyDown={(e) => {
          if (!n) return
          if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
            e.preventDefault()
            setActive((v) => Math.max(0, Math.min(n - 1, (v ?? n - 1) + (e.key === 'ArrowRight' ? 1 : -1))))
          }
        }}
        className="overflow-visible outline-none [&:focus-visible_rect.frame]:stroke-[#0f6b65]"
      >
        <defs>
          <linearGradient id="waterline-fill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="#0f6b65" stopOpacity="0.18" />
            <stop offset="62%" stopColor="#4aa79c" stopOpacity="0.07" />
            <stop offset="100%" stopColor="#a9d6cc" stopOpacity="0" />
          </linearGradient>
          <linearGradient id="waterline-stroke" x1="0" x2="1" y1="0" y2="0">
            <stop offset="0%" stopColor="#1f8a70" />
            <stop offset="70%" stopColor="#0f6b65" />
            <stop offset="100%" stopColor="#0a4e4a" />
          </linearGradient>
        </defs>
        <rect className="frame" x="0.5" y="0.5" width={width - 1} height={H - 1} rx="10" fill="transparent" stroke="transparent" />
        {ticks.map((t) => {
          const gy = P.t + plotH * t
          return (
            <g key={t}>
              <line x1={P.l} x2={width - P.r} y1={gy} y2={gy} stroke="rgb(22 49 46 / .08)" strokeDasharray={t === 1 ? undefined : '2 5'} />
              <text x={P.l - 8} y={gy + 3.5} textAnchor="end" fill="#5C706A" fontSize="9.5" fontFamily="IBM Plex Mono, monospace">
                {format(max * (1 - t))}
              </text>
            </g>
          )
        })}
        {!data.length ? (
          <g>
            <line x1={P.l} x2={width - P.r} y1={P.t + plotH / 2} y2={P.t + plotH / 2} stroke="rgb(22 49 46 / .14)" strokeDasharray="3 6" />
            <text x={width / 2} y={P.t + plotH / 2 - 9} textAnchor="middle" fill="#5C706A" fontSize="11">这个时间窗还没有记录</text>
          </g>
        ) : (
          <>
            {showArea && <motion.path d={area} fill="url(#waterline-fill)" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.7, ease: 'easeOut' }} />}
            <motion.path
              d={line} fill="none" stroke="url(#waterline-stroke)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
              initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 1.05, ease: [0.16, 1, 0.3, 1] }}
            />
            {pts.map(([px, py], i) => (
              <circle key={i} cx={px} cy={py} r={active === i ? 4.2 : 2.2} fill={active === i ? '#fbfaf6' : '#0f6b65'} stroke="#0f6b65" strokeWidth={active === i ? 2 : 0} />
            ))}
            {active != null && (
              <line x1={activeX} x2={activeX} y1={P.t} y2={P.t + plotH} stroke="rgb(22 49 46 / .2)" strokeDasharray="2 4" />
            )}
          </>
        )}
        {xLabels.map(({ i, label }) => (
          <text key={i} x={x(i)} y={H - 8} textAnchor={i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'} fill="#5C706A" fontSize="9.5" fontFamily="IBM Plex Mono, monospace">
            {label}
          </text>
        ))}
      </svg>
      <ul className="sr-only" aria-label={`${ariaLabel} 数据`}>
        {data.map((d) => <li key={`${d.label}-${d.value}`}>{d.label}：{format(num(d.value))}{d.meta ? `，${d.meta}` : ''}</li>)}
      </ul>
      {activePoint && (
        <div
          className="pointer-events-none absolute z-10 min-w-[120px] -translate-x-1/2 rounded-lg border border-white/80 bg-white/95 px-2.5 py-2 shadow-[0_16px_32px_-22px_rgba(10,60,56,.55)] backdrop-blur-md"
          style={{ left: `${(activeX / width) * 100}%`, top: Math.max(0, activeY - 66) }}
        >
          <div className="mono text-[10px] text-ink-3">{activePoint.label}</div>
          <div className="mt-0.5 text-[14px] font-semibold tabular-nums text-ink">{format(num(activePoint.value))}</div>
          {activePoint.meta && <div className="mt-0.5 text-[10.5px] text-ink-3">{activePoint.meta}</div>}
        </div>
      )}
    </div>
  )
}

export function Sparkbars({ data, format = fmtNum, ariaLabel = '分布' }: { data: Point[]; format?: (v: number) => string; ariaLabel?: string }) {
  const max = Math.max(1, ...data.map((d) => num(d.value)))
  return (
    <div className="flex h-14 items-end gap-[3px]" role="img" aria-label={ariaLabel}>
      {data.map((d, i) => (
        <div key={i} className="group relative flex-1" title={`${d.label} · ${format(num(d.value))}`}>
          <div
            className="w-full rounded-t-[2px] bg-[linear-gradient(180deg,#4aa79c,#0f6b65)] opacity-70 transition-opacity group-hover:opacity-100"
            style={{ height: `${Math.max(2, (num(d.value) / max) * 56)}px` }}
          />
        </div>
      ))}
    </div>
  )
}

export function DistributionBar({ segments, ariaLabel }: { segments: { label: string; value: number; color: string }[]; ariaLabel: string }) {
  const total = segments.reduce((s, x) => s + num(x.value), 0)
  return (
    <div>
      <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-ink/5" role="img" aria-label={ariaLabel}>
        {total > 0 && segments.map((s) => (
          <div key={s.label} title={`${s.label} ${s.value}`} style={{ width: `${(num(s.value) / total) * 100}%`, background: s.color }} />
        ))}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
        {segments.map((s) => (
          <span key={s.label} className="inline-flex items-center gap-1.5 text-[11px] text-ink-2">
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: s.color }} />{s.label}
            <span className="mono text-ink-3">{fmtNum(s.value)}</span>
          </span>
        ))}
      </div>
    </div>
  )
}
