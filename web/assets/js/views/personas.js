/** 视图:人设库(§2.2 · 内置只读 + 自定义 + 本地导入/角色卡) */
(function () {
  window.VIEWS = window.VIEWS || {}

  const AVA_BG = ['linear-gradient(135deg,#eef0fe,#e2e5fd)', 'linear-gradient(135deg,#e4f8f5,#d3f3ec)', 'linear-gradient(135deg,#fdf3e2,#fbe9c8)', 'linear-gradient(135deg,#fdecef,#fad9e0)', 'linear-gradient(135deg,#e8f6fe,#d3ecfc)']

  window.VIEWS.personas = {
    name: 'PersonasView',
    setup() {
      const { ref, computed, reactive, onMounted } = Vue
      const { toast, fmt } = window.UI
      const M = window.MOCK

      const personas = computed(() => M.personas)
      const personaLore = computed(() => M.personaLore || [])
      const loreMap = computed(() => Object.fromEntries(personaLore.value.map((l) => [l.id, l])))
      const loreOf = (p) => (p && p.id ? loreMap.value[p.id] : null) || null
      // 合并结构：有独立草稿时主资料带 .draft 字段；展示以草稿优先（待采纳内容）
      const lorePending = (p) => { const l = loreOf(p); return !!(l && l.draft) }
      const loreView = (p) => { const l = loreOf(p); return l ? (l.draft || l) : null }
      const detail = ref(null)
      const editor = ref({ show: false, idx: -1, form: null })
      const busy = ref('')

      // 角色卡片摘要（只读展示；完整卡片仍保存在 persona.card）
      const cardStats = (p) => {
        const c = p && p.card && typeof p.card === 'object' ? p.card : null
        if (!c) return null
        const list = (v) => (Array.isArray(v) ? v.map((x) => String(x || '').trim()).filter(Boolean) : [])
        const count = (v) => (Array.isArray(v) ? v.length : (v && typeof v === 'object' ? Object.keys(v).length : 0))
        const meta = c.meta && typeof c.meta === 'object' ? c.meta : {}
        const ident = c.identity && typeof c.identity === 'object' ? c.identity : {}
        const persona = c.persona && typeof c.persona === 'object' ? c.persona : {}
        const path = list(ident.path)
        const element = String(ident.element || '').trim()
        const faction = String(ident.faction || '').trim()
        return {
          spec: String(c.spec || 'character-card').trim(),
          nameEn: String(meta.name_en || '').trim(),
          version: String(meta.version || '').trim(),
          base: String(meta.base || '').trim(),
          aliases: list(ident.aliases).slice(0, 6),
          titles: list(ident.titles).slice(0, 4),
          identityLine: [path.join(' / '), element, faction].filter(Boolean).join(' · '),
          summary: String(persona.summary || '').trim(),
          keywords: list(persona.keywords).slice(0, 8),
          rules: count(c.behavior_rules),
          taboos: list(c.voice && c.voice.taboos).length,
          relationships: Object.keys(c.relationships || {}).slice(0, 8),
          timeline: count(c.lore && c.lore.timeline),
          examples: count(c.example_dialogues),
        }
      }
      const detailCard = computed(() => (detail.value ? cardStats(detail.value) : null))

      // —— 本地文件导入（.txt / .md 人设正文 + .json 角色卡片）——
      const importState = reactive({ show: false, personaFile: null, cardFile: null, overwrite: false, busy: false, error: '' })
      const personaFileEl = ref(null)
      const cardFileEl = ref(null)
      const canImport = computed(() => !!(importState.personaFile || importState.cardFile) && !importState.busy)
      const openImport = () => {
        importState.show = true
        importState.personaFile = null
        importState.cardFile = null
        importState.overwrite = false
        importState.busy = false
        importState.error = ''
      }
      const closeImport = () => { if (!importState.busy) importState.show = false }
      const fileExt = (name) => (String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/) || [])[1] || ''
      const onPickPersona = (e) => {
        const f = e.target.files?.[0] || null
        if (f && !['txt', 'md'].includes(fileExt(f.name))) {
          importState.personaFile = null
          importState.error = '人设文件只支持 .txt / .md'
          e.target.value = ''
          return
        }
        importState.personaFile = f
        importState.error = ''
      }
      const onPickCard = (e) => {
        const f = e.target.files?.[0] || null
        if (f && fileExt(f.name) !== 'json') {
          importState.cardFile = null
          importState.error = '角色卡片只支持 .json'
          e.target.value = ''
          return
        }
        importState.cardFile = f
        importState.error = ''
      }
      const readImportFile = async (f) => ({ filename: f.name, content: await f.text() })
      const doImport = async () => {
        if (!canImport.value) { toast('请先选择 .txt/.md 人设文件或 .json 角色卡片', 'warn'); return }
        importState.busy = true
        importState.error = ''
        try {
          const body = { overwrite: importState.overwrite }
          if (importState.personaFile) body.personaFile = await readImportFile(importState.personaFile)
          if (importState.cardFile) body.cardFile = await readImportFile(importState.cardFile)
          const r = await window.api.post('/personas/import', body)
          await window.store.loadPersonas()
          importState.show = false
          toast(`${r.created ? '已导入' : '已更新'}「${r.persona.name}」${r.persona.card ? '（含角色卡片）' : ''}`, 'success')
          for (const w of (r.warnings || []).slice(0, 3)) toast(w, 'warn')
        } catch (e) {
          importState.error = e.message || '导入失败'
          toast(importState.error, 'error')
        } finally { importState.busy = false }
      }

      const openCreate = () => {
        editor.value = { show: true, idx: -1, form: { id: '', name: '', description: '', tags: [], avatar: '新', greeting: '', systemPrompt: '', card: null, builtin: false, creator: '', createdAt: Date.now() } }
      }
      const openEdit = (p, i) => {
        if (p.builtin) { toast('内置人设为代码常量,只读不可改', 'warn'); return }
        editor.value = { show: true, idx: i, form: JSON.parse(JSON.stringify(p)) }
      }
      const tagInput = ref('')
      const addTag = () => {
        const f = editor.value.form
        const v = tagInput.value.trim()
        if (v && f.tags.length < 8 && !f.tags.includes(v)) f.tags.push(v)
        tagInput.value = ''
      }
      const applyEdit = async () => {
        const f = editor.value.form
        if (!f.name.trim() || !f.systemPrompt.trim()) { toast('名称与 systemPrompt 必填', 'warn'); return }
        const payload = JSON.parse(JSON.stringify(f))
        try {
          if (editor.value.idx === -1) {
            await window.api.post('/personas', payload)
            toast(`人设「${f.name}」已创建`)
          } else {
            await window.api.put(`/personas/${f.id}`, payload)
            toast(`人设「${f.name}」已更新`)
          }
          await window.store.loadPersonas()
          editor.value.show = false
        } catch (e) {
          const msg = e.message || ''
          if (/内置/.test(msg)) toast('内置人设只读', 'warn')
          else toast(msg, 'error')
        }
      }
      const del = async (p, i) => {
        if (p.builtin) { toast('内置人设不可删除', 'warn'); return }
        try {
          await window.api.del(`/personas/${p.id}`)
          await window.store.loadPersonas()
          toast(`已删除人设「${p.name}」`, 'info')
        } catch (e) {
          const msg = e.message || ''
          if (/内置/.test(msg)) toast('内置人设只读', 'warn')
          else toast(msg, 'error')
        }
      }

      onMounted(async () => {
        try { await window.store.loadPersonas() } catch (e) { toast(e.message, 'error') }
        try { await window.store.loadPersonaLore() } catch { /* 兼容旧后端：无人设资料库 */ }
      })

      // —— 人设资料库：补齐 / 采纳 / 丢弃（草稿须采纳才生效）——
      const loadLore = async () => { try { await window.store.loadPersonaLore() } catch { /* noop */ } }
      const doComplete = async (p) => {
        if (busy.value) return
        busy.value = 'complete'
        try { await window.api.post(`/persona-lore/${p.id}/complete`, {}); await loadLore(); toast(`已为「${p.name}」生成补齐草稿，预览后采纳生效`) }
        catch (e) { toast(e.message || '补齐失败', 'error') } finally { busy.value = '' }
      }
      const doAdopt = async (p) => {
        if (busy.value) return
        busy.value = 'adopt'
        try {
          // 采纳改为「进审批门」：提交待审项，须在审批门批准后才 draft→active
          const r = await window.api.post('/persona-adoptions', { personaId: p.id })
          try { await window.store.loadPersonaAdoptions() } catch { /* noop */ }
          toast(r?.duplicated
            ? `「${p.name}」已有待审采纳，已刷新为最新草稿，请在「审批门」批准`
            : `已提交「${p.name}」资料采纳审批，请在「审批门」批准后生效`)
        } catch (e) { toast(e.message || '提交采纳审批失败', 'error') } finally { busy.value = '' }
      }
      const doDiscard = async (p) => {
        if (busy.value) return
        busy.value = 'discard'
        const wasDraft = lorePending(p)
        try { await window.api.del(`/persona-lore/${p.id}`); await loadLore(); toast(wasDraft ? '已丢弃待审草稿（生效资料保留）' : '已丢弃人设资料', 'info') }
        catch (e) { toast(e.message || '丢弃失败', 'error') } finally { busy.value = '' }
      }

      return {
        personas, personaLore, loreOf, lorePending, loreView, detail, detailCard, editor,
        openCreate, openEdit, tagInput, addTag, applyEdit, del, busy, doComplete, doAdopt, doDiscard,
        importState, personaFileEl, cardFileEl, openImport, closeImport, onPickPersona, onPickCard, doImport, canImport,
        AVA_BG, fmt,
      }
    },
    template: `
    <div class="view view-personas">
      <page-head title="人设库" icon="persona" desc="data/personas/&lt;id&gt;.json + data/persona-lore/&lt;id&gt;.json · 内置为代码常量(只读)；支持 .txt / .md / .json 角色卡片导入；资料采纳须经「审批门」批准后生效">
        <button class="btn b-line" @click="openImport"><v-icon name="file"/>导入</button>
        <button class="btn b-pri" @click="openCreate"><v-icon name="plus"/>新建人设</button>
      </page-head>

      <div class="grid g3 stagger">
        <div v-for="(p, i) in personas" :key="p.id" class="card lift ps-card" :style="{'--i': i + 1}" @click="detail = p">
          <div class="row-b">
            <div class="ps-ava" :style="{background: AVA_BG[i % AVA_BG.length]}">{{ p.avatar }}</div>
            <span v-if="p.builtin" class="pill p-line"><v-icon name="lock"/>内置</span>
            <span v-else class="pill p-vio">自定义</span>
            <span v-if="p.card" class="pill p-honey" style="font-size:10px"><v-icon name="file"/>角色卡</span>
            <span v-if="lorePending(p)" class="pill p-pri" style="font-size:10px">待审草稿</span>
            <span v-else-if="loreOf(p) && loreOf(p).status === 'active'" class="pill p-mint" style="font-size:10px">资料已启用</span>
            <span v-else-if="loreOf(p)" class="pill p-pri" style="font-size:10px">资料草稿</span>
          </div>
          <div>
            <div style="font-weight:800;font-size:15px">{{ p.name }}</div>
            <div class="mut" style="font-size:12px;margin-top:3px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">{{ p.description }}</div>
          </div>
          <div class="row g6 wrap">
            <span v-for="t in p.tags" :key="t" class="pill p-pri" style="font-size:10.5px">{{ t }}</span>
          </div>
          <div class="row-b" style="margin-top:auto">
            <span class="mut2" style="font-size:11px">{{ fmt.ago(p.createdAt) }}创建</span>
            <div class="row g6" @click.stop>
              <button class="bic" @click="openEdit(p, i)" :title="p.builtin ? '内置只读' : '编辑'"><v-icon name="edit"/></button>
              <button class="bic dg" title="删除人设" aria-label="删除人设" @click="del(p, i)"><v-icon name="trash"/></button>
            </div>
          </div>
        </div>
      </div>

      <!-- 详情 -->
      <v-modal v-if="detail" :title="detail.name" icon="persona" width="720px" @close="detail = null">
        <div class="row g14" style="align-items:flex-start">
          <div class="ps-ava" style="width:64px;height:64px;font-size:32px;flex:0 0 64px" :style="{background: AVA_BG[0]}">{{ detail.avatar }}</div>
          <div style="flex:1;min-width:0">
            <div class="row g6 wrap">
              <span class="pill" :class="detail.builtin ? 'p-line' : 'p-vio'">{{ detail.builtin ? '内置(代码常量)' : '自定义 .json' }}</span>
              <span v-if="detail.card" class="pill p-honey"><v-icon name="file"/>角色卡片</span>
              <span v-for="t in detail.tags" :key="t" class="pill p-pri">{{ t }}</span>
            </div>
            <p class="mut mt8" style="font-size:13px">{{ detail.description }}</p>
          </div>
        </div>
        <div class="hr"></div>
        <div class="field">
          <label class="f-label">开场白 greeting</label>
          <div class="m-b a" style="max-width:100%">{{ detail.greeting }}</div>
        </div>
        <div class="field mt16">
          <label class="f-label">systemPrompt（基础）</label>
          <pre class="code" style="white-space:pre-wrap">{{ detail.systemPrompt }}</pre>
        </div>

        <template v-if="detailCard">
          <div class="hr"></div>
          <div class="row-b">
            <label class="f-label" style="margin:0">角色卡片</label>
            <span class="pill p-honey">{{ detailCard.spec }}</span>
          </div>
          <div class="grid g2" style="gap:8px 14px;margin-top:10px;font-size:12.5px">
            <div><span class="mut2">英文名</span> {{ detailCard.nameEn || '—' }}</div>
            <div><span class="mut2">版本</span> {{ detailCard.version || '—' }}</div>
            <div style="grid-column:1/-1"><span class="mut2">所属</span> {{ detailCard.base || '—' }}</div>
            <div v-if="detailCard.identityLine" style="grid-column:1/-1"><span class="mut2">身份</span> {{ detailCard.identityLine }}</div>
          </div>
          <div v-if="detailCard.aliases.length" class="row g6 wrap mt8">
            <span class="mut2" style="font-size:12px">别名</span>
            <span v-for="a in detailCard.aliases" :key="a" class="pill p-line">{{ a }}</span>
          </div>
          <div v-if="detailCard.titles.length" class="row g6 wrap mt8">
            <span class="mut2" style="font-size:12px">头衔</span>
            <span v-for="t in detailCard.titles" :key="t" class="pill p-pri">{{ t }}</span>
          </div>
          <p v-if="detailCard.summary" class="mut mt8" style="font-size:13px">{{ detailCard.summary }}</p>
          <div class="row g6 wrap mt8">
            <span class="pill p-line">行为规则 {{ detailCard.rules }}</span>
            <span class="pill p-line">表达禁忌 {{ detailCard.taboos }}</span>
            <span class="pill p-line">关系 {{ detailCard.relationships.length }}</span>
            <span class="pill p-line">时间线 {{ detailCard.timeline }}</span>
            <span class="pill p-line">示例对话 {{ detailCard.examples }}</span>
          </div>
          <div v-if="detailCard.relationships.length" class="mut2 mt8" style="font-size:12px">关系：{{ detailCard.relationships.join('、') }}</div>
          <div v-if="detailCard.keywords.length" class="row g6 wrap mt8">
            <span v-for="k in detailCard.keywords" :key="k" class="pill p-pri" style="font-size:10.5px">{{ k }}</span>
          </div>
          <div class="mut2 mt8" style="font-size:11.5px">卡片结构化设定用于导入映射与运行时补充；当人设正文不是卡片自带 system_prompt 时，会追加身份、概述、语气、行为规则、禁忌与当前状态等。</div>
        </template>
        <div class="hr"></div>
        <div class="row-b">
          <label class="f-label" style="margin:0">角色设定资料（已核实事实）</label>
          <div class="row g6" style="flex-wrap:wrap">
            <button class="btn b-soft b-sm" :disabled="!!busy" @click="doComplete(detail)"><v-icon name="search"/>{{ busy === 'complete' ? '检索中…' : (loreOf(detail) ? '重取' : '补齐') }}</button>
            <button v-if="loreView(detail) && (lorePending(detail) || loreView(detail).status !== 'active')" class="btn b-pri b-sm" :disabled="!!busy" @click="doAdopt(detail)" title="提交到审批门，批准后生效"><v-icon name="check"/>提交采纳</button>
            <button v-if="loreView(detail)" class="btn b-line b-sm" :disabled="!!busy" @click="doDiscard(detail)"><v-icon name="trash"/>丢弃</button>
          </div>
        </div>
        <div v-if="!loreView(detail)" class="mut2 mt8" style="font-size:12.5px">暂无资料。点「补齐」让 Agent 检索角色设定并生成草稿（也可在群里发 <span class="mono">#人设补齐 {{ detail.id }}</span>）。</div>
        <template v-else>
          <div class="row g6 wrap mt8">
            <span class="pill" :class="loreView(detail).status === 'active' && !lorePending(detail) ? 'p-mint' : 'p-pri'">{{ lorePending(detail) ? '待采纳草稿' : (loreView(detail).status === 'active' ? '已生效' : '草稿（未生效）') }}</span>
            <span v-if="loreOf(detail) && loreOf(detail).refreshCron" class="pill p-vio">定时：{{ loreOf(detail).refreshCron }}</span>
          </div>
          <p v-if="loreView(detail).summary" class="mut mt8" style="font-size:13px">{{ loreView(detail).summary }}</p>
          <label class="f-label mt16">事实</label>
          <pre class="code" style="white-space:pre-wrap">{{ loreView(detail).facts || '（无）' }}</pre>
          <template v-if="loreView(detail).sources && loreView(detail).sources.length">
            <label class="f-label mt16">出处</label>
            <div v-for="(s, i) in loreView(detail).sources" :key="i" class="mut2" style="font-size:12px">[{{ i + 1 }}] {{ s.title || s.ref }}<span v-if="s.ref && s.title">（{{ s.ref }}）</span></div>
          </template>
        </template>
        <div class="mut2 mt16" style="font-size:11.5px">id: <span class="mono">{{ detail.id }}</span> · creator: {{ detail.creator || '—' }} · {{ new Date(detail.createdAt).toLocaleString('zh-CN') }}</div>
      </v-modal>

      <!-- 编辑/新建 -->
      <v-modal v-if="editor.show" :title="editor.idx === -1 ? '新建人设' : '编辑人设 · ' + editor.form.name" icon="edit" width="720px" @close="editor.show = false">
        <div class="grid g2" style="gap:14px">
          <div class="field"><label class="f-label">名称</label><input class="inp" v-model="editor.form.name"></div>
          <div class="field"><label class="f-label">头像 emoji</label><input class="inp" v-model="editor.form.avatar" maxlength="4"></div>
          <div class="field" style="grid-column:1/-1"><label class="f-label">一句话描述</label><input class="inp" v-model="editor.form.description"></div>
          <div class="field" style="grid-column:1/-1">
            <label class="f-label">标签(≤8,回车添加)</label>
            <div class="row g6 wrap">
              <span v-for="(t, i) in editor.form.tags" :key="t" class="pill p-pri">{{ t }}<v-icon name="x" style="cursor:pointer" @click="editor.form.tags.splice(i, 1)"/></span>
              <input class="inp" style="width:110px;padding:5px 10px;font-size:12px" v-model="tagInput" enterkeyhint="enter" @keydown.enter.prevent="addTag" @keyup.enter.prevent="addTag" placeholder="回车添加">
              <button type="button" class="btn b-soft b-sm" @click="addTag" title="添加"><v-icon name="plus"/></button>
            </div>
          </div>
          <div class="field" style="grid-column:1/-1"><label class="f-label">开场白</label><input class="inp" v-model="editor.form.greeting"></div>
          <div class="field" style="grid-column:1/-1">
            <label class="f-label">systemPrompt（≤20000 字）</label>
            <textarea class="txa" style="min-height:130px" v-model="editor.form.systemPrompt" maxlength="20000"></textarea>
          </div>
          <div v-if="editor.form.card" class="field" style="grid-column:1/-1">
            <label class="f-label">角色卡片</label>
            <div class="mut2" style="font-size:12px">已关联 {{ editor.form.card.spec || 'character-card' }}。编辑上方正文不会删除卡片；运行时按卡片补充约束合并。</div>
          </div>
        </div>
        <template #foot>
          <button class="btn b-line" @click="editor.show = false">取消</button>
          <button class="btn b-pri" @click="applyEdit"><v-icon name="check"/>保存</button>
        </template>
      </v-modal>

      <!-- 本地文件导入：.txt/.md 人设正文 + .json 角色卡片 -->
      <v-modal v-if="importState.show" title="导入人设" icon="file" width="720px" @close="closeImport">
        <div class="mut2" style="font-size:12px;margin-bottom:14px">至少选择人设正文或角色卡片之一；同时选择时正文优先，卡片补全结构化设定。</div>
        <div class="field">
          <label class="f-label" for="persona-import-text">人设正文 · .txt / .md（可选）</label>
          <input id="persona-import-text" name="persona-file" ref="personaFileEl" type="file" class="inp" accept=".txt,.md,text/plain,text/markdown" aria-describedby="persona-import-text-help" @change="onPickPersona">
          <div id="persona-import-text-help" class="mut2" style="font-size:11.5px;margin-top:5px">正文会作为 systemPrompt。Markdown 支持简单 frontmatter（name/description/tags/avatar/greeting/systemPrompt）与首个 # 标题作为名称。</div>
          <div v-if="importState.personaFile" class="mut2" style="font-size:11.5px;margin-top:4px">已选：{{ importState.personaFile.name }}（{{ fmt.bytes(importState.personaFile.size) }}）</div>
        </div>
        <div class="field mt16">
          <label class="f-label" for="persona-import-card">角色卡片 · .json（可选）</label>
          <input id="persona-import-card" name="persona-card" ref="cardFileEl" type="file" class="inp" accept=".json,application/json" aria-describedby="persona-import-card-help" @change="onPickCard">
          <div id="persona-import-card-help" class="mut2" style="font-size:11.5px;margin-top:5px">支持 aha-character-card/1.x。卡片补全名称、简介、标签、开场白与 systemPrompt，并保存在人设的 card 字段；同时提供正文时正文优先。</div>
          <div v-if="importState.cardFile" class="mut2" style="font-size:11.5px;margin-top:4px">已选：{{ importState.cardFile.name }}（{{ fmt.bytes(importState.cardFile.size) }}）</div>
        </div>
        <label class="row g6" style="font-size:12.5px;cursor:pointer;margin-top:14px;align-items:flex-start">
          <input type="checkbox" v-model="importState.overwrite" style="margin-top:2px">
          <span>同名覆盖已有自定义人设<br><span class="mut2" style="font-size:11.5px">内置人设不会被覆盖；不勾选时遇到同名会提示。</span></span>
        </label>
        <div v-if="importState.error" class="subpanel sp-rose" role="alert" style="margin-top:10px;font-size:12.5px">{{ importState.error }}</div>
        <template #foot>
          <button class="btn b-line" :disabled="importState.busy" @click="closeImport">取消</button>
          <button class="btn b-pri" :disabled="!canImport" @click="doImport"><v-icon name="check"/>{{ importState.busy ? '导入中…' : '导入' }}</button>
        </template>
      </v-modal>
    </div>`,
  }
})()
