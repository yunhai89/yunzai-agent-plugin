/**
 * 会话短 ID：给用户/Web 展示与会话操作使用的稳定短标识。
 *
 * 内部身份（KV scope 键 / 官方 openid 等）仍使用完整 scope（可能很长），
 * 但用户不应被要求复制 `1903797111:8DCD...` 这类长 ID。短 ID 由完整 scope + 对话 id
 * 确定性哈希得到，刷新/重启/迁移后不变；同一用户在不同群、不同 bot 下也不会撞。
 */
import { createHash } from 'node:crypto'

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'
const SHORT_LEN = 8

/**
 * @param {object} opts
 * @param {string} [opts.scopeUserId] 真实 scope 用户（群共享时为 __group__:...）
 * @param {string} [opts.scopeGroupId] 群号（私聊为空）
 * @param {string|number} [opts.conversationId] 内部对话 id
 * @param {string} [opts.adapter] onebot / qqbot / qqguild
 * @param {string} [opts.botId] bot 自身 id
 * @returns {string} `c` + 8 位 base36
 */
export function shortConversationId({
  scopeUserId = '', scopeGroupId = '', conversationId = '', adapter = '', botId = '',
} = {}) {
  const raw = [adapter, botId, scopeUserId, scopeGroupId, conversationId]
    .map((v) => String(v ?? ''))
    .join('\u0000')
  const hex = createHash('sha256').update(raw).digest('hex').slice(0, 16)
  let n = BigInt(`0x${hex}`)
  let out = ''
  for (let i = 0; i < SHORT_LEN; i++) {
    out = ALPHABET[Number(n % 36n)] + out
    n /= 36n
  }
  return `c${out}`
}

/** 是否为短会话 ID（用于区分旧数字 id 与短 ID 输入）。 */
export function isShortConversationId(value) {
  return /^c[0-9a-z]{8}$/.test(String(value ?? '').trim().toLowerCase())
}
