import { Component, type ErrorInfo, type ReactNode } from 'react'
import { getToken } from '@/lib/api'

type Props = { children: ReactNode; label?: string }
type State = { error: Error | null; stack: string; componentStack: string }

/**
 * 页面级错误边界：任何渲染异常都必须留下可读信息，而不是整页空白。
 * 同时把错误（不含令牌/配置）上报到本地 `/api/client-error`，让 DevLog/后台能看到前端堆栈。
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, stack: '', componentStack: '' }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    const payload = {
      label: this.props.label || 'console',
      message: String(error?.message || error || 'unknown'),
      stack: String(error?.stack || '').slice(0, 8000),
      componentStack: String(info?.componentStack || '').slice(0, 4000),
      url: typeof location !== 'undefined' ? location.href : '',
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
      at: new Date().toISOString(),
    }
    this.setState({ stack: payload.stack, componentStack: payload.componentStack })
    try { console.error('[ui] render error', payload) } catch { /* noop */ }
    try {
      const token = getToken()
      void fetch('/api/client-error', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
        body: JSON.stringify(payload),
      }).catch(() => {})
    } catch { /* noop */ }
  }

  render() {
    if (!this.state.error) return this.props.children
    const err = this.state.error
    return (
      <div className="page">
        <div className="panel p-6" role="alert">
          <div className="text-[11px] tracking-[.14em] text-coral">CONSOLE ERROR</div>
          <h1 className="mt-1 text-[22px] font-semibold tracking-[-0.03em]">这个页面加载失败了</h1>
          <p className="mt-2 max-w-[70ch] text-[12.5px] leading-relaxed text-ink-2">
            错误已记录到后台日志（<span className="mono">[web] 前端异常</span>）。刷新通常可以恢复；如果持续出现，请把下面的信息发给开发者。
          </p>
          <div className="mono mt-4 rounded-[10px] border border-line-soft bg-white/55 px-3 py-2 text-[11px] text-ink-2">
            {String(err?.message || err)}
          </div>
          <details className="mt-3 rounded-[10px] border border-line-soft bg-white/35 px-3 py-2">
            <summary className="cursor-pointer text-[11px] text-ink-3">查看错误堆栈</summary>
            <pre className="mono mt-2 max-h-[40vh] overflow-auto whitespace-pre-wrap text-[10px] leading-relaxed text-ink-2">{this.state.stack || '（无堆栈）'}{this.state.componentStack ? `\n\n组件栈：${this.state.componentStack}` : ''}</pre>
          </details>
          <div className="mt-4 flex gap-2">
            <button type="button" className="btn btn-primary btn-sm" onClick={() => location.reload()}>重新加载</button>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => location.assign('/')}>回到概览</button>
          </div>
        </div>
      </div>
    )
  }
}
