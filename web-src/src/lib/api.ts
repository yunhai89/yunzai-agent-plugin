export type ApiData = any

export class ApiError extends Error {
  code: number
  status: number
  payload: any
  constructor(message: string, code = -1, status = 0, payload?: any) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.status = status
    this.payload = payload
  }
}

const TOKEN_KEY = 'agents_token'
const TOKEN_RE = /^[A-Za-z0-9_-]{16,128}$/

/** Accept a bare token, a whole console URL, or a pasted message containing one. */
export function normalizeToken(raw: unknown): string {
  let s = String(raw ?? '').trim()
  if (!s) return ''
  const m = s.match(/[?&#]token=([^&#\s]+)/i)
  if (m) {
    try { s = decodeURIComponent(m[1]) } catch { s = m[1] }
    s = s.trim()
  }
  if (!TOKEN_RE.test(s)) {
    const hit = s.match(/[A-Za-z0-9_-]{16,128}/)
    s = hit ? hit[0] : ''
  }
  return TOKEN_RE.test(s) ? s : ''
}

export function getToken(): string {
  try {
    const raw = localStorage.getItem(TOKEN_KEY) || ''
    const tk = normalizeToken(raw)
    if (raw && tk !== raw) {
      if (tk) localStorage.setItem(TOKEN_KEY, tk)
      else localStorage.removeItem(TOKEN_KEY)
    }
    return tk
  } catch { return '' }
}

export function setToken(raw: unknown): string {
  const tk = normalizeToken(raw)
  try {
    if (tk) localStorage.setItem(TOKEN_KEY, tk)
    else localStorage.removeItem(TOKEN_KEY)
  } catch { /* private mode */ }
  return tk
}

let bootTokenRead = false
export function takeUrlToken(): boolean {
  if (bootTokenRead) return false
  bootTokenRead = true
  try {
    const params = new URLSearchParams(location.search)
    const tk = normalizeToken(params.get('token') || '')
    if (!tk) return false
    setToken(tk)
    history.replaceState(null, '', location.pathname + location.hash)
    return true
  } catch { return false }
}

export function notifyNeedLogin() {
  window.dispatchEvent(new CustomEvent('agents:need-login'))
}

type RequestOptions = {
  query?: Record<string, unknown>
  body?: unknown
  raw?: { body: Blob; type?: string }
  signal?: AbortSignal
}

async function request<T = ApiData>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
  let qs = ''
  if (opts.query) {
    const sp = new URLSearchParams()
    for (const [k, v] of Object.entries(opts.query)) {
      if (v === undefined || v === null) continue
      sp.append(k, String(v))
    }
    qs = sp.toString()
  }
  const headers: Record<string, string> = {}
  const tk = getToken()
  if (tk) headers.Authorization = 'Bearer ' + tk
  let body: BodyInit | undefined
  if (opts.raw) {
    headers['Content-Type'] = opts.raw.type || 'application/octet-stream'
    body = opts.raw.body
  } else if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify(opts.body)
  }
  let res: Response
  try {
    res = await fetch('/api' + path + (qs ? '?' + qs : ''), {
      method, headers, body, signal: opts.signal,
    })
  } catch (e: any) {
    if (e?.name === 'AbortError') throw e
    throw new ApiError('网络错误：' + (e?.message || e))
  }
  let payload: any = null
  try { payload = await res.json() } catch { payload = null }
  const code = Number(payload?.code ?? -1)
  if (code === 4010 || res.status === 401) {
    setToken('')
    notifyNeedLogin()
    throw new ApiError(payload?.msg || '登录已失效，请重新登录', 4010, res.status, payload)
  }
  if (!payload) throw new ApiError(`响应格式错误（HTTP ${res.status}）`, -1, res.status)
  if (code !== 0) throw new ApiError(payload.msg || `错误码 ${code}`, code, res.status, payload)
  return payload.data as T
}

export const api = {
  get: <T = ApiData>(path: string, query?: Record<string, unknown>, signal?: AbortSignal) =>
    request<T>('GET', path, { query, signal }),
  post: <T = ApiData>(path: string, body?: unknown) => request<T>('POST', path, { body }),
  postRaw: <T = ApiData>(path: string, blob: Blob, query?: Record<string, unknown>) =>
    request<T>('POST', path, { raw: { body: blob, type: blob.type }, query }),
  put: <T = ApiData>(path: string, body?: unknown) => request<T>('PUT', path, { body }),
  del: <T = ApiData>(path: string) => request<T>('DELETE', path),
}
