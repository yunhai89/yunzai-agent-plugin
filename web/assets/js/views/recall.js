/** 视图:长期记忆 recall(§3.3 · KV · 按用户) */
(function () {
  window.VIEWS = window.VIEWS || {}

  const LEVEL = {
    L2: { name: 'L2 近期', cls: 'p-sky', desc: '近期上下文事实' },
    L3: { name: 'L3 偏好', cls: 'p-vio', desc: '用户偏好' },
    L4: { name: 'L4 事实', cls: 'p-mint', desc: '稳定事实/身份' },
  }
  // 兜底：后端 LLM 抽取的 level 未经枚举校验，可能是别名/大小写/undefined。
  // 直接 LEVEL[e.level].cls 会抛 TypeError 使整个列表渲染失败（曾整页空白）。
  const lv = (l) => LEVEL[l] || LEVEL.L3

  window.VIEWS.recall = {
    name: 'RecallView',
    setup() {
      const { ref, computed, onMounted, watch } = Vue
      const { toast, fmt } = window.UI
      const M = window.MOCK

      /* 用户清单：声明式记忆 scope + 长期记忆 KV 里实际存在的用户键（官方 openid 的 scope 目录是净化后的，不能只靠 scopes） */
      const userIds = computed(() => [...new Set([
        ...(M.recallUsers || []),
        ...(M.scopes || []).map((s) => s.userId),
      ].filter(Boolean))])
      const userId = ref('')
      const level = ref('all')
      const showSuspect = ref(true)

      const entries = computed(() => (M.recall[userId.value] || [])
        .filter((e) => level.value === 'all' || e.level === level.value)
        .filter((e) => showSuspect.value || !e.suspect)
        .slice()
        .sort((a, b) => b.updatedAt - a.updatedAt))

      const expanded = ref({})
      const toggle = (id) => { expanded.value[id] = !expanded.value[id] }

      const del = async (e) => {
        try {
          await window.api.del(`/recall/${userId.value}/${e.id}`)
          await window.store.loadRecall(userId.value)
          toast('已删除该条长期记忆', 'info')
        } catch (err) { toast(err.message, 'error') }
      }

      const addModal = ref({ show: false, level: 'L3', type: 'preference', content: '', confidence: 0.8 })
      const add = async () => {
        const m = addModal.value
        if (!m.content.trim()) return
        try {
          await window.api.post(`/recall/${userId.value}`, {
            level: m.level, type: m.type, content: m.content.trim(), confidence: m.confidence,
          })
          await window.store.loadRecall(userId.value)
          toast('已写入长期记忆(已过威胁扫描)')
          addModal.value.show = false
          addModal.value.content = ''
        } catch (err) { toast(err.message, 'error') }
      }

      /* 惰性加载:scope 列表定默认用户 → 拉该用户 recall;切用户重拉 */
      onMounted(async () => {
        try {
          await Promise.all([window.store.loadScopes(), window.store.loadRecallUsers()])
          if (!userId.value && userIds.value[0]) userId.value = userIds.value[0]
          if (userId.value) await window.store.loadRecall(userId.value)
        } catch (e) { toast(e.message, 'error') }
      })
      watch(userId, (v) => { if (v) window.store.loadRecall(v).catch((e) => toast(e.message, 'error')) })

      const allEntries = computed(() => M.recall[userId.value] || [])
      const levelCounts = computed(() => {
        const out = { L2: 0, L3: 0, L4: 0 }
        for (const e of allEntries.value) if (out[e.level] != null) out[e.level]++
        return out
      })
      const suspectCount = computed(() => allEntries.value.filter((e) => e.suspect).length)

      return { userIds, userId, level, showSuspect, entries, allEntries, levelCounts, suspectCount, expanded, toggle, del, addModal, add, LEVEL, lv, fmt }
    },
    template: `
    <div class="view view-recall">
      <page-head title="长期记忆" icon="recall" desc="LLM 抽取沉淀 · L2/L3/L4 分层 · 上限 200 条超限按价值淘汰；命中注入扫描的条目召回屏蔽，但仍在排查视图保留。">
        <button class="btn b-pri" @click="addModal.show = true"><v-icon name="plus"/>写入记忆</button>
      </page-head>

      <div class="toolbar">
        <div class="scp-bar">
          <span class="scp-lab">用户</span>
          <div v-for="u in userIds" :key="u" class="scp" :class="{ on: u === userId }" @click="userId = u">
            <v-icon name="user"/><span>{{ u }}</span>
          </div>
        </div>
        <span class="spacer"></span>
        <div class="seg">
          <button :class="{ on: level === 'all' }" @click="level = 'all'">全部</button>
          <button v-for="(v, k) in LEVEL" :key="k" :class="{ on: level === k }" @click="level = k">{{ k }}</button>
        </div>
        <button class="pill" :class="showSuspect ? 'p-honey' : 'p-line'" style="cursor:pointer" @click="showSuspect = !showSuspect">
          <v-icon name="shield"/>{{ showSuspect ? '含可疑条目' : '已隐藏可疑' }}
        </button>
      </div>

      <div class="split" style="margin-top:18px">
        <aside class="split-aside">
          <section class="chamber">
            <header class="chamber-head">
              <div><h2 class="chamber-title">分层</h2><p class="chamber-sub">当前用户的长期记忆存量</p></div>
            </header>
            <div class="chamber-body">
              <div class="metric-stack">
                <div class="metric">
                  <div class="metric-label">全部条目</div>
                  <div class="metric-value">{{ allEntries.length }}</div>
                  <div class="metric-note">上限 200 · 超限按价值淘汰</div>
                </div>
                <div class="metric">
                  <div class="metric-label">L2 近期 / L3 偏好 / L4 事实</div>
                  <div class="metric-value" style="font-size:22px">{{ levelCounts.L2 }} <small>/</small> {{ levelCounts.L3 }} <small>/</small> {{ levelCounts.L4 }}</div>
                </div>
              </div>
            </div>
          </section>
          <section class="chamber">
            <div class="chamber-body" style="padding-top:22px">
              <div class="stat-line"><span>KV 键</span><b style="font-size:10px">Yz:agent:mem:{{ userId || '—' }}</b></div>
              <div class="stat-line"><span>可疑条目</span><b>{{ suspectCount }}</b></div>
              <p class="aside-note" style="margin-top:14px">长期记忆由 LLM 在对话后异步抽取，也可手动写入。写入会经过威胁扫描；可疑条目召回时会被屏蔽。</p>
            </div>
          </section>
        </aside>

        <section class="chamber">
          <header class="chamber-head">
            <div>
              <h2 class="chamber-title">记忆条目</h2>
              <p class="chamber-sub">{{ entries.length }} 条 · 按更新时间排序</p>
            </div>
            <button class="btn b-line b-sm" @click="addModal.show = true"><v-icon name="plus"/>写入</button>
          </header>
          <div class="chamber-body">
            <TransitionGroup name="list" tag="div" class="list-stack">
              <article v-for="(e, i) in entries" :key="e.id" class="entry-row" :class="{ 'is-suspect': e.suspect }">
                <span class="entry-index">{{ i + 1 }}</span>
                <div class="entry-main">
                  <div class="pill-row" style="margin-bottom:7px">
                    <span class="pill" :class="lv(e.level).cls">{{ lv(e.level).name }}</span>
                    <span class="pill p-line">{{ e.type }}</span>
                    <span v-if="e.suspect" class="pill p-rose"><v-icon name="warn"/>疑似注入</span>
                  </div>
                  <div class="entry-text">{{ e.content }}</div>
                  <div class="entry-meta">
                    <span class="meter" style="width:92px" :class="e.confidence > 0.85 ? 'm-mint' : e.confidence > 0.6 ? '' : 'm-honey'">
                      <i :style="{ width: e.confidence * 100 + '%' }"></i>
                    </span>
                    <span>置信 {{ (e.confidence * 100).toFixed(0) }}%</span>
                    <span>更新于 {{ fmt.ago(e.updatedAt) }}</span>
                    <button v-if="e.prev && e.prev.length" class="pill p-line" style="cursor:pointer" @click="toggle(e.id)">
                      <v-icon name="clock"/>{{ expanded[e.id] ? '收起历史' : e.prev.length + ' 个旧值' }}
                    </button>
                  </div>
                  <Transition name="expand">
                    <div v-if="expanded[e.id]" class="list-stack" style="margin-top:9px">
                      <div v-for="(p, j) in e.prev" :key="j" class="note" style="margin:0;padding:10px 12px">
                        <span class="mut" style="text-decoration:line-through">{{ p.content }}</span>
                        <span class="mut2" style="margin-left:8px;font-size:10.5px">置信 {{ (p.confidence * 100).toFixed(0) }}% · {{ fmt.ago(p.updatedAt) }}</span>
                      </div>
                    </div>
                  </Transition>
                </div>
                <div class="entry-actions">
                  <button class="bic dg" title="删除" @click="del(e)"><v-icon name="trash"/></button>
                </div>
              </article>
            </TransitionGroup>
            <empty-state v-if="!entries.length" icon="recall" text="该筛选下暂无记忆条目" sub="继续对话，或手动写入一条长期记忆"/>
          </div>
        </section>
      </div>

      <v-modal v-if="addModal.show" title="写入长期记忆" icon="plus" @close="addModal.show = false">
        <div class="grid g2" style="gap:14px">
          <div class="field">
            <label class="f-label">层级</label>
            <select class="sel" v-model="addModal.level"><option v-for="(v, k) in LEVEL" :value="k">{{ v.name }} · {{ v.desc }}</option></select>
          </div>
          <div class="field">
            <label class="f-label">类型</label>
            <select class="sel" v-model="addModal.type">
              <option value="preference">preference 偏好</option><option value="name">name 称呼</option>
              <option value="identity">identity 身份</option><option value="fact">fact 事实</option>
            </select>
          </div>
          <div class="field" style="grid-column:1/-1">
            <label class="f-label">内容</label>
            <textarea class="txa" v-model="addModal.content" placeholder="例如：用户周五晚上有固定开黑活动"></textarea>
          </div>
          <div class="field" style="grid-column:1/-1">
            <label class="f-label">置信度 {{ (addModal.confidence * 100).toFixed(0) }}%</label>
            <input type="range" class="rng" min="0.1" max="1" step="0.05" v-model.number="addModal.confidence" :style="{ '--fill': addModal.confidence * 100 + '%' }">
          </div>
        </div>
        <template #foot>
          <button class="btn b-line" @click="addModal.show = false">取消</button>
          <button class="btn b-pri" @click="add"><v-icon name="check"/>写入</button>
        </template>
      </v-modal>
    </div>`,
  }
})()
