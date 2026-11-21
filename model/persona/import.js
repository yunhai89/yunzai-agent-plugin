/**
 * 人设导入 —— 从本地 .txt / .md / .json 文件构建人设。
 *
 * 支持三种来源：
 *  1. .txt：正文 = systemPrompt，名称取文件名；
 *  2. .md ：支持简单 frontmatter（name/description/tags/avatar/greeting/systemPrompt）
 *           与首个 # 标题；正文 = systemPrompt；
 *  3. .json：`aha-character-card/1.x` 角色卡片；卡片自带 system_prompt 时作为正文，
 *           结构化字段补全名称/简介/标签/开场白，并原样保存在 persona.card 供运行时补充。
 *
 * 人设正文与角色卡片可以同时导入：正文以 .txt/.md 为准，卡片负责结构化设定与补充约束；
 * 只导入卡片时，卡片 system_prompt → 人设正文。
 *
 * 本模块不依赖插件 Config/Log；文件大小、id 冲突、注入检测最终由 PersonaStore 把关。
 */

import {
  PERSONA_MAX_NAME_LEN,
  PERSONA_MAX_PROMPT_LEN,
  PERSONA_MAX_CARD_BYTES,
  slugify,
} from './store.js'

export const IMPORT_MAX_TEXT_BYTES = 512 * 1024
const MAX_DESCRIPTION_LEN = 500
const MAX_GREETING_LEN = 500
const MAX_AVATAR_LEN = 500
const MAX_TAGS = 8
const MAX_TAG_LEN = 24
const CARD_SPEC_RE = /^aha-character-card\/\d+\.\d+$/i

function importError(message, code, extra = {}) {
  const e = new Error(message)
  e.code = code
  Object.assign(e, extra)
  return e
}

function text(v) {
  return String(v ?? '').trim()
}

function oneLine(v) {
  return text(v).replace(/\s+/g, ' ').trim()
}

function firstChar(s) {
  return Array.from(text(s))[0] || '人'
}

function clampText(v, max) {
  const s = text(v)
  return s.length > max ? s.slice(0, max) : s
}

function asArray(v) {
  if (Array.isArray(v)) return v.map((x) => text(x)).filter(Boolean)
  if (typeof v === 'string') return v.split(/[,，]/).map((x) => text(x)).filter(Boolean)
  return []
}

function uniqueTags(values) {
  const out = []
  const seen = new Set()
  for (const raw of values) {
    const t = oneLine(raw).slice(0, MAX_TAG_LEN)
    if (!t) continue
    const key = t.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(t)
    if (out.length >= MAX_TAGS) break
  }
  return out
}

function baseName(filename) {
  const base = String(filename || '').split(/[\\/]/).pop() || ''
  return base.replace(/\.[^.]+$/, '').trim()
}

function extOf(filename) {
  return (String(filename || '').toLowerCase().match(/\.([a-z0-9]+)$/) || [])[1] || ''
}

function byteLength(s) {
  return Buffer.byteLength(String(s || ''), 'utf8')
}

/** 简单 frontmatter：只支持顶层 key: value / [a, b]，不引入 YAML 依赖。 */
function parseFrontmatter(source) {
  const raw = String(source || '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  const m = raw.match(/^---\n([\s\S]*?)\n---(?:\n|$)/)
  if (!m) return { data: {}, body: raw }
  const data = {}
  for (const line of m[1].split(/\r?\n/)) {
    const s = line.trim()
    if (!s || s.startsWith('#')) continue
    const idx = s.indexOf(':')
    if (idx <= 0) continue
    const key = s.slice(0, idx).trim()
    if (!/^[A-Za-z0-9_.-]+$/.test(key)) continue
    let value = s.slice(idx + 1).trim()
    if (value.startsWith('[') && value.endsWith(']')) {
      value = value.slice(1, -1).split(',').map((x) => {
        const t = x.trim()
        return (t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")) ? t.slice(1, -1) : t
      }).filter(Boolean)
    } else if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    data[key] = value
  }
  return { data, body: raw.slice(m[0].length) }
}

/** Markdown 首个 H1 作为名称候选（仅长度合理时）；同时返回去掉 H1 的正文。 */
function firstHeading(body) {
  const m = String(body || '').match(/^[ \t]*#[ \t]+(.+?)[ \t]*$/m)
  if (!m) return null
  const title = oneLine(m[1])
  if (!title || title.length > PERSONA_MAX_NAME_LEN) return null
  return { title, body: String(body).replace(m[0], '').replace(/^\s*\n/, '') }
}

function readFileInput(input, { label, exts, maxBytes }) {
  if (!input || typeof input !== 'object') return null
  const filename = text(input.filename)
  const content = typeof input.content === 'string' ? input.content : ''
  if (!filename && !content) return null
  if (!filename) throw importError(`${label}缺少文件名`, 'persona_file_name')
  const ext = extOf(filename)
  if (!exts.includes(ext)) throw importError(`${label}必须是 ${exts.map((x) => '.' + x).join(' / ')} 文件`, 'persona_file_type')
  if (!content.trim()) throw importError(`${label}内容为空`, 'persona_file_empty')
  if (content.includes('\u0000')) throw importError(`${label}看起来是二进制文件`, 'persona_file_binary')
  if (byteLength(content) > maxBytes) throw importError(`${label}过大（上限 ${(maxBytes / 1024).toFixed(0)} KB）`, 'persona_file_too_large')
  return { filename, content, ext }
}

/**
 * 解析 .txt/.md 人设正文。
 * @returns {{ persona: object, nameSource: string, filename: string, avatarExplicit: boolean, warnings: string[] }}
 */
export function parsePersonaText(input) {
  const file = readFileInput(input, { label: '人设文件', exts: ['txt', 'md'], maxBytes: IMPORT_MAX_TEXT_BYTES })
  if (!file) throw importError('未提供人设文件', 'persona_file_missing')
  const warnings = []
  const { data, body } = parseFrontmatter(file.content)
  const explicitName = text(data.name)
  const heading = file.ext === 'md' && !explicitName ? firstHeading(body) : null
  const nameSource = explicitName ? 'frontmatter' : heading ? 'heading' : 'filename'
  let name = explicitName || heading?.title || baseName(file.filename) || '导入人设'
  if (name.length > PERSONA_MAX_NAME_LEN) {
    warnings.push(`名称超过 ${PERSONA_MAX_NAME_LEN} 字，已截断`)
    name = name.slice(0, PERSONA_MAX_NAME_LEN)
  }

  const frontPrompt = text(data.systemPrompt || data.system_prompt || data.prompt)
  const prompt = frontPrompt || text(heading?.body || body)
  if (!prompt) throw importError('人设正文为空', 'persona_prompt_empty')
  if (prompt.length > PERSONA_MAX_PROMPT_LEN) {
    throw importError(`人设正文超过 ${PERSONA_MAX_PROMPT_LEN} 字（实际 ${prompt.length}）`, 'persona_prompt_too_long')
  }

  const tags = uniqueTags(asArray(data.tags))
  return {
    persona: {
      ...(text(data.id) ? { id: slugify(data.id) } : {}),
      name,
      description: clampText(data.description, MAX_DESCRIPTION_LEN),
      tags,
      avatar: clampText(data.avatar, MAX_AVATAR_LEN) || firstChar(name),
      greeting: clampText(data.greeting, MAX_GREETING_LEN),
      systemPrompt: prompt,
      card: null,
    },
    nameSource,
    filename: file.filename,
    avatarExplicit: !!text(data.avatar),
    warnings,
  }
}

function cardPromptFallback(card, name) {
  const p = card.persona || {}
  const voice = card.voice || {}
  const lines = [`你是${name}。`]
  if (text(p.summary)) lines.push(text(p.summary))
  const layers = p.layers && typeof p.layers === 'object' ? p.layers : null
  if (layers) {
    for (const [k, label] of [['surface', '表层'], ['middle', '中层'], ['deep', '深层'], ['core', '内核']]) {
      if (text(layers[k])) lines.push(`${label}：${text(layers[k])}`)
    }
  }
  if (text(voice.tone)) lines.push(`语气：${text(voice.tone)}`)
  if (text(voice.rhythm)) lines.push(`节奏：${text(voice.rhythm)}`)
  const rules = asArray(card.behavior_rules).slice(0, 12)
  if (rules.length) lines.push('行为规则：', ...rules.map((x) => `- ${oneLine(x)}`))
  if (text(card.lore?.current_state)) lines.push(`当前状态：${text(card.lore.current_state)}`)
  return lines.join('\n').slice(0, PERSONA_MAX_PROMPT_LEN)
}

function selectCardPrompt(card, name, warnings) {
  const full = text(card.system_prompt || card.systemPrompt || card.prompt)
  const compact = text(card.system_prompt_compact || card.systemPromptCompact)
  if (full && full.length <= PERSONA_MAX_PROMPT_LEN) return full
  if (full) warnings.push(`角色卡片 system_prompt 超过 ${PERSONA_MAX_PROMPT_LEN} 字，已改用精简版`)
  if (compact && compact.length <= PERSONA_MAX_PROMPT_LEN) return compact
  if (compact) warnings.push(`角色卡片 system_prompt_compact 也超过 ${PERSONA_MAX_PROMPT_LEN} 字，已按结构化字段生成`)
  const generated = cardPromptFallback(card, name)
  if (!generated.trim()) throw importError('角色卡片缺少 system_prompt，且无法从结构化字段生成正文', 'persona_card_prompt')
  warnings.push('角色卡片未提供可用 system_prompt，已按结构化字段生成正文')
  return generated
}

function cardTags(card) {
  return uniqueTags([
    ...asArray(card.persona?.keywords),
    ...asArray(card.identity?.path),
  ])
}

/**
 * 解析 aha-character-card/1.x 角色卡片。
 * @returns {{ persona: object, card: object, filename: string, warnings: string[] }}
 */
export function parseCharacterCard(input) {
  const file = readFileInput(input, { label: '角色卡片', exts: ['json'], maxBytes: PERSONA_MAX_CARD_BYTES })
  if (!file) throw importError('未提供角色卡片', 'persona_card_missing')
  let card
  try { card = JSON.parse(String(file.content).replace(/^\uFEFF/, '')) } catch (e) {
    throw importError(`角色卡片不是合法 JSON：${e.message}`, 'persona_card_json')
  }
  if (!card || typeof card !== 'object' || Array.isArray(card)) {
    throw importError('角色卡片必须是 JSON 对象', 'persona_card_shape')
  }
  const warnings = []
  const spec = text(card.spec)
  if (!spec) warnings.push('角色卡片缺少 spec，已按 aha-character-card 结构尝试导入')
  else if (!CARD_SPEC_RE.test(spec)) throw importError(`不支持的角色卡片格式：${spec}（需要 aha-character-card/1.x）`, 'persona_card_spec')

  const name = oneLine(card.identity?.name) || oneLine(card.meta?.name) || oneLine(card.name)
  if (!name) throw importError('角色卡片缺少 identity.name / meta.name', 'persona_card_name')
  if (byteLength(JSON.stringify(card)) > PERSONA_MAX_CARD_BYTES) {
    throw importError(`角色卡片过大（上限 ${(PERSONA_MAX_CARD_BYTES / 1024).toFixed(0)} KB）`, 'persona_card_too_large')
  }

  const safeName = name.length > PERSONA_MAX_NAME_LEN ? name.slice(0, PERSONA_MAX_NAME_LEN) : name
  if (safeName !== name) warnings.push(`角色名称超过 ${PERSONA_MAX_NAME_LEN} 字，已截断`)

  const systemPrompt = selectCardPrompt(card, safeName, warnings)
  const description = clampText(
    oneLine(card.persona?.summary) || oneLine(card.meta?.base) || asArray(card.identity?.titles)[0] || `角色卡片：${safeName}`,
    MAX_DESCRIPTION_LEN,
  )
  return {
    persona: {
      name: safeName,
      description,
      tags: cardTags(card),
      avatar: firstChar(safeName),
      greeting: clampText(card.greeting, MAX_GREETING_LEN),
      systemPrompt,
      card,
    },
    card,
    filename: file.filename,
    warnings,
  }
}

/**
 * 合并人设正文与角色卡片。
 * @returns {{ persona: object, card: object|null, nameSource: string, warnings: string[] }}
 */
export function buildPersonaImport({ personaFile = null, cardFile = null } = {}) {
  const hasFile = (f) => !!(f && typeof f === 'object' && (text(f.filename) || (typeof f.content === 'string' && f.content.trim())))
  const textImport = hasFile(personaFile) ? parsePersonaText(personaFile) : null
  const cardImport = hasFile(cardFile) ? parseCharacterCard(cardFile) : null
  if (!textImport && !cardImport) throw importError('请至少提供一个 .txt/.md 人设文件或 .json 角色卡片', 'persona_import_empty')

  const warnings = [...(textImport?.warnings || []), ...(cardImport?.warnings || [])]
  const textExplicitName = textImport && textImport.nameSource !== 'filename'
  const name = textExplicitName
    ? textImport.persona.name
    : (cardImport?.persona.name || textImport?.persona.name || '导入人设')
  const description = textImport?.persona.description || cardImport?.persona.description || ''
  const tags = uniqueTags([...(textImport?.persona.tags || []), ...(cardImport?.persona.tags || [])])
  const greeting = textImport?.persona.greeting || cardImport?.persona.greeting || ''
  const textAvatar = textImport && (textExplicitName || textImport.avatarExplicit) ? textImport.persona.avatar : ''
  const avatar = textAvatar || cardImport?.persona.avatar || firstChar(name)
  const systemPrompt = textImport?.persona.systemPrompt || cardImport?.persona.systemPrompt || ''
  if (!systemPrompt) throw importError('导入内容没有可用的 systemPrompt', 'persona_prompt_empty')

  const persona = {
    ...(textImport?.persona.id && textExplicitName ? { id: textImport.persona.id } : {}),
    name,
    description,
    tags,
    avatar,
    greeting,
    systemPrompt,
    card: cardImport?.card || null,
  }
  return {
    persona,
    card: cardImport?.card || null,
    nameSource: textExplicitName ? textImport.nameSource : (cardImport ? 'card' : textImport?.nameSource || 'filename'),
    warnings,
  }
}

/**
 * 导入并落盘。默认同名不覆盖；overwrite=true 时更新已有自定义人设（内置永远拒绝）。
 * @param {import('./store.js').PersonaStore} store
 * @param {{ personaFile?: object, cardFile?: object, overwrite?: boolean }} body
 * @param {{ overwrite?: boolean, creator?: string|null }} opts
 * @returns {{ persona: object, created: boolean, updated: boolean, warnings: string[] }}
 */
export function applyPersonaImport(store, body = {}, { overwrite = false, creator = null } = {}) {
  if (!store) throw importError('人设库未就绪', 'persona_store_unavailable')
  const built = buildPersonaImport({ personaFile: body.personaFile, cardFile: body.cardFile })
  const flag = (v) => v === true || v === 1 || v === '1' || v === 'true'
  const wantOverwrite = flag(overwrite) || flag(body.overwrite)
  const desiredId = built.persona.id || slugify(built.persona.name)
  const existing = store.getExact(desiredId) || store.getExact(built.persona.name)

  if (existing) {
    if (existing.builtin) {
      throw importError(`「${existing.name}」是内置人设，不能通过导入覆盖`, 'persona_builtin', { existing: { id: existing.id, name: existing.name } })
    }
    if (!wantOverwrite) {
      throw importError(
        `已存在同名人设「${existing.name}」（#${existing.id}）；勾选「同名覆盖」后可更新`,
        'persona_exists',
        { existing: { id: existing.id, name: existing.name } },
      )
    }
    const updated = store.update(existing.id, { ...built.persona, id: existing.id })
    return { persona: updated, created: false, updated: true, warnings: built.warnings }
  }

  const created = store.add(built.persona, { creator })
  return { persona: created, created: true, updated: false, warnings: built.warnings }
}
