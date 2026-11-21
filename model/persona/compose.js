/**
 * 人设 + 角色卡片 → 最终身份层 systemPrompt。
 *
 * 设计：
 *  - 人设正文（systemPrompt）仍是身份层主体；.txt/.md 导入或手写内容优先。
 *  - 角色卡片（card）是结构化附件：导入时补全名称/简介/标签/开场白/正文；
 *    运行时只追加“卡片补充约束”，避免把整张卡每轮重复塞进 system。
 *  - 卡片自带的 system_prompt 已包含完整设定时，不再重复追加 behavior_rules/taboos；
 *    若人设正文是另一份 .txt/.md，则用卡片里的身份、概述、语气、行为规则、禁忌、
 *    价值取向与当前状态做补充。
 *  - 所有追加内容只取决于人设文件，跨轮稳定，不破坏 prompt 前缀缓存。
 */

const MAX_GUIDANCE_CHARS = 2400

function text(v) {
  return String(v ?? '').trim()
}

function list(v) {
  if (!Array.isArray(v)) return []
  return v.map((x) => text(x)).filter(Boolean)
}

function oneLine(v) {
  return text(v).replace(/\s+/g, ' ').trim()
}

/** 卡片补充约束（仅在人设正文不是卡片 system_prompt 时使用） */
export function cardGuidanceText(card, base = '') {
  const c = card && typeof card === 'object' ? card : null
  if (!c) return ''
  const baseText = text(base)
  const parts = []
  const has = (s) => !!s && baseText.includes(s)

  const ident = c.identity && typeof c.identity === 'object' ? c.identity : {}
  const name = oneLine(ident.name)
  const aliases = list(ident.aliases).slice(0, 6)
  const titles = list(ident.titles).slice(0, 4)
  const path = list(ident.path).slice(0, 4)
  const element = oneLine(ident.element)
  const identityBits = [
    name,
    aliases.length ? `别名：${aliases.join('、')}` : '',
    titles.length ? `头衔：${titles.join('、')}` : '',
    path.length ? `命途：${path.join('、')}` : '',
    element ? `属性：${element}` : '',
  ].filter(Boolean)
  if (identityBits.length && !has(name) && !aliases.some((a) => has(a))) {
    parts.push(`身份：${identityBits.join('；')}`)
  }

  const summary = oneLine(c.persona?.summary)
  if (summary && !has(summary)) parts.push(`角色概述：${summary}`)

  const tone = oneLine(c.voice?.tone)
  if (tone && !has(tone)) parts.push(`语气：${tone}`)
  const rhythm = oneLine(c.voice?.rhythm)
  if (rhythm && !has(rhythm)) parts.push(`节奏：${rhythm}`)

  const current = oneLine(c.lore?.current_state)
  if (current && !has(current)) parts.push(`当前状态：${current}`)

  const rules = list(c.behavior_rules)
    .filter((x) => !has(x))
    .slice(0, 16)
  if (rules.length) parts.push(['行为规则：', ...rules.map((x) => `- ${oneLine(x)}`)].join('\n'))

  const taboos = list(c.voice?.taboos)
    .filter((x) => !has(x))
    .slice(0, 12)
  if (taboos.length) parts.push(['表达禁忌：', ...taboos.map((x) => `- ${oneLine(x)}`)].join('\n'))

  const values = list(c.persona?.values)
    .filter((x) => !has(x))
    .slice(0, 10)
  if (values.length) parts.push(['价值取向：', ...values.map((x) => `- ${oneLine(x)}`)].join('\n'))

  if (!parts.length) return ''
  const body = parts.join('\n\n')
  const clipped = body.length > MAX_GUIDANCE_CHARS ? body.slice(0, MAX_GUIDANCE_CHARS) + '\n…（卡片补充约束已截断）' : body
  return `## 角色卡片·补充约束（与以上设定同等优先）\n${clipped}`
}

/**
 * 合成最终身份层。
 * @param {{ systemPrompt?: string, card?: object|null }} persona
 * @returns {string}
 */
export function composePersonaSystemPrompt(persona) {
  const base = text(persona?.systemPrompt)
  const card = persona?.card && typeof persona.card === 'object' ? persona.card : null
  if (!card) return base

  const cardPrompt = text(card.system_prompt || card.systemPrompt || card.system_prompt_compact || card.systemPromptCompact || card.prompt)
  const usingCardPrompt = !!cardPrompt && base === cardPrompt
  const parts = []

  if (base) parts.push(base)
  else if (cardPrompt) parts.push(cardPrompt)

  const post = text(card.post_history_instructions).slice(0, 2000)

  if (!usingCardPrompt) {
    const guidance = cardGuidanceText(card, base)
    if (guidance) parts.push(guidance)
  }

  if (post && !base.includes(post)) {
    parts.push(`## 角色卡片·输出要求\n${post}`)
  }

  return parts.filter(Boolean).join('\n\n')
}
