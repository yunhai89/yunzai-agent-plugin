/** 视图:定时任务（一次性提醒 + cron 重复任务链） */
;(function () {
  window.VIEWS = window.VIEWS || {}

  window.VIEWS.schedule = {
    name: 'ScheduleView',
    setup() {
      const { ref, computed, onMounted, onUnmounted } = Vue
      const { toast, fmt } = window.UI
      const M = window.MOCK

      const tick = ref(0)
      const timer = setInterval(() => tick.value++, 1000)

      const jobs = computed(() => (M.schedules || []).slice().sort((a, b) => {
        // task(cron) 排前按 createdAt；reminder 按 at
        if (a.type === 'task' && b.type !== 'task') return -1
        if (a.type !== 'task' && b.type === 'task') return 1
        if (a.type === 'task') return (a.createdAt || 0) - (b.createdAt || 0)
        return (a.at || 0) - (b.at || 0)
      }))
      const until = (ts) => { void tick.value; return fmt.until(ts) }
      const del = async (j) => {
        try {
          await window.api.del(`/schedule/${j.id}`)
          await window.store.loadSchedule()
          toast('已取消该任务', 'info')
        } catch (e) { toast(e.message, 'error') }
      }

      /* 第 6 轮审计：本视图原先不加载 config 且回落 'master'，直接打开 #/schedule 时会以假 userId='master'
         建任务（到点 pickFriend('master') 投递失败，用户永远收不到），故取真实主人 QQ 并在取不到时禁止提交。 */
      const ownerId = computed(() => String(window.MOCK.config?.masters?.[0] ?? '').trim())

      const addModal = ref({ show: false, type: 'reminder', message: '', groupId: '', inHours: 2, when: '', prompt: '' })
      const add = async () => {
        const m = addModal.value
        if (!ownerId.value) { toast('未取到主人 QQ（配置中心 · 主人列表为空），无法创建任务', 'warn'); return }
        const body = { userId: ownerId.value, groupId: m.groupId || null }
        if (m.type === 'task') {
          if (!m.when.trim() || !m.prompt.trim()) { toast('任务链需时间 + 任务描述', 'warn'); return }
          body.type = 'task'; body.when = m.when.trim(); body.prompt = m.prompt.trim()
        } else {
          if (!m.message.trim()) { toast('请填写提醒内容', 'warn'); return }
          // 第 6 轮审计：v-model.number 清空时是 ''，''*3600e3===0 → at=当前时刻，提醒会被立即触发
          const hours = Number(m.inHours)
          if (!Number.isFinite(hours) || hours <= 0) { toast('「N 小时后触发」需填大于 0 的数字', 'warn'); return }
          body.message = m.message.trim(); body.at = Date.now() + hours * 3600e3
        }
        try {
          await window.api.post('/schedule', body)
          await window.store.loadSchedule()
          toast(m.type === 'task' ? '定时任务已创建（到点跑 Agent + 发结果）' : '提醒已创建')
          addModal.value.show = false
          addModal.value.message = ''; addModal.value.when = ''; addModal.value.prompt = ''
        } catch (e) { toast(e.message, 'error') }
      }

      onMounted(async () => {
        // 先取配置（主人 QQ 来源），失败也不阻塞列表：ownerId 为空时创建按钮禁用（第 6 轮审计）
        try { await window.store.loadConfig() } catch { /* 忽略 */ }
        try { await window.store.loadSchedule() } catch (e) { toast(e.message, 'error') }
      })
      onUnmounted(() => clearInterval(timer))

      const taskCount = computed(() => jobs.value.filter((j) => j.type === 'task').length)
      const reminderCount = computed(() => jobs.value.filter((j) => j.type !== 'task').length)
      const nextJob = computed(() => {
        void tick.value
        return jobs.value.filter((j) => j.type !== 'task' && j.at > Date.now()).sort((a, b) => a.at - b.at)[0] || null
      })

      return { jobs, tick, until, del, addModal, add, ownerId, fmt, taskCount, reminderCount, nextJob }
    },
    template: `
    <div class="view view-schedule">
      <page-head title="定时任务" icon="schedule" desc="一次性提醒到点发送消息；cron 任务链到点运行 Agent 并发送结果。时间支持自然语言：每天 8 点、每 2 小时、工作日 9 点。">
        <button class="btn b-pri" @click="addModal.show = true"><v-icon name="plus"/>新建任务</button>
      </page-head>

      <div class="split">
        <aside class="split-aside">
          <section class="chamber">
            <header class="chamber-head">
              <div>
                <h2 class="chamber-title">队列</h2>
                <p class="chamber-sub">当前 bot 的定时安排</p>
              </div>
            </header>
            <div class="chamber-body">
              <div class="metric-stack">
                <div class="metric">
                  <div class="metric-label">下一件事</div>
                  <div class="metric-value" style="font-size:26px">{{ nextJob ? until(nextJob.at) : '—' }}</div>
                  <div class="metric-note">{{ nextJob ? nextJob.message : '没有待触发的提醒' }}</div>
                </div>
                <div class="metric">
                  <div class="metric-label">全部安排</div>
                  <div class="metric-value">{{ jobs.length }}<small>项</small></div>
                  <div class="metric-note">{{ taskCount }} 条任务链 · {{ reminderCount }} 条提醒</div>
                </div>
              </div>
            </div>
          </section>
          <section class="chamber">
            <div class="chamber-body" style="padding-top:22px">
              <div class="stat-line"><span>归属</span><b>{{ ownerId || '未取到主人 QQ' }}</b></div>
              <div class="stat-line"><span>时间基准</span><b>服务器本地时区</b></div>
              <p class="aside-note" style="margin-top:14px">任务链到点会运行完整 Agent，再发送结果；一次性提醒只发送静态文本。取消后不可恢复。</p>
            </div>
          </section>
        </aside>

        <section class="chamber">
          <header class="chamber-head">
            <div>
              <h2 class="chamber-title">时间线</h2>
              <p class="chamber-sub">按类型与触发时间排列</p>
            </div>
            <button class="btn b-line b-sm" @click="addModal.show = true"><v-icon name="plus"/>新建</button>
          </header>
          <div class="chamber-body">
            <div v-if="jobs.length" class="schedule-list">
              <article v-for="j in jobs" :key="j.id" class="schedule-row">
                <div class="schedule-time">
                  <b>{{ j.type === 'task' ? '周期' : until(j.at) }}</b>
                  <span v-if="j.type === 'task'">{{ j.cron }}</span>
                  <span v-else>{{ new Date(j.at).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) }}</span>
                </div>
                <div class="schedule-axis"><i :class="{ task: j.type === 'task' }"></i></div>
                <div class="schedule-main">
                  <div class="pill-row" style="margin-bottom:7px">
                    <span class="pill" :class="j.type === 'task' ? 'p-green' : (j.groupId ? 'p-sky' : 'p-vio')">
                      <v-icon :name="j.type === 'task' ? 'tool' : (j.groupId ? 'group' : 'user')"/>{{ j.type === 'task' ? '任务链' : (j.groupId ? '群 ' + j.groupId : '私聊') }}
                    </span>
                    <span class="pill p-line mono">#{{ j.id }}</span>
                  </div>
                  <div class="entry-text">{{ j.type === 'task' ? j.prompt : j.message }}</div>
                  <div class="entry-meta">
                    <span>bot {{ j.selfId || '?' }}</span>
                    <span v-if="j.type === 'task'">到点运行 Agent</span>
                    <span v-else>到点发送消息</span>
                  </div>
                </div>
                <button class="bic dg" title="取消" @click="del(j)"><v-icon name="trash"/></button>
              </article>
            </div>
            <empty-state v-else icon="schedule" text="还没有定时任务" sub="新建一条提醒，或让 Agent 定时执行一串动作"/>
          </div>
        </section>
      </div>

      <v-modal v-if="addModal.show" title="新建定时任务" icon="plus" @close="addModal.show = false">
        <div class="seg mb12">
          <button :class="{ on: addModal.type === 'reminder' }" @click="addModal.type = 'reminder'">一次性提醒</button>
          <button :class="{ on: addModal.type === 'task' }" @click="addModal.type = 'task'">cron 重复任务</button>
        </div>
        <div class="field mb12">
          <label class="f-label">目标群（留空为私聊）</label>
          <input class="inp" v-model="addModal.groupId" placeholder="群号">
        </div>
        <template v-if="addModal.type === 'task'">
          <div class="field mb12">
            <label class="f-label">时间</label>
            <input class="inp" v-model="addModal.when" placeholder="每天 8 点 / 每 2 小时 / 工作日 9 点 / 每周一 8:30">
          </div>
          <div class="field">
            <label class="f-label">任务描述（到点运行 Agent 并发送结果）</label>
            <textarea class="txa" v-model="addModal.prompt" placeholder="例如：搜索今日 AI 资讯，总结 5 条"></textarea>
          </div>
        </template>
        <template v-else>
          <div class="field mb12">
            <label class="f-label">提醒内容</label>
            <textarea class="txa" v-model="addModal.message" placeholder="到点发送的文本"></textarea>
          </div>
          <div class="field">
            <label class="f-label">多少小时后触发</label>
            <input type="number" class="inp" min="1" v-model.number="addModal.inHours">
          </div>
        </template>
        <div v-if="!ownerId" class="dlg-hint" style="margin-top:10px">未取到主人 QQ（配置中心的主人列表为空），无法创建任务。</div>
        <template #foot>
          <button class="btn b-line" @click="addModal.show = false">取消</button>
          <button class="btn b-pri" :disabled="!ownerId" @click="add"><v-icon name="check"/>创建</button>
        </template>
      </v-modal>
    </div>`,
  }
})()
