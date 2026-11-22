import { useId } from 'react'

export function BrandMark({ size = 28, className }: { size?: number; className?: string }) {
  const id = useId()
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" className={className} aria-hidden="true">
      <defs>
        <linearGradient id={`${id}-glass`} x1="6" y1="3" x2="27" y2="30" gradientUnits="userSpaceOnUse">
          <stop stopColor="#ffffff" stopOpacity=".92" />
          <stop offset=".55" stopColor="#b9e2d9" stopOpacity=".55" />
          <stop offset="1" stopColor="#7cc7ba" stopOpacity=".5" />
        </linearGradient>
      </defs>
      <rect x="1" y="1" width="30" height="30" rx="9.5" fill={`url(#${id}-glass)`} stroke="#0f6b65" strokeOpacity=".28" />
      <circle cx="16" cy="15.2" r="8.1" stroke="#0f6b65" strokeWidth="1.25" strokeOpacity=".8" />
      <circle cx="16" cy="15.2" r="4.3" stroke="#0f6b65" strokeWidth="1" strokeOpacity=".42" />
      <path d="M6.4 20.1c3.4-2.1 5.7-2.1 9.1 0s5.7 2.1 9.1 0" stroke="#d9553f" strokeWidth="1.3" strokeLinecap="round" />
      <circle cx="16" cy="15.2" r="1.55" fill="#0f6b65" fillOpacity=".75" />
      <path d="M16 4.4v4.1" stroke="#0f6b65" strokeOpacity=".35" strokeWidth="1" strokeLinecap="round" />
    </svg>
  )
}

export function CausticScene({ compact = false }: { compact?: boolean }) {
  return (
    <div className={`relative isolate overflow-hidden ${compact ? 'h-48' : 'h-full min-h-[520px]'}`} aria-hidden="true">
      <div className="absolute inset-0 bg-[radial-gradient(120%_90%_at_15%_0%,#eef8f4_0%,#f8f5ec_46%,#efe7d6_100%)]" />
      <div className="absolute -left-24 top-[-10%] h-[52%] w-[78%] rotate-[-8deg] rounded-[26px] border border-white/80 bg-[linear-gradient(130deg,rgba(255,255,255,.72),rgba(174,224,213,.24))] shadow-[0_40px_100px_-50px_rgba(15,107,101,.5)] backdrop-blur-[2px]" />
      <div className="absolute right-[-12%] top-[14%] h-[54%] w-[62%] rotate-[6deg] rounded-[30px] border border-white/70 bg-[linear-gradient(160deg,rgba(255,255,255,.52),rgba(198,231,222,.2))] shadow-[0_26px_80px_-44px_rgba(15,107,101,.42)]" />
      <div className="absolute bottom-[-8%] left-[14%] h-[46%] w-[82%] rounded-[50%] bg-[radial-gradient(ellipse_at_center,rgba(165,219,208,.55),rgba(236,226,203,.2)_58%,transparent_72%)] blur-[2px]" />
      <svg className="absolute inset-x-0 bottom-[16%] h-[36%] w-full" viewBox="0 0 900 260" fill="none" preserveAspectRatio="none">
        <defs>
          <linearGradient id="scene-line" x1="0" x2="1">
            <stop stopColor="#0f6b65" stopOpacity=".1" />
            <stop offset=".5" stopColor="#0f6b65" stopOpacity=".38" />
            <stop offset="1" stopColor="#d9553f" stopOpacity=".34" />
          </linearGradient>
        </defs>
        {[0, 1, 2, 3, 4].map((i) => (
          <path
            key={i}
            d={`M-20 ${150 + i * 15} C 140 ${112 + i * 14}, 260 ${198 + i * 9}, 430 ${150 + i * 13} S 700 ${104 + i * 12}, 930 ${142 + i * 10}`}
            stroke="url(#scene-line)" strokeWidth={i === 2 ? 1.4 : 0.8} strokeOpacity={1 - i * 0.12}
          />
        ))}
      </svg>
      <div className="absolute bottom-[14%] right-[8%] h-16 w-16 rounded-full border border-white/70" />
      <div className="absolute bottom-[19%] right-[11%] h-6 w-6 rounded-full border border-vermilion/30" />
    </div>
  )
}
