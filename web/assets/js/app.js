/**
 * 应用外壳: hash 路由 + 桌面侧栏 / 移动端顶条 + 底部 Dock + 登录态 + 命令面板
 */
(function () {
  const { createApp, ref, computed, onMounted, onUnmounted, nextTick } = Vue

  /* 审批门待审数 = 工具确认（内存）+ 人设采纳待审（持久） */
  const pendingApprovals = () => (window.MOCK?.confirms || []).length + (window.MOCK?.personaAdoptions || []).filter((p) => p.status === 'pending').length

  const NAV = [
    { group: '总览', items: [{ id: 'dashboard', name: '概览', icon: 'dashboard' }] },
    {
      group: '数据中心', items: [
        { id: 'memory', name: '声明式记忆', icon: 'memory' },
        { id: 'recall', name: '长期记忆', icon: 'recall' },
        { id: 'profile', name: '用户画像', icon: 'user' },
        { id: 'personas', name: '人设库', icon: 'persona' },
        { id: 'skills', name: '技能', icon: 'skill' },
        { id: 'kb', name: '知识库', icon: 'book' },
        { id: 'sessions', name: '会话回放', icon: 'session' },
        { id: 'logs', name: '日志时间线', icon: 'log' },
      ],
    },
    {
      group: '运行时', items: [
        { id: 'schedule', name: '定时任务', icon: 'schedule' },
        { id: 'tasks', name: '任务账本', icon: 'schedule' },
        { id: 'confirm', name: '审批门', icon: 'confirm', badge: pendingApprovals },
        { id: 'suggestions', name: '进化建议', icon: 'evolution', badge: () => (window.MOCK?.suggestions || []).filter((s) => s.status === 'pending').length },
        { id: 'evolution', name: '工具进化', icon: 'tool', badge: () => (window.MOCK?.tevoTools || []).filter((v) => v.status === 'verified').length },
      ],
    },
    { group: '系统', items: [{ id: 'config', name: '配置中心', icon: 'config' }, { id: 'qqbot', name: '机器人账号', icon: 'bot' }, { id: 'toolpacks', name: '外置工具', icon: 'tool' }, { id: 'tts', name: '语音合成', icon: 'music' }, { id: 'humanize', name: '伪人模式', icon: 'group' }, { id: 'groupworld', name: '群聊小世界', icon: 'globe' }, { id: 'selfstate', name: '自我状态', icon: 'bot' }, { id: 'sticker', name: '表情包', icon: 'smile' }] },
  ]
  const TITLES = {
    dashboard: ['概览', '插件运行状态与核心指标'],
    memory: ['声明式记忆', 'MEMORY.md / USER.md · 按 scope 隔离'],
    recall: ['长期记忆', 'LLM 抽取沉淀 · L2/L3/L4 分层'],
    profile: ['用户画像', '统一用户模型 · 分面/证据/置信/纠错'],
    personas: ['人设库', '内置 + 自定义人设 · 角色设定资料'],
    skills: ['技能', 'skills/*.md · 按需/常驻注入'],
    kb: ['知识库', '全局文档库 · embedding RAG'],
    sessions: ['会话回放', '对话列表与消息历史'],
    logs: ['日志时间线', 'devLog 全链路 · traceId 串联'],
    schedule: ['定时任务', '到点投递提醒'],
    tasks: ['任务账本', '可恢复任务记录 · 阶段/事件/检查点（P0-3）'],
    confirm: ['审批门', '高危工具人工把关'],
    suggestions: ['进化建议', '自评审产出的待审改进项'],
    evolution: ['工具进化', 'Tool Evolution · 候选生成/验证/审批/版本'],
    config: ['配置中心', 'config.yaml 全量配置项'],
    qqbot: ['QQ 官方机器人账号', '自实现适配器 · AppID + AppSecret 直连 · 连接管理'],
    toolpacks: ['外置工具', 'tools/ 自研工具 · 元信息与配置（tool.config.js 约定）'],
    humanize: ['伪人模式', '群聊环境参与者 · 旁听/门控/决策/发送'],
    groupworld: ['群聊小世界', '群聊社会记忆层 · 画像/关系/事件/圈子'],
    selfstate: ['自我状态', '自我认知与情绪 · 心境/情绪/期待/心事'],
    sticker: ['表情包', '配置 + 库概览 · 发送策略 / 自动发现'],
    tts: ['语音合成', 'TTS 服务配置 + 参考音频库 · 情绪化支持（pro/max）'],
  }
  /* 移动端底部 Dock: 四个常用 + 更多 */
  const DOCK = [
    { id: 'dashboard', name: '概览', icon: 'home' },
    { id: 'memory', name: '记忆', icon: 'memory' },
    { id: 'sessions', name: '会话', icon: 'session' },
    { id: 'confirm', name: '审批', icon: 'confirm', badge: pendingApprovals },
  ]

  const App = {
    name: 'App',
    setup() {
      const route = ref((location.hash || '#/dashboard').slice(2))
      const valid = computed(() => !!window.VIEWS[route.value])
      if (!valid.value) route.value = 'dashboard'
      const menuOpen = ref(false) // 移动端全屏菜单
      const go = (id) => {
        location.hash = '#/' + id
        menuOpen.value = false
        paletteOpen.value = false
      }
      const view = computed(() => window.VIEWS[route.value])
      const title = computed(() => TITLES[route.value] || ['', ''])
      const groupName = computed(() => (NAV.find((g) => g.items.some((it) => it.id === route.value)) || {}).group || 'agents-plugin')
      const syncTitle = (r) => { try { document.title = `${(TITLES[r] || ['控制台'])[0]} · agents-plugin` } catch { /* noop */ } }
      syncTitle(route.value)

      /* —— 命令面板：一个页面搜索，键盘可达 —— */
      const paletteOpen = ref(false)
      const paletteQuery = ref('')
      const paletteIndex = ref(0)
      const paletteInput = ref(null)
      const paletteItems = computed(() => NAV.flatMap((g) => g.items.map((it) => ({ ...it, group: g.group }))))
      const paletteMatches = computed(() => {
        const q = paletteQuery.value.trim().toLowerCase()
        if (!q) return paletteItems.value
        return paletteItems.value.filter((it) => (it.name + ' ' + it.group + ' ' + it.id).toLowerCase().includes(q))
      })
      const paletteGroups = computed(() => {
        const q = paletteQuery.value.trim().toLowerCase()
        let idx = 0
        const out = []
        for (const g of NAV) {
          const items = []
          for (const it of g.items) {
            const hay = (it.name + ' ' + g.group + ' ' + it.id).toLowerCase()
            if (!q || hay.includes(q)) items.push({ ...it, idx: idx++ })
          }
          if (items.length) out.push({ group: g.group, items })
        }
        return out
      })
      const openPalette = () => {
        paletteOpen.value = true
        paletteQuery.value = ''
        paletteIndex.value = 0
        menuOpen.value = false
        nextTick(() => { try { paletteInput.value?.focus?.() } catch { /* noop */ } })
      }
      const closePalette = () => { paletteOpen.value = false }
      const paletteMove = (delta) => {
        const n = paletteMatches.value.length
        if (!n) return
        paletteIndex.value = (paletteIndex.value + delta + n) % n
      }
      const paletteChoose = () => {
        const it = paletteMatches.value[paletteIndex.value]
        if (it) go(it.id)
      }
      const onKey = (e) => {
        if (!loggedIn.value) return
        if ((e.metaKey || e.ctrlKey) && String(e.key).toLowerCase() === 'k') {
          e.preventDefault()
          paletteOpen.value ? closePalette() : openPalette()
          return
        }
        if (!paletteOpen.value) return
        if (e.key === 'Escape') { e.preventDefault(); closePalette() }
        else if (e.key === 'ArrowDown') { e.preventDefault(); paletteMove(1) }
        else if (e.key === 'ArrowUp') { e.preventDefault(); paletteMove(-1) }
        else if (e.key === 'Enter') { e.preventDefault(); paletteChoose() }
      }

      // 登录态：URL ?token= 落地 → localStorage；无 token 显示登录框
      const loggedIn = ref(false)
      try {
        if (typeof window.storeLoginFromUrl === 'function' && window.storeLoginFromUrl()) loggedIn.value = true
        else if (window.api?.getToken?.()) loggedIn.value = true
      } catch { /* noop */ }
      window.addEventListener('agents-need-login', () => { loggedIn.value = false })
      const loginInput = ref('')
      const doLogin = async () => {
        // 允许直接粘贴整条登录地址/整段消息；非法 token 明确拒绝（旧代码原样存会污染 Authorization 头）
        const t = window.api.normalizeToken(loginInput.value)
        if (!t) {
          window.UI.alert({
            title: '登录 token 格式不对',
            icon: 'warn',
            message: '应形如 <b>48 位字母数字</b>，或直接粘贴<b>完整登录链接</b>（含 <code>?token=</code>）。<br>'
              + '请私聊 bot 重新发送 <b>#agent登录</b> 获取。',
          })
          return
        }
        window.api.setToken(t)
        try { await window.store.loadScopes(); loggedIn.value = true }
        catch (e) {
          const msg = String(e?.message || e)
          // 只有「确实没认证」才清 token。运行时未就绪（首次部署还没配模型/API Key）不是登录失败：
          // 面板服务与令牌都不依赖运行时，必须能进去填配置。
          if (/4010|未认证|token 已失效|未登录/.test(msg)) {
            window.api.setToken('')
            window.UI.alert({
              title: '登录失败',
              icon: 'warn',
              message: `Token 校验未通过：${msg}<br>请私聊 bot 重新发送 <b>#agent登录</b> 获取新链接，或核对粘贴的 token 是否完整。`,
            })
          } else {
            window.api.setToken(t) // 保留 token：认证已通过，只是部分接口暂时不可用
            loggedIn.value = true
            window.UI.toast?.(`已登录，但运行时未就绪（${msg}）；可先在「配置中心」填模型/API Key`, 'warn')
          }
        }
      }
      const logout = () => { loggedIn.value = false; window.api && window.api.setToken('') }

      const onHashChange = () => {
        const r = location.hash.slice(2)
        route.value = window.VIEWS[r] ? r : 'dashboard'
        syncTitle(route.value)
        menuOpen.value = false
        paletteOpen.value = false
        window.scrollTo({ top: 0 })
      }
      window.addEventListener('hashchange', onHashChange)

      onMounted(async () => {
        document.addEventListener('keydown', onKey)
        if (!loggedIn.value) return
        try { await window.store.loadScopes() } catch { /* 未登录或运行时未就绪，各页 load 时再处理 */ }
        try { await window.store.loadTevo?.() } catch { /* 工具进化未启用/未登录，忽略 */ }
      })
      onUnmounted(() => {
        document.removeEventListener('keydown', onKey)
        window.removeEventListener('hashchange', onHashChange)
      })

      return {
        route, go, view, title, groupName, NAV, DOCK, menuOpen, loggedIn, loginInput, doLogin, logout,
        paletteOpen, paletteQuery, paletteIndex, paletteInput, paletteGroups, paletteMatches,
        openPalette, closePalette, paletteMove, paletteChoose,
      }
    },
    template: `
    <div v-if="!loggedIn" class="login-wrap">
      <section class="login-aside">
        <div class="login-brand">
          <span class="login-brand-mark"><brand-mark/></span>
          <span class="login-brand-name">agents-plugin</span>
          <span class="login-brand-tag">Runtime</span>
        </div>
        <div class="login-copy">
          <h1>一个能回话、能干活、<br class="login-br">能记住的 Agent 运行时</h1>
          <p class="login-lead">多模型对话、工具调用、长期记忆、人设、MCP 与沙箱，在同一个面板里配置和观察。</p>
          <div class="login-facts">
            <div><span>模型</span><b>OpenAI / Anthropic / Gemini</b></div>
            <div><span>记忆</span><b class="mono">MEMORY.md · USER.md</b></div>
            <div><span>执行</span><b>E2B 沙箱 · 工具审批</b></div>
          </div>
        </div>
        <div class="login-foot"><span>TRSS-Yunzai</span><span>·</span><span>插件管理面板</span></div>
      </section>
      <section class="login-panel">
        <div class="login-card">
          <div class="login-card-head">
            <span class="login-card-mark"><brand-mark/></span>
            <div><h2>进入控制台</h2><p>使用登录链接或访问令牌</p></div>
          </div>
          <label class="f-label" for="login-token">访问令牌</label>
          <input id="login-token" class="inp" v-model="loginInput" placeholder="粘贴登录 token 或完整登录链接" autocomplete="off" spellcheck="false" @keyup.enter="doLogin"/>
          <button class="btn b-pri login-btn" @click="doLogin"><v-icon name="key"/><span>登录</span></button>
          <p class="login-hint">私聊 bot 发送 <code>#agent登录</code> 获取带 token 的地址；也可直接粘贴完整链接。</p>
          <div class="login-after">
            <p class="login-after-title">登录后可管理</p>
            <div class="login-after-row"><span class="status-dot is-ok"></span>运行时状态、模型与工具</div>
            <div class="login-after-row"><span class="status-dot is-ok"></span>审批、记忆、人设与会话</div>
            <div class="login-after-row"><span class="status-dot is-ok"></span>配置热加载与日志回放</div>
          </div>
        </div>
        <p class="login-legal">仅限授权用户 · 令牌 24 小时滑动续期</p>
      </section>
    </div>
    <div v-else class="shell">
      <!-- 桌面侧栏 -->
      <aside class="rail">
        <div class="rail-head">
          <span class="brand-badge"><brand-mark/></span>
          <div>
            <div class="brand-t">agents-plugin</div>
            <div class="brand-s">AI Agent Runtime</div>
          </div>
        </div>
        <div class="rail-scope">
          <span class="st-dot"></span>
          <span>TRSS-Yunzai</span>
          <span class="rail-scope-sep">/</span>
          <span class="mono">本地</span>
        </div>
        <nav class="rail-nav" aria-label="主导航">
          <template v-for="g in NAV" :key="g.group">
            <div class="nav-sec">{{ g.group }}</div>
            <div v-for="it in g.items" :key="it.id" class="nav-link" :class="{ on: route === it.id }" :title="it.name" role="button" tabindex="0"
              @click="go(it.id)" @keydown.enter.prevent="go(it.id)" @keydown.space.prevent="go(it.id)">
              <v-icon :name="it.icon"/><span>{{ it.name }}</span>
              <span v-if="it.badge && it.badge()" class="nav-badge">{{ it.badge() }}</span>
            </div>
          </template>
        </nav>
        <div class="rail-foot"><span class="st-dot"></span><span>面板运行中</span><span class="rail-ver mono">v1.49.0</span></div>
      </aside>

      <div class="stage">
        <!-- 桌面顶栏 -->
        <header class="bar">
          <button class="bar-search" type="button" aria-label="搜索页面" @click="openPalette">
            <v-icon name="search"/><span class="bar-search-text">搜索页面</span><kbd>Ctrl K</kbd>
          </button>
          <div class="bar-acts">
            <span class="pill p-mint bar-status"><span class="st-dot"></span>运行中</span>
            <button class="bar-btn" type="button" @click="logout" title="退出登录"><v-icon name="logout"/><span>退出</span></button>
          </div>
        </header>

        <!-- 移动端顶栏 -->
        <header class="m-top">
          <span class="m-brand"><brand-mark/></span>
          <div class="m-tt">{{ groupName }}</div>
          <div class="m-acts">
            <button class="m-x" type="button" aria-label="搜索页面" @click="openPalette"><v-icon name="search"/></button>
            <button class="m-x" type="button" aria-label="退出登录" @click="logout"><v-icon name="logout"/></button>
          </div>
        </header>

        <!-- 白色工作台 -->
        <div class="sheet">
          <main class="page">
            <Transition name="page" mode="out-in">
              <component :is="view" :key="route"/>
            </Transition>
          </main>
        </div>
      </div>

      <!-- 移动端底部 Dock -->
      <nav class="dock" aria-label="快捷导航">
        <div v-for="d in DOCK" :key="d.id" class="dock-i" :class="{ on: route === d.id }" role="button" tabindex="0"
          @click="go(d.id)" @keydown.enter.prevent="go(d.id)" @keydown.space.prevent="go(d.id)">
          <span v-if="d.badge && d.badge()" class="dock-badge">{{ d.badge() }}</span>
          <v-icon :name="d.icon"/><span>{{ d.name }}</span>
        </div>
        <div class="dock-i" :class="{ on: menuOpen }" role="button" tabindex="0"
          @click="menuOpen = !menuOpen" @keydown.enter.prevent="menuOpen = !menuOpen" @keydown.space.prevent="menuOpen = !menuOpen">
          <v-icon name="grid"/><span>更多</span>
        </div>
      </nav>

      <!-- 移动端全屏菜单 -->
      <Transition name="fade">
        <div v-if="menuOpen" class="nav-sheet-back" @click="menuOpen = false"></div>
      </Transition>
      <Transition name="sheet">
        <div v-if="menuOpen" class="nav-sheet">
          <div class="nav-sheet-head">
            <div class="nav-sheet-brand"><span class="brand-badge"><brand-mark/></span><div class="nav-sheet-title">agents-plugin · 全部页面</div></div>
            <button class="mdl-x" type="button" aria-label="关闭菜单" @click="menuOpen = false"><v-icon name="x"/></button>
          </div>
          <div class="nav-sheet-body">
            <template v-for="g in NAV" :key="g.group">
              <div class="nav-sheet-sec">{{ g.group }}</div>
              <div class="nav-sheet-grid">
                <div v-for="it in g.items" :key="it.id" class="nav-sheet-item" :class="{ on: route === it.id }" role="button" tabindex="0"
                  @click="go(it.id)" @keydown.enter.prevent="go(it.id)" @keydown.space.prevent="go(it.id)">
                  <span v-if="it.badge && it.badge()" class="nav-badge">{{ it.badge() }}</span>
                  <v-icon :name="it.icon"/><span>{{ it.name }}</span>
                </div>
              </div>
            </template>
          </div>
        </div>
      </Transition>

      <!-- 命令面板 -->
      <Transition name="fade">
        <div v-if="paletteOpen" class="cmd-back" @click.self="closePalette">
          <div class="cmd" role="dialog" aria-modal="true" aria-label="搜索页面">
            <div class="cmd-search">
              <v-icon name="search"/>
              <input ref="paletteInput" v-model="paletteQuery" class="cmd-input" placeholder="搜索页面或功能…" aria-label="搜索页面"
                @input="paletteIndex = 0" @keydown.esc.prevent="closePalette" @keydown.down.prevent="paletteMove(1)" @keydown.up.prevent="paletteMove(-1)" @keydown.enter.prevent="paletteChoose"/>
              <kbd>Esc</kbd>
            </div>
            <div class="cmd-list">
              <template v-for="g in paletteGroups" :key="g.group">
                <div class="cmd-group">{{ g.group }}</div>
                <button v-for="it in g.items" :key="it.id" type="button" class="cmd-item" :class="{ on: paletteIndex === it.idx }" @mouseenter="paletteIndex = it.idx" @click="go(it.id)">
                  <v-icon :name="it.icon"/><span>{{ it.name }}</span><span v-if="it.badge && it.badge()" class="cmd-badge">{{ it.badge() }}</span><kbd>↵</kbd>
                </button>
              </template>
              <div v-if="!paletteGroups.length" class="cmd-empty">没有匹配的页面</div>
            </div>
            <div class="cmd-foot"><span><kbd>↑</kbd><kbd>↓</kbd> 浏览</span><span><kbd>Esc</kbd> 关闭</span></div>
          </div>
        </div>
      </Transition>
    </div>
    <!-- 全局服务宿主：放在登录壳之外，未登录/掉线（4010 清 token）时依然可用 -->
    <toast-host/>
    <dialog-host>`,
  }

  const app = createApp(App)
  window.UI.register(app)
  app.mount('#app')
})()
