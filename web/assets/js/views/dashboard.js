/** 视图:概览（Agent 运行时总览：状态、待批、用量趋势、运行明细） */
(function () {
  window.VIEWS = window.VIEWS || {}

  /* —— 图表辅助：一组数字，一条时间线 —— */
  const niceMax = (v) => {
    if (!v || v <= 0) return 1
    const p = Math.pow(10, Math.floor(Math.log10(v)))
    const n = v / p
    const m = n <= 1 ? 1 : n <= 1.5 ? 1.5 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10
    return m * p
  }
  const shortNum = (v) => {
    if (v >= 1e6) return (v / 1e6).toFixed(v >= 1e7 ? 0 : 1) + 'M'
    if (v >= 1e4) return (v / 1e3).toFixed(v >= 1e5 ? 0 : 1) + 'k'
    if (v >= 1e3) return (v / 1e3).toFixed(1) + 'k'
    return String(Math.round(v))
  }
  const lineChart = (list, { W = 640, H = 220, L = 46, R = 14, T = 16, B = 30 } = {}) => {
    const hasData = list.length > 0
    const max = niceMax(Math.max(1, ...list.map((d) => d.v || 0)))
    const plotW = W - L - R
    const plotH = H - T - B
    const x = (i) => L + (list.length > 1 ? (i * plotW) / (list.length - 1) : plotW / 2)
    const y = (v) => T + plotH * (1 - (v || 0) / max)
    const pts = list.map((d, i) => [x(i), y(d.v)])
    const path = pts.length ? pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ') : ''
    const area = pts.length
      ? `${path} L${pts[pts.length - 1][0].toFixed(1)} ${(H - B).toFixed(1)} L${pts[0][0].toFixed(1)} ${(H - B).toFixed(1)} Z`
      : ''
    const ticks = 4
    const grid = Array.from({ length: ticks + 1 }, (_, i) => {
      const v = (max * i) / ticks
      return { y: y(v), label: shortNum(v) }
    })
    return {
      W, H, L, R, T, B, max, hasData, path, area, grid,
      points: pts.map((p, i) => ({ x: p[0], y: p[1], v: list[i].v, day: list[i].day })),
      days: list.map((d, i) => ({ x: x(i), label: d.day })),
      zeroY: H - B,
    }
  }
  const barChart = (list, { W = 640, H = 220, L = 46, R = 14, T = 16, B = 30 } = {}) => {
    const hasData = list.length > 0
    const max = niceMax(Math.max(1, ...list.map((d) => d.v || 0)))
    const plotW = W - L - R
    const plotH = H - T - B
    const slot = list.length ? plotW / list.length : plotW
    const bw = Math.min(34, Math.max(8, slot * 0.52))
    const y = (v) => T + plotH * (1 - (v || 0) / max)
    const bars = list.map((d, i) => ({
      x: L + i * slot + (slot - bw) / 2,
      y: y(d.v),
      w: bw,
      h: Math.max(0, H - B - y(d.v)),
      v: d.v,
      day: d.day,
    }))
    const ticks = 4
    const grid = Array.from({ length: ticks + 1 }, (_, i) => {
      const v = (max * i) / ticks
      return { y: y(v), label: shortNum(v) }
    })
    return {
      W, H, L, R, T, B, max, hasData, bars, grid,
      days: list.map((d, i) => ({ x: L + i * slot + slot / 2, label: d.day })),
      zeroY: H - B,
    }
  }

  window.VIEWS.dashboard = {
    name: 'DashboardView',
    setup() {
      const { computed, onMounted, ref } = Vue
      const M = window.MOCK
      const fmt = window.UI.fmt
      const { toast } = window.UI

      /* —— 抬头 —— */
      const today = (() => {
        const d = new Date()
        const w = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()]
        return `${d.getMonth() + 1} 月 ${d.getDate()} 日 · 星期${w}`
      })()

      /* —— 关键数字 —— */
      const conversations = computed(() => M.counts?.conversations ?? (M.conversations || []).length)
      const adoptions = computed(() => (M.personaAdoptions || []).filter((p) => p.status === 'pending'))
      const pendSug = computed(() => (M.suggestions || []).filter((s) => s.status === 'pending'))
      const pending = computed(() => (M.confirms || []).length + adoptions.value.length + pendSug.value.length)
      const pendingNote = computed(() => {
        const a = []
        if ((M.confirms || []).length) a.push(`工具 ${(M.confirms || []).length}`)
        if (adoptions.value.length) a.push(`人设 ${adoptions.value.length}`)
        if (pendSug.value.length) a.push(`建议 ${pendSug.value.length}`)
        return a.length ? a.join(' · ') : '队列已清空'
      })
      const failures = computed(() => M.toolFail ?? 0)
      const failureText = computed(() => (M.toolFail == null ? '—' : fmt.num(M.toolFail)))
      const successRateText = computed(() => {
        if (M.toolSuccessRate != null) return (M.toolSuccessRate * 100).toFixed(1) + '%'
        if (M.toolOk != null && M.toolFail != null && M.toolOk + M.toolFail > 0) return ((M.toolOk / (M.toolOk + M.toolFail)) * 100).toFixed(1) + '%'
        return '—'
      })
      const sandbox = computed(() => M.config?.sandbox?.mode || 'off')
      const provider = computed(() => (M.config?.llmProviders || []).find((p) => p.id === M.config?.providerId) || null)
      const runtime = computed(() => {
        const c = M.config || {}
        return {
          provider: provider.value?.name || c.providerId || '未配置',
          model: c.model || '未配置',
          protocol: ({ openai: 'OpenAI', anthropic: 'Anthropic', gemini: 'Gemini' }[c.protocol] || c.protocol || '—'),
          trigger: ({ at: '@ 提及', command: `触发词 ${c.triggerCommand || ''}`, both: '提及 / 触发词' }[c.trigger] || c.trigger || '—'),
          memory: !!c.memory?.enable,
          isolation: !!c.isolation?.enable,
          ready: !!(c.model && c.providerId),
        }
      })

      /* —— 待批队列 —— */
      const todo = computed(() => [
        ...(M.confirms || []).map((c) => ({
          key: 'c' + c.id, kind: 'tool', id: c.id,
          name: `工具确认 · ${c.tool}`,
          sub: `${c.ctx?.user || '—'}${c.ctx?.gid ? ' · 群 ' + c.ctx.gid : ' · 私聊'} · ${c.ctx?.reason || '需二次确认'}`,
          act: '批准执行',
        })),
        ...adoptions.value.map((a) => ({
          key: 'a' + a.id, kind: 'persona', id: a.id,
          name: `人设采纳 · ${a.personaName || a.personaId}`,
          sub: `${a.via === 'qq' ? 'QQ' : 'Web'} 提交 · ${a.by || '—'} · ${fmt.ago(a.createdAt)}`,
          act: '批准采纳',
        })),
        ...pendSug.value.map((s) => ({
          key: 's' + s.id, kind: 'suggestion', id: s.id,
          name: `进化建议 · ${s.title || s.kind || '改进项'}`,
          sub: `${s.summary || s.payload || ''}`.slice(0, 72) || '待审改进项',
          act: '采纳建议',
        })),
      ])
      const todoShown = computed(() => todo.value.slice(0, 4))
      const todoRest = computed(() => Math.max(0, todo.value.length - todoShown.value.length))
      const kindLabel = (k) => (k === 'tool' ? '工具' : k === 'persona' ? '人设' : '建议')

      const stamping = ref('')
      const approve = async (item) => {
        stamping.value = item.key
        try {
          if (item.kind === 'tool') {
            await window.api.post(`/confirm/${item.id}/decide`, { approve: true })
            await window.store.loadConfirm()
          } else if (item.kind === 'persona') {
            await window.api.post(`/persona-adoptions/${item.id}/approve`, {})
            await window.store.loadPersonaAdoptions()
          } else {
            await window.api.post(`/suggestions/${item.id}/apply`)
            await window.store.loadSuggestions(null, 'pending')
          }
          toast(`已批：${item.name}`, 'success')
        } catch (e) { toast(e.message, 'error') } finally {
          setTimeout(() => { stamping.value = '' }, 420)
        }
      }

      /* —— 主趋势：一条线，一个总量 —— */
      const tokenChart = computed(() => lineChart(
        (M.tokenTrend || []).map((d) => ({ day: d.day, v: (d.input || 0) + (d.output || 0) })),
      ))
      const reqBars = computed(() => barChart(
        (M.requestTrend || []).map((d) => ({ day: d.day, v: d.count || 0 })),
      ))

      /* —— 明细图（保留旧图表的数据口径） —— */
      const chart = computed(() => {
        const W = 560, Hgt = 180, PAD = 8
        const trend = M.tokenTrend || []
        const empty = { W, H: Hgt, lineIn: '', lineOut: '', lineHitIn: '', lineHitOut: '', lineMissIn: '', lineMissOut: '', areaIn: '', areaOut: '', days: [], dots: [], single: false, hasCached: false, rows: [] }
        if (!trend.length) return empty
        const hasCached = trend.some((d) => (d.cacheRead || 0) > 0 || (d.cached || 0) > 0 || (d.uncached || 0) > 0)
        for (const d of trend) {
          const read = d.cacheRead ?? d.cached ?? 0
          const obsIn = d.observedInput || (read > 0 ? Math.max(read, d.input || 0) : 0)
          d.hitIn = read
          d.missIn = d.uncached != null ? d.uncached : Math.max(0, (d.input || 0) - read)
          const ratio = obsIn > 0 ? Math.min(1, read / obsIn) : 0
          d.hitOut = Math.round((d.output || 0) * ratio)
          d.missOut = (d.output || 0) - d.hitOut
        }
        const maxV = Math.max(...trend.map((d) => Math.max(d.input + d.output, d.hitIn + d.missIn))) || 1
        const denom = (trend.length - 1) || 1
        const pt = (i, v) => [PAD + (i * (W - PAD * 2)) / denom, Hgt - PAD - (v / maxV) * (Hgt - PAD * 2 - 14)]
        const line = (key) => trend.map((d, i) => pt(i, d[key]).map((n) => n.toFixed(1)).join(',')).join(' ')
        const area = (key) => {
          const pts = trend.map((d, i) => pt(i, d[key]))
          return `M${pts[0][0]},${Hgt - PAD} ` + pts.map((p) => `L${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ') + ` L${pts[pts.length - 1][0]},${Hgt - PAD} Z`
        }
        const dots = trend.length === 1 ? [{ x: pt(0, 0)[0], yIn: pt(0, trend[0].input)[1], yOut: pt(0, trend[0].output)[1] }] : []
        const rows = [...trend].reverse().map((d) => ({ day: d.day, input: d.input || 0, cached: d.hitIn || 0, miss: d.missIn || 0, output: d.output || 0, hitOut: d.hitOut || 0, missOut: d.missOut || 0 }))
        return { W, H: Hgt, lineIn: line('input'), lineOut: line('output'), lineHitIn: hasCached ? line('hitIn') : '', lineHitOut: hasCached ? line('hitOut') : '', lineMissIn: hasCached ? line('missIn') : '', lineMissOut: hasCached ? line('missOut') : '', areaIn: area('input'), areaOut: area('output'), days: trend.map((d) => d.day), dots, single: trend.length === 1, hasCached, rows }
      })

      const reqChart = computed(() => {
        const W = 560, Hgt = 180, PAD = 8
        const trend = M.requestTrend || []
        if (!trend.length) return { W, H: Hgt, bars: [], days: [], max: 0 }
        const maxV = Math.max(...trend.map((d) => d.count)) || 1
        const slot = (W - PAD * 2) / trend.length
        const bw = Math.max(4, slot - 6)
        const bars = trend.map((d, i) => {
          const h = (d.count / maxV) * (Hgt - PAD * 2 - 14)
          return { x: PAD + i * slot + (slot - bw) / 2, y: Hgt - PAD - h, w: bw, h, count: d.count }
        })
        return { W, H: Hgt, bars, days: trend.map((d) => d.day), max: maxV }
      })

      const toolTop = computed(() => M.toolTop || [])
      const toolMax = computed(() => Math.max(1, ...(M.toolTop || []).map((t) => t.count)))
      const toolTotal = computed(() => (M.toolTop || []).reduce((s, t) => s + (t.count || 0), 0))

      const switches = computed(() => {
        const cfg = M.config || {}
        return [
          { name: '声明式记忆', on: cfg.memory?.enable },
          { name: '威胁扫描', on: cfg.memory?.threatScan },
          { name: '后台自评审', on: cfg.selfReview?.enable },
          { name: '多模态', on: cfg.media?.enable },
          { name: '视觉子模型', on: cfg.vision?.enable },
          { name: '终端(E2B 沙箱)', on: cfg.sandbox?.mode === 'e2b', danger: true },
        ]
      })

      const perceptions = computed(() => M.perceptions || [])
      const totalTokens = computed(() => (M.tokenTrend || []).reduce((s, d) => s + (d.input || 0) + (d.output || 0), 0))
      const tokenPeak = computed(() => Math.max(0, ...(M.tokenTrend || []).map((d) => (d.input || 0) + (d.output || 0))))
      const tokenAvg = computed(() => Math.round(totalTokens.value / ((M.tokenTrend || []).length || 1)))
      const switchOn = computed(() => switches.value.filter((s) => s.on).length)

      /* 缓存统计（完整 Agent 流口径；未观测旧日志不进分母） */
      const win = Vue.ref('7d')
      const winLabel = computed(() => ({ '1h': '近 1 小时', '24h': '近 24 小时', '7d': '近 7 日', 'new': '部署后', 'all': '全部时间' }[win.value] || '近 7 日'))
      const cacheStats = computed(() => {
        const c = M.cache || null
        if (c) {
          const pct = (v) => (v == null ? null : Math.max(0, Math.min(100, v * 100)))
          const hitRate = pct(c.tokenHitRate)
          return {
            input: c.observedInput || 0, output: c.observedOutput || 0, cached: c.totalCacheRead || 0,
            cacheWrite: c.totalCacheWrite || 0, miss: Math.max(0, (c.observedInput || 0) - (c.totalCacheRead || 0)),
            hitRate, missRate: hitRate == null ? 0 : 100 - hitRate, requestHitRate: pct(c.requestHitRate), warmHitRate: pct(c.warmRequestHitRate),
            warmTokenHitRate: pct(c.warmTokenHitRate),
            unobserved: c.unobservedRequests || 0, observedReq: c.observedRequests || 0,
            warmObserved: c.warmObserved || 0, warmHit: c.warmHit || 0, coldObserved: c.coldObserved || 0,
            hasData: (c.observedRequests || 0) > 0, hasRequestRate: c.requestHitRate != null,
          }
        }
        const t = M.tokenTrend || []
        const input = t.reduce((s, d) => s + (d.input || 0), 0)
        const output = t.reduce((s, d) => s + (d.output || 0), 0)
        const cached = t.reduce((s, d) => s + (d.cached || 0), 0)
        const hitRate = input > 0 ? (cached / input) * 100 : 0
        return { input, output, cached, cacheWrite: 0, miss: Math.max(0, input - cached), hitRate, missRate: input > 0 ? 100 - hitRate : 0, hasData: input > 0, hasRequestRate: false, unobserved: 0 }
      })
      const setWin = async (w) => {
        win.value = w
        try { await window.store.loadOverview({ window: w }); lastUpdated.value = Date.now() } catch { /* 忽略 */ }
      }
      const clearing = ref(false)
      const clearCache = async () => {
        const ask = await window.UI.confirm({
          title: '清空 Token 缓存统计',
          icon: 'warn',
          danger: true,
          confirmText: '清空统计',
          message: '将清空 <b>全部 Token 缓存命中数据</b>：Redis 日统计 + 会话日志（devLog）文件。<br>'
            + '影响：概览的命中率、Token 趋势、工具统计从零重新累计；<b>日志时间线</b>同时清空。<br>'
            + '不受影响：记忆 / 人设 / 会话 / 定时 / 配置。此操作不可恢复。',
        })
        if (!ask) return
        clearing.value = true
        try {
          const r = await window.api.post('/cache/clear', {})
          M.cache = null
          await window.store.loadOverview({ window: win.value })
          lastUpdated.value = Date.now()
          toast(`已清空：日统计 ${r?.kvRemoved ?? 0} 天 · 日志 ${r?.logsRemoved ?? 0} 个文件`, 'success')
        } catch (e) { toast(e.message, 'error') } finally { clearing.value = false }
      }

      /* —— 运行明细（保留账目式展开） —— */
      const open = ref('')
      const toggle = (id) => { open.value = open.value === id ? '' : id }
      const books = computed(() => [
        {
          id: 'token', name: 'Token 消耗', unit: 'tokens',
          sub: `${winLabel.value} · ${M.statsSource === 'kv' ? '按 Redis 日统计聚合（本地时区）' : '按 devLog 聚合（过渡，产生对话后切 Redis）'}`,
          value: fmt.num(totalTokens.value),
        },
        {
          id: 'tool', name: '工具调用', unit: '次',
          sub: `${winLabel.value} · 成功率 ${M.toolSuccessRate != null ? (M.toolSuccessRate * 100).toFixed(1) + '%' : '暂无'}`,
          value: fmt.num(M.totalToolCalls || 0),
        },
        {
          id: 'cache', name: 'Token 缓存', unit: '命中率',
          sub: '未观测旧日志不进命中率 · cold/warm 分层',
          value: cacheStats.value.hitRate != null ? cacheStats.value.hitRate.toFixed(1) + '%' : '—',
        },
        {
          id: 'req', name: '请求', unit: '次',
          sub: `${winLabel.value} · 每日对话轮次（devLog run_end 计数）`,
          value: fmt.num(M.totalRequests || 0),
        },
        {
          id: 'recall', name: '长期记忆', unit: '条',
          sub: `上限 ${M.config?.recall?.cap || '—'} 条/用户 · 抽取每 ${M.config?.recall?.extractEvery || '—'} 轮`,
          value: fmt.num(Object.values(M.recall || {}).flat().length),
        },
        {
          id: 'switch', name: '功能开关', unit: '开启',
          sub: '当前生效配置一览（只读，修改请前往配置中心）',
          value: `${switchOn.value}/${switches.value.length}`,
        },
        {
          id: 'percept', name: '群情境', unit: '个群',
          sub: 'perception:met / last_active',
          value: fmt.num(perceptions.value.length),
        },
      ])

      /* 刷新与更新时间 */
      const refreshing = ref(false)
      const lastUpdated = ref(Date.now())
      const lastUpdatedLabel = computed(() => new Date(lastUpdated.value).toTimeString().slice(0, 5))
      const loadAll = async () => {
        const tasks = [
          window.store.loadOverview(),
          window.store.loadConfig(),
          window.store.loadConfirm(),
          window.store.loadPersonaAdoptions(),
          window.store.loadSuggestions(null, 'pending'),
        ]
        const results = await Promise.allSettled(tasks)
        lastUpdated.value = Date.now()
        return results
      }
      const reload = async () => {
        if (refreshing.value) return
        refreshing.value = true
        try {
          const results = await loadAll()
          const failed = results.find((r) => r.status === 'rejected')
          if (failed) toast('部分数据刷新失败：' + (failed.reason?.message || failed.reason), 'warn')
          else toast('概览已刷新', 'success')
        } finally { refreshing.value = false }
      }

      onMounted(async () => {
        await loadAll()
      })

      return {
        today, conversations, pending, pendingNote, failures, failureText, successRateText, sandbox, runtime,
        todo, todoShown, todoRest, kindLabel, stamping, approve,
        chart, reqChart, tokenChart, reqBars, toolTop, toolMax, toolTotal,
        switches, perceptions, totalTokens, tokenPeak, tokenAvg, cacheStats, win, winLabel, setWin, clearCache, clearing,
        books, open, toggle, fmt, M,
        refreshing, lastUpdatedLabel, reload,
      }
    },
    template: `
    <div class="dash">
      <!-- 抬头 -->
      <header class="dash-head">
        <div class="dash-head-main">
          <h1 class="dash-title">概览</h1>
          <p class="dash-sub">TRSS-Yunzai · {{ today }} · {{ runtime.provider }} / {{ runtime.model }} · 数据更新于 {{ lastUpdatedLabel }}</p>
        </div>
        <div class="dash-actions">
          <span class="pill" :class="pending ? 'p-honey' : 'p-green'">
            <span class="status-dot" :class="pending ? 'is-warn' : 'is-ok'"></span>{{ pending ? pending + ' 条待批' : '队列已清空' }}
          </span>
          <button class="btn b-line b-sm" :disabled="refreshing" @click="reload">
            <v-icon name="refresh"/>{{ refreshing ? '刷新中…' : '刷新' }}
          </button>
        </div>
      </header>

      <!-- 运行时一行：当前模型 + 近 7 日链路 -->
      <section class="runtime" aria-label="运行时状态">
        <div class="runtime-main">
          <div class="runtime-state">
            <span class="live-dot"></span>
            <span>{{ runtime.ready ? '运行时在线' : '待配置模型' }}</span>
            <span class="runtime-sep"></span>
            <span class="mono">沙箱 {{ sandbox }}</span>
          </div>
          <div class="runtime-name">
            <span class="runtime-provider">{{ runtime.provider }}</span>
            <span class="runtime-slash">/</span>
            <span class="runtime-model mono">{{ runtime.model }}</span>
          </div>
          <div class="runtime-meta">
            <span>协议 {{ runtime.protocol }}</span>
            <span>触发 {{ runtime.trigger }}</span>
            <span>记忆 {{ runtime.memory ? '开启' : '关闭' }}</span>
            <span>隔离 {{ runtime.isolation ? '开启' : '关闭' }}</span>
          </div>
        </div>
        <div class="runtime-chain">
          <div class="chain-head">近 7 日运行链路</div>
          <div class="chain">
            <div class="chain-step">
              <span class="chain-value num">{{ fmt.num(conversations) }}</span>
              <span class="chain-label">活跃会话</span>
            </div>
            <span class="chain-arrow">→</span>
            <div class="chain-step">
              <span class="chain-value num">{{ fmt.num(M.totalRequests || 0) }}</span>
              <span class="chain-label">请求</span>
            </div>
            <span class="chain-arrow">→</span>
            <div class="chain-step">
              <span class="chain-value num">{{ fmt.num(M.totalToolCalls || 0) }}</span>
              <span class="chain-label">工具调用</span>
            </div>
            <span class="chain-arrow">→</span>
            <div class="chain-step">
              <span class="chain-value num">{{ fmt.num(totalTokens) }}</span>
              <span class="chain-label">Token</span>
            </div>
          </div>
        </div>
      </section>

      <!-- 关键数字：一个容器，四条分隔 -->
      <section class="kpi-strip" aria-label="关键指标">
        <div class="kpi">
          <span class="kpi-label">活跃会话</span>
          <span class="kpi-value num">{{ fmt.num(conversations) }}</span>
          <span class="kpi-note">群聊 / 私聊</span>
        </div>
        <div class="kpi">
          <span class="kpi-label">待你决定</span>
          <span class="kpi-value num" :class="{ 'is-alert': pending > 0 }">{{ pending }}</span>
          <span class="kpi-note">{{ pendingNote }}</span>
        </div>
        <div class="kpi">
          <span class="kpi-label">工具成功率</span>
          <span class="kpi-value num">{{ successRateText }}</span>
          <span class="kpi-note">近 7 日 · 失败 {{ failureText }}</span>
        </div>
        <div class="kpi">
          <span class="kpi-label">Token 消耗</span>
          <span class="kpi-value num">{{ fmt.num(totalTokens) }}</span>
          <span class="kpi-note">缓存命中 {{ cacheStats.hitRate != null ? cacheStats.hitRate.toFixed(1) + '%' : '—' }}</span>
        </div>
      </section>

      <!-- 主工作区 -->
      <div class="dash-grid dash-grid-main">
        <section class="panel approvals">
          <header class="panel-head">
            <div>
              <h2 class="panel-title">待你决定</h2>
              <p class="panel-meta">工具确认 · 人设采纳 · 进化建议，批准后立即生效</p>
            </div>
            <a class="panel-link" href="#/confirm">全部审批 <span aria-hidden="true">→</span></a>
          </header>
          <div v-if="todoShown.length" class="approval-list">
            <div v-for="t in todoShown" :key="t.key" class="approval-row">
              <span class="approval-kind" :class="'kind-' + t.kind">{{ kindLabel(t.kind) }}</span>
              <div class="approval-body">
                <div class="approval-title">{{ t.name }}</div>
                <div class="approval-sub">{{ t.sub }}</div>
              </div>
              <button class="btn b-pri b-sm approval-act" :class="{ 'is-stamping': stamping === t.key }"
                :title="t.act" :aria-label="t.act" :disabled="!!stamping" @click="approve(t)">
                <v-icon name="check"/>批准
              </button>
            </div>
          </div>
          <div v-else class="queue-empty">
            <v-icon name="check"/>
            <div><b>队列已清空</b><span>没有在等你定的事。</span></div>
          </div>
          <div v-if="todoRest" class="queue-more">
            还有 {{ todoRest }} 条 · <a href="#/confirm">去审批门</a> 或 <a href="#/suggestions">进化建议</a>
          </div>
        </section>

        <section class="panel chart-panel">
          <header class="panel-head">
            <div>
              <h2 class="panel-title">Token 消耗</h2>
              <p class="panel-meta">输入 + 输出 · {{ winLabel }}</p>
            </div>
            <div class="seg seg-sm">
              <button v-for="w in ['1h','24h','7d','new','all']" :key="w" :class="{ on: win === w }" @click="setWin(w)">
                {{ w === 'new' ? '部署后' : (w === 'all' ? '全部' : w) }}
              </button>
            </div>
          </header>
          <div class="chart-body">
            <svg class="chart-svg" :viewBox="'0 0 ' + tokenChart.W + ' ' + tokenChart.H" role="img" aria-label="Token 消耗趋势">
              <g class="chart-grid">
                <line v-for="g in tokenChart.grid" :key="'g' + g.y" :x1="tokenChart.L" :x2="tokenChart.W - tokenChart.R" :y1="g.y" :y2="g.y"/>
              </g>
              <g class="chart-ticks">
                <text v-for="g in tokenChart.grid" :key="'t' + g.y" :x="tokenChart.L - 8" :y="g.y + 3.5" text-anchor="end">{{ g.label }}</text>
              </g>
              <path v-if="tokenChart.path" class="chart-area" :d="tokenChart.area"/>
              <path v-if="tokenChart.path" class="chart-line" :d="tokenChart.path" pathLength="1"/>
              <circle v-for="p in tokenChart.points" :key="'p' + p.day" class="chart-dot" :cx="p.x" :cy="p.y" r="2.6">
                <title>{{ p.day }} · {{ fmt.num(p.v) }} tokens</title>
              </circle>
              <g class="chart-days">
                <text v-for="d in tokenChart.days" :key="'d' + d.label" :x="d.x" :y="tokenChart.H - 8" text-anchor="middle">{{ d.label }}</text>
              </g>
              <line v-if="!tokenChart.hasData" class="chart-zero" :x1="tokenChart.L" :x2="tokenChart.W - tokenChart.R" :y1="tokenChart.zeroY" :y2="tokenChart.zeroY"/>
            </svg>
            <div v-if="!tokenChart.hasData" class="chart-empty">暂无 Token 数据：产生对话后自动统计</div>
            <div class="token-split">
              <div><span>输入</span><b class="mono">{{ fmt.num(cacheStats.input) }}</b></div>
              <div><span>输出</span><b class="mono">{{ fmt.num(cacheStats.output) }}</b></div>
              <div><span>缓存读取</span><b class="mono">{{ fmt.num(cacheStats.cached) }}</b></div>
              <div><span>日均</span><b class="mono">{{ fmt.num(tokenAvg) }}</b></div>
              <div><span>峰值</span><b class="mono">{{ fmt.num(tokenPeak) }}</b></div>
            </div>
          </div>
        </section>
      </div>

      <div class="dash-grid dash-grid-2">
        <section class="panel chart-panel">
          <header class="panel-head">
            <div>
              <h2 class="panel-title">对话轮次</h2>
              <p class="panel-meta">每日请求 · {{ winLabel }}</p>
            </div>
            <span class="panel-stat"><b>{{ fmt.num(M.totalRequests || 0) }}</b> 次</span>
          </header>
          <div class="chart-body">
            <svg class="chart-svg" :viewBox="'0 0 ' + reqBars.W + ' ' + reqBars.H" role="img" aria-label="每日对话轮次">
              <g class="chart-grid">
                <line v-for="g in reqBars.grid" :key="'rg' + g.y" :x1="reqBars.L" :x2="reqBars.W - reqBars.R" :y1="g.y" :y2="g.y"/>
              </g>
              <g class="chart-ticks">
                <text v-for="g in reqBars.grid" :key="'rt' + g.y" :x="reqBars.L - 8" :y="g.y + 3.5" text-anchor="end">{{ g.label }}</text>
              </g>
              <rect v-for="(b, i) in reqBars.bars" :key="'b' + b.day" class="chart-bar" :x="b.x" :y="b.y" :width="b.w" :height="b.h" :style="{ animationDelay: (i * 45) + 'ms' }">
                <title>{{ b.day }} · {{ b.v }} 次</title>
              </rect>
              <line v-if="!reqBars.hasData" class="chart-zero" :x1="reqBars.L" :x2="reqBars.W - reqBars.R" :y1="reqBars.zeroY" :y2="reqBars.zeroY"/>
              <g class="chart-days">
                <text v-for="d in reqBars.days" :key="'rd' + d.label" :x="d.x" :y="reqBars.H - 8" text-anchor="middle">{{ d.label }}</text>
              </g>
            </svg>
            <div v-if="!reqBars.hasData" class="chart-empty">暂无请求数据：产生对话后自动统计</div>
          </div>
        </section>

        <section class="panel">
          <header class="panel-head">
            <div>
              <h2 class="panel-title">工具调用 Top 5</h2>
              <p class="panel-meta">近 7 日 · 共 {{ fmt.num(toolTotal) }} 次</p>
            </div>
            <a class="panel-link" href="#/evolution">工具进化 <span aria-hidden="true">→</span></a>
          </header>
          <div v-if="toolTop.length" class="tool-rank">
            <div v-for="(t, i) in toolTop" :key="t.name" class="tool-row">
              <div class="tool-row-top">
                <span class="tool-name mono">{{ t.name }}</span>
                <span class="tool-count num">{{ fmt.num(t.count) }}<em> 次</em></span>
              </div>
              <div class="tool-track"><i :style="{ width: (t.count / toolMax * 100) + '%', animationDelay: (i * 45) + 'ms' }"></i></div>
              <div v-if="t.rate != null" class="tool-meta">成功率 {{ (t.rate * 100).toFixed(0) }}%（{{ t.ok }}/{{ t.count }}）</div>
            </div>
          </div>
          <div v-else class="queue-empty compact">
            <v-icon name="tool"/>
            <div><b>暂无工具调用</b><span>产生对话后自动统计。</span></div>
          </div>
        </section>
      </div>

      <div class="dash-grid dash-grid-2">
        <section class="panel">
          <header class="panel-head">
            <div>
              <h2 class="panel-title">功能开关</h2>
              <p class="panel-meta">{{ switchOn }} / {{ switches.length }} 开启 · 只读</p>
            </div>
            <a class="panel-link" href="#/config">配置中心 <span aria-hidden="true">→</span></a>
          </header>
          <div class="switch-grid">
            <div v-for="s in switches" :key="s.name" class="switch-item">
              <span class="switch-dot" :class="{ on: s.on, danger: s.danger && s.on }"></span>
              <span class="switch-name">{{ s.name }}</span>
              <span class="switch-state">{{ s.on ? '开启' : '关闭' }}</span>
            </div>
          </div>
        </section>

        <section class="panel">
          <header class="panel-head">
            <div>
              <h2 class="panel-title">群情境</h2>
              <p class="panel-meta">{{ perceptions.length }} 个群在观察范围</p>
            </div>
            <a class="panel-link" href="#/groupworld">群聊小世界 <span aria-hidden="true">→</span></a>
          </header>
          <div v-if="perceptions.length" class="perception-list">
            <div v-for="p in perceptions" :key="p.groupId" class="perception-row">
              <div class="perception-main">
                <div class="perception-id mono">群 {{ p.groupId }}</div>
                <div class="perception-meta">入群 {{ fmt.ago(p.met.at) }}</div>
              </div>
              <span class="pill" :class="(Date.now() - p.lastActive.at) > 6 * 3600e3 ? 'p-honey' : 'p-green'">
                {{ (Date.now() - p.lastActive.at) > 6 * 3600e3 ? '久离 ' : '活跃 ' }}{{ fmt.ago(p.lastActive.at) }}
              </span>
            </div>
          </div>
          <div v-else class="queue-empty compact">
            <v-icon name="group"/>
            <div><b>暂无群感知数据</b><span>bot 入群并产生互动后会出现在这里。</span></div>
          </div>
        </section>
      </div>

      <!-- 运行明细 -->
      <section class="dash-section">
        <header class="section-head">
          <div>
            <h2 class="section-title">运行明细</h2>
            <p class="section-sub">Token、工具、缓存与配置口径 · 点开查看</p>
          </div>
          <span class="section-side">只读</span>
        </header>
        <div class="run-list">
          <div v-for="b in books" :key="b.id" class="run-item" :class="{ open: open === b.id }">
            <button type="button" class="run-row" :aria-expanded="open === b.id" @click="toggle(b.id)">
              <span class="run-main">
                <span class="run-name">{{ b.name }}</span>
                <span class="run-sub">{{ b.sub }}</span>
              </span>
              <span class="run-value">{{ b.value }}<em>{{ b.unit }}</em></span>
              <svg class="run-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>
            </button>

            <Transition name="expand">
              <div v-if="open === b.id" class="run-body">
                <!-- Token 消耗明细 -->
                <template v-if="b.id === 'token'">
                  <div class="chart-legend">
                    <span><i style="background:var(--ch-in)"></i>输入</span>
                    <span><i style="background:var(--ch-out)"></i>输出</span>
                    <span v-if="chart.hasCached"><i style="background:var(--ch-hit-in)"></i>命中·输入</span>
                    <span v-if="chart.hasCached"><i style="background:var(--ch-hit-out)"></i>命中·输出</span>
                    <span v-if="chart.hasCached"><i style="background:var(--ch-miss-in)"></i>未命中·输入</span>
                    <span v-if="chart.hasCached"><i style="background:var(--ch-miss-out)"></i>未命中·输出</span>
                  </div>
                  <svg v-if="chart.lineIn" :viewBox="'0 0 ' + chart.W + ' ' + chart.H" class="legacy-chart">
                    <defs>
                      <linearGradient id="agIn" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" style="stop-color:var(--ch-in);stop-opacity:.16"/><stop offset="100%" style="stop-color:var(--ch-in);stop-opacity:0"/>
                      </linearGradient>
                      <linearGradient id="agOut" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" style="stop-color:var(--ch-out);stop-opacity:.14"/><stop offset="100%" style="stop-color:var(--ch-out);stop-opacity:0"/>
                      </linearGradient>
                    </defs>
                    <path :d="chart.areaIn" fill="url(#agIn)"/>
                    <path :d="chart.areaOut" fill="url(#agOut)"/>
                    <polyline :points="chart.lineIn" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
                      pathLength="1" style="stroke:var(--ch-in);stroke-dasharray:1;stroke-dashoffset:1;animation:dashIn 1.1s .15s var(--eo) forwards"/>
                    <polyline :points="chart.lineOut" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
                      pathLength="1" style="stroke:var(--ch-out);stroke-dasharray:1;stroke-dashoffset:1;animation:dashIn 1.1s .3s var(--eo) forwards"/>
                    <polyline v-if="chart.lineHitIn" :points="chart.lineHitIn" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"
                      style="stroke:var(--ch-hit-in)" stroke-dasharray="8 5"/>
                    <polyline v-if="chart.lineHitOut" :points="chart.lineHitOut" fill="none" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"
                      style="stroke:var(--ch-hit-out)" stroke-dasharray="4 4"/>
                    <polyline v-if="chart.lineMissIn" :points="chart.lineMissIn" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"
                      style="stroke:var(--ch-miss-in)" stroke-dasharray="2 3"/>
                    <polyline v-if="chart.lineMissOut" :points="chart.lineMissOut" fill="none" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"
                      style="stroke:var(--ch-miss-out)" stroke-dasharray="1 4"/>
                    <template v-if="chart.single && chart.dots.length">
                      <circle :cx="chart.dots[0].x" :cy="chart.dots[0].yIn" r="3" style="fill:var(--ch-in)"/>
                      <circle :cx="chart.dots[0].x" :cy="chart.dots[0].yOut" r="3" style="fill:var(--ch-out)"/>
                    </template>
                  </svg>
                  <div v-if="chart.lineIn" class="chart-day-row">
                    <span v-for="d in chart.days" :key="d">{{ d }}</span>
                  </div>
                  <div v-if="chart.rows && chart.rows.length" class="detail-table-wrap">
                    <table class="detail-table mono">
                      <thead><tr>
                        <th>日期</th>
                        <th style="color:var(--ch-in)">输入</th>
                        <th v-if="chart.hasCached" style="color:var(--ch-hit-in)">命中·输入</th>
                        <th v-if="chart.hasCached" style="color:var(--ch-miss-in)">未命中·输入</th>
                        <th style="color:var(--ch-out)">输出</th>
                        <th v-if="chart.hasCached" style="color:var(--ch-hit-out)">命中·输出</th>
                        <th v-if="chart.hasCached" style="color:var(--ch-miss-out)">未命中·输出</th>
                      </tr></thead>
                      <tbody>
                        <tr v-for="r in chart.rows" :key="r.day">
                          <td>{{ r.day }}</td>
                          <td>{{ fmt.num(r.input) }}</td>
                          <td v-if="chart.hasCached">{{ fmt.num(r.cached) }}</td>
                          <td v-if="chart.hasCached">{{ fmt.num(r.miss) }}</td>
                          <td>{{ fmt.num(r.output) }}</td>
                          <td v-if="chart.hasCached">{{ fmt.num(r.hitOut) }}</td>
                          <td v-if="chart.hasCached">{{ fmt.num(r.missOut) }}</td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                  <div v-else class="detail-empty">暂无数据：产生对话（@机器人 / #ai）后自动统计</div>
                </template>

                <!-- 工具调用明细 -->
                <template v-else-if="b.id === 'tool'">
                  <div v-if="M.statsSource === 'kv'" class="row g6 wrap detail-pills">
                    <span class="pill p-sky">成功 {{ M.toolOk ?? 0 }}</span>
                    <span class="pill p-honey">失败 {{ M.toolFail ?? 0 }}</span>
                    <span class="pill p-sky">成功率 {{ M.toolSuccessRate != null ? (M.toolSuccessRate * 100).toFixed(1) + '%' : '暂无' }}</span>
                  </div>
                  <div v-if="toolTop.length" class="tool-rank detail-rank">
                    <div v-for="t in toolTop" :key="t.name" class="tool-row">
                      <div class="tool-row-top">
                        <span class="tool-name mono">{{ t.name }}</span>
                        <span class="tool-count num">{{ fmt.num(t.count) }}<em> 次</em></span>
                      </div>
                      <div class="meter"><i :style="{ width: (t.count / toolMax * 100) + '%' }"></i></div>
                      <div v-if="t.rate != null" class="tool-meta">成功率 <span :class="t.rate >= 0.9 ? 'is-ok-text' : 'is-warn-text'">{{ (t.rate * 100).toFixed(0) }}%</span> <span class="mut2">（{{ t.ok }}/{{ t.count }}）</span></div>
                    </div>
                  </div>
                  <div v-else class="detail-empty">暂无数据：产生对话后自动统计</div>
                </template>

                <!-- Token 缓存明细 -->
                <template v-else-if="b.id === 'cache'">
                  <div class="row-b wrap g10">
                    <span class="mut2" style="font-size:12px">观测窗口</span>
                    <button type="button" class="btn b-danger b-sm" :disabled="clearing" @click="clearCache">
                      <v-icon name="trash"/>{{ clearing ? '清空中…' : '清空统计' }}
                    </button>
                  </div>
                  <div class="row g6 wrap detail-pills">
                    <button v-for="w in ['1h','24h','7d','new','all']" :key="w" class="btn b-sm" :class="win === w ? 'b-pri' : 'b-line'" @click="setWin(w)">{{ w === 'new' ? '部署后' : (w === 'all' ? '全部' : w) }}</button>
                  </div>
                  <template v-if="cacheStats.hasData">
                    <div class="row g10 wrap detail-pills">
                      <span class="pill p-honey">请求命中率 {{ cacheStats.requestHitRate != null ? cacheStats.requestHitRate.toFixed(1) + '%' : '暂无' }}</span>
                      <span class="pill p-mint">Token 命中率 {{ cacheStats.hitRate != null ? cacheStats.hitRate.toFixed(1) + '%' : '暂无' }}</span>
                      <span v-if="cacheStats.warmTokenHitRate != null" class="pill p-mint">warm Token 命中率 {{ cacheStats.warmTokenHitRate.toFixed(1) }}%（剔除每会话首个请求）</span>
                      <span v-if="cacheStats.warmHitRate != null" class="pill p-sky">warm 请求命中率 {{ cacheStats.warmHitRate.toFixed(1) }}%（{{ cacheStats.warmHit }}/{{ cacheStats.warmObserved }}）</span>
                      <span class="pill">cold {{ cacheStats.coldObserved }}</span>
                      <span v-if="cacheStats.unobserved > 0" class="pill" style="opacity:.75">未观测旧日志 {{ cacheStats.unobserved }} 条（不进分母）</span>
                    </div>
                    <div class="cache-blocks">
                      <div>
                        <div class="row-b cache-row">
                          <span class="cache-label" style="color:var(--ch-in)">输入 tokens</span>
                          <span class="num cache-value">{{ fmt.num(cacheStats.input) }}</span>
                        </div>
                        <div class="cache-sub">
                          <span style="color:var(--ch-hit-in)">缓存读取 {{ fmt.num(cacheStats.cached) }}（{{ cacheStats.hitRate != null ? cacheStats.hitRate.toFixed(1) : '?' }}%）</span>
                          <span style="color:var(--ch-miss-in)">未缓存输入 {{ fmt.num(cacheStats.miss) }}</span>
                          <span v-if="cacheStats.cacheWrite > 0" class="mut">缓存写入 {{ fmt.num(cacheStats.cacheWrite) }}</span>
                        </div>
                        <div class="cache-track">
                          <i :style="{ width: cacheStats.hitRate + '%', background: 'var(--ch-hit-in)' }"></i>
                          <i :style="{ width: cacheStats.missRate + '%', background: 'var(--ch-miss-in)' }"></i>
                        </div>
                      </div>
                      <div>
                        <div class="row-b cache-row">
                          <span class="cache-label" style="color:var(--ch-out)">输出 tokens</span>
                          <span class="num cache-value">{{ fmt.num(cacheStats.output) }}</span>
                        </div>
                        <div class="meter"><i :style="{ width: '100%', background: 'var(--ch-out)' }"></i></div>
                        <div class="cache-sub" style="margin-top:6px">输出生成不走前缀缓存，按全价计；缓存写入为 Anthropic cache_creation / OpenAI cache_write</div>
                      </div>
                      <div class="row-b cache-total">
                        <span>合计</span>
                        <span class="num">{{ fmt.num(cacheStats.input + cacheStats.output) }} tokens</span>
                      </div>
                    </div>
                  </template>
                  <div v-else class="detail-empty">暂无缓存数据：产生对话后自动统计（旧日志无缓存字段时仅显示趋势线）</div>
                </template>

                <!-- 请求明细 -->
                <template v-else-if="b.id === 'req'">
                  <div class="row-b detail-subhead">
                    <span>每日对话轮次</span>
                    <span class="pill p-pri">峰值 {{ reqChart.max }} / 日</span>
                  </div>
                  <svg v-if="reqChart.bars.length" :viewBox="'0 0 ' + reqChart.W + ' ' + reqChart.H" class="legacy-chart">
                    <rect v-for="(bar, i) in reqChart.bars" :key="i" :x="bar.x" :y="bar.y" :width="bar.w" :height="bar.h" class="chart-bar">
                      <title>{{ bar.count }} 次</title>
                    </rect>
                  </svg>
                  <div v-if="reqChart.bars.length" class="chart-day-row">
                    <span v-for="d in reqChart.days" :key="d">{{ d }}</span>
                  </div>
                  <div v-else class="detail-empty">暂无数据：产生对话（@机器人 / #ai）后自动统计</div>
                </template>

                <!-- 长期记忆 -->
                <template v-else-if="b.id === 'recall'">
                  <div class="detail-copy">
                    文件即真相：MEMORY.md / USER.md 人可读可编辑；LLM 抽取沉淀后按 scope 隔离。
                    明细见 <a href="#/recall">长期记忆</a> 与 <a href="#/memory">声明式记忆</a>。
                  </div>
                </template>

                <!-- 功能开关 -->
                <template v-else-if="b.id === 'switch'">
                  <div class="grid g4 switch-detail-grid">
                    <div v-for="s in switches" :key="s.name" class="switch-detail">
                      <span>{{ s.name }}</span>
                      <span class="pill" :class="s.on ? (s.danger ? 'p-rose' : 'p-green') : ''">{{ s.on ? 'ON' : 'OFF' }}</span>
                    </div>
                  </div>
                </template>

                <!-- 群情境 -->
                <template v-else-if="b.id === 'percept'">
                  <div v-if="perceptions.length" class="perception-list detail-perception">
                    <div v-for="p in perceptions" :key="p.groupId" class="perception-row">
                      <div class="perception-main">
                        <div class="perception-id mono">群 {{ p.groupId }}</div>
                        <div class="perception-meta">入群 {{ fmt.ago(p.met.at) }}</div>
                      </div>
                      <span class="pill" :class="(Date.now() - p.lastActive.at) > 6 * 3600e3 ? 'p-honey' : 'p-green'">
                        {{ (Date.now() - p.lastActive.at) > 6 * 3600e3 ? '久离 ' : '活跃 ' }}{{ fmt.ago(p.lastActive.at) }}
                      </span>
                    </div>
                  </div>
                  <div v-else class="detail-empty">暂无群感知数据</div>
                </template>
              </div>
            </Transition>
          </div>
        </div>
      </section>
    </div>`,
  }
})()
