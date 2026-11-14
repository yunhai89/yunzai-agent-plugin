/** 视图:声明式记忆(§2.1 · 按 scope 隔离) */
(function () {
  window.VIEWS = window.VIEWS || {}

  window.VIEWS.memory = {
    name: 'MemoryView',
    setup() {
      const { ref, computed, onMounted, watch } = Vue
      const { toast, fmt } = window.UI
      const M = window.MOCK

      const scopeId = ref(M.scopes[0]?.scopeId || '')
      const tab = ref('memory') // memory=MEMORY.md / user=USER.md
      const data = computed(() => M.memories[scopeId.value]?.[tab.value] || { usedChars: 0, limitChars: 0, entries: [] })
      const pct = computed(() => fmt.pct(data.value.usedChars, data.value.limitChars))
      const scopeInfo = computed(() => M.scopes.find((s) => s.scopeId === scopeId.value))

      /* 编辑 / 新增 → PUT 全量条目,成功重拉 */
      const editor = ref({ show: false, idx: -1, text: '' })
      const openAdd = () => { editor.value = { show: true, idx: -1, text: '' } }
      const openEdit = (i) => { editor.value = { show: true, idx: i, text: data.value.entries[i] } }
      const applyEdit = async () => {
        const t = editor.value.text.trim()
        if (!t) return
        const entries = data.value.entries.slice()
        if (editor.value.idx === -1) entries.push(t)
        else entries[editor.value.idx] = t
        try {
          await window.api.put(`/memories/${scopeId.value}/${tab.value}`, { entries })
          await window.store.loadMemories(scopeId.value)
          toast(editor.value.idx === -1 ? '已添加记忆条目' : '已更新条目')
        } catch (e) { toast(e.message, 'error') }
        editor.value.show = false
      }
      const del = async (i) => {
        const entries = data.value.entries.slice()
        entries.splice(i, 1)
        try {
          await window.api.put(`/memories/${scopeId.value}/${tab.value}`, { entries })
          await window.store.loadMemories(scopeId.value)
          toast('已删除条目', 'info')
        } catch (e) { toast(e.message, 'error') }
      }

      const fileName = computed(() => (tab.value === 'memory' ? 'MEMORY.md' : 'USER.md'))
      const headerLine = computed(() => {
        const d = data.value
        const label = tab.value === 'memory' ? 'MEMORY (your personal notes)' : 'USER (about the user)'
        return `${label} [${pct.value}% — ${d.usedChars}/${d.limitChars} chars]`
      })

      /* 惰性加载:先拉 scope 列表定默认值,再拉该 scope 记忆;切 scope 重拉 */
      onMounted(async () => {
        try {
          await window.store.loadScopes()
          if (!scopeId.value && M.scopes[0]) scopeId.value = M.scopes[0].scopeId
          if (scopeId.value) await window.store.loadMemories(scopeId.value)
        } catch (e) { toast(e.message, 'error') }
      })
      watch(scopeId, (v) => { if (v) window.store.loadMemories(v).catch((e) => toast(e.message, 'error')) })

      return { scopeId, tab, data, pct, scopeInfo, editor, openAdd, openEdit, applyEdit, del, fileName, headerLine }
    },
    template: `
    <div class="view view-memory">
      <page-head title="声明式记忆" icon="memory" desc="MEMORY.md / USER.md · 按 scope 隔离。私聊 u_qq，群隔离 g群_uqq，群共享 g群；同一用户在不同群是独立数据集。">
        <button class="btn b-pri" @click="openAdd"><v-icon name="plus"/>新增条目</button>
      </page-head>

      <div class="toolbar">
        <scope-picker v-model="scopeId"/>
        <div class="seg">
          <button :class="{ on: tab === 'memory' }" @click="tab = 'memory'">MEMORY.md</button>
          <button :class="{ on: tab === 'user' }" @click="tab = 'user'">USER.md</button>
        </div>
        <span class="spacer"></span>
        <span class="code-strip">data/memories/{{ scopeId }}/{{ fileName }}</span>
      </div>

      <div class="split" style="margin-top:18px">
        <aside class="split-aside">
          <section class="chamber">
            <header class="chamber-head">
              <div>
                <h2 class="chamber-title">容量</h2>
                <p class="chamber-sub">{{ scopeInfo?.label || '未选择 scope' }}</p>
              </div>
            </header>
            <div class="chamber-body" style="display:flex;flex-direction:column;align-items:center;gap:14px">
              <ring-progress :percent="pct" :key="scopeId + tab" :size="148" :stroke="10">
                <template #default="{ percent }">
                  <div class="metric-value" style="margin:0">{{ percent }}<small>%</small></div>
                  <div class="metric-note">容量占用</div>
                </template>
              </ring-progress>
              <div class="metric-value" style="font-size:24px">{{ data.usedChars }}<small>/ {{ data.limitChars }} chars</small></div>
              <div class="meter" :class="pct > 85 ? 'm-rose' : pct > 60 ? 'm-honey' : 'm-mint'" style="width:100%">
                <i :style="{ width: pct + '%' }"></i>
              </div>
              <div class="metric-note">{{ data.entries.length }} 条 bullet 条目</div>
            </div>
          </section>

          <section class="chamber">
            <div class="chamber-body" style="padding-top:22px">
              <div class="stat-line"><span>文件</span><b>{{ fileName }}</b></div>
              <div class="stat-line"><span>条目</span><b>{{ data.entries.length }}</b></div>
              <div class="stat-line"><span>Scope</span><b>{{ scopeId || '—' }}</b></div>
              <p class="aside-note" style="margin-top:14px">文件即真相。Agent 在对话里可以 add / replace / remove；你也可以直接编辑 <code>data/memories/</code> 下的 Markdown，重启后生效。</p>
            </div>
          </section>
        </aside>

        <section class="chamber">
          <header class="chamber-head">
            <div>
              <h2 class="chamber-title">{{ fileName }}</h2>
              <p class="chamber-sub mono">{{ headerLine }}</p>
            </div>
            <button class="btn b-line b-sm" @click="openAdd"><v-icon name="plus"/>新增</button>
          </header>
          <div class="chamber-body">
            <TransitionGroup name="list" tag="div" class="list-stack">
              <div v-for="(e, i) in data.entries" :key="e + i" class="entry-row">
                <span class="entry-index">{{ i + 1 }}</span>
                <div class="entry-main">
                  <div class="entry-text">{{ e }}</div>
                </div>
                <div class="entry-actions">
                  <button class="bic" title="编辑" @click="openEdit(i)"><v-icon name="edit"/></button>
                  <button class="bic dg" title="删除" @click="del(i)"><v-icon name="trash"/></button>
                </div>
              </div>
            </TransitionGroup>
            <empty-state v-if="!data.entries.length" icon="memory" text="此 scope 暂无记忆" sub="Agent 会在对话中自动沉淀，也可手动新增"/>
          </div>
        </section>
      </div>

      <v-modal v-if="editor.show" :title="editor.idx === -1 ? '新增记忆条目' : '编辑条目 #' + (editor.idx + 1)" icon="edit" @close="editor.show = false">
        <div class="field">
          <label class="f-label">条目内容（一条 bullet）</label>
          <textarea class="txa" v-model="editor.text" maxlength="500" placeholder="例如：用户偏好简洁回答"></textarea>
          <span class="f-help">写入 {{ scopeInfo?.label }} 的 {{ fileName }}；超过上限会触发淘汰策略。</span>
        </div>
        <template #foot>
          <button class="btn b-line" @click="editor.show = false">取消</button>
          <button class="btn b-pri" @click="applyEdit"><v-icon name="check"/>保存</button>
        </template>
      </v-modal>
    </div>`,
  }
})()
