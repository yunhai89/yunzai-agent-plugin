/**
 * 人设（persona）公共出口 —— 人设库 + 每用户激活绑定 + Agent 接入。
 *
 * 用法（apps 层）：
 *   import { PersonaStore, PersonaService } from '../model/persona/index.js'
 *   const store = new PersonaStore({ dir: path.join(yunzaiRoot, 'data/agents-plugin/personas') })
 *   const persona = new PersonaService({ store, kv })
 *   // 每轮对话解析激活人设：
 *   const { persona: p } = await persona.resolve(ctx.userId)
 *   await agent.run(input, { ctx, systemPrompt: p?.systemPrompt })
 *
 * 人设作为 Agent 的"身份层"替换默认 systemPrompt；工具/记忆/防护仍照常追加。
 * 导入：.txt/.md 人设正文、aha-character-card/1.x 角色卡片（JSON）；卡片结构化字段
 * 由 compose.js 合成补充约束，不把整张卡原样塞进 system。
 */

import { PersonaStore, slugify, normalizePersona, PERSONA_MAX_NAME_LEN, PERSONA_MAX_PROMPT_LEN, PERSONA_MAX_CARD_BYTES } from './store.js'
import { PersonaService } from './service.js'
import { BUILTIN_PERSONAS } from './defaults.js'
import { PersonaLore, normalizeLore, normalizeCanonical, normalizeSources, groundingText, assertSafeLore } from './lore.js'
import { PersonaAdoptionQueue } from './adoptions.js'
import { PERSONA_COMPLETION_SYSTEM, buildCompletionInput, parseCompletionOutput, buildLoreDraft, formatDraftSummary, isCompletionToolAllowed } from './completion.js'
import { composePersonaSystemPrompt, cardGuidanceText, personaBreakReminder, PERSONA_LOCK } from './compose.js'
import { parsePersonaText, parseCharacterCard, buildPersonaImport, applyPersonaImport, IMPORT_MAX_TEXT_BYTES } from './import.js'

export {
  PersonaStore,
  PersonaService,
  PersonaLore,
  PersonaAdoptionQueue,
  slugify,
  normalizePersona,
  PERSONA_MAX_NAME_LEN,
  PERSONA_MAX_PROMPT_LEN,
  PERSONA_MAX_CARD_BYTES,
  normalizeLore,
  normalizeCanonical,
  normalizeSources,
  groundingText,
  assertSafeLore,
  BUILTIN_PERSONAS,
  PERSONA_COMPLETION_SYSTEM,
  buildCompletionInput,
  parseCompletionOutput,
  buildLoreDraft,
  formatDraftSummary,
  isCompletionToolAllowed,
  composePersonaSystemPrompt,
  cardGuidanceText,
  personaBreakReminder,
  PERSONA_LOCK,
  parsePersonaText,
  parseCharacterCard,
  buildPersonaImport,
  applyPersonaImport,
  IMPORT_MAX_TEXT_BYTES,
}
