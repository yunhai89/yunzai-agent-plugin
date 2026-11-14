/** 视图:审批门(§3.5 · 工具确认=纯内存重启清空；人设采纳=持久化待审) */
(function () {
  window.VIEWS = window.VIEWS || {}

  window.VIEWS.confirm = {
    name: 'ConfirmView',
    setup() {
      const { ref, computed, onMounted, onUnmounted } = Vue
      const { toast, fmt } = window.UI
      const M = window.MOCK
      /* confirmTimeout 来自 config;未加载时取默认 300s */
      const TIMEOUT = computed(() => (M.config?.confirmTimeout || 300) * 1000)

      /* 直接读 MOCK.confirms:侧边栏徽标/概览计数联动更新 */
      const items = computed(() => M.confirms)
      /* 人设资料采纳待审（持久化，须批准才 draft→active） */
      const adoptions = computed(() => (M.personaAdoptions || []).filter((p) => p.status === 'pending'))
      const tick = ref(0)
      const timer = setInterval(() => tick.value++, 1000)
      let pollTimer = null
      // 第 6 轮审计：onMounted 的 await 未返回就切页时 onUnmounted 已经跑过（pollTimer 仍为 null），
      // 续体若继续建 interval 就再没人清理 → 每 5s 永久轮询 /confirm 与 /persona-adoptions
      let disposed = false

      /* 读 tick 建立依赖,倒计时环每秒刷新 */
      const remain = (c) => { void tick.value; return Math.max(0, TIMEOUT.value - (Date.now() - c.createdAt)) }
      const remainPct = (c) => (remain(c) / TIMEOUT.value) * 100
      const ringOffset = (c) => 2 * Math.PI * 19 * (1 - remainPct(c) / 100)

      const decide = async (c, ok) => {
        try {
          await window.api.post(`/confirm/${c.id}/decide`, { approve: ok })
          await window.store.loadConfirm()
          toast(ok ? `已批准 ${c.tool}(不真正执行)` : `已拒绝 ${c.tool}`, ok ? 'success' : 'info')
        } catch (e) { toast(e.message, 'error') }
      }

      /* 人设采纳待审：批准=采纳当前草稿生效；驳回=保留草稿 */
      const decideAdopt = async (a, ok) => {
        try {
          const r = await window.api.post(`/persona-adoptions/${a.id}/${ok ? 'approve' : 'reject'}`, {})
          await window.store.loadPersonaAdoptions()
          const name = a.personaName || a.personaId
          if (ok) toast(r?.ingestError ? `已采纳「${name}」（长尾入库提示：${r.ingestError}）` : `已采纳「${name}」，之后使用该人设以已核实事实为先`)
          else toast(`已驳回「${name}」的采纳请求（草稿保留）`, 'info')
        } catch (e) { toast(e.message, 'error') }
      }

      // 需二次确认的工具里风险最高的几个（terminal 已沙箱化、不再走审批队列）
      const danger = (tool) => ['send_like', 'stagehand', 'stagehand_act'].includes(tool)

      /* 惰性加载:config(取 confirmTimeout)+ 队列;5s 轮询(后端管超时淘汰) */
      onMounted(async () => {
        try { await window.store.loadConfig() } catch { /* 忽略 */ }
        try { await window.store.loadConfirm() } catch (e) { toast(e.message, 'error') }
        try { await window.store.loadPersonaAdoptions() } catch { /* 兼容旧后端：无人设采纳队列 */ }
        if (disposed) return
        pollTimer = setInterval(() => {
          window.store.loadConfirm().catch(() => {})
          window.store.loadPersonaAdoptions().catch(() => {})
        }, 5000)
      })
      onUnmounted(() => { disposed = true; clearInterval(timer); if (pollTimer) clearInterval(pollTimer) })

      return { items, adoptions, tick, remain, remainPct, ringOffset, decide, decideAdopt, danger, fmt, TIMEOUT }
    },
    template: `
    <div class="view view-confirm">
      <page-head title="审批门" icon="confirm" desc="高风险工具在真正执行前停在这里；人设资料的采纳也会进入待审队列。批准后立即生效。"/>

      <div class="split">
        <aside class="split-aside">
          <section class="chamber">
            <header class="chamber-head">
              <div><h2 class="chamber-title">队列</h2><p class="chamber-sub">需要你手动决定的事项</p></div>
            </header>
            <div class="chamber-body">
              <div class="metric-stack">
                <div class="metric">
                  <div class="metric-label">全部待审</div>
                  <div class="metric-value">{{ items.length + adoptions.length }}<small>项</small></div>
                </div>
                <div class="metric">
                  <div class="metric-label">工具确认 / 人设采纳</div>
                  <div class="metric-value" style="font-size:24px">{{ items.length }} <small>/</small> {{ adoptions.length }}</div>
                </div>
              </div>
            </div>
          </section>
          <section class="chamber">
            <div class="chamber-body" style="padding-top:22px">
              <div class="stat-line"><span>确认超时</span><b>{{ TIMEOUT / 1000 }} 秒</b></div>
              <div class="stat-line"><span>超时处理</span><b>自动拒绝</b></div>
              <p class="aside-note" style="margin-top:14px">工具确认只保存在内存里，重启即清空。人设采纳会持久保存，批准后草稿才会生效。</p>
            </div>
          </section>
        </aside>

        <div class="split-main">
          <section class="chamber">
            <header class="chamber-head">
              <div>
                <h2 class="chamber-title">工具确认</h2>
                <p class="chamber-sub">需二次确认的工具调用</p>
              </div>
              <span class="pill" :class="items.length ? 'p-rose' : 'p-green'">{{ items.length ? items.length + ' 条待审' : '已清空' }}</span>
            </header>
            <div class="chamber-body">
              <div v-if="items.length" class="review-list">
                <article v-for="c in items" :key="c.id" class="review-row">
                  <div class="review-count">
                    <div class="cd-ring">
                      <svg width="46" height="46">
                        <circle cx="23" cy="23" r="19" fill="none" stroke="var(--well)" stroke-width="5"/>
                        <circle cx="23" cy="23" r="19" fill="none" stroke-linecap="round" stroke-width="5"
                          :stroke="remainPct(c) > 40 ? 'var(--cobalt)' : 'var(--coral)'"
                          :stroke-dasharray="2 * Math.PI * 19" :stroke-dashoffset="ringOffset(c)"
                          style="transition:stroke-dashoffset 1s linear, stroke .5s"/>
                      </svg>
                      <div class="cd-num">{{ Math.ceil(remain(c) / 1000) }}</div>
                    </div>
                    <span>秒</span>
                  </div>
                  <div class="review-main">
                    <div class="pill-row" style="margin-bottom:7px">
                      <span class="pill" :class="danger(c.tool) ? 'p-rose' : 'p-sky'"><v-icon :name="danger(c.tool) ? 'warn' : 'tool'"/>{{ c.tool }}</span>
                      <span class="pill p-line mono">#{{ c.id }}</span>
                    </div>
                    <div class="entry-meta" style="margin-top:0">
                      <span>申请人 {{ c.ctx?.user || '未知' }}</span>
                      <span>{{ c.ctx?.gid ? '群 ' + c.ctx.gid : '私聊' }}</span>
                      <span>{{ fmt.ago(c.createdAt) }}发起</span>
                    </div>
                    <div v-if="c.ctx?.reason" class="entry-text" style="margin-top:6px;font-size:12px;color:var(--ink-2)">事由：{{ c.ctx.reason }}</div>
                    <div class="mt12"><json-block :data="c.args"/></div>
                  </div>
                  <div class="review-actions">
                    <button class="btn b-danger b-sm" @click="decide(c, false)"><v-icon name="x"/>拒绝</button>
                    <button class="btn b-pri b-sm" @click="decide(c, true)"><v-icon name="check"/>批准</button>
                  </div>
                </article>
              </div>
              <empty-state v-else icon="confirm" text="没有待确认的工具调用" sub="高风险工具发起时会出现在这里；终端命令已在 E2B 沙箱内直接执行，stagehand act 不再单独审批"/>
            </div>
          </section>

          <section v-if="adoptions.length" class="chamber">
            <header class="chamber-head">
              <div>
                <h2 class="chamber-title">人设资料采纳</h2>
                <p class="chamber-sub">批准后草稿才会从 draft 变为 active，并注入身份层</p>
              </div>
              <span class="pill p-pri">{{ adoptions.length }} 条</span>
            </header>
            <div class="chamber-body">
              <div class="review-list">
                <article v-for="a in adoptions" :key="a.id" class="review-row">
                  <div class="review-main">
                    <div class="pill-row" style="margin-bottom:7px">
                      <span class="pill p-pri"><v-icon name="persona"/>{{ a.personaName || a.personaId }}</span>
                      <span class="pill p-line mono">#{{ a.id }}</span>
                      <span class="pill p-line">{{ a.via === 'qq' ? 'QQ 提交' : 'Web 提交' }}</span>
                    </div>
                    <div v-if="a.snapshot && a.snapshot.summary" class="entry-text">{{ a.snapshot.summary }}</div>
                    <div v-if="a.snapshot && a.snapshot.facts" class="json-block mt12" style="max-height:180px;overflow:auto">{{ a.snapshot.facts }}</div>
                    <div class="entry-meta">
                      <span>{{ a.by || '—' }} · {{ fmt.ago(a.createdAt) }}</span>
                      <span>出处 {{ a.snapshot?.sourceCount || 0 }} 条</span>
                      <span>长尾 {{ a.snapshot?.rawNotesLen || 0 }} 字</span>
                    </div>
                  </div>
                  <div class="review-actions">
                    <button class="btn b-line b-sm" @click="decideAdopt(a, false)"><v-icon name="x"/>驳回</button>
                    <button class="btn b-pri b-sm" @click="decideAdopt(a, true)"><v-icon name="check"/>采纳</button>
                  </div>
                </article>
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>`,
  }
})()
