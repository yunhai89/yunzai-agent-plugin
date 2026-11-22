import { useState } from 'react'
import { ArrowRight, ClipboardPaste, Eye, EyeOff, Loader2, ShieldCheck } from 'lucide-react'
import { BrandMark, CausticScene } from '@/components/Brand'
import { useAuth } from '@/lib/auth'
import { ErrorState } from '@/components/ui'

export function LoginGate() {
  const { login } = useAuth()
  const [raw, setRaw] = useState('')
  const [show, setShow] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!raw.trim() || busy) return
    setBusy(true)
    setError('')
    try {
      await login(raw)
    } catch (err: any) {
      setError(err?.message || '登录失败，请检查令牌')
    } finally {
      setBusy(false)
    }
  }

  const paste = async () => {
    try {
      const text = await navigator.clipboard.readText()
      if (text) { setRaw(text); setError('') }
    } catch {
      setError('浏览器拒绝了剪贴板读取，请手动粘贴。')
    }
  }

  return (
    <main className="grid min-h-dvh grid-cols-1 lg:grid-cols-[1.08fr_0.92fr]">
      <section className="relative hidden border-r border-white/60 lg:block">
        <CausticScene />
        <div className="absolute inset-0 flex flex-col justify-between p-10 xl:p-14">
          <div className="flex items-center gap-3">
            <BrandMark size={34} />
            <div>
              <div className="text-[14px] font-semibold tracking-[-0.02em]">agents-plugin</div>
              <div className="text-[10.5px] tracking-[.16em] text-ink-3">YUNZAI AGENT RUNTIME</div>
            </div>
          </div>
          <div className="max-w-[34rem]">
            <h1 className="text-[clamp(30px,4.2vw,58px)] font-semibold leading-[1.06] tracking-[-0.045em] text-ink">
              让运行时<br />像水一样可见。
            </h1>
            <p className="mt-5 max-w-[30rem] text-[14px] leading-relaxed text-ink-2">
              健康、开销、待办与异常，都在同一片日光下。面板直接读写插件配置与运行状态，不另存一份真相。
            </p>
            <div className="mt-9 grid max-w-[31rem] grid-cols-3 gap-5 border-t border-ink/10 pt-5">
              {[
                ['离线可用', '字体与资源随插件分发'],
                ['热加载', '保存后下一轮对话生效'],
                ['主人级', '令牌即权限，不设多角色'],
              ].map(([a, b]) => (
                <div key={a}>
                  <div className="text-[12px] font-semibold text-lagoon">{a}</div>
                  <div className="mt-1 text-[10.5px] leading-snug text-ink-3">{b}</div>
                </div>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-2 text-[10.5px] text-ink-3">
            <ShieldCheck size={13} /> 控制台令牌仅保存在当前浏览器
          </div>
        </div>
      </section>

      <section className="relative flex items-center justify-center px-5 py-12">
        <div className="pointer-events-none absolute inset-0 lg:hidden">
          <CausticScene compact />
        </div>
        <div className="relative w-full max-w-[410px]">
          <div className="mb-8 lg:hidden">
            <BrandMark size={38} />
          </div>
          <div className="mb-7">
            <h2 className="text-[27px] font-semibold tracking-[-0.035em]">进入运行控制台</h2>
            <p className="mt-2 text-[13px] leading-relaxed text-ink-2">
              粘贴启动日志里的完整地址，或主人私聊机器人发送 <span className="mono rounded bg-white/60 px-1.5 py-0.5 text-[12px] text-lagoon">#agent登录</span> 获取令牌。
            </p>
          </div>

          <form onSubmit={submit} className="glass rounded-[18px] p-5">
            <label className="field-label mb-1.5 block" htmlFor="console-token">控制台令牌 / 登录地址</label>
            <div className="relative">
              <input
                id="console-token"
                className="input mono h-11 pr-24 text-[12px]"
                type={show ? 'text' : 'password'}
                value={raw}
                onChange={(e) => { setRaw(e.target.value); setError('') }}
                placeholder="粘贴 https://…?token=… 或令牌"
                autoComplete="off"
                spellCheck={false}
                autoFocus
              />
              <div className="absolute right-1.5 top-1/2 flex -translate-y-1/2 items-center gap-0.5">
                <button type="button" className="btn btn-ghost btn-icon btn-sm" onClick={paste} aria-label="从剪贴板粘贴" title="从剪贴板粘贴">
                  <ClipboardPaste size={14} />
                </button>
                <button type="button" className="btn btn-ghost btn-icon btn-sm" onClick={() => setShow((v) => !v)} aria-label={show ? '隐藏令牌' : '显示令牌'} title={show ? '隐藏令牌' : '显示令牌'}>
                  {show ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </div>
            </div>
            <p className="mt-2 text-[10.5px] leading-relaxed text-ink-3">
              支持整段消息。令牌只写入本机 localStorage，不随配置或日志导出。
            </p>
            {error && <div className="mt-3"><ErrorState message={error} /></div>}
            <button className="btn btn-primary btn-lg mt-5 w-full" disabled={busy || !raw.trim()} type="submit">
              {busy ? <Loader2 size={16} className="animate-spin" /> : null}
              {busy ? '正在验证…' : '进入控制台'}
              {!busy && <ArrowRight size={15} />}
            </button>
          </form>

          <div className="mt-5 flex items-start gap-2 text-[10.5px] leading-relaxed text-ink-3">
            <span className="mt-1 h-1.5 w-1.5 flex-none rounded-full bg-vermilion/70" />
            <p>令牌失效时页面会回到这里。启动日志与 <span className="mono">data/web/console-url.txt</span> 里的地址会随重启更新。</p>
          </div>
        </div>
      </section>
    </main>
  )
}
