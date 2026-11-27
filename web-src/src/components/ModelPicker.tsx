import { useEffect, useState } from 'react'
import { api } from '@/lib/api'
import { Select } from '@/components/ui'

export type ProviderModel = { id: string; name?: string }

type ProviderLike = {
  id?: string
  name?: string
  protocol?: string
  preset?: string
  baseURL?: string
  apiKey?: string
}

/** 厂商模型目录缓存：同一份厂商配置 5 分钟内复用，避免每行/每次切换都打厂商接口。 */
const CACHE_TTL_MS = 5 * 60 * 1000
const cache = new Map<string, { at: number; list: ProviderModel[] }>()
const inflight = new Map<string, Promise<ProviderModel[]>>()

function cacheKey(p: ProviderLike): string {
  return [p.id, p.protocol, p.preset, p.baseURL, p.apiKey].map((v) => String(v ?? '')).join('\u0000')
}

function fetchModels(p: ProviderLike, force = false): Promise<ProviderModel[]> {
  const key = cacheKey(p)
  const hit = cache.get(key)
  if (!force && hit && Date.now() - hit.at < CACHE_TTL_MS) return Promise.resolve(hit.list)
  const pending = inflight.get(key)
  if (pending) return pending
  const task = api.get<ProviderModel[]>('/models', {
    protocol: p.protocol || 'openai',
    preset: p.preset || '',
    baseURL: p.baseURL || '',
    apiKey: p.apiKey || '',
  }).then((list) => {
    const arr = (Array.isArray(list) ? list : [])
      .filter((m) => m && typeof m.id === 'string' && m.id)
      .map((m) => ({ id: m.id, ...(m.name ? { name: String(m.name) } : {}) }))
    cache.set(key, { at: Date.now(), list: arr })
    return arr
  }).finally(() => {
    inflight.delete(key)
  })
  inflight.set(key, task)
  return task
}

/**
 * 厂商模型下拉：选择后把真实模型 ID 回填到输入框，避免手写 ID 拼错。
 * 仍保留输入框手输，兼容厂商未返回/自定义模型。
 */
export function ProviderModelSelect({
  provider,
  value = '',
  onSelect,
  className,
  ariaLabel = '从厂商模型列表选择',
}: {
  provider?: ProviderLike | null
  value?: string
  onSelect: (id: string, model?: ProviderModel) => void
  className?: string
  ariaLabel?: string
}) {
  const providerId = provider?.id || ''
  const ready = !!(provider?.baseURL || provider?.preset) && !!provider?.apiKey
  const [list, setList] = useState<ProviderModel[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    let alive = true
    if (!providerId || !ready) {
      setList([])
      setError('')
      setLoading(false)
      return () => { alive = false }
    }
    setLoading(true)
    setError('')
    fetchModels(provider, nonce > 0)
      .then((models) => { if (alive) setList(models) })
      .catch((e) => { if (alive) { setList([]); setError(e?.message || '拉取模型列表失败') } })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
    // provider 的具体字段变化由「刷新模型列表」显式触发，避免输入 Key/baseURL 时每敲一个字就请求厂商。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providerId, ready, nonce])

  const providerName = String(provider?.name || '').trim()
  const pickLabel = providerName ? `选择 ${providerName} 模型` : '选择厂商模型'
  const placeholder = !providerId
    ? '选择厂商后可拉取模型'
    : !provider?.apiKey
      ? '先填 API Key 后拉取'
      : loading
        ? (providerName ? `拉取 ${providerName} 模型中…` : '拉取厂商模型中…')
        : error
          ? '拉取失败 · 点此重试'
          : list.length
            ? `${pickLabel}（${list.length}）`
            : '厂商未返回模型'

  return (
    <Select
      className={className}
      value={value}
      aria-label={ariaLabel}
      title={error || placeholder}
      disabled={!providerId || loading}
      onChange={(e) => {
        const v = e.target.value
        if (!v) return
        if (v === '__refresh__') {
          setNonce((n) => n + 1)
          return
        }
        onSelect(v, list.find((m) => m.id === v))
      }}
    >
      <option value="">{placeholder}</option>
      {ready && <option value="__refresh__">↻ 重新拉取模型列表</option>}
      {value && !list.some((m) => m.id === value) && <option value={value}>{value}</option>}
      {list.map((m) => (
        <option key={m.id} value={m.id}>
          {m.name && m.name !== m.id ? `${m.id} · ${m.name}` : m.id}
        </option>
      ))}
    </Select>
  )
}
